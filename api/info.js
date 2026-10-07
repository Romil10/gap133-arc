import { publicClient, readPrice, attesterAccount, json, fail, KINDS, ARC } from '../lib/core.mjs';
import { formatUnits, getAddress, parseAbiItem } from 'viem';

// Public service description. Before deployment it still reports the attester
// address, which the deploy page passes to the contract constructor.
export default async function handler(req, res) {
  try {
    const attester = attesterAccount().address;
    const out = {
      service: 'gap133 on Arc: pay-per-query verified market gaps',
      chain: { id: ARC.id, name: 'Arc mainnet', explorer: 'https://explorer.arc.io' },
      attester,
      contract: null,
      price: null,
      kinds: KINDS,
      endpoints: { query: '/api/query?kind=top|net|pair&ticker=...', sample: '/api/sample', stats: '/api/stats', info: '/api/info' },
    };
    const address = process.env.CONTRACT_ADDRESS;
    if (address) {
      const client = publicClient();
      const a = getAddress(address);
      const [price, onchainAttester] = await Promise.all([
        readPrice(client, a),
        client.readContract({ address: a, abi: [parseAbiItem('function attester() view returns (address)')], functionName: 'attester' }),
      ]);
      out.contract = a;
      out.price = { usdc: formatUnits(price, 18), wei: price.toString() };
      out.attesterMatchesContract = getAddress(onchainAttester) === attester;
    }
    return json(res, 200, out);
  } catch (err) {
    return fail(res, err);
  }
}
