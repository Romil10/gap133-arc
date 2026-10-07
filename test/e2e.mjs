// End-to-end test on a local chain that uses Arc's chain id (5042).
// Starts ganache, a mock gap133 desk API, deploys the contract, then drives
// the real API handlers through the full 402 -> pay -> query flow and a set
// of negative cases. Run: node test/e2e.mjs
import ganache from 'ganache';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createWalletClient, createPublicClient, http as vhttp, parseUnits, verifyMessage, getAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const PORT_CHAIN = 18545, PORT_MOCK = 18546;
const payerKey = '0x' + '11'.repeat(32), ownerKey = '0x' + '22'.repeat(32);
const server = ganache.server({
  chain: { chainId: 5042 },
  wallet: { accounts: [payerKey, ownerKey].map((k) => ({ secretKey: k, balance: '0x' + (10n ** 21n).toString(16) })) },
  logging: { quiet: true },
});
await server.listen(PORT_CHAIN);

let deskCalls = 0;
const mock = http.createServer((req, res) => {
  deskCalls++;
  if (req.headers['x-api-key'] !== 'test-desk-key') { res.statusCode = 401; return res.end('{}'); }
  const pairs = [
    { kx: { ticker: 'KXA-1' }, gap: { rawCents: 4.2, netPositive: true } },
    { kx: { ticker: 'KXB-2' }, gap: { rawCents: 9.1, netPositive: false } },
    { kx: { ticker: 'KXC-3' }, gap: { rawCents: 1.0, netPositive: true } },
  ];
  const u = new URL(req.url, 'http://x');
  const t = u.searchParams.get('ticker');
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ pairs: t ? pairs.filter((p) => p.kx.ticker === t) : pairs }));
});
await new Promise((r) => mock.listen(PORT_MOCK, r));

process.env.ARC_RPC_URL = `http://127.0.0.1:${PORT_CHAIN}`;
process.env.GAP133_API = `http://127.0.0.1:${PORT_MOCK}`;
process.env.SERVICE_SECRET = 'test secret phrase that is long enough';
process.env.DESK_KEY = 'test-desk-key';

const core = await import('../lib/core.mjs');
const { default: query } = await import('../api/query.js');
const { default: info } = await import('../api/info.js');
const { default: sample } = await import('../api/sample.js');
const { default: stats } = await import('../api/stats.js');
const art = JSON.parse(readFileSync('public/contract.json', 'utf8'));
const chain = core.ARC;
const pub = createPublicClient({ chain, transport: vhttp(process.env.ARC_RPC_URL) });
const owner = createWalletClient({ account: privateKeyToAccount(ownerKey), chain, transport: vhttp(process.env.ARC_RPC_URL) });
const payer = createWalletClient({ account: privateKeyToAccount(payerKey), chain, transport: vhttp(process.env.ARC_RPC_URL) });

let pass = 0, failN = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  PASS', m); } else { failN++; console.log('  FAIL', m); } };

function call(handler, url, headers = {}) {
  return new Promise((resolve) => {
    const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(b) { resolve({ status: this.statusCode, headers: this.headers, body: b ? JSON.parse(b) : null, raw: b }); } };
    handler({ method: 'GET', url, headers }, res);
  });
}

// 1. info before deployment reports the attester
let r = await call(info, '/api/info');
ok(r.status === 200 && r.body.contract === null, 'info works before deployment');
const attester = r.body.attester;
ok(attester === core.attesterAccount().address, 'info attester matches derived key');
r = await call(query, '/api/query?kind=top');
ok(r.status === 503, 'query refuses while contract address is missing');

// 2. deploy
const price = parseUnits('0.01', 18);
const hash = await owner.deployContract({ abi: art.abi, bytecode: art.bytecode, args: [attester, price] });
const rcpt = await pub.waitForTransactionReceipt({ hash });
process.env.CONTRACT_ADDRESS = rcpt.contractAddress;
r = await call(info, '/api/info');
ok(r.body.price.usdc === '0.01' && r.body.attesterMatchesContract === true, 'info reads price and attester from contract');

// 3. happy path
r = await call(query, '/api/query?kind=top');
ok(r.status === 402 && r.body.nonce && r.body.challenge, '402 with challenge');
const c1 = r.body;
const payHash = await payer.writeContract({ address: c1.contract, abi: art.abi, functionName: 'pay', args: [c1.nonce], value: BigInt(c1.price.wei) });
await pub.waitForTransactionReceipt({ hash: payHash });
r = await call(query, '/api/query?kind=top', { 'x-payment-challenge': c1.challenge, 'x-payment-tx': payHash });
ok(r.status === 200, 'paid query returns 200');
ok(r.body.data.pairs[0].kx.ticker === 'KXB-2' && r.body.data.pairs.length === 3, 'top sorts by raw gap');
ok(getAddress(r.body.payment.payer) === payer.account.address && r.body.payment.amountUsdc === '0.01', 'response records payer and amount');
const valid = await verifyMessage({ address: r.headers['x-attester'], message: r.raw, signature: r.headers['x-signature'] });
ok(valid && r.headers['x-attester'] === attester, 'signature verifies against attester');
const tampered = await verifyMessage({ address: attester, message: r.raw.replace('KXB-2', 'KXZ-9'), signature: r.headers['x-signature'] });
ok(!tampered, 'tampered body fails verification');

// 4. negatives
r = await call(query, '/api/query?kind=net', { 'x-payment-challenge': c1.challenge, 'x-payment-tx': payHash });
ok(r.status === 400 && /different query/.test(r.body.error), 'challenge cannot unlock a different query');
const forged = c1.challenge.slice(0, -2) + (c1.challenge.endsWith('A') ? 'BB' : 'AA');
r = await call(query, '/api/query?kind=top', { 'x-payment-challenge': forged, 'x-payment-tx': payHash });
ok(r.status === 400, 'forged challenge rejected');
r = await call(query, '/api/query?kind=top');
const c2 = r.body;
r = await call(query, '/api/query?kind=top', { 'x-payment-challenge': c2.challenge, 'x-payment-tx': payHash });
ok(r.status === 402 && /no Paid event/.test(r.body.error), 'old tx cannot pay for a new nonce');
try {
  await payer.writeContract({ address: c1.contract, abi: art.abi, functionName: 'pay', args: [c1.nonce], value: price });
  ok(false, 'contract rejects reused nonce');
} catch { ok(true, 'contract rejects reused nonce'); }
try {
  await payer.writeContract({ address: c1.contract, abi: art.abi, functionName: 'pay', args: [c2.nonce], value: price - 1n });
  ok(false, 'contract rejects wrong amount');
} catch { ok(true, 'contract rejects wrong amount'); }
r = await call(query, '/api/query?kind=top', { 'x-payment-challenge': c2.challenge, 'x-payment-tx': '0x' + 'ab'.repeat(32) });
ok(r.status === 402, 'unknown tx hash rejected');
r = await call(query, '/api/query?kind=nope');
ok(r.status === 400, 'unknown kind rejected');

// 5. pair query + net filter
r = await call(query, '/api/query?kind=pair&ticker=kxa-1');
const c3 = r.body;
const h3 = await payer.writeContract({ address: c3.contract, abi: art.abi, functionName: 'pay', args: [c3.nonce], value: price });
await pub.waitForTransactionReceipt({ hash: h3 });
r = await call(query, '/api/query?kind=pair&ticker=KXA-1', { 'x-payment-challenge': c3.challenge, 'x-payment-tx': h3 });
ok(r.status === 200 && r.body.data.pairs[0].kx.ticker === 'KXA-1', 'pair query works (ticker case-insensitive)');

// 6. free sample and on-chain stats
r = await call(sample, '/api/sample');
ok(r.status === 200 && r.body.sample === true && r.body.pair.ticker === 'KXB-2' && r.body.pair.rawCents === 9.1, 'free sample returns the single biggest gap');
ok(/s-maxage=600/.test(r.headers['cache-control']) && !('x-signature' in r.headers), 'sample is edge-cached for 10 min and unsigned');
r = await call(stats, '/api/stats');
ok(r.status === 200 && r.body.paidQueries === 2 && r.body.uniqueWallets === 1 && r.body.usdcCollected === '0.02' && r.body.complete, 'stats count Paid events on-chain');
ok(r.body.recent.length === 2 && r.body.recent[0].tx === h3 && r.body.recent[0].at, 'stats list latest payment first, with time');
r = await call(query, '/api/query?kind=net');
const c4 = r.body;
const h4 = await owner.writeContract({ address: c4.contract, abi: art.abi, functionName: 'pay', args: [c4.nonce], value: price });
await pub.waitForTransactionReceipt({ hash: h4 });
r = await call(stats, '/api/stats');
ok(r.body.paidQueries === 3 && r.body.uniqueWallets === 2 && r.body.usdcCollected === '0.03', 'stats pick up new payments incrementally');

// 7. client library and MCP server against a local copy of the service
const PORT_SVC = 18547;
const routes = { '/api/query': query, '/api/sample': sample, '/api/stats': stats, '/api/info': info };
const svc = http.createServer((req, res) => { const h = routes[req.url.split('?')[0]]; if (!h) { res.statusCode = 404; return res.end('{}'); } h(req, res); });
await new Promise((r) => svc.listen(PORT_SVC, r));
const SVC = `http://127.0.0.1:${PORT_SVC}`;
const client = await import('../lib/client.mjs');
const localChain = client.arcChain(process.env.ARC_RPC_URL);
const paidNow = async () => (await call(stats, '/api/stats')).body.paidQueries;

let before = await paidNow();
const bought = await client.buyAnswer({ service: SVC, contract: c1.contract, account: privateKeyToAccount(payerKey), kind: 'top', chain: localChain });
ok(bought.body.data.pairs.length === 3 && getAddress(bought.attester) === getAddress(attester) && (await paidNow()) === before + 1, 'client pays, then verifies the signature against the on-chain attester');
before = await paidNow();
let refused = null;
try { await client.buyAnswer({ service: SVC, contract: '0x' + '12'.repeat(20), account: privateKeyToAccount(payerKey), chain: localChain }); } catch (e) { refused = e; }
ok(refused instanceof client.BuyError && /not the pinned contract/.test(refused.message) && (await paidNow()) === before, 'client refuses to pay a contract other than the pinned one');
refused = null;
try { await client.buyAnswer({ service: SVC, contract: c1.contract, account: privateKeyToAccount(payerKey), maxPriceWei: price - 1n, chain: localChain }); } catch (e) { refused = e; }
ok(refused instanceof client.BuyError && /above your limit/.test(refused.message) && (await paidNow()) === before, 'client refuses when the price is above the limit');

const mcp = spawn(process.execPath, ['mcp/server.mjs'], {
  env: { ...process.env, GAP133_SERVICE_URL: SVC, GAP133_CONTRACT: c1.contract, GAP133_AGENT_KEY: payerKey, GAP133_MAX_SPEND_USDC: '0.01' },
  stdio: ['pipe', 'pipe', 'pipe'],
});
const replies = new Map();
let buf = '';
mcp.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line.trim()) { const m = JSON.parse(line); replies.get(m.id)?.(m); } } });
let rid = 0;
const rpc = (method, params) => new Promise((resolve) => { const id = ++rid; replies.set(id, resolve); mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
const tool = async (name, args = {}) => (await rpc('tools/call', { name, arguments: args })).result;

const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
ok(init.result.serverInfo.name === 'gap133-arc' && init.result.capabilities.tools, 'MCP initialize handshake');
const list = await rpc('tools/list', {});
ok(['gap133_sample', 'gap133_query', 'gap133_wallet', 'gap133_stats'].every((n) => list.result.tools.some((t) => t.name === n)), 'MCP lists the four tools');
let t = await tool('gap133_sample');
ok(!t.isError && /FREE SAMPLE/.test(t.content[0].text) && /KXB-2/.test(t.content[0].text), 'MCP free sample tool');
before = await paidNow();
t = await tool('gap133_query', { kind: 'top' });
ok(!t.isError && /Verified: signed by/.test(t.content[0].text) && (await paidNow()) === before + 1, 'MCP paid query pays once and returns a verified answer');
t = await tool('gap133_query', { kind: 'net' });
ok(t.isError && /spending limit reached/.test(t.content[0].text) && (await paidNow()) === before + 1, 'MCP enforces the session spending limit without paying');
t = await tool('gap133_wallet');
ok(!t.isError && /0\.01 of 0\.01 USDC/.test(t.content[0].text), 'MCP wallet tool reports spend against the limit');
t = await tool('gap133_stats');
ok(!t.isError && /Paid queries: \d+/.test(t.content[0].text), 'MCP stats tool');
mcp.stdin.end();
svc.close();

// 8. owner functions
try {
  await payer.writeContract({ address: c1.contract, abi: art.abi, functionName: 'withdraw', args: [payer.account.address] });
  ok(false, 'non-owner cannot withdraw');
} catch { ok(true, 'non-owner cannot withdraw'); }
const balBefore = await pub.getBalance({ address: owner.account.address });
const wh = await owner.writeContract({ address: c1.contract, abi: art.abi, functionName: 'withdraw', args: [owner.account.address] });
await pub.waitForTransactionReceipt({ hash: wh });
ok((await pub.getBalance({ address: c1.contract })) === 0n && (await pub.getBalance({ address: owner.account.address })) > balBefore - parseUnits('0.01', 18), 'owner withdraws collected USDC');

console.log(`\n${pass} passed, ${failN} failed (desk API calls: ${deskCalls}, cache in use)`);
await server.close();
mock.close();
process.exit(failN ? 1 : 0);
