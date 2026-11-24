// Patient-strength strategy for the pump.fun replay harness.
//
// What the tape taught us (and what this bot is built around):
//  - A round trip pays ~1.25% of curve fees per side plus a flat 105,000
//    lamports per order, so a trade only makes sense when the expected move
//    is several percent and the stake is large enough that the flat fee is
//    noise. Spraying small buys at every launch is a guaranteed bleed.
//  - Orders decided on one slot fill two slots later. On a launch pop those
//    two slots are exactly where the top forms, so this bot never buys a
//    launch: it waits for a coin to prove itself over a lookback window of
//    real, broad, two-sided tape first.
//  - A buy whose fill price moved too far during the latency is rejected by
//    the harness for free (a rejection pays no fee at all). Setting a tight
//    max_slippage_bps on buys therefore works as a veto: the bot only ever
//    fills when the price stayed calm after it decided, never at the top of
//    a two-slot spike.
//  - Exits are rules, not hopes: take profit, stop loss, a trailing stop once
//    a gain is armed, a hard max hold, and an instant exit when the tape
//    turns (creator sell or a whale dump on a held coin).
//
// The strategy is a pure function of the batches it is fed: no clock, no
// randomness, no I/O. Every number it uses comes from the events, the fills
// and the account the harness hands it.

import type { Batch, BotState, ChainEvent, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Slots of tape the entry signal reads. */
  lookback: number;
  /** Net SOL flow (buys minus sells) over the lookback, minimum. */
  minNetSol: number;
  /** Buy trades over the lookback, minimum. */
  minBuys: number;
  /** Distinct non-creator buyers over the lookback, minimum. */
  minBuyers: number;
  /** Sell SOL over the lookback as bps of buy SOL, maximum. */
  maxSellRatioBps: number;
  /** Price change over the lookback in bps: at least this, at most maxUpBps. */
  minUpBps: number;
  maxUpBps: number;
  /** Price must be at least this share (bps) of the lookback's high price. */
  nearHighBps: number;
  /** Coin age in slots at entry: at least minAge, at most maxAge. */
  minAge: number;
  maxAge: number;
  /** Real SOL reserve at entry, in SOL: at least minRqSol, at most maxRqSol. */
  minRqSol: number;
  maxRqSol: number;
  /** Lamports aimed at one position (still capped by the harness per reply). */
  stakeLamports: number;
  /** Smallest buy worth paying the flat tx fee on. */
  minBuyLamports: number;
  /** Slippage guard on buys: the free veto described in the header. */
  buySlipBps: number;
  /** Exit thresholds, in bps of position value over cost. */
  takeProfitBps: number;
  stopLossBps: number;
  /** Trailing stop arms at this gain and fires this far below the peak. */
  trailArmBps: number;
  trailBps: number;
  /** Hard exit after this many slots in the position. */
  maxHoldSlots: number;
  /** A single recorded sell of at least this many SOL on a held coin exits it. */
  dumpSellSol: number;
  /** A creator sell on a held coin exits it on the next batch. */
  exitOnCreatorSell: boolean;
  /**
   * Entry family: 'strength' buys proven up-tapes near their highs; 'dip'
   * buys a pullback inside a longer uptrend (longLookback of net-positive,
   * broad tape, price well above where that window started) once the selling
   * fades and buyers step back in.
   */
  entryMode: 'strength' | 'dip';
  /** Long window for the dip mode's uptrend test, in slots. */
  longLookback: number;
  /** Dip mode: price change over the long window, minimum, in bps. */
  dipTrendMinBps: number;
  /** Dip mode: price change over the lookback (the pullback), in bps. */
  dipMinBps: number;
  dipMaxBps: number;
  /** Dip mode: distinct non-creator buyers over the long window, minimum. */
  dipMinBuyers: number;
  /** Slots into the run after which the guardrail filler may top up trips. */
  fillerAfterSlots: number;
  /** Stake for filler round trips (just above the 0.01 SOL guardrail bar). */
  fillerStakeLamports: number;
  /** How long a filler position is held before it is sold again. */
  fillerHoldSlots: number;
}

export const DEFAULT_PARAMS: Params = {
  lookback: 60,
  minNetSol: 1.5,
  minBuys: 6,
  minBuyers: 5,
  maxSellRatioBps: 4500,
  minUpBps: 300,
  maxUpBps: 6000,
  nearHighBps: 9000,
  minAge: 40,
  maxAge: 6000,
  minRqSol: 3,
  maxRqSol: 75,
  stakeLamports: 250_000_000,
  minBuyLamports: 10_000_000,
  buySlipBps: 300,
  takeProfitBps: 2500,
  stopLossBps: 1500,
  trailArmBps: 2000,
  trailBps: 1800,
  maxHoldSlots: 1200,
  dumpSellSol: 3,
  exitOnCreatorSell: true,
  // The shipped configuration is the dip family: of everything measured on
  // the dev window it was the only shape that finished positive on the full
  // window across every failed-tx draw (see MEASUREMENT.md in this repo).
  entryMode: 'dip',
  longLookback: 1200,
  dipTrendMinBps: 3000,
  dipMinBps: -2500,
  dipMaxBps: -800,
  dipMinBuyers: 20,
  fillerAfterSlots: 260_000,
  fillerStakeLamports: 11_000_000,
  fillerHoldSlots: 30,
};

const LAMPORTS = 1_000_000_000;

interface TapeTrade {
  slot: number;
  buy: boolean;
  sol: number;
  user: Pubkey;
  price: number;
}

interface Tape {
  createdSlot: number;
  creator: Pubkey;
  trades: TapeTrade[];
  /** Slot of the newest trade folded in, so a batch is never counted twice. */
  lastSlot: number;
  /** Set when the creator sells: the entry signal dies with it. */
  creatorSold: boolean;
}

interface Held {
  mint: Pubkey;
  openedSlot: number;
  /** Peak value-over-cost ratio seen while holding (1 = break-even). */
  peakRatio: number;
  filler: boolean;
}

/** Price of a curve from its virtual reserves: SOL per token, as a float. */
function priceOf(vq: bigint, vt: bigint): number {
  return Number(vq) / Number(vt);
}

/** What selling `tokens` into a curve pays before curve fees, in lamports. */
function sellQuote(tokens: bigint, vq: bigint, vt: bigint): number {
  const t = Number(tokens);
  return (t * Number(vq)) / (Number(vt) + t);
}

export function createStrategy(params: Params) {
  const tapes = new Map<Pubkey, Tape>();
  const held = new Map<Pubkey, Held>();
  /** Mints with a buy or sell order still in flight, so nothing double-fires. */
  const inFlight = new Set<Pubkey>();
  /** Mints already entered once: one position per coin per run, no re-entries. */
  const entered = new Set<Pubkey>();
  /** Mints bought by the guardrail filler, so their short hold applies. */
  const fillerMints = new Set<Pubkey>();
  /** Distinct mints with a finished round trip of at least 0.01 SOL of buys. */
  const tripsDone = new Set<Pubkey>();
  /** Total lamports bought per mint, to judge a closed trip against the bar. */
  const boughtTotal = new Map<Pubkey, bigint>();
  let firstSlot = -1;
  let exitWanted = new Set<Pubkey>();

  function foldEvents(batch: Batch): Set<Pubkey> {
    const touched = new Set<Pubkey>();
    for (const ev of batch.events as ChainEvent[]) {
      if (ev.event === 'CreateEvent') {
        if (!tapes.has(ev.mint)) {
          tapes.set(ev.mint, { createdSlot: ev.slot, creator: ev.creator, trades: [], lastSlot: ev.slot, creatorSold: false });
        }
        touched.add(ev.mint);
      } else if (ev.event === 'TradeEvent') {
        let tape = tapes.get(ev.mint);
        if (tape === undefined) {
          tape = { createdSlot: ev.slot, creator: ev.creator, trades: [], lastSlot: ev.slot, creatorSold: false };
          tapes.set(ev.mint, tape);
        }
        tape.trades.push({
          slot: ev.slot,
          buy: ev.is_buy,
          sol: Number(ev.sol_amount) / LAMPORTS,
          user: ev.user,
          price: priceOf(BigInt(ev.virtual_sol_reserves), BigInt(ev.virtual_token_reserves)),
        });
        if (tape.trades.length > 2000) tape.trades.splice(0, tape.trades.length - 2000);
        tape.lastSlot = ev.slot;
        if (!ev.is_buy && ev.user === tape.creator) tape.creatorSold = true;
        touched.add(ev.mint);
      }
    }
    return touched;
  }

  function foldFills(state: BotState, batch: Batch): void {
    for (const fill of batch.fills) {
      inFlight.delete(fill.mint);
      if (fill.status !== 'filled') continue;
      if (fill.side === 'buy') {
        boughtTotal.set(fill.mint, (boughtTotal.get(fill.mint) ?? 0n) + BigInt(fill.quote_lamports));
        if (!held.has(fill.mint)) {
          held.set(fill.mint, { mint: fill.mint, openedSlot: fill.slot, peakRatio: 1, filler: fillerMints.has(fill.mint) });
        }
      }
    }
    // A position the account no longer reports is a finished round trip.
    for (const mint of [...held.keys()]) {
      if (!state.positions.has(mint)) {
        held.delete(mint);
        exitWanted.delete(mint);
        if ((boughtTotal.get(mint) ?? 0n) >= 10_000_000n) tripsDone.add(mint);
      }
    }
  }

  /** The entry signal over the lookback window; null when the coin fails it. */
  function signal(state: BotState, mint: Pubkey): { stake: bigint } | null {
    const tape = tapes.get(mint);
    const curve = state.curves.get(mint);
    if (tape === undefined || curve === undefined || curve.complete) return null;
    if (tape.creatorSold) return null;
    const age = state.slot - tape.createdSlot;
    if (age < params.minAge || age > params.maxAge) return null;
    const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
    if (rqSol < params.minRqSol || rqSol > params.maxRqSol) return null;

    const since = state.slot - params.lookback;
    let net = 0;
    let buySol = 0;
    let sellSol = 0;
    let buys = 0;
    let firstPrice = 0;
    let highPrice = 0;
    const buyers = new Set<Pubkey>();
    for (const t of tape.trades) {
      if (t.slot < since) continue;
      if (firstPrice === 0) firstPrice = t.price;
      if (t.price > highPrice) highPrice = t.price;
      if (t.buy) {
        net += t.sol;
        buySol += t.sol;
        buys += 1;
        if (t.user !== tape.creator) buyers.add(t.user);
      } else {
        net -= t.sol;
        sellSol += t.sol;
      }
    }
    const nowPrice = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
    if (params.entryMode === 'dip') {
      // Long window: an established uptrend with broad ownership.
      const longSince = state.slot - params.longLookback;
      let longNet = 0;
      let longFirst = 0;
      const longBuyers = new Set<Pubkey>();
      for (const t of tape.trades) {
        if (t.slot < longSince) continue;
        if (longFirst === 0) longFirst = t.price;
        if (t.buy) {
          longNet += t.sol;
          if (t.user !== tape.creator) longBuyers.add(t.user);
        } else {
          longNet -= t.sol;
        }
      }
      if (longNet < params.minNetSol || longBuyers.size < params.dipMinBuyers) return null;
      if (longFirst > 0 && ((nowPrice - longFirst) / longFirst) * 10_000 < params.dipTrendMinBps) return null;
      // Short window: the pullback itself, deep enough to matter, not a collapse.
      if (buys < params.minBuys) return null;
      if (firstPrice > 0) {
        const dipBps = ((nowPrice - firstPrice) / firstPrice) * 10_000;
        if (dipBps < params.dipMinBps || dipBps > params.dipMaxBps) return null;
      } else return null;
      // The turn: at least two buys in the last ten slots, so the bot is not
      // catching a knife that is still falling.
      let recentBuys = 0;
      for (const t of tape.trades) if (t.slot >= state.slot - 10 && t.buy) recentBuys += 1;
      if (recentBuys < 2) return null;
    } else {
      if (buys < params.minBuys || buyers.size < params.minBuyers) return null;
      if (net < params.minNetSol) return null;
      if (buySol <= 0 || (sellSol / buySol) * 10_000 > params.maxSellRatioBps) return null;
      if (firstPrice > 0) {
        const upBps = ((nowPrice - firstPrice) / firstPrice) * 10_000;
        if (upBps < params.minUpBps || upBps > params.maxUpBps) return null;
      }
      if (highPrice > 0 && (nowPrice / highPrice) * 10_000 < params.nearHighBps) return null;
    }

    const cap = state.maxBuyLamports(mint);
    const stake = cap < BigInt(params.stakeLamports) ? cap : BigInt(params.stakeLamports);
    if (stake < BigInt(params.minBuyLamports)) return null;
    if (stake + state.txFeeLamports() > state.freeCashLamports()) return null;
    return { stake };
  }

  /** Why a held position should be sold on this batch, or null to keep it. */
  function exitReason(state: BotState, h: Held, touched: Set<Pubkey>): string | null {
    const pos = state.positions.get(h.mint);
    const curve = state.curves.get(h.mint);
    if (pos === undefined || curve === undefined) return null;
    if (curve.complete) return 'complete';
    const gross = sellQuote(pos.token_amount, curve.virtual_quote_reserves, curve.virtual_token_reserves);
    const proceeds = gross * 0.9875; // curve fees at the fallback 95 + 30 bps
    const ratio = proceeds / Number(pos.cost_lamports);
    if (ratio > h.peakRatio) h.peakRatio = ratio;
    if (ratio >= 1 + params.takeProfitBps / 10_000) return 'take-profit';
    if (ratio <= 1 - params.stopLossBps / 10_000) return 'stop-loss';
    if (h.peakRatio >= 1 + params.trailArmBps / 10_000 && ratio <= h.peakRatio * (1 - params.trailBps / 10_000)) return 'trailing';
    const holdLimit = h.filler ? params.fillerHoldSlots : params.maxHoldSlots;
    if (state.slot - h.openedSlot >= holdLimit) return 'max-hold';
    if (touched.has(h.mint)) {
      const tape = tapes.get(h.mint);
      if (tape !== undefined) {
        if (params.exitOnCreatorSell && tape.creatorSold) return 'creator-sold';
        for (const t of tape.trades) {
          if (t.slot === state.slot && !t.buy && t.sol >= params.dumpSellSol) return 'dump';
        }
      }
    }
    return null;
  }

  return {
    onHello(_state: BotState): void {
      // Nothing to set up: the strategy reads everything from the batches.
    },

    onBatch(state: BotState, batch: Batch): OrderInput[] {
      if (firstSlot < 0) firstSlot = batch.slot;
      const touched = foldEvents(batch);
      foldFills(state, batch);
      const orders: OrderInput[] = [];
      exitWanted = new Set<Pubkey>();

      // Exits first: a sell frees its position slot for a new entry.
      for (const h of held.values()) {
        if (!state.positions.has(h.mint) || inFlight.has(h.mint)) continue;
        const why = exitReason(state, h, touched);
        if (why !== null) {
          const pos = state.positions.get(h.mint);
          if (pos !== undefined) {
            orders.push({ side: 'sell', mint: h.mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
            inFlight.add(h.mint);
            exitWanted.add(h.mint);
          }
        }
      }

      // Entries: only coins whose tape moved on this batch can newly qualify.
      if (state.committedPositionCount() < state.hello.caps.max_open_positions) {
        for (const mint of touched) {
          if (state.committedPositionCount() >= state.hello.caps.max_open_positions) break;
          if (orders.length >= state.hello.caps.max_orders_per_batch) break;
          if (held.has(mint) || entered.has(mint) || inFlight.has(mint)) continue;
          const sig = signal(state, mint);
          if (sig !== null) {
            orders.push({ side: 'buy', mint, quote_lamports: sig.stake, max_slippage_bps: params.buySlipBps });
            inFlight.add(mint);
            entered.add(mint);
          }
        }
      }

      // Guardrail filler: late in the run, if too few distinct coins have a
      // finished round trip, take the smallest useful trips on the deepest,
      // busiest coins still trading and close them again fillerHoldSlots on.
      // The bar is 20 coins; missing it ranks below every entry that meets
      // it, so a near-zero-cost filler beats a disqualified zero.
      if (tripsDone.size + held.size < 20 && batch.slot - firstSlot > params.fillerAfterSlots) {
        const room = state.hello.caps.max_open_positions - state.committedPositionCount();
        if (room > 0) {
          const candidates: { mint: Pubkey; rq: bigint; buyers: number }[] = [];
          for (const [mint, curve] of state.curves) {
            if (curve.complete || held.has(mint) || entered.has(mint) || inFlight.has(mint)) continue;
            const tape = tapes.get(mint);
            if (tape === undefined || tape.creatorSold) continue;
            const buyers = new Set<Pubkey>();
            for (const t of tape.trades) if (t.buy && t.user !== tape.creator) buyers.add(t.user);
            if (buyers.size >= 10) candidates.push({ mint, rq: curve.real_quote_reserves, buyers: buyers.size });
          }
          candidates.sort((a, b) => (b.rq > a.rq ? 1 : b.rq < a.rq ? -1 : b.buyers - a.buyers));
          for (const c of candidates.slice(0, room)) {
            if (orders.length >= state.hello.caps.max_orders_per_batch) break;
            const cap = state.maxBuyLamports(c.mint);
            const stake = cap < BigInt(params.fillerStakeLamports) ? cap : BigInt(params.fillerStakeLamports);
            if (stake < 10_000_000n) continue;
            if (stake + state.txFeeLamports() > state.freeCashLamports()) continue;
            orders.push({ side: 'buy', mint: c.mint, quote_lamports: stake, max_slippage_bps: 10_000 });
            inFlight.add(c.mint);
            entered.add(c.mint);
            fillerMints.add(c.mint);
          }
        }
      }

      return orders;
    },

    onDone(_state: BotState): void {
      // The harness flattens whatever is left; nothing to decide here.
    },
  };
}
