// Client side of gap133 on Arc: request, pay, retry, verify.
// Used by the MCP server (mcp/server.mjs) and the example agent.
//
// Safety rules enforced here, before any money moves:
//   - the contract named in the 402 must equal the pinned contract
//   - the price must not exceed maxPriceWei, and must equal price() on-chain
//   - the wallet must hold enough USDC for price plus gas
// and after payment:
//   - the answer must be signed by attester() read from the pinned contract
import { createPublicClient, createWalletClient, http, parseAbi, getAddress, verifyMessage, formatUnits, parseUnits } from 'viem';

export const DEFAULT_SERVICE = 'https://arc.gap133.xyz';
export const DEFAULT_CONTRACT = '0x5EA8609e0DFA6F40b0c24CB3F766e37e91051585';
export const EXPLORER = 'https://explorer.arc.io';

const ABI = parseAbi([
  'function pay(bytes32 nonce) payable',
  'function attester() view returns (address)',
  'function price() view returns (uint256)',
]);

export function arcChain(rpcUrl = process.env.ARC_RPC_URL || 'https://rpc.mainnet.arc.io') {
  return {
    id: 5042,
    name: 'Arc',
    nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  };
}

export class BuyError extends Error {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function queryUrl(service, kind, ticker) {
  const q = new URLSearchParams({ kind });
  if (ticker) q.set('ticker', ticker);
  return `${service.replace(/\/$/, '')}/api/query?${q}`;
}

export async function getJson(url) {
  const r = await fetch(url);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new BuyError(body.error || `request failed with ${r.status}`);
  return body;
}

/**
 * Buy one answer. Returns { body, raw, signature, attester, txHash, payer, priceWei }.
 * Throws BuyError without paying if any pre-payment check fails.
 */
export async function buyAnswer({ service = DEFAULT_SERVICE, contract = DEFAULT_CONTRACT, account, kind = 'top', ticker, maxPriceWei = parseUnits('0.01', 18), chain = arcChain(), beforePay }) {
  if (!account) throw new BuyError('no wallet configured');
  const pinned = getAddress(contract);
  const pub = createPublicClient({ chain, transport: http() });
  const url = queryUrl(service, kind, ticker);

  const first = await fetch(url);
  const c = await first.json().catch(() => ({}));
  if (first.status !== 402) throw new BuyError(c.error || `expected 402 Payment Required, got ${first.status}`);
  if (!c.contract || getAddress(c.contract) !== pinned) throw new BuyError(`service asked for payment to ${c.contract}, which is not the pinned contract ${pinned}; refusing to pay`);

  const quoted = BigInt(c.price?.wei ?? -1);
  const onchain = await pub.readContract({ address: pinned, abi: ABI, functionName: 'price' });
  if (quoted !== onchain) throw new BuyError('quoted price does not match the contract price; refusing to pay');
  if (onchain > maxPriceWei) throw new BuyError(`price ${formatUnits(onchain, 18)} USDC is above your limit of ${formatUnits(maxPriceWei, 18)} USDC`);

  const balance = await pub.getBalance({ address: account.address });
  const gasReserve = parseUnits('0.005', 18);
  if (balance < onchain + gasReserve) throw new BuyError(`wallet ${account.address} holds ${formatUnits(balance, 18)} USDC; needs about ${formatUnits(onchain + gasReserve, 18)} (price plus gas)`);

  if (beforePay) await beforePay(onchain);

  const wallet = createWalletClient({ account, chain, transport: http() });
  const txHash = await wallet.writeContract({ address: pinned, abi: ABI, functionName: 'pay', args: [c.nonce], value: onchain });
  const rcpt = await pub.waitForTransactionReceipt({ hash: txHash, timeout: 60_000 });
  if (rcpt.status !== 'success') throw new BuyError(`payment transaction reverted: ${EXPLORER}/tx/${txHash}`);

  // The service reads the receipt itself; retry briefly in case its RPC lags ours.
  let res, raw;
  for (let i = 0; i < 4; i++) {
    res = await fetch(url, { headers: { 'X-Payment-Challenge': c.challenge, 'X-Payment-Tx': txHash } });
    raw = await res.text();
    if (res.ok || res.status !== 402) break;
    await sleep(1000 * (i + 1));
  }
  if (!res.ok) throw new BuyError(`paid (${EXPLORER}/tx/${txHash}) but the service returned ${res.status}: ${raw.slice(0, 200)}`);

  const attester = await pub.readContract({ address: pinned, abi: ABI, functionName: 'attester' });
  const signature = res.headers.get('X-Signature');
  const signer = res.headers.get('X-Attester');
  const valid = !!signature && !!signer && getAddress(signer) === getAddress(attester) && (await verifyMessage({ address: attester, message: raw, signature }));
  if (!valid) throw new BuyError(`answer is not signed by the contract's attester ${attester}; discarding it (payment ${EXPLORER}/tx/${txHash})`);

  return { body: JSON.parse(raw), raw, signature, attester, txHash, payer: account.address, priceWei: onchain };
}

export async function walletInfo({ account, chain = arcChain() }) {
  const pub = createPublicClient({ chain, transport: http() });
  const balance = await pub.getBalance({ address: account.address });
  return { address: account.address, balanceUsdc: formatUnits(balance, 18) };
}
