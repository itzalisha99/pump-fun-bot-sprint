# Pump.fun Bot Sprint

[![make.fun](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![Rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/itzalisha99/pump-fun-bot-sprint/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![Reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/itzalisha99/pump-fun-bot-sprint/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

A paper-money trading bot for pump.fun bonding curves, built for the make.fun bounty "Pump.fun Bot Sprint: Make Bot And Win".

## Strategy: Survivor Breakout + Post-Creator-Exit Ride

Most pump.fun coins spike and die. Chasing every up-move loses and dip-buying loses, so this bot only buys coins that already proved they can survive:

1. **Breakout mode** — a coin pumped at least 2× from launch, pulled back at least 20% from that peak, then broke 10% above the frozen old peak with buy-dominant flow (at least 60% buys, at least 4 distinct buyers, real SOL at least 3 and rising).
2. **Post-creator-exit mode** — the creator dumped at least 0.5 SOL in one trade and the coin still recovered to within 2% of its high, with real SOL at least 30 and rising and at least 55% buys. Surviving the creator's exit is the strongest signal on the curve.

One trade per coin, ever. One disciplined exit system serves both: take-profit +75%, a 35% trailing stop armed at +25%, a −15% hard stop, an 1800-slot hold limit, and exits on a single sell of 2 SOL or more or a single creator sell of 0.5 SOL or more. Stakes are 0.20 SOL per coin, capped at 1% of the coin's real reserves. A rejected sell is retried next batch instead of orphaning the position.

Local grade on the dev window: −0.328 SOL over 89 round trips (29.2% win rate, 6.0% max drawdown, guardrails met). The edge is thin and sequence-dependent — the bot is built to survive the final window, not to promise a win.

## Speed

Per-mint tape is updated only for mints with an event in the current batch; exits scan only held positions. The full curve set is never iterated, and tape windows are ring buffers with a head index (no splice, no per-call Map churn). Age is checked first so young coins cost nothing.

## Files

- `main.ts` — entrypoint (runs under Node 22 type-stripping, no build step)
- `strategy.ts` — the strategy
- `vendor/makefun-bot.ts` — the kit's SDK shim, vendored byte-identical

## Run locally

```sh
node --experimental-strip-types main.ts
```

Grade with the kit:

```sh
node cli/makefun.mjs grade-local --kit . --bot <repo> --driver process
```
