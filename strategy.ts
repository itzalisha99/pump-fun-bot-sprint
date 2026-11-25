// Survivor Breakout + Completion Ride — pump.fun paper bot.
// Idea: most pump.fun coins spike and die. Chasing every up-move loses and
// dip-buying loses (both proven on the dev window by the two earlier bots).
// The surviving edge is coins that lived through a dump and came back:
//   1. Breakout mode — a coin pulls back >=20% from its early peak, then
//      prints a new high 10% above that peak with buy-dominant flow.
//   2. Completion mode — a late-curve coin with real SOL >= 45 and rising
//      into migration, bought while the tape still flows in.
// One disciplined exit system serves both: take profit, a trailing stop
// armed on strength, a hard stop, a hold limit, and exits on a big sell
// or a big creator sell. Small stakes, capped by the 1% reserve rule,
// pyramided only while the flow stays strong.
// Speed by construction: per-mint tape is updated ONLY for mints that have
// an event in this batch; exits only scan held positions (<= 5). The full
// curve set is never iterated. Ring buffers use a head index, never splice.

import type { Batch, BotState, OrderInput } from './vendor/makefun-bot.ts';

export const PARAMS = {
  minAgeSlots: 60,
  minTrades: 8,
  pullbackPct: 0.2,
  breakoutPct: 0.1,
  completionPct: 0.02,
  minBuyShare: 0.6,
  completionBuyShare: 0.55,
  minBuyers: 4,
  minRealSol: 3_000_000_000n, // 3 SOL in lamports
  completionRealSol: 45_000_000_000n, // 45 SOL in lamports
  stakeSol: 200_000_000n, // 0.20 SOL max per coin (paper-sprint's proven stake)
  pyramidStepPct: 0.1,
  pyramidAddSol: 100_000_000n, // 0.10 SOL per pyramid add
  tpBreakout: 0.75,
  tpCompletion: 0.5,
  trailArm: 0.25,
  trailPct: 0.35,
  hardStop: -0.15,
  maxHoldSlots: 1800,
  bigSellSol: 2_000_000_000n, // 2 SOL single sell exits
  creatorSellSol: 500_000_000n, // 0.5 SOL single creator sell exits
  minBuySol: 10_000_000n, // 0.01 SOL minimum buy (guardrail round trip)
  slippageBps: 500, // sell slippage (rejected sells retry next batch anyway)
  slippageBuyBps: 500, // buy slippage: 5% was a useful filter (variant F at 15% lost more)
  windowTrades: 20,
  // Variant I: the early peak must be a real pump (>=2x launch price)
  // before a pullback-breakout means anything; noise peaks are filtered out.
  minPeakMult: 2,
  // Variant K: post-creator-exit momentum (dev leader +1.07 SOL):
  // the creator dumped and the coin still recovered to near its high.
  enableCreatorExit: true,
  creatorExitRealSol: 30_000_000_000n, // 30 SOL in lamports
  creatorExitBuyShare: 0.55,
  // A/B switches: variant B (proven-shape baseline) runs with both off.
  // Paper-sprint's breakout-only bot made +0.309 SOL on this window;
  // pyramids + completion mode lost money, so they stay off until one
  // of them proves itself in a measured re-test.
  enablePyramid: false,
  enableCompletion: false,
  // Panic exits (big-sell / creator-sell) cut real dumps: on (variant G off lost more).
  enablePanicExits: true,
};

const SOL = 1_000_000_000n;

interface Tape {
  createdSlot: number | null;
  creator: string;
  startPrice: number; // price at creation (launch); 0 if never seen
  creatorExited: boolean; // the creator sold >= creatorSellSol in one trade
  peak: number; // max price (lamports per token base unit) seen
  refPeak: number; // peak frozen when the pullback started (breakout target)
  pulledBack: boolean; // price fell >= pullbackPct below peak at some point
  lastPrice: number;
  realSol: bigint;
  prevRealSol: bigint;
  trades: number;
  // ring buffer of the last windowTrades trades: direction + buyer
  dirs: boolean[];
  users: string[];
  head: number;
  count: number;
  buys: number;
}

interface Book {
  mint: string;
  tokens: bigint; // tokens held (0 while a buy is still in flight)
  cost: bigint; // lamports spent on the tokens still held, fees included
  spent: bigint; // lamports spent on this mint in total (pyramid cap)
  peakPrice: number; // max price since entry
  peakReturn: number; // max unrealised return since entry
  armed: boolean; // trailing stop armed
  buySlot: number; // slot of the first buy decision
  lastBuyPrice: number; // price of the last buy fill (pyramid step)
  mode: 'breakout' | 'completion' | 'creatorExit';
  pendingBuy: boolean; // a buy order is in flight for this mint
  pendingLamports: bigint; // lamports committed to the in-flight buy
  pendingSell: boolean; // a sell order is in flight; the book stays until its fill
}

function priceOf(vq: bigint, vt: bigint): number {
  if (vt === 0n) return 0;
  return Number(vq) / Number(vt);
}

function newTape(createdSlot: number | null, creator: string): Tape {
  return {
    createdSlot,
    creator,
    startPrice: 0,
    creatorExited: false,
    peak: 0,
    refPeak: 0,
    pulledBack: false,
    lastPrice: 0,
    realSol: 0n,
    prevRealSol: 0n,
    trades: 0,
    dirs: new Array<boolean>(PARAMS.windowTrades).fill(false),
    users: new Array<string>(PARAMS.windowTrades).fill(''),
    head: 0,
    count: 0,
    buys: 0,
  };
}

export class SurvivorStrategy {
  private tapes = new Map<string, Tape>();
  private books = new Map<string, Book>();
  private traded = new Set<string>(); // coins bought once already: no re-entry

  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const orders: OrderInput[] = [];
    const bigSell = new Set<string>();
    const creatorSell = new Set<string>();

    // 1. Age check first is the speed rule: nothing below is expensive,
    //    but fills and tape updates only ever touch this batch's mints.
    this.applyFills(batch);

    // 2. Fold this batch's events into per-mint tape (event mints only).
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        const tape = this.tapes.get(e.mint) ?? newTape(e.slot, e.creator);
        tape.createdSlot = e.slot;
        tape.creator = e.creator;
        const p = priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
        if (p > 0) {
          tape.startPrice = p;
          tape.peak = p;
          tape.lastPrice = p;
        }
        this.tapes.set(e.mint, tape);
      } else if (e.event === 'TradeEvent') {
        const tape = this.tapes.get(e.mint) ?? newTape(null, e.creator);
        tape.creator = e.creator;
        const p = priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
        if (p > 0) {
          if (p > tape.peak) tape.peak = p;
          else if (p <= tape.peak * (1 - PARAMS.pullbackPct)) {
            // freeze the reference peak the first time the pullback bites:
            // the breakout target is this old peak, not the running max
            if (!tape.pulledBack) tape.refPeak = tape.peak;
            tape.pulledBack = true;
          }
          tape.lastPrice = p;
        }
        tape.prevRealSol = tape.realSol;
        tape.realSol = BigInt(e.real_quote_reserves);
        // ring buffer push (head index, no splice)
        if (tape.count === PARAMS.windowTrades && tape.dirs[tape.head]) tape.buys -= 1;
        tape.dirs[tape.head] = e.is_buy;
        tape.users[tape.head] = e.user;
        tape.head = (tape.head + 1) % PARAMS.windowTrades;
        if (tape.count < PARAMS.windowTrades) tape.count += 1;
        if (e.is_buy) tape.buys += 1;
        tape.trades += 1;
        const solAmt = BigInt(e.sol_amount);
        if (!e.is_buy && solAmt >= PARAMS.bigSellSol) bigSell.add(e.mint);
        if (!e.is_buy && e.user === tape.creator && solAmt >= PARAMS.creatorSellSol) {
          creatorSell.add(e.mint);
          tape.creatorExited = true;
        }
        this.tapes.set(e.mint, tape);
      } else {
        const tape = this.tapes.get(e.mint);
        if (tape) tape.pulledBack = false;
      }
    }

    // 3. Exits first (sells take priority over new buys in the order cap).
    for (const book of this.books.values()) {
      if (book.tokens === 0n) continue;
      if (book.pendingSell) continue; // sell already in flight: wait for its fill
      const curve = state.curves.get(book.mint);
      if (curve === undefined || curve.complete) continue;
      const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
      if (price <= 0) continue;
      const value = Number(book.tokens) * price;
      const ret = value / Number(book.cost) - 1;
      if (price > book.peakPrice) book.peakPrice = price;
      if (ret > book.peakReturn) book.peakReturn = ret;
      if (ret >= PARAMS.trailArm) book.armed = true;
      const tp = book.mode === 'completion' ? PARAMS.tpCompletion : PARAMS.tpBreakout;
      const sellAll =
        ret >= tp ||
        (book.armed && price < book.peakPrice * (1 - PARAMS.trailPct)) ||
        ret <= PARAMS.hardStop ||
        batch.slot - book.buySlot >= PARAMS.maxHoldSlots ||
        (PARAMS.enablePanicExits && (bigSell.has(book.mint) || creatorSell.has(book.mint)));
      if (sellAll) {
        // keep the book until the fill lands: a rejected sell must be
        // retried next batch, not orphaned into a zombie position
        book.pendingSell = true;
        orders.push({
          side: 'sell',
          mint: book.mint,
          token_amount: book.tokens,
          max_slippage_bps: PARAMS.slippageBps,
        });
      }
    }
    if (orders.length >= state.hello.caps.max_orders_per_batch) return orders;

    // 4. Entries: only mints with an event this batch (incremental set).
    // cash already committed by buys decided earlier in THIS batch is not
    // in state.pending yet, so track it or the later buys get rejected
    let spentThisBatch = 0n;
    let openedThisBatch = 0;
    const seen = new Set<string>();
    for (const e of batch.events) {
      if (e.event !== 'TradeEvent') continue;
      if (seen.has(e.mint)) continue;
      seen.add(e.mint);
      if (orders.length >= state.hello.caps.max_orders_per_batch) break;
      const tape = this.tapes.get(e.mint);
      if (tape === undefined) continue;
      const curve = state.curves.get(e.mint);
      if (curve === undefined || curve.complete) continue;
      // age check first: young coins have no peak/pullback history yet
      if (tape.createdSlot !== null && batch.slot - tape.createdSlot < PARAMS.minAgeSlots) continue;
      if (tape.trades < PARAMS.minTrades) continue;
      const price = tape.lastPrice;
      if (price <= 0 || tape.peak <= 0) continue;
      const book = this.books.get(e.mint);
      if (book !== undefined && book.spent >= PARAMS.stakeSol) continue;
      if (book === undefined && state.committedPositionCount() + openedThisBatch >= state.hello.caps.max_open_positions) continue;

      const buyShare = tape.count > 0 ? tape.buys / tape.count : 0;
      const realRising = tape.realSol > tape.prevRealSol;
      let mode: 'breakout' | 'completion' | 'creatorExit' | null = null;
      if (book !== undefined && book.tokens > 0n) {
        // pyramid add on a live position: stepped price + strong flow is
        // enough — it does not need a fresh breakout setup to fire again
        if (
          PARAMS.enablePyramid &&
          price >= book.lastBuyPrice * (1 + PARAMS.pyramidStepPct) &&
          buyShare >= PARAMS.minBuyShare &&
          realRising
        ) {
          mode = book.mode;
        }
      } else if (book === undefined) {
        // fresh entry: breakout or completion setup; one trade per coin ever
        if (this.traded.has(e.mint)) continue;
        // the early peak must be a real pump, not noise
        if (tape.startPrice > 0 && tape.peak < tape.startPrice * PARAMS.minPeakMult) continue;
        if (
          tape.pulledBack &&
          tape.refPeak > 0 &&
          price >= tape.refPeak * (1 + PARAMS.breakoutPct) &&
          buyShare >= PARAMS.minBuyShare &&
          this.distinctBuyers(tape) >= PARAMS.minBuyers &&
          tape.realSol >= PARAMS.minRealSol &&
          realRising
        ) {
          mode = 'breakout';
        } else if (
          PARAMS.enableCreatorExit &&
          tape.creatorExited &&
          tape.realSol >= PARAMS.creatorExitRealSol &&
          realRising &&
          price >= tape.peak * (1 - PARAMS.completionPct) &&
          buyShare >= PARAMS.creatorExitBuyShare
        ) {
          mode = 'creatorExit';
        } else if (
          PARAMS.enableCompletion &&
          tape.realSol >= PARAMS.completionRealSol &&
          realRising &&
          price >= tape.peak * (1 - PARAMS.completionPct) &&
          buyShare >= PARAMS.completionBuyShare
        ) {
          mode = 'completion';
        }
      }
      if (mode === null) continue;

      // pyramid sizing: top the position up toward the per-coin cap
      let stake = PARAMS.stakeSol;
      if (book !== undefined) {
        if (book.pendingBuy) continue;
        stake = PARAMS.pyramidAddSol;
        if (book.spent + stake > PARAMS.stakeSol) stake = PARAMS.stakeSol - book.spent;
      }
      const cap = state.maxBuyLamports(e.mint);
      if (stake > cap) stake = cap;
      if (stake < PARAMS.minBuySol) continue;
      const free = state.freeCashLamports();
      const txFee = state.txFeeLamports();
      if (stake + txFee > free - spentThisBatch) continue;

      orders.push({
        side: 'buy',
        mint: e.mint,
        quote_lamports: stake,
        max_slippage_bps: PARAMS.slippageBuyBps,
      });
      spentThisBatch += stake + txFee;
      if (book === undefined) openedThisBatch += 1;
      // a breakout buy consumes the setup: re-arm only after a fresh pullback
      if (mode === 'breakout') {
        tape.pulledBack = false;
        tape.refPeak = 0;
      }
      const b: Book =
        book ??
        {
          mint: e.mint,
          tokens: 0n,
          cost: 0n,
          spent: 0n,
          peakPrice: price,
          peakReturn: 0,
          armed: false,
          buySlot: batch.slot,
          lastBuyPrice: price,
          mode,
          pendingBuy: false,
          pendingLamports: 0n,
          pendingSell: false,
        };
      b.pendingBuy = true;
      b.pendingLamports = stake;
      b.mode = mode;
      this.books.set(e.mint, b);
    }
    return orders;
  }

  private distinctBuyers(tape: Tape): number {
    const seen = new Set<string>();
    for (let i = 0; i < tape.count; i++) {
      if (tape.dirs[i]) seen.add(tape.users[i]);
    }
    return seen.size;
  }

  private applyFills(batch: Batch): void {
    for (const f of batch.fills) {
      if (f.client_id.startsWith('_')) {
        // harness close (complete / flatten / writeoff): position is gone
        this.books.delete(f.mint);
        continue;
      }
      const book = this.books.get(f.mint);
      if (f.side === 'buy') {
        if (f.status === 'filled') {
          this.traded.add(f.mint); // filled once: this coin is done forever
          const b: Book =
            book ??
            {
              mint: f.mint,
              tokens: 0n,
              cost: 0n,
              spent: 0n,
              peakPrice: 0,
              peakReturn: 0,
              armed: false,
              buySlot: f.decided_slot,
              lastBuyPrice: 0,
              mode: 'breakout',
              pendingBuy: false,
              pendingLamports: 0n,
              pendingSell: false,
            };
          b.tokens += BigInt(f.token_amount);
          b.cost += BigInt(f.quote_lamports);
          b.spent += BigInt(f.quote_lamports);
          // pyramid step keys off the realised fill price, not the decision price
          const fillTokens = BigInt(f.token_amount);
          if (fillTokens > 0n) b.lastBuyPrice = Number(f.quote_lamports) / Number(fillTokens);
          b.pendingBuy = false;
          b.pendingLamports = 0n;
          this.books.set(f.mint, b);
        } else if (book !== undefined) {
          // rejected / failed: the committed stake never landed
          book.pendingBuy = false;
          book.pendingLamports = 0n;
          if (book.tokens === 0n) this.books.delete(f.mint);
        }
      } else if (book !== undefined) {
        if (f.status === 'filled') {
          const sold = BigInt(f.token_amount);
          if (sold >= book.tokens) {
            this.books.delete(f.mint);
          } else {
            const before = book.tokens;
            book.tokens -= sold;
            book.cost = (book.cost * book.tokens) / before;
            book.pendingSell = false; // partial fill: the rest can exit later
          }
        } else {
          // rejected / failed sell: clear the flag so the exit retries
          book.pendingSell = false;
        }
      }
    }
  }
}
