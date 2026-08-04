// Trade history — every trade that ACTUALLY EXECUTED, and what it made or lost.
//
// The other views all answer "what should I do now?". This one answers "what have
// I already done?", which needs a different source of truth. Open positions come
// from the local store, but the store only knows about trades the bot placed, and
// only while it was running: anything filled by hand, anything from before the
// store existed, and anything the bot mis-recorded is invisible to it.
//
// So the BROKER LEDGER is the spine here. `/v2/account/activities` is the one
// record that forgets nothing — every fill, expiration and assignment on the
// account, whoever placed it. We FIFO-match those fills into round trips and
// compute realized P&L from actual fill prices, then *enrich* each round trip
// with the local store's context (thesis levels, exit reason, flow at entry)
// wherever an order id lines up.
//
// Two things this deliberately does NOT do:
//   * attribute fees to individual trades. Alpaca's FEE rows carry no symbol, so
//     any per-trade split would be invented. Fees are reported as one window total.
//   * hide anything. Positions still open appear as open rows with unrealized P&L,
//     and entries that never filled appear in `unfilled` — an attempted trade that
//     didn't fill is history too, just history with no P&L.

import * as alpaca from "./alpaca.js";
import * as vd from "./voldesk_trades.js";

const OCC = /^([A-Z]{1,6})(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/;

// OCC contract symbol -> readable parts. Returns null for plain equities.
export function parseOccSymbol(sym) {
  const m = OCC.exec(String(sym || "").toUpperCase());
  if (!m) return null;
  const [, underlying, yy, mm, dd, cp, strike8] = m;
  return {
    underlying,
    expiry: `20${yy}-${mm}-${dd}`,
    type: cp === "C" ? "call" : "put",
    strike: +strike8 / 1000,
  };
}

const isOption = (sym) => OCC.test(String(sym || "").toUpperCase());
const mult = (sym) => (isOption(sym) ? 100 : 1);
const num = (x) => { const n = parseFloat(x); return Number.isFinite(n) ? n : null; };
const day = (ts) => String(ts || "").slice(0, 10);

// Calendar days between two ISO timestamps (0 for same-session round trips).
function daysBetween(a, b) {
  const d = (Date.parse(b) - Date.parse(a)) / 864e5;
  return Number.isFinite(d) ? Math.max(0, Math.round(d)) : null;
}

// ---- Normalising the ledger ------------------------------------------------
// Everything downstream works on one flat event shape:
//   { symbol, time, dir: +1 buy / -1 sell / 0 expire, qty, price, orderId, kind }
function toEvents(activities) {
  const events = [];
  for (const a of activities) {
    const t = a.activity_type;
    if (t === "FILL") {
      const qty = num(a.qty), price = num(a.price);
      if (!a.symbol || !qty || price == null) continue;
      events.push({
        symbol: a.symbol.toUpperCase(),
        time: a.transaction_time || a.created_at,
        // sell_short is still a sell — it opens rather than closes, which the
        // FIFO pass works out from the lots it already holds.
        dir: a.side === "buy" ? 1 : -1,
        qty, price,
        orderId: a.order_id || null,
        kind: "fill",
      });
    } else if (t === "OPEXP" || t === "OPASN" || t === "OPEXC") {
      // The option leg leaves the account. Worthless expiry settles at 0, which
      // is a 100% loss and absolutely belongs in the history.
      const qty = Math.abs(num(a.qty) ?? 0);
      if (!a.symbol || !qty) continue;
      events.push({
        symbol: a.symbol.toUpperCase(),
        time: a.date ? `${a.date}T20:00:00Z` : a.created_at,
        dir: 0,                                     // closes whatever is held
        qty,
        price: Math.abs(num(a.per_share_amount) ?? num(a.price) ?? 0),
        orderId: null,
        kind: t === "OPEXP" ? "expired" : t === "OPASN" ? "assigned" : "exercised",
      });
    }
  }
  return events.sort((x, y) => String(x.time).localeCompare(String(y.time)));
}

// Same shape, rebuilt from closed orders — the fallback when activities are
// unavailable. Less faithful (no expirations, one row per order) but it keeps
// the tab useful instead of empty.
function ordersToEvents(orders) {
  const events = [];
  for (const o of orders) {
    const qty = num(o.filled_qty), price = num(o.filled_avg_price);
    if (o.status !== "filled" || !qty || price == null) continue;
    events.push({
      symbol: String(o.symbol).toUpperCase(),
      time: o.filled_at || o.submitted_at || o.created_at,
      dir: o.side === "buy" ? 1 : -1,
      qty, price,
      orderId: o.id,
      kind: "fill",
    });
  }
  return events.sort((x, y) => String(x.time).localeCompare(String(y.time)));
}

// ---- FIFO matching ---------------------------------------------------------
// Walk each symbol's events in time order against a queue of open lots. An event
// in the opposite direction to the front lot CLOSES it (oldest first); anything
// left over opens a new lot. Works for longs and shorts, and for a position that
// flips direction inside one fill.
export function matchRoundTrips(events) {
  const bySymbol = new Map();
  for (const e of events) {
    if (!bySymbol.has(e.symbol)) bySymbol.set(e.symbol, []);
    bySymbol.get(e.symbol).push(e);
  }

  const closed = [], open = [];
  for (const [symbol, list] of bySymbol) {
    const lots = [];                     // FIFO: [{ dir, qty, price, time, orderId }]
    for (const e of list) {
      let qty = e.qty;

      // dir 0 (expiry/assignment) closes whatever is there, whichever way it points.
      const closes = (lot) => (e.dir === 0 ? true : lot.dir === -e.dir);
      while (qty > 0 && lots.length && closes(lots[0])) {
        const lot = lots[0];
        const take = Math.min(qty, lot.qty);
        closed.push(buildTrip(symbol, lot, e, take));
        lot.qty -= take;
        qty -= take;
        if (lot.qty <= 1e-9) lots.shift();
      }
      if (qty > 0 && e.dir !== 0) {
        lots.push({ dir: e.dir, qty, price: e.price, time: e.time, orderId: e.orderId });
      }
    }
    for (const lot of lots) {
      open.push({
        symbol, side: lot.dir === 1 ? "long" : "short",
        qty: lot.qty, entryPrice: lot.price, entryTime: lot.time,
        entryOrderId: lot.orderId,
      });
    }
  }
  return { closed, open };
}

function buildTrip(symbol, lot, exit, qty) {
  const m = mult(symbol);
  const side = lot.dir === 1 ? "long" : "short";
  // A short's P&L is the mirror of a long's: sold high, bought back low.
  const pnl = +((exit.price - lot.price) * qty * m * lot.dir).toFixed(2);
  const cost = +(lot.price * qty * m).toFixed(2);
  return {
    symbol, side, qty,
    entryPrice: lot.price, entryTime: lot.time, entryOrderId: lot.orderId,
    exitPrice: exit.price, exitTime: exit.time, exitOrderId: exit.orderId,
    closedBy: exit.kind,                       // fill | expired | assigned | exercised
    cost, pnl,
    pnlPct: cost > 0 ? +((pnl / cost) * 100).toFixed(1) : null,
    holdDays: daysBetween(lot.time, exit.time),
  };
}

// Partial fills of the same order pair are one trade to a human, so collapse
// them — quantity-weighted, so the blended prices stay honest.
function mergePartials(trips) {
  const groups = new Map();
  for (const t of trips) {
    const key = [t.symbol, t.entryOrderId ?? t.entryTime, t.exitOrderId ?? t.exitTime, t.side].join("|");
    const g = groups.get(key);
    if (!g) { groups.set(key, { ...t }); continue; }
    const q = g.qty + t.qty;
    g.entryPrice = +((g.entryPrice * g.qty + t.entryPrice * t.qty) / q).toFixed(4);
    g.exitPrice = +((g.exitPrice * g.qty + t.exitPrice * t.qty) / q).toFixed(4);
    g.qty = q;
    g.cost = +(g.cost + t.cost).toFixed(2);
    g.pnl = +(g.pnl + t.pnl).toFixed(2);
    g.pnlPct = g.cost > 0 ? +((g.pnl / g.cost) * 100).toFixed(1) : null;
    if (String(t.entryTime) < String(g.entryTime)) g.entryTime = t.entryTime;
    if (String(t.exitTime) > String(g.exitTime)) g.exitTime = t.exitTime;
    g.holdDays = daysBetween(g.entryTime, g.exitTime);
  }
  return [...groups.values()];
}

// ---- Local-store context ---------------------------------------------------
// Order ids are the join key: the store records the entry order id, the exit
// order id, and one per scale-out tranche. Anything that lines up gets the WHY
// attached to the broker's WHAT.
function storeIndex(rows) {
  const byOrder = new Map();
  for (const p of rows) {
    if (p.orderId) byOrder.set(p.orderId, p);
    if (p.exitOrderId) byOrder.set(p.exitOrderId, p);
    for (const s of p.scaleOuts || []) if (s.orderId) byOrder.set(s.orderId, p);
  }
  return byOrder;
}

function contextFrom(p) {
  if (!p) return { strategy: "manual", tracked: false };
  return {
    strategy: "voldesk",
    tracked: true,
    positionId: p.id,
    ticker: p.ticker,
    instrument: p.instrument || "option",
    exitReason: p.exitReason || null,
    triggeredBy: p.triggeredBy || null,
    levels: (p.trigger != null || p.t1 != null)
      ? { trigger: p.trigger ?? null, stop: p.stopLevel ?? null, t1: p.t1 ?? null, t2: p.t2 ?? null }
      : null,
    entrySpot: p.entrySpot ?? null,
    flowStance: p.flowAtEntry?.stance ?? null,
    flowScore: p.flowAtEntry?.score ?? null,
    storedPnl: p.realizedPnl ?? null,
    pnlIsEstimate: p.pnlIsEstimate === true,
  };
}

// ---- Summary ---------------------------------------------------------------
export function summarize(trades) {
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl < 0);
  const sum = (arr) => +arr.reduce((a, t) => a + t.pnl, 0).toFixed(2);
  const grossWin = sum(wins), grossLoss = Math.abs(sum(losses));
  const totalCost = +trades.reduce((a, t) => a + (t.cost || 0), 0).toFixed(2);
  return {
    n: trades.length,
    wins: wins.length,
    losses: losses.length,
    scratches: trades.length - wins.length - losses.length,
    winRate: trades.length ? +((wins.length / trades.length) * 100).toFixed(1) : null,
    realizedPnl: sum(trades),
    grossWin, grossLoss,
    avgWin: wins.length ? +(grossWin / wins.length).toFixed(2) : null,
    avgLoss: losses.length ? +(-grossLoss / losses.length).toFixed(2) : null,
    // Infinity is a real answer when nothing has lost yet, but it doesn't survive
    // JSON — null reads as "not meaningful yet", which is the truth.
    profitFactor: grossLoss > 0 ? +(grossWin / grossLoss).toFixed(2) : null,
    expectancy: trades.length ? +(sum(trades) / trades.length).toFixed(2) : null,
    totalCost,
    returnOnCost: totalCost > 0 ? +((sum(trades) / totalCost) * 100).toFixed(1) : null,
    best: trades.length ? trades.reduce((a, t) => (t.pnl > a.pnl ? t : a)) : null,
    worst: trades.length ? trades.reduce((a, t) => (t.pnl < a.pnl ? t : a)) : null,
    avgHoldDays: trades.length
      ? +(trades.reduce((a, t) => a + (t.holdDays || 0), 0) / trades.length).toFixed(1)
      : null,
  };
}

function groupBy(trades, keyFn) {
  const m = new Map();
  for (const t of trades) {
    const k = keyFn(t);
    if (!k) continue;
    const g = m.get(k) || { key: k, n: 0, wins: 0, pnl: 0 };
    g.n++; if (t.pnl > 0) g.wins++; g.pnl = +(g.pnl + t.pnl).toFixed(2);
    m.set(k, g);
  }
  return [...m.values()].map((g) => ({ ...g, winRate: +((g.wins / g.n) * 100).toFixed(0) }));
}

// ---- Calendar breakdown ----------------------------------------------------
// "What did I do on Tuesday, and what did Tuesday make?" are two different
// questions and they group by two different dates: a trade is TAKEN on its entry
// date but its P&L is REALIZED on its exit date. A position opened Monday and
// sold Friday belongs to Monday's activity and Friday's P&L — so each period
// carries both numbers rather than pretending one date fits both.
const MONDAY = (isoDate) => {
  const d = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  const dow = (d.getUTCDay() + 6) % 7;             // Mon = 0
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
};

function periodKey(isoDate, granularity) {
  if (!isoDate) return null;
  if (granularity === "week") return MONDAY(isoDate);
  if (granularity === "month") return isoDate.slice(0, 7);
  return isoDate;                                   // day
}

function periodLabel(key, granularity) {
  if (!key) return "";
  if (granularity !== "week") return key;
  const end = new Date(`${key}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() + 4);             // Mon–Fri is the trading week
  return `${key} → ${end.toISOString().slice(5, 10)}`;
}

export function calendarBreakdown(closed, open, granularity) {
  const rows = new Map();
  const row = (key) => {
    if (!rows.has(key)) {
      rows.set(key, {
        key, label: periodLabel(key, granularity),
        opened: 0, openedCost: 0, stillOpen: 0,
        closed: 0, wins: 0, losses: 0, realizedPnl: 0,
        tickers: [], openedIds: [], closedIds: [],
      });
    }
    return rows.get(key);
  };

  // Entries — every trade taken in the period, whether or not it has closed.
  for (const t of [...closed, ...open]) {
    const k = periodKey(t.entryDate, granularity);
    if (!k) continue;
    const g = row(k);
    g.opened++;
    g.openedCost = +(g.openedCost + (t.cost || 0)).toFixed(2);
    if (t.open) g.stillOpen++;
    if (!g.tickers.includes(t.ticker)) g.tickers.push(t.ticker);
    g.openedIds.push(t.id);
  }

  // Exits — the P&L the period actually banked.
  for (const t of closed) {
    const k = periodKey(t.exitDate, granularity);
    if (!k) continue;
    const g = row(k);
    g.closed++;
    if (t.pnl > 0) g.wins++; else if (t.pnl < 0) g.losses++;
    g.realizedPnl = +(g.realizedPnl + (t.pnl || 0)).toFixed(2);
    if (!g.tickers.includes(t.ticker)) g.tickers.push(t.ticker);
    g.closedIds.push(t.id);
  }

  const out = [...rows.values()].sort((a, b) => b.key.localeCompare(a.key));   // newest first
  // Running total is only meaningful oldest-first, so accumulate then flip back.
  let run = 0;
  for (const g of [...out].reverse()) {
    run = +(run + g.realizedPnl).toFixed(2);
    g.cumulativePnl = run;
    g.winRate = g.closed ? +((g.wins / g.closed) * 100).toFixed(0) : null;
  }
  return out;
}

// ---- Public entry point ----------------------------------------------------
export async function tradeHistory({ days = 365 } = {}) {
  const since = new Date(Date.now() - Math.max(1, days) * 864e5).toISOString();
  const out = { since, source: null, errors: [] };

  // 1. The broker ledger (everything), with closed orders as the fallback.
  let activities = [];
  try {
    activities = await alpaca.getActivities({ after: since });
    out.source = "activities";
  } catch (e) {
    out.errors.push(`activities unavailable (${String(e.message || e).slice(0, 120)}) — falling back to closed orders`);
    activities = [];
    out.source = "orders";
  }

  let events;
  if (out.source === "activities") {
    events = toEvents(activities);
  } else {
    try { events = ordersToEvents(await alpaca.getClosedOrders({ after: since })); }
    catch (e) { events = []; out.errors.push(`closed orders failed: ${String(e.message || e).slice(0, 120)}`); }
  }

  // 2. FIFO the fills into round trips.
  const matched = matchRoundTrips(events);
  const trips = mergePartials(matched.closed);

  // 3. Attach the local store's context, and remember which store rows we used.
  const storeRows = vd.listAll();
  const byOrder = storeIndex(storeRows);
  const usedPositions = new Set();

  const trades = trips.map((t) => {
    const p = byOrder.get(t.exitOrderId) || byOrder.get(t.entryOrderId) || null;
    if (p) usedPositions.add(p.id);
    const occ = parseOccSymbol(t.symbol);
    return {
      ...t,
      id: `${t.symbol}-${t.entryTime}-${t.exitTime}`,
      open: false,
      ticker: occ ? occ.underlying : (p?.ticker || t.symbol),
      assetClass: occ ? "option" : "equity",
      contract: occ,
      entryDate: day(t.entryTime),
      exitDate: day(t.exitTime),
      origin: "broker",
      ...contextFrom(p),
    };
  });

  // 4. Store rows that closed without a matching broker fill. These are real
  //    outcomes (reconcile found the position gone, an exit filled outside the
  //    window) and dropping them would understate the record — but their P&L
  //    came from the store, so they are labelled as such.
  const storeOnly = [];
  for (const p of storeRows) {
    if (p.status !== "CLOSED" || usedPositions.has(p.id)) continue;
    const sym = p.instrument === "shares" ? p.ticker : p.optionSymbol;
    if (!sym || day(p.exitDate) < day(since)) continue;
    const isSh = p.instrument === "shares";
    const qty = isSh ? (p.shares || 0) : (p.contracts || 0);
    const entryPrice = isSh ? p.entryPrice : p.entryPremium;
    const exitPrice = isSh ? p.exitPrice : p.exitPremium;
    const cost = entryPrice != null ? +(entryPrice * qty * (isSh ? 1 : 100)).toFixed(2) : 0;
    const pnl = p.realizedPnl ?? null;
    const occ = parseOccSymbol(sym);
    storeOnly.push({
      id: p.id, symbol: sym, ticker: p.ticker, side: p.side || "long",
      assetClass: isSh ? "equity" : "option", contract: occ,
      qty, entryPrice: entryPrice ?? null, exitPrice: exitPrice ?? null,
      entryTime: p.entryDate, exitTime: p.exitDate,
      entryDate: day(p.entryDate), exitDate: day(p.exitDate),
      entryOrderId: p.orderId || null, exitOrderId: p.exitOrderId || null,
      closedBy: p.exitFilled ? "fill" : "store",
      cost, pnl: pnl ?? 0,
      pnlPct: cost > 0 && pnl != null ? +((pnl / cost) * 100).toFixed(1) : null,
      holdDays: daysBetween(p.entryDate, p.exitDate),
      open: false, origin: "store",
      ...contextFrom(p),
    });
  }
  const allClosed = trades.concat(storeOnly)
    .sort((a, b) => String(b.exitTime).localeCompare(String(a.exitTime)));

  // 5. Lots still open — same row shape, marked open, priced off the broker's
  //    live position so unrealized P&L is current rather than stale.
  let live = [];
  try { live = await alpaca.getPositions(); }
  catch (e) { out.errors.push(`positions unavailable: ${String(e.message || e).slice(0, 120)}`); }
  const liveBySymbol = new Map(live.map((p) => [p.symbol, p]));

  const openTrades = matched.open.map((lot) => {
    const lp = liveBySymbol.get(lot.symbol);
    const p = byOrder.get(lot.entryOrderId) || null;
    const occ = parseOccSymbol(lot.symbol);
    const m = mult(lot.symbol);
    const cur = lp ? num(lp.current_price) : null;
    const dirSign = lot.side === "long" ? 1 : -1;
    const cost = +(lot.entryPrice * lot.qty * m).toFixed(2);
    const pnl = cur != null ? +((cur - lot.entryPrice) * lot.qty * m * dirSign).toFixed(2) : null;
    return {
      id: `${lot.symbol}-${lot.entryTime}-open`,
      symbol: lot.symbol, ticker: occ ? occ.underlying : (p?.ticker || lot.symbol),
      side: lot.side, qty: lot.qty,
      assetClass: occ ? "option" : "equity", contract: occ,
      entryPrice: lot.entryPrice, entryTime: lot.entryTime, entryDate: day(lot.entryTime),
      entryOrderId: lot.entryOrderId,
      exitPrice: null, exitTime: null, exitDate: null, exitOrderId: null,
      closedBy: null, cost, pnl,
      pnlPct: cost > 0 && pnl != null ? +((pnl / cost) * 100).toFixed(1) : null,
      currentPrice: cur,
      holdDays: daysBetween(lot.entryTime, new Date().toISOString()),
      open: true, origin: "broker",
      ...contextFrom(p),
    };
  }).sort((a, b) => String(b.entryTime).localeCompare(String(a.entryTime)));

  // 6. Entries that never filled. No P&L, but they're part of the record —
  //    a run of these is the difference between "the strategy lost" and "the
  //    strategy never got on".
  const unfilled = storeRows
    .filter((p) => p.status === "CANCELED" && day(p.entryDate) >= day(since))
    .map((p) => ({
      id: p.id, ticker: p.ticker,
      symbol: p.instrument === "shares" ? p.ticker : p.optionSymbol,
      date: day(p.entryDate), reason: p.exitReason || "entry never filled",
      quotedPrice: p.entryPremium ?? p.entryPrice ?? null,
      contracts: p.contracts ?? p.shares ?? null,
    }))
    .sort((a, b) => b.date.localeCompare(a.date));

  // 7. Fees for the window. Not split per trade — Alpaca's FEE rows carry no
  //    symbol, so any attribution would be fabricated.
  const feeRows = activities.filter((a) => a.activity_type === "FEE");
  const fees = +feeRows.reduce((a, f) => a + Math.abs(num(f.net_amount) || 0), 0).toFixed(2);

  // 8. Cumulative realized curve, oldest -> newest.
  // One point per DAY, holding that day's closing cumulative. Several exits can
  // land on the same date, and the chart keys on the date — so emitting a point
  // per trade would silently plot the day's first running total and drop the rest.
  const chron = [...allClosed].sort((a, b) => String(a.exitTime).localeCompare(String(b.exitTime)));
  let run = 0;
  const curveByDate = new Map();
  for (const t of chron) {
    run = +(run + t.pnl).toFixed(2);
    if (t.exitDate) curveByDate.set(t.exitDate, run);
  }
  const equityCurve = [...curveByDate].map(([date, value]) => ({ date, value }));

  return {
    ...out,
    trades: allClosed,
    openTrades,
    unfilled,
    summary: summarize(allClosed),
    unrealizedPnl: +openTrades.reduce((a, t) => a + (t.pnl || 0), 0).toFixed(2),
    openCost: +openTrades.reduce((a, t) => a + (t.cost || 0), 0).toFixed(2),
    fees,
    equityCurve,
    bySymbol: groupBy(allClosed, (t) => t.ticker).sort((a, b) => b.pnl - a.pnl),
    byDay: calendarBreakdown(allClosed, openTrades, "day"),
    byWeek: calendarBreakdown(allClosed, openTrades, "week"),
    byMonth: calendarBreakdown(allClosed, openTrades, "month"),
    counts: { fills: events.length, activities: activities.length },
  };
}
