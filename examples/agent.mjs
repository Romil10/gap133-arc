// An autonomous agent that buys one gap133 answer on Arc and verifies it.
//
//   AGENT_PRIVATE_KEY=0x...  (a throwaway wallet holding a few cents of USDC on Arc)
//   SERVICE_URL=https://arc.gap133.xyz   (optional, this is the default)
//   node examples/agent.mjs top
//
// It requests the query, receives HTTP 402 with a nonce, checks the contract and
// price against the pinned contract, pays pay(nonce) on Arc, retries with proof of
// payment, and checks the attester's signature against the address stored in the
// contract before trusting the data. For AI assistants, see mcp/server.mjs.
import { privateKeyToAccount } from 'viem/accounts';
import { buyAnswer, DEFAULT_SERVICE } from '../lib/client.mjs';

const KEY = process.env.AGENT_PRIVATE_KEY;
if (!KEY) throw new Error('set AGENT_PRIVATE_KEY');
const [kind = 'top', ticker] = process.argv.slice(2);

const r = await buyAnswer({ service: process.env.SERVICE_URL || DEFAULT_SERVICE, account: privateKeyToAccount(KEY), kind, ticker });
console.log('paid:', r.txHash);
console.log('verified answer from', r.attester);
for (const p of r.body.data.pairs) {
  console.log(`  ${p.gap?.rawCents?.toFixed?.(2) ?? '-'}c raw, ${p.gap?.netCents?.toFixed?.(2) ?? '-'}c net  ${p.kx?.title ?? p.kx?.ticker}`);
}
