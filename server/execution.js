// Limit-ladder execution — try to get filled near the mid instead of paying the
// whole spread.
//
// THE PROBLEM WITH CROSSING
// The original code placed a marketable limit every time: buy at ask*1.02, sell
// at bid*0.98. That always fills, which is simple and safe — but you pay half the
// spread going in and half coming out. On a wide options market that is brutal:
// GOOGL's Sep-26 315 call had roughly a $7 spread on a $23 mid, so a round trip
// surrendered ~30% of the position before the thesis had a chance to be right.
//
// THE LADDER
// Post a passive limit at (or near) the mid, wait a few seconds, and if it hasn't
// filled step the price toward the far side. Cross only as the last rung. Most
// fills land in the middle of the book, and you keep the difference.
//
//   buy  ladder:  mid → mid+25% of spread → mid+50% → ... → ask (cross)
//   sell ladder:  mid → mid-25% of spread → mid-50% → ... → bid (cross)
//
// URGENCY IS THE KEY DISTINCTION
//   "patient" (entries, take-profits) — a missed fill costs nothing. If the whole
//        ladder expires unfilled we simply don't trade; the setup will still be
//        there next tick.
//   "urgent" (STOP-LOSS exits) — a missed fill is the expensive outcome. Sitting
//        passively at the mid while the position bleeds is far worse than paying
//        the spread, so stops use one quick rung and then cross immediately.
//
// Total ladder time is bounded so it always completes inside one 60s trader tick.
//
// ⚠ PAPER-TRADING CAVEAT: Alpaca's paper engine simulates fills. A resting limit
// at the mid may fill more (or less) readily than it would against a real book, so
// the measured savings here are indicative, not proof. The logic is what matters —
// it's standard practice — but don't treat paper slippage numbers as gospel.

import * as alpaca from "./alpaca.js";

export const DEFAULTS = {
  enabled: true,
  patient: {
    steps: 4,            // rungs from mid to the far side (last one crosses)
    stepSeconds: 6,      // dwell at each rung
    startAtMidPct: 0.0,  // 0 = start exactly at mid; 0.25 = a quarter toward far side
  },
  urgent: {
    steps: 2,            // one polite attempt, then cross
    stepSeconds: 3,
    startAtMidPct: 0.5,  // stops start halfway — we want out
  },
  maxTotalSeconds: 45,   // hard bound so a tick can't be blocked
  minTickSize: 0.01,
};

const cfgFor = (cfg) => {
  const c = { ...DEFAULTS, ...(cfg?.execution || {}) };
  c.patient = { ...DEFAULTS.patient, ...(cfg?.execution?.patient || {}) };
  c.urgent = { ...DEFAULTS.urgent, ...(cfg?.execution?.urgent || {}) };
  return c;
};

const round2 = (x) => Math.max(0.01, Math.round(x * 100) / 100);

// Price rungs from mid toward the far side of the book.
export function ladderPrices(side, bid, ask, { steps, startAtMidPct }, tick = 0.01) {
  const mid = (bid + ask) / 2;
  const spread = Math.max(ask - bid, 0);
  const out = [];
  for (let i = 0; i < steps; i++) {
    // fraction of the half-spread we're willing to give up at this rung
    const frac = startAtMidPct + (1 - startAtMidPct) * (steps === 1 ? 1 : i / (steps - 1));
    const px = side === "buy" ? mid + (spread / 2) * frac : mid - (spread / 2) * frac;
    out.push(round2(px));
  }
  // Guarantee the final rung actually crosses, so an urgent order always fills.
  out[out.length - 1] = side === "buy" ? round2(ask + tick) : round2(Math.max(bid - tick, 0.01));
  return [...new Set(out)];
}

async function currentQuote(symbol, isOption) {
  if (isOption) {
    const q = (await alpaca.getOptionQuotes([symbol]))[symbol]?.latestQuote;
    return q ? { bid: q.bp, ask: q.ap } : null;
  }
  // Equities: Alpaca's snapshot carries a quote too; fall back to last trade.
  try {
    const s = (await alpaca.getSnapshots([symbol]))[symbol];
    if (s?.latestQuote?.bp && s?.latestQuote?.ap) return { bid: s.latestQuote.bp, ask: s.latestQuote.ap };
    const last = s?.latestTrade?.p;
    if (last) return { bid: last * 0.999, ask: last * 1.001 };
  } catch {}
  return null;
}

/**
 * Work an order up the ladder. Returns the fill (or the last unfilled state).
 *
 * side     "buy" | "sell"
 * urgency  "patient" | "urgent"
 */
export async function execute({ symbol, qty, side, urgency = "patient", isOption = true, cfg = {} }) {
  const c = cfgFor(cfg);
  const profile = urgency === "urgent" ? c.urgent : c.patient;

  const q = await currentQuote(symbol, isOption);
  if (!q || !(q.ask > 0)) {
    // No quote — fall back to a plain marketable order rather than doing nothing.
    const order = await alpaca.placeOrder({
      symbol, qty, side, type: "market", time_in_force: "day",
    });
    const f = await alpaca.waitForFill(order.id, { timeoutMs: 15000 });
    return { ...f, orderId: order.id, rungs: [], note: "no quote — market order" };
  }

  if (!c.enabled) {
    const px = side === "buy" ? round2(q.ask * 1.02) : round2(q.bid * 0.98);
    const order = await alpaca.placeOrder({
      symbol, qty, side, type: "limit", limit_price: px, time_in_force: "day",
    });
    const f = await alpaca.waitForFill(order.id, { timeoutMs: 20000 });
    return { ...f, orderId: order.id, rungs: [px], note: "ladder disabled — crossed" };
  }

  const mid = (q.bid + q.ask) / 2;
  const prices = ladderPrices(side, q.bid, q.ask, profile, c.minTickSize);
  const deadline = Date.now() + c.maxTotalSeconds * 1000;
  const attempted = [];
  let lastOrderId = null;

  for (let i = 0; i < prices.length; i++) {
    const px = prices[i];
    const isLast = i === prices.length - 1;
    attempted.push(px);

    const order = await alpaca.placeOrder({
      symbol, qty, side, type: "limit", limit_price: px, time_in_force: "day",
    });
    lastOrderId = order.id;

    // Give the rung its dwell time — but never overrun the tick budget.
    const budget = Math.min(profile.stepSeconds * 1000, Math.max(0, deadline - Date.now()));
    const f = await alpaca.waitForFill(order.id, {
      timeoutMs: isLast ? Math.max(budget, 10000) : budget,
      pollMs: 800,
    });

    if (f.filled) {
      const saved = side === "buy" ? (q.ask - f.price) : (f.price - q.bid);
      return {
        filled: true, price: f.price, qty: f.qty, orderId: order.id,
        rungs: attempted, rung: i + 1, of: prices.length,
        mid: round2(mid), bid: q.bid, ask: q.ask,
        vsMid: +(side === "buy" ? f.price - mid : mid - f.price).toFixed(2), // + = worse than mid
        vsCross: +saved.toFixed(2),                                          // + = better than crossing
      };
    }

    // Unfilled at this rung — cancel before repricing so we don't stack orders.
    try { await alpaca.cancelOrder(order.id); } catch {}
    if (Date.now() >= deadline) break;
  }

  return {
    filled: false, price: null, qty: 0, orderId: lastOrderId,
    rungs: attempted, mid: round2(mid), bid: q.bid, ask: q.ask,
    note: urgency === "urgent"
      ? "URGENT order did not fill even after crossing — check the symbol/market state"
      : "ladder expired unfilled — no trade taken, will retry next tick",
  };
}
