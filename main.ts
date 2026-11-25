// Pump.fun Bot Sprint — entrypoint.
// Survivor Breakout + Post-Creator-Exit Ride: buys only coins that pulled
// back then broke out with buy-dominant flow, or survived a creator dump
// and recovered to near their high. One trade per coin, tight exits.
// Runs under Node 22 type-stripping: erasable TypeScript only, no build.
import { runBot } from './vendor/makefun-bot.ts';
import { SurvivorStrategy, PARAMS } from './strategy.ts';

// Gate mirroring the bounty rules: refuse to start on a bad config rather
// than trading 24h on it. The harness caps (5 positions, 1% order size,
// 10 SOL capital, 20-coin / 0.01 SOL guardrail, 50% drawdown) are enforced
// per order by the strategy itself; this checks the tunables are sane.
function validate(): void {
  const problems: string[] = [];
  if (PARAMS.stakeSol < PARAMS.minBuySol) problems.push('stake below the 0.01 SOL guardrail minimum');
  if (PARAMS.stakeSol > 1_000_000_000n) problems.push('stake above 1 SOL per coin');
  if (PARAMS.pyramidAddSol <= 0n) problems.push('pyramid add must be positive');
  if (!(PARAMS.tpBreakout > 0)) problems.push('take-profit must be positive');
  if (!(PARAMS.trailPct > 0 && PARAMS.trailPct < 1)) problems.push('trail must be between 0 and 1');
  if (!(PARAMS.trailArm > 0)) problems.push('trail arm must be positive');
  if (!(PARAMS.hardStop < 0 && PARAMS.hardStop > -1)) problems.push('hard stop must be between -1 and 0');
  if (PARAMS.maxHoldSlots <= 0) problems.push('max hold must be positive');
  if (PARAMS.minTrades < 1) problems.push('min trades must be at least 1');
  if (PARAMS.slippageBps <= 0 || PARAMS.slippageBps > 10000) problems.push('slippage out of range');
  if (PARAMS.slippageBuyBps <= 0 || PARAMS.slippageBuyBps > 10000) problems.push('buy slippage out of range');
  if (!(PARAMS.minPeakMult >= 1)) problems.push('peak multiple must be at least 1');
  if (problems.length > 0) throw new Error(`bad config: ${problems.join('; ')}`);
}

validate();

const strategy = new SurvivorStrategy();

await runBot({
  onBatch(state, batch) {
    return strategy.onBatch(state, batch);
  },
});
