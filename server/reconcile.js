// Reconcile local position state against Alpaca — run on every boot.
//
// WHY THIS IS NEEDED: you shut the laptop down each evening, so the bot is blind
// overnight while Alpaca keeps living. Our JSON store can therefore be wrong by
// morning in several ways, and every one of them is dangerous in a different way:
//
//   1. PHANTOM OPEN — store says OPEN, Alpaca has no such position. It expired,
//      was assigned, or you closed it by hand. Left alone the loop keeps trying to
//      "manage" something that doesn't exist, and every exit attempt errors.
//
//   2. UNRESOLVED ENTRY — we placed a marketable limit near the close and shut
//      down before knowing the outcome. The order may have filled (we're actually
//      in the trade, with no stop being watched), or expired unfilled (we think
//      we're in a trade we never got).
//
//   3. UNTRACKED POSITION — Alpaca holds something the store doesn't know about.
//      Nothing is managing its stop. We flag it loudly rather than adopting it
//      silently, because inventing entry levels for a position we didn't plan
//      would be worse than saying "a human should look at this".
//
// Alpaca is the source of truth for WHAT WE HOLD. The local store is the source of
// truth for WHY (levels, targets, flow context) — that can't be recovered from the
// broker, which is exactly why we don't auto-adopt.

import * as alpaca from "./alpaca.js";
import * as vd from "./voldesk_trades.js";

const iso = () => new Date().toISOString().slice(0, 10);

export async function reconcile({ apply = true } = {}) {
  const out = {
    ranAt: new Date().toISOString(),
    checked: 0, phantomsClosed: [], entriesResolved: [], untracked: [], errors: [],
  };

  // Live truth from the broker.
  let livePositions = [], liveOrders = [];
  try {
    livePositions = await alpaca.getPositions();
  } catch (e) {
    out.errors.push(`getPositions failed: ${String(e.message || e)}`);
    return out;   // without broker truth, changing local state would be guessing
  }
  try {
    // "all" so we can see yesterday's filled/expired/canceled entry orders.
    liveOrders = await alpaca.getOrders("all");
  } catch (e) {
    out.errors.push(`getOrders failed: ${String(e.message || e)}`);
  }

  const heldBySymbol = new Map(livePositions.map((p) => [p.symbol, p]));
  const orderById = new Map((liveOrders || []).map((o) => [o.id, o]));

  const rows = vd.listAll();
  const open = rows.filter((p) => p.status === "OPEN");
  out.checked = open.length;

  for (const p of open) {
    // The symbol we'd actually be holding: option contract, or the ticker itself.
    const sym = p.instrument === "shares" ? p.ticker : p.optionSymbol;
    const held = heldBySymbol.get(sym);
    const entryOrder = p.orderId ? orderById.get(p.orderId) : null;
    const orderStatus = entryOrder?.status || null;

    if (held) {
      // We really hold it. If the entry filled overnight, record the real fill
      // price — our stored entryPremium was only an estimate at placement.
      const filledAvg = parseFloat(entryOrder?.filled_avg_price ?? "");
      if (Number.isFinite(filledAvg) && filledAvg > 0) {
        const stored = p.instrument === "shares" ? p.entryPrice : p.entryPremium;
        if (!stored || Math.abs(stored - filledAvg) / Math.max(stored, 0.01) > 0.02) {
          if (apply) {
            vd.patchPosition(p.id, p.instrument === "shares"
              ? { entryPrice: +filledAvg.toFixed(2), fillReconciled: true }
              : { entryPremium: +filledAvg.toFixed(2), fillReconciled: true });
          }
          out.entriesResolved.push({
            ticker: p.ticker, id: p.id, action: "fill-price-corrected",
            from: stored ?? null, to: +filledAvg.toFixed(2),
          });
        }
      }
      continue;
    }

    // Not held at Alpaca. Which case is it?
    if (orderStatus && ["new", "accepted", "held", "partially_filled", "pending_new"].includes(orderStatus)) {
      // Entry still working — leave it alone, the loop will see the fill.
      out.entriesResolved.push({ ticker: p.ticker, id: p.id, action: "entry-still-working", orderStatus });
      continue;
    }

    if (orderStatus && ["canceled", "expired", "rejected"].includes(orderStatus)) {
      if (apply) vd.markStatus(p.id, "CANCELED", `reconcile: entry ${orderStatus} overnight (never filled)`);
      out.entriesResolved.push({ ticker: p.ticker, id: p.id, action: "entry-never-filled", orderStatus });
      continue;
    }

    // Order filled (or unknown) yet nothing is held → the position is gone:
    // expired worthless, assigned, or closed outside the bot.
    const why = orderStatus === "filled"
      ? "position no longer at broker (expired / assigned / closed outside the bot)"
      : `position not at broker and entry order status unknown${orderStatus ? ` (${orderStatus})` : ""}`;
    if (apply) vd.markStatus(p.id, "CLOSED", `reconcile: ${why}`);
    out.phantomsClosed.push({ ticker: p.ticker, id: p.id, reason: why, orderStatus });
  }

  // Anything at the broker we aren't tracking?
  const trackedSymbols = new Set(open.map((p) => p.instrument === "shares" ? p.ticker : p.optionSymbol));
  for (const lp of livePositions) {
    if (!trackedSymbols.has(lp.symbol)) {
      out.untracked.push({
        symbol: lp.symbol, qty: lp.qty, side: lp.side,
        marketValue: lp.market_value, unrealizedPl: lp.unrealized_pl,
        note: "held at Alpaca but not in the bot's store — NOT auto-managed (no stop/target). Close it manually or leave it.",
      });
    }
  }

  return out;
}

// Human-readable one-liner for the boot log.
export function summarize(r) {
  if (r.errors.length && !r.checked) return `reconcile skipped: ${r.errors[0]}`;
  const bits = [`${r.checked} open checked`];
  if (r.phantomsClosed.length) bits.push(`${r.phantomsClosed.length} phantom closed`);
  if (r.entriesResolved.length) bits.push(`${r.entriesResolved.length} entry resolved`);
  if (r.untracked.length) bits.push(`${r.untracked.length} UNTRACKED at broker`);
  if (r.errors.length) bits.push(`${r.errors.length} error(s)`);
  return bits.join(", ");
}
