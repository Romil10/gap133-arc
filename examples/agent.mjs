// An autonomous agent that buys one gap133 answer on Arc and verifies it.
//
//   AGENT_PRIVATE_KEY=0x...  (a throwaway wallet holding a few cents of USDC on Arc)
//   SERVICE_URL=https://arc.gap133.xyz
//   node examples/agent.mjs top
//
// It requests the query, receives HTTP 402 with a nonce, pays pay(nonce) on
// Arc, retries with proof of payment, and checks the attester's signature
// against the address stored in the contract before trusting the data.
import { createWalletClient, createPublicClient, http, verifyMessage, parseAbi, getAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const SERVICE = process.env.SERVICE_URL;
const KEY = process.env.AGENT_PRIVATE_KEY;
if (!SERVICE || !KEY) throw new Error('set SERVICE_URL and AGENT_PRIVATE_KEY');
const kind = process.argv[2] || 'top';
const ticker = process.argv[3];

const arc = {
  id: 5042,
  name: 'Arc',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.mainnet.arc.io'] } },
};
const abi = parseAbi(['function pay(bytes32 nonce) payable', 'function attester() view returns (address)']);
const pub = createPublicClient({ chain: arc, transport: http() });
const wallet = createWalletClient({ account: privateKeyToAccount(KEY), chain: arc, transport: http() });

const url = `${SERVICE}/api/query?kind=${kind}${ticker ? `&ticker=${encodeURIComponent(ticker)}` : ''}`;

const first = await fetch(url);
if (first.status !== 402) throw new Error(`expected 402, got ${first.status}`);
const c = await first.json();
console.log(`402: pay ${c.price.usdc} USDC to ${c.contract}`);

const hash = await wallet.writeContract({ address: c.contract, abi, functionName: 'pay', args: [c.nonce], value: BigInt(c.price.wei) });
await pub.waitForTransactionReceipt({ hash });
console.log('paid:', hash);

const res = await fetch(url, { headers: { 'X-Payment-Challenge': c.challenge, 'X-Payment-Tx': hash } });
const raw = await res.text();
if (!res.ok) throw new Error(raw);

// Trust the answer only if it is signed by the attester recorded on-chain.
const onchainAttester = await pub.readContract({ address: c.contract, abi, functionName: 'attester' });
const signer = res.headers.get('X-Attester');
const valid = getAddress(signer) === getAddress(onchainAttester) &&
  (await verifyMessage({ address: onchainAttester, message: raw, signature: res.headers.get('X-Signature') }));
if (!valid) throw new Error('signature does not match the contract attester; discarding answer');

const body = JSON.parse(raw);
console.log('verified answer from', onchainAttester);
for (const p of body.data.pairs) {
  console.log(`  ${p.gap?.rawCents?.toFixed?.(2) ?? '–'}c raw, ${p.gap?.netCents?.toFixed?.(2) ?? '–'}c net  ${p.kx?.title ?? p.kx?.ticker}`);
}
