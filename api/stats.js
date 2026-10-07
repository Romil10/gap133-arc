import { publicClient, contractAddress, json, fail } from '../lib/core.mjs';
import { liveStats } from '../lib/stats.mjs';

// On-chain usage: paid queries, unique wallets and USDC collected, all counted
// from the contract's Paid events. Cached at the edge for a minute.
export default async function handler(req, res) {
  try {
    const stats = await liveStats(publicClient(), contractAddress());
    return json(res, 200, stats, { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300' });
  } catch (err) {
    return fail(res, err);
  }
}
