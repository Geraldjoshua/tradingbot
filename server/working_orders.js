// Working orders — patient limit ladders that DON'T block the trading loop.
//
// THE PROBLEM WITH BLOCKING
// The first ladder implementation sat in an `await` loop while it stepped from
// mid toward the far side. That was fine at 6s per rung (24s total, inside one
// 60s tick), but 6s is far too short to actually get filled at the mid — a
// resting order needs minutes, not seconds, to be taken.
//
// Simply raising the dwell would have been dangerous: manage() and enter() run
// sequentially in one tick, so a patient entry blocking for 8-12 minutes means
// STOP-LOSSES CANNOT FIRE for 8-12 minutes. Being patient about buying one name
// would delay selling a different one that's breaking down. Unacceptable coupling.
//
// THE FIX
// Patient orders become stateful instead of blocking:
//   tick 1  place rung 1 at the mid, record it, return immediately
//   tick N  is it filled? -> finalize. dwell elapsed? -> cancel, reprice one rung
//           further out, place again. Out of rungs? -> give up (entry) and no trade.
//
// The loop never waits. Dwell can now be minutes because it costs nothing.
//
// Stops deliberately do NOT use this path — they stay synchronous and urgent in
// execution.js, because for a stop the expensive outcome is *not filling*.
//
// Prices are re-derived from the LIVE book at each rung, so if the underlying
// moves while we're working, we follow it rather than chasing a stale quote.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import * as alpaca from "./alpaca.js";
import { ladderPrices } from "./execution.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STORE = path.join(ROOT, "data", "working_orders.json");

function load() { try { return JSON.parse(fs.readFileSync(STORE)); } catch { return []; } }
function persist(rows) {
  fs.mkdirSync(path.dirname(STORE), { recursive: true });
  fs.writeFileSync(STORE, JSON.stringify(rows, null, 2));
}

export function list() { return load(); }
export function activeFor(ticker) {
  return load().find((w) => w.ticker === ticker && w.status === "working") || null;
}

async function quoteFor(symbol, isOption) {
  if (isOption) {
    const q = (await alpaca.getOptionQuotes([symbol]))[symbol]?.latestQuote;
    return q && q.ap > 0 ? { bid: q.bp, ask: q.ap } : null;
  }
  try {
    const s = (await alpaca.getSnapshots([symbol]))[symbol];
    if (s?.latestQuote?.bp && s?.latestQuote?.ap) return { bid: s.latestQuote.bp, ask: s.latestQuote.ap };
    const last = s?.latestTrade?.p;
    if (last) return { bid: last * 0.999, ask: last * 1.001 };
  } catch {}
  return null;
}

// Place (or replace) the order for the current rung, pricing off the live book.
async function placeRung(w, cfg) {
  const q = await quoteFor(w.symbol, w.isOption);
  if (!q) return { ok: false, reason: "no quote" };

  const prof = cfg.execution?.patient || { steps: 4, startAtMidPct: 0 };
  const prices = ladderPrices(w.side, q.bid, q.ask, { steps: w.totalRungs, startAtMidPct: prof.startAtMidPct });
  const px = prices[Math.min(w.rung, prices.length - 1)];

  const order = await alpaca.placeOrder({
    symbol: w.symbol, qty: w.qty, side: w.side,
    type: "limit", limit_price: px, time_in_force: "day",
  }, { kind: w.kind, ticker: w.ticker });
  w.orderId = order.id;
  w.lastPrice = px;
  w.placedAt = Date.now();
  w.mid = +(((q.bid + q.ask) / 2)).toFixed(2);
  w.bid = q.bid; w.ask = q.ask;
  return { ok: true, price: px };
}

/**
 * Start a patient ladder. Returns immediately — the loop does the rest.
 * `intent` is whatever the caller needs handed back when it fills.
 */
export async function start({ ticker, symbol, qty, side, isOption = true, kind = "entry", intent = {} }, cfg) {
  const prof = cfg.execution?.patient || {};
  const w = {
    id: `${kind}-${ticker}-${Date.now()}`,
    kind, ticker, symbol, qty, side, isOption,
    rung: 0,
    totalRungs: prof.steps ?? 4,
    dwellSeconds: prof.stepSeconds ?? 90,
    maxWorkingMinutes: cfg.execution?.maxWorkingMinutes ?? 12,
    startedAt: Date.now(),
    status: "working",
    intent,
  };
  const r = await placeRung(w, cfg);
  if (!r.ok) return { started: false, reason: r.reason };
  const rows = load(); rows.push(w); persist(rows);
  return { started: true, working: w, price: r.price };
}

/**
 * Advance every working order by one tick's worth of decision-making.
 * Returns [{ event, ... }] for the caller to log / act on.
 */
export async function process(cfg, { onFilled } = {}) {
  const rows = load();
  const events = [];
  let dirty = false;

  for (const w of rows) {
    if (w.status !== "working") continue;

    // 1. Did it fill?
    let ord = null;
    try { ord = await alpaca.getOrder(w.orderId); } catch {}
    const filledPx = parseFloat(ord?.filled_avg_price);
    if (ord?.status === "filled" && Number.isFinite(filledPx) && filledPx > 0) {
      w.status = "filled";
      w.filledPrice = filledPx;
      w.filledAt = Date.now();
      dirty = true;
      events.push({
        event: "working-filled", kind: w.kind, ticker: w.ticker,
        price: filledPx, rung: `${w.rung + 1}/${w.totalRungs}`,
        mid: w.mid, vsMid: +(w.side === "buy" ? filledPx - w.mid : w.mid - filledPx).toFixed(2),
        waitedSec: Math.round((w.filledAt - w.startedAt) / 1000),
      });
      if (onFilled) { try { await onFilled(w); } catch (e) { events.push({ event: "working-finalize-failed", ticker: w.ticker, error: String(e.message || e) }); } }
      continue;
    }

    // 2. Externally cancelled/rejected — stop tracking.
    if (ord && ["canceled", "expired", "rejected"].includes(ord.status) && w.rung >= w.totalRungs - 1) {
      w.status = "expired"; dirty = true;
      events.push({ event: "working-expired", kind: w.kind, ticker: w.ticker, reason: ord.status });
      continue;
    }

    // 3. Overall time budget blown?
    const elapsedMin = (Date.now() - w.startedAt) / 60000;
    if (elapsedMin >= w.maxWorkingMinutes) {
      try { await alpaca.cancelOrder(w.orderId); } catch {}
      w.status = "expired"; dirty = true;
      events.push({
        event: "working-expired", kind: w.kind, ticker: w.ticker,
        reason: `unfilled after ${w.maxWorkingMinutes} min`,
        note: w.kind === "entry" ? "no position opened — will re-evaluate next tick" : "exit still open, will retry",
      });
      continue;
    }

    // 4. Dwell elapsed at this rung -> step closer to the far side.
    if (Date.now() - w.placedAt >= w.dwellSeconds * 1000) {
      if (w.rung >= w.totalRungs - 1) {
        // Already at the crossing rung and still nothing — let the time budget end it.
        continue;
      }
      try { await alpaca.cancelOrder(w.orderId); } catch {}
      w.rung += 1;
      const r = await placeRung(w, cfg);
      dirty = true;
      events.push({
        event: "working-reprice", kind: w.kind, ticker: w.ticker,
        rung: `${w.rung + 1}/${w.totalRungs}`, price: r.ok ? r.price : null,
        mid: w.mid, waitedSec: Math.round((Date.now() - w.startedAt) / 1000),
        ...(r.ok ? {} : { error: r.reason }),
      });
      if (!r.ok) { w.status = "expired"; }
    }
  }

  if (dirty) persist(rows.filter((w) => {
    // keep working ones; retain terminal ones briefly for the UI
    if (w.status === "working") return true;
    return Date.now() - (w.filledAt || w.startedAt) < 30 * 60 * 1000;
  }));
  return events;
}

export function cancelAll(reason = "manual") {
  const rows = load();
  const ids = [];
  for (const w of rows) {
    if (w.status !== "working") continue;
    ids.push(w.orderId);
    w.status = "canceled"; w.cancelReason = reason;
  }
  persist(rows);
  return Promise.allSettled(ids.map((id) => alpaca.cancelOrder(id))).then(() => ({ canceled: ids.length }));
}
