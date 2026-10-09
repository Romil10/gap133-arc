#!/usr/bin/env node
// gap133 on Arc, as an MCP server (stdio). Gives an AI assistant four tools:
//   gap133_sample  free, the biggest verified gap from a 10-minute snapshot
//   gap133_stats   free, usage counted from the contract's on-chain Paid events
//   gap133_wallet  the agent wallet's address, USDC balance and spending budget
//   gap133_query   pays 0.01 USDC on Arc and returns the live answer, signature verified
//
// Configuration (environment variables set in your MCP client config):
//   GAP133_AGENT_KEY       private key of a DEDICATED spending wallet holding about $1 of USDC on Arc.
//                          Optional: without it the free tools still work.
//   GAP133_MAX_SPEND_USDC  total the server may spend per session (default 0.10)
//   GAP133_MAX_PRICE_USDC  refuse if one query costs more than this (default 0.01)
//   GAP133_SERVICE_URL     default https://arc.gap133.xyz
//   GAP133_CONTRACT        pinned payment contract, default the live one
//   ARC_RPC_URL            default https://rpc.mainnet.arc.io
//
// Speaks newline-delimited JSON-RPC 2.0 on stdin/stdout. Logs go to stderr only.
import { createInterface } from 'node:readline';
import { privateKeyToAccount } from 'viem/accounts';
import { formatUnits, parseUnits } from 'viem';
import { buyAnswer, walletInfo, getJson, DEFAULT_SERVICE, DEFAULT_CONTRACT, EXPLORER, BuyError } from '../lib/client.mjs';

const VERSION = '1.1.0';
const env = (k, d) => { const v = (process.env[k] || '').trim(); return v && !v.startsWith('${') ? v : d; };
const service = env('GAP133_SERVICE_URL', DEFAULT_SERVICE).replace(/\/$/, '');
const contract = env('GAP133_CONTRACT', DEFAULT_CONTRACT);
const maxSpendWei = parseUnits(String(env('GAP133_MAX_SPEND_USDC', '0.10')), 18);
const maxPriceWei = parseUnits(String(env('GAP133_MAX_PRICE_USDC', '0.01')), 18);
let account = null;
try {
  const k = env('GAP133_AGENT_KEY', '');
  if (k) account = privateKeyToAccount(k.startsWith('0x') ? k : '0x' + k);
} catch {
  process.stderr.write('gap133: GAP133_AGENT_KEY is not a valid private key; paid queries are disabled\n');
}
let spentWei = 0n;
let paidCount = 0;
let payLock = Promise.resolve(); // paid queries run one at a time so the budget check cannot race

const usdc = (wei) => formatUnits(wei, 18);
const fmtCents = (v) => (v == null ? 'n/a' : `${Number(v).toFixed(2)}c`);

const TOOLS = [
  {
    name: 'gap133_sample',
    description: 'Free. Returns the single biggest verified price gap between Polymarket/Limitless and Kalshi for the same prediction-market event, from a snapshot up to 10 minutes old. Use this first to see what gap133 data looks like, or when slightly delayed data is fine.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'gap133_query',
    description: 'Paid: costs 0.01 USDC on Arc mainnet per call, paid automatically from the configured agent wallet. Returns LIVE verified cross-venue prediction-market gaps (Polymarket/Limitless vs Kalshi) with raw and after-fee gaps in cents. The answer is signed and the signature is checked against the attester stored in the gap133 contract before it is returned. kind="top": five biggest gaps now. kind="net": gaps still positive after both venues\' taker fees. kind="pair": one pair by Kalshi ticker. Market data only, not trading advice.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['top', 'net', 'pair'], default: 'top' },
        ticker: { type: 'string', description: 'Kalshi ticker, required when kind is "pair", e.g. KXPRESNOMD-28-AOC' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'gap133_wallet',
    description: 'Free. Shows the agent wallet used for paid gap133 queries: address, USDC balance on Arc, and how much of this session\'s spending limit is left.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'gap133_stats',
    description: 'Free. Usage of gap133 on Arc counted from the payment contract\'s on-chain Paid events: paid queries, unique wallets, USDC collected, latest payments.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

function pairLines(pairs) {
  if (!pairs?.length) return ['No pairs match right now.'];
  return pairs.map((p, i) => {
    const venue = p.second?.venue ? p.second.venue.charAt(0).toUpperCase() + p.second.venue.slice(1) : 'Second venue';
    return `${i + 1}. ${p.kx?.title || p.kx?.ticker} [${p.kx?.ticker || '?'}]\n   ${venue} vs Kalshi: raw gap ${fmtCents(p.gap?.rawCents)}, after fees ${fmtCents(p.gap?.netCents)}`;
  });
}

const text = (t, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });

async function callTool(name, args = {}) {
  if (name === 'gap133_sample') {
    const s = await getJson(`${service}/api/sample`);
    if (!s.pair) return text('No verified gaps on the board right now.');
    const p = s.pair;
    return text(`FREE SAMPLE (snapshot ${s.snapshotAt}, refreshes every ${s.refreshMinutes} min)\n${p.market} [${p.ticker}]\n${p.venues[0]} vs Kalshi: raw gap ${fmtCents(p.rawCents)}, after fees ${fmtCents(p.netCents)}\n\nFor the live top five, signed, use gap133_query (0.01 USDC).`);
  }
  if (name === 'gap133_stats') {
    const s = await getJson(`${service}/api/stats`);
    const recent = s.recent.slice(0, 5).map((r) => `  ${r.at || 'block ' + r.block}  ${r.payer}  ${EXPLORER}/tx/${r.tx}`).join('\n');
    return text(`gap133 on Arc usage (counted from on-chain Paid events on ${s.contract})\nPaid queries: ${s.paidQueries}\nUnique wallets: ${s.uniqueWallets}\nUSDC collected: ${s.usdcCollected}${recent ? '\nLatest:\n' + recent : ''}`);
  }
  if (name === 'gap133_wallet') {
    if (!account) return text('No agent wallet configured. Add the private key of a dedicated wallet holding about $1 of USDC on Arc mainnet (in Claude Desktop: Settings > Extensions > gap133 > Configure; otherwise the GAP133_AGENT_KEY env var). The free tools work without it.');
    const w = await walletInfo({ account });
    return text(`Agent wallet: ${w.address}\nBalance: ${w.balanceUsdc} USDC on Arc\nSpent this session: ${usdc(spentWei)} of ${usdc(maxSpendWei)} USDC limit (${paidCount} paid queries)`);
  }
  if (name === 'gap133_query') {
    if (!account) return text('Paid queries need an agent wallet: add the private key of a dedicated wallet with about $1 of USDC on Arc (Claude Desktop: Settings > Extensions > gap133 > Configure). Meanwhile gap133_sample is free.', true);
    const kind = args.kind || 'top';
    if (!['top', 'net', 'pair'].includes(kind)) return text('kind must be top, net or pair', true);
    if (kind === 'pair' && !args.ticker) return text('kind "pair" needs a ticker', true);
    const run = payLock.then(() => buyAnswer({
      service,
      contract,
      account,
      kind,
      ticker: kind === 'pair' ? args.ticker : undefined,
      maxPriceWei,
      beforePay: async (price) => {
        if (spentWei + price > maxSpendWei) throw new BuyError(`session spending limit reached (${usdc(spentWei)} of ${usdc(maxSpendWei)} USDC spent). Raise GAP133_MAX_SPEND_USDC to allow more.`);
        spentWei += price; // count it before sending, so a later failure cannot hide a payment
        paidCount += 1;
      },
    }));
    payLock = run.catch(() => {});
    const r = await run;
    const title = { top: 'Top 5 live gaps', net: 'Gaps still positive after fees', pair: `Pair ${args.ticker}` }[kind];
    return text(`${title} (live, issued ${r.body.issuedAt})\n${pairLines(r.body.data?.pairs).join('\n')}\n\nVerified: signed by ${r.attester}, the attester stored in contract ${contract}.\nPaid ${usdc(r.priceWei)} USDC: ${EXPLORER}/tx/${r.txHash}\nSession spend: ${usdc(spentWei)} of ${usdc(maxSpendWei)} USDC.\n${r.body.notice}`);
  }
  throw new BuyError(`unknown tool ${name}`);
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

async function handle(msg) {
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;
  try {
    let result;
    if (method === 'initialize') {
      result = {
        protocolVersion: params?.protocolVersion || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'gap133-arc', version: VERSION },
        instructions: 'gap133 finds verified price gaps for the same event between Polymarket/Limitless and Kalshi. gap133_sample is free and delayed; gap133_query costs 0.01 USDC on Arc per call and returns live, signature-verified data. Market data only, not trading advice.',
      };
    } else if (method === 'tools/list') {
      result = { tools: TOOLS };
    } else if (method === 'tools/call') {
      try {
        result = await callTool(params?.name, params?.arguments || {});
      } catch (e) {
        result = text(e instanceof BuyError ? e.message : `error: ${e.shortMessage || e.message || e}`, true);
      }
    } else if (method === 'ping') {
      result = {};
    } else if (!isRequest) {
      return; // notifications such as notifications/initialized
    } else {
      return send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
    }
    if (isRequest) send({ jsonrpc: '2.0', id, result });
  } catch (e) {
    if (isRequest) send({ jsonrpc: '2.0', id, error: { code: -32603, message: String(e.message || e) } });
  }
}

const rl = createInterface({ input: process.stdin });
const pending = new Set();
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
  }
  const p = handle(msg).finally(() => pending.delete(p));
  pending.add(p);
});
rl.on('close', async () => {
  await Promise.all(pending);
  process.exit(0);
});
process.stderr.write(`gap133-arc MCP ${VERSION} ready (${account ? 'wallet ' + account.address : 'no wallet, free tools only'})\n`);
