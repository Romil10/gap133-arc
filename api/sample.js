import { runQuery, json, fail } from '../lib/core.mjs';

// Free sample: the single biggest verified gap from a snapshot refreshed every
// 10 minutes. Unsigned and delayed, like gap133's free board. The paid query
// returns the live top five, fee-adjusted, signed by the attester.
const TTL_MS = 10 * 60 * 1000;
let snap = null;
const round2 = (v) => (v == null ? null : Math.round(v * 100) / 100);
const venueName = (v) => (v ? v.charAt(0).toUpperCase() + v.slice(1) : null);

export default async function handler(req, res) {
  try {
    if (!snap || Date.now() - snap.at > TTL_MS) {
      const { pairs } = await runQuery({ kind: 'top' });
      const p = pairs[0] || null;
      snap = {
        at: Date.now(),
        pair: p && {
          market: p.kx?.title || p.kx?.ticker || null,
          ticker: p.kx?.ticker || null,
          venues: [venueName(p.second?.venue), 'Kalshi'],
          status: p.status || null,
          rawCents: round2(p.gap?.rawCents),
          netCents: round2(p.gap?.netCents),
        },
        liveCount: pairs.length,
      };
    }
    return json(res, 200, {
      sample: true,
      snapshotAt: new Date(snap.at).toISOString(),
      refreshMinutes: 10,
      pair: snap.pair,
      upgrade: 'Pay 0.01 USDC on Arc via /api/query?kind=top for the live top five, signed by the attester.',
      notice: 'Market data only. Not trading advice.',
    }, { 'Cache-Control': 'public, max-age=60, s-maxage=600' });
  } catch (err) {
    return fail(res, err);
  }
}
