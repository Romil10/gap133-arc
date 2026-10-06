// Shared logic for the gap133 Arc pay-per-query service.
//
// Flow (HTTP 402 style):
//   1. GET /api/query?kind=top            -> 402 + a signed challenge with a one-time nonce
//   2. caller pays pay(nonce) on the Arc contract (0.01 USDC)
//   3. GET /api/query?kind=top with headers
//        X-Payment-Challenge: <challenge from step 1>
//        X-Payment-Tx:        <transaction hash from step 2>
//      -> the service checks the challenge, reads the receipt on Arc, finds the
//         Paid(nonce) event, then returns live gap133 data signed by the attester.
//
// Secrets (environment variables, never in this repo):
//   SERVICE_SECRET  any long random phrase; the HMAC key and the attester
//                   signing key are derived from it. The attester key holds no funds.
//   DESK_KEY        a gap133 desk key, used server-side to read the live desk API.
//   CONTRACT_ADDRESS  the deployed Gap133PayPerQuery address on Arc mainnet.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  createPublicClient,
  http,
  keccak256,
  toHex,
  stringToBytes,
  decodeEventLog,
  parseAbiItem,
  getAddress,
  formatUnits,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

export const ARC = {
  id: 5042,
  name: 'Arc',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [process.env.ARC_RPC_URL || 'https://rpc.mainnet.arc.io'] } },
  blockExplorers: { default: { name: 'Arc Explorer', url: 'https://explorer.arc.io' } },
};

export const GAP133_API = process.env.GAP133_API || 'https://gap133.xyz';
export const CHALLENGE_TTL_SEC = 15 * 60;

const PAID_EVENT = parseAbiItem('event Paid(bytes32 indexed nonce, address indexed payer, uint256 amount)');
const PRICE_ABI = [parseAbiItem('function price() view returns (uint256)'), parseAbiItem('function attester() view returns (address)')];

export const KINDS = {
  top: 'The five biggest verified cross-venue gaps right now (Polymarket/Limitless vs Kalshi).',
  net: 'Pairs whose gap is still positive after both venues\' taker fees.',
  pair: 'One pair by Kalshi ticker (pass ticker=...).',
};

export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

function secret() {
  const s = process.env.SERVICE_SECRET;
  if (!s || s.length < 24) throw new HttpError(500, 'service not configured (SERVICE_SECRET missing or too short)');
  return s;
}

function hmacKey() {
  return keccak256(stringToBytes('gap133-arc:hmac:' + secret()));
}

export function attesterAccount() {
  return privateKeyToAccount(keccak256(stringToBytes('gap133-arc:attester:' + secret())));
}

export function contractAddress() {
  const a = process.env.CONTRACT_ADDRESS;
  if (!a) throw new HttpError(503, 'contract not deployed yet (CONTRACT_ADDRESS missing)');
  return getAddress(a);
}

export function publicClient() {
  return createPublicClient({ chain: ARC, transport: http(ARC.rpcUrls.default.http[0], { timeout: 10_000 }) });
}

/** Canonical form of the query so a challenge can only unlock the query it was issued for. */
export function normaliseQuery(params) {
  const kind = String(params.get('kind') || 'top');
  if (!KINDS[kind]) throw new HttpError(400, `unknown kind "${kind}"`, { kinds: KINDS });
  const q = { kind };
  if (kind === 'pair') {
    const ticker = String(params.get('ticker') || '').trim().toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9._-]{2,80}$/.test(ticker)) throw new HttpError(400, 'pair queries need a valid ticker=...');
    q.ticker = ticker;
  }
  return q;
}

function sign(payload) {
  return createHmac('sha256', Buffer.from(hmacKey().slice(2), 'hex')).update(payload).digest('base64url');
}

export async function readPrice(client, address) {
  return client.readContract({ address, abi: PRICE_ABI, functionName: 'price' });
}

export async function issueChallenge(query, priceWei) {
  const nonce = toHex(randomBytes(32));
  const body = {
    v: 1,
    nonce,
    query,
    priceWei: priceWei.toString(),
    contract: contractAddress(),
    chainId: ARC.id,
    expiresAt: Math.floor(Date.now() / 1000) + CHALLENGE_TTL_SEC,
  };
  const payload = Buffer.from(JSON.stringify(body)).toString('base64url');
  return { challenge: `${payload}.${sign(payload)}`, ...body };
}

export function openChallenge(token, query) {
  const [payload, mac] = String(token || '').split('.');
  if (!payload || !mac) throw new HttpError(400, 'malformed X-Payment-Challenge');
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw new HttpError(400, 'challenge signature invalid');
  const body = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  if (body.v !== 1 || body.chainId !== ARC.id) throw new HttpError(400, 'challenge version or chain mismatch');
  if (body.expiresAt < Math.floor(Date.now() / 1000)) throw new HttpError(402, 'challenge expired; request a new one');
  if (JSON.stringify(body.query) !== JSON.stringify(query)) throw new HttpError(400, 'challenge was issued for a different query');
  if (getAddress(body.contract) !== contractAddress()) throw new HttpError(400, 'challenge is for a different contract');
  return body;
}

/** Find the Paid(nonce) event in the given transaction on Arc. */
export async function verifyPayment(client, txHash, challenge) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(txHash || ''))) throw new HttpError(400, 'malformed X-Payment-Tx');
  let receipt;
  try {
    receipt = await client.getTransactionReceipt({ hash: txHash });
  } catch {
    throw new HttpError(402, 'payment transaction not found on Arc yet; retry in a moment');
  }
  if (receipt.status !== 'success') throw new HttpError(402, 'payment transaction reverted');
  const contract = getAddress(challenge.contract);
  for (const log of receipt.logs) {
    if (getAddress(log.address) !== contract) continue;
    let ev;
    try {
      ev = decodeEventLog({ abi: [PAID_EVENT], data: log.data, topics: log.topics });
    } catch {
      continue;
    }
    if (ev.args.nonce.toLowerCase() !== challenge.nonce.toLowerCase()) continue;
    if (ev.args.amount < BigInt(challenge.priceWei)) throw new HttpError(402, 'payment amount below price');
    return { payer: ev.args.payer, amount: ev.args.amount, block: receipt.blockNumber };
  }
  throw new HttpError(402, 'no Paid event for this nonce in that transaction');
}

// Small in-memory cache so repeated paid queries stay inside gap133's rate limits.
const cache = new Map();
async function gap133(path) {
  const hit = cache.get(path);
  if (hit && Date.now() - hit.at < 30_000) return hit.data;
  const key = process.env.DESK_KEY;
  if (!key) throw new HttpError(503, 'data source not configured (DESK_KEY missing)');
  const res = await fetch(GAP133_API + path, { headers: { 'X-API-Key': key, Accept: 'application/json' } });
  if (!res.ok) throw new HttpError(502, `gap133 desk API returned ${res.status}`);
  const data = await res.json();
  cache.set(path, { at: Date.now(), data });
  return data;
}

function pairsOf(d) {
  return Array.isArray(d) ? d : d.pairs || d.data || [];
}

export async function runQuery(query) {
  if (query.kind === 'pair') {
    const d = await gap133(`/api/v1/pairs?ticker=${encodeURIComponent(query.ticker)}&include=held,dismissed`);
    const pairs = pairsOf(d);
    if (!pairs.length) throw new HttpError(404, 'no pair with that ticker on gap133 right now');
    return { pairs };
  }
  const d = await gap133('/api/v1/pairs?limit=250');
  let pairs = pairsOf(d);
  if (query.kind === 'net') pairs = pairs.filter((p) => p.gap && p.gap.netPositive);
  pairs = [...pairs].sort((a, b) => (b.gap?.rawCents ?? 0) - (a.gap?.rawCents ?? 0)).slice(0, query.kind === 'top' ? 5 : 25);
  return { pairs };
}

/** Sign the exact JSON string returned, so an agent can verify it byte for byte. */
export async function signedResponse(query, data, payment, txHash) {
  const account = attesterAccount();
  const result = {
    source: 'gap133.xyz desk API (live tier)',
    query,
    issuedAt: new Date().toISOString(),
    payment: {
      chainId: ARC.id,
      txHash,
      payer: payment.payer,
      amountUsdc: formatUnits(payment.amount, 18),
    },
    data,
    notice: 'Market data only. Not trading advice. Gaps can close before you act.',
  };
  const body = JSON.stringify(result);
  const signature = await account.signMessage({ message: body });
  return { body, signature, attester: account.address };
}

export function json(res, status, obj, headers = {}) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'X-Payment-Challenge, X-Payment-Tx, Content-Type');
  res.setHeader('Access-Control-Expose-Headers', 'X-Attester, X-Signature');
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(typeof obj === 'string' ? obj : JSON.stringify(obj));
}

export function fail(res, err) {
  if (err instanceof HttpError) return json(res, err.status, { error: err.message, ...err.extra });
  console.error(err);
  return json(res, 500, { error: 'internal error' });
}
