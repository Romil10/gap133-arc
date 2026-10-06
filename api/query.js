import {
  normaliseQuery,
  publicClient,
  contractAddress,
  readPrice,
  issueChallenge,
  openChallenge,
  verifyPayment,
  runQuery,
  signedResponse,
  json,
  fail,
  KINDS,
} from '../lib/core.mjs';
import { formatUnits } from 'viem';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return json(res, 204, '');
  try {
    const url = new URL(req.url, 'http://local');
    const query = normaliseQuery(url.searchParams);
    const challengeToken = req.headers['x-payment-challenge'];
    const txHash = req.headers['x-payment-tx'];
    const client = publicClient();

    if (!challengeToken || !txHash) {
      // No payment yet: answer 402 with a fresh one-time challenge.
      const address = contractAddress();
      const price = await readPrice(client, address);
      const c = await issueChallenge(query, price);
      return json(res, 402, {
        error: 'payment required',
        how: 'Call pay(nonce) on the contract with exactly priceWei of native USDC on Arc, then repeat this request with headers X-Payment-Challenge and X-Payment-Tx.',
        price: { usdc: formatUnits(price, 18), wei: price.toString() },
        chain: { id: 5042, name: 'Arc mainnet', rpc: 'https://rpc.mainnet.arc.io' },
        contract: c.contract,
        method: 'pay(bytes32)',
        nonce: c.nonce,
        challenge: c.challenge,
        expiresAt: c.expiresAt,
        kinds: KINDS,
      });
    }

    const challenge = openChallenge(challengeToken, query);
    const payment = await verifyPayment(client, txHash, challenge);
    const data = await runQuery(query);
    const { body, signature, attester } = await signedResponse(query, data, payment, txHash);
    return json(res, 200, body, { 'X-Attester': attester, 'X-Signature': signature });
  } catch (err) {
    return fail(res, err);
  }
}
