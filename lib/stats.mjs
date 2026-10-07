// Usage stats counted from the contract's Paid events on Arc.
//
// Arc's public RPC limits eth_getLogs to 10,000 blocks per call and rate-limits
// bursts, while Arc produces about two blocks a second. Scanning from the deploy
// block on every request would not scale, so totals up to a recent block are kept
// in lib/stats-checkpoint.mjs (refreshed daily by a GitHub Action running
// scripts/update-checkpoint.mjs). The live endpoint scans only the blocks after
// the checkpoint and keeps the result warm in memory.
import { parseAbiItem, getAddress, formatUnits } from 'viem';
import checkpoint from './stats-checkpoint.mjs';

const PAID_EVENT = parseAbiItem('event Paid(bytes32 indexed nonce, address indexed payer, uint256 amount)');
const RANGE = 10_000n;
const RECENT = 8;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getLogsRetry(client, address, fromBlock, toBlock) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await client.getLogs({ address, event: PAID_EVENT, fromBlock, toBlock });
    } catch (e) {
      const limited = /rate limit|429|-32005/i.test(String(e?.message || e) + String(e?.details || ''));
      if (!limited || attempt >= 4) throw e;
      await sleep(400 * 2 ** attempt);
    }
  }
}

/** Empty totals, or the committed checkpoint when it belongs to this contract. */
export function baseState(contract) {
  if (checkpoint && checkpoint.contract && getAddress(checkpoint.contract) === getAddress(contract)) {
    return {
      contract: getAddress(contract),
      deployBlock: BigInt(checkpoint.deployBlock),
      scannedTo: BigInt(checkpoint.block),
      count: checkpoint.count,
      totalWei: BigInt(checkpoint.totalWei),
      payers: new Set(checkpoint.payers.map((p) => getAddress(p))),
      recent: checkpoint.recent.map((r) => ({ ...r })),
    };
  }
  const from = BigInt(process.env.STATS_DEPLOY_BLOCK || 0);
  return { contract: getAddress(contract), deployBlock: from, scannedTo: from - 1n, count: 0, totalWei: 0n, payers: new Set(), recent: [] };
}

/**
 * Scan Paid events from state.scannedTo+1 up to `head`, mutating state.
 * Stops early (complete=false) when the time budget runs out.
 */
export async function scan(client, state, head, budgetMs = Infinity) {
  const started = Date.now();
  let from = state.scannedTo + 1n;
  while (from <= head) {
    if (Date.now() - started > budgetMs) return false;
    const to = from + RANGE - 1n < head ? from + RANGE - 1n : head;
    const logs = await getLogsRetry(client, state.contract, from, to);
    for (const log of logs) {
      state.count += 1;
      state.totalWei += log.args.amount;
      state.payers.add(getAddress(log.args.payer));
      state.recent.unshift({ tx: log.transactionHash, payer: getAddress(log.args.payer), block: log.blockNumber.toString(), amountWei: log.args.amount.toString() });
    }
    state.recent = state.recent.slice(0, RECENT);
    state.scannedTo = to;
    from = to + 1n;
  }
  return true;
}

/** Fill in timestamps for recent payments that do not have one yet. */
export async function stampRecent(client, state) {
  for (const r of state.recent) {
    if (r.ts) continue;
    const b = await client.getBlock({ blockNumber: BigInt(r.block) });
    r.ts = new Date(Number(b.timestamp) * 1000).toISOString();
  }
}

export function serialise(state) {
  return {
    contract: state.contract,
    deployBlock: state.deployBlock.toString(),
    block: state.scannedTo.toString(),
    count: state.count,
    totalWei: state.totalWei.toString(),
    payers: [...state.payers],
    recent: state.recent,
  };
}

export function publicView(state, complete) {
  return {
    contract: state.contract,
    paidQueries: state.count,
    uniqueWallets: state.payers.size,
    usdcCollected: formatUnits(state.totalWei, 18),
    recent: state.recent.map((r) => ({ tx: r.tx, payer: r.payer, block: r.block, usdc: formatUnits(BigInt(r.amountWei), 18), at: r.ts || null })),
    countedThroughBlock: state.scannedTo.toString(),
    complete,
    method: 'Counted from Paid events emitted by the contract on Arc mainnet. Anyone can recount them on the explorer.',
  };
}

// Warm-instance cache: later requests only scan blocks added since the last one.
let warm = null;

export async function liveStats(client, contract, budgetMs = 12_000) {
  if (!warm || warm.contract !== getAddress(contract)) warm = baseState(contract);
  const head = await client.getBlockNumber();
  const complete = await scan(client, warm, head, budgetMs);
  try {
    await stampRecent(client, warm);
  } catch {
    // timestamps are cosmetic; skip if the RPC is busy
  }
  return publicView(warm, complete);
}

export function _resetWarm() {
  warm = null;
}
