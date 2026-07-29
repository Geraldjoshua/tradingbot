// Vol Desk Phase 2 — entry + position management on the Alpaca paper account.
//
// Entry:  checks the "first 5-min close above pTrans" trigger, picks a ~21-DTE
//         ATM call, sizes it to a premium budget, places the paper order, and
//         records the position with its levels (pTrans / nTrans / T1 / T2).
// Manage: evaluates each open position against the Stop 1-4 / T1 framework and
//         returns the recommended action. Exiting is one click (market sell).
//
// Everything is paper-only. Positions persist to data/voldesk_trades.json.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import * as alpaca from "./alpaca.js";
import * as flow from "./flow.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STORE = path.join(ROOT, "data", "voldesk_trades.json");
const SNAP_DIR = path.join(ROOT, "data", "voldesk");

const iso = (d) => d.toISOString().slice(0, 10);

const fmtET = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", hour12: false,
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
});
function etParts(tsIso) {
  const p = Object.fromEntries(fmtET.formatToParts(new Date(tsIso)).map((o) => [o.type, o.value]));
  let h = parseInt(p.hour, 10); if (h === 24) h = 0;
  return { date: `${p.year}-${p.month}-${p.day}`, hm: h * 60 + parseInt(p.minute, 10) };
}

function load() { try { return JSON.parse(fs.readFileSync(STORE)); } catch { return []; } }
function persist(rows) {
  fs.mkdirSync(path.dirname(STORE), { recursive: true });
  fs.writeFileSync(STORE, JSON.stringify(rows, null, 2));
}

export function latestSnapshot(ticker) {
  const dir = path.join(SNAP_DIR, ticker.toUpperCase());
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  if (!files.length) return null;
  return JSON.parse(fs.readFileSync(path.join(dir, files[files.length - 1])));
}

// Close of the first regular-hours 5-min bar today (09:30-09:35 ET), or null.
async function firstFiveMinClose(ticker) {
  const start = new Date(Date.now() - 2 * 864e5).toISOString();
  const end = new Date().toISOString();
  let bars;
  try { bars = await alpaca.getBars(ticker, "5Min", start, end); } catch { return null; }
  const todayET = etParts(new Date().toISOString()).date;
  for (const b of bars) {
    const { date, hm } = etParts(b.t);
    if (date === todayET && hm === 570) return b.c; // 570 = 09:30
  }
  return null;
}

// Pick a call by DTE target + moneyness and return its symbol + quote.
//   dteTarget  — days to expiration to aim for (default 45 = "longer DTE")
//   moneyness  — "ITM" (strike ~5% below spot, default), "ATM", or "OTM"
async function selectCall(ticker, spot, { dteTarget = 45, moneyness = "ITM" } = {}) {
  const lo = Math.max(7, dteTarget - 20), hi = dteTarget + 30;
  const expGte = iso(new Date(Date.now() + lo * 864e5));
  const expLte = iso(new Date(Date.now() + hi * 864e5));
  const band = spot * 0.15; // wide enough to include ITM and OTM strikes
  const contracts = await alpaca.getOptionContracts({
    underlying: ticker, type: "call", expGte, expLte,
    strikeGte: spot - band, strikeLte: spot + band, limit: 600,
  });
  if (!contracts.length) throw new Error(`no call contracts in ${lo}-${hi} DTE window`);
  const dte = (e) => (Date.parse(e + "T20:00:00Z") - Date.now()) / 864e5;
  const exps = [...new Set(contracts.map((c) => c.expiration_date))];
  const exp = exps.sort((a, b) => Math.abs(dte(a) - dteTarget) - Math.abs(dte(b) - dteTarget))[0];

  // For calls: ITM = strike below spot, OTM = above spot. Target ~5% in/out.
  const targetStrike = moneyness === "ITM" ? spot * 0.95 : moneyness === "OTM" ? spot * 1.05 : spot;
  let pool = contracts.filter((c) => c.expiration_date === exp);
  if (moneyness === "ITM") { const s = pool.filter((c) => +c.strike_price < spot); if (s.length) pool = s; }
  else if (moneyness === "OTM") { const s = pool.filter((c) => +c.strike_price > spot); if (s.length) pool = s; }
  const pick = pool.sort((a, b) => Math.abs(+a.strike_price - targetStrike) - Math.abs(+b.strike_price - targetStrike))[0];

  const q = (await alpaca.getOptionQuotes([pick.symbol]))[pick.symbol]?.latestQuote;
  const mid = q ? +(((q.bp + q.ap) / 2) || 0).toFixed(2) : null;
  return {
    symbol: pick.symbol, strike: +pick.strike_price, expiry: exp, dte: Math.round(dte(exp)),
    moneyness, bid: q?.bp ?? null, ask: q?.ap ?? null, mid,
  };
}

// ---- Entry ---------------------------------------------------------------
// flowDecision (optional) lets a caller (the auto-trader) pass a conviction it
// already fetched so we don't hit the flow sources twice. If absent we compute it.
export async function enterTrade({ ticker, riskPremium = 300, force = false, confirm = false, dteTarget = 45, moneyness = "ITM", flowDecision = null, ignoreFlow = false }) {
  ticker = ticker.toUpperCase();
  const snap = latestSnapshot(ticker);
  if (!snap) throw new Error(`no snapshot for ${ticker} — run a Vol Desk scan first`);

  const spot = await alpaca.getLatestTrade(ticker, "delayed_sip");
  const fmc = await firstFiveMinClose(ticker);
  const triggered = fmc != null && fmc > snap.levels.pTrans;

  // --- Flow conviction (does the options flow cement a LONG here?) ----------
  const cfg = flow.loadConfig();
  let conviction = flowDecision?.conviction || null;
  let decision = flowDecision?.decision || null;
  if (!ignoreFlow && !decision) {
    conviction = await flow.getConviction(ticker, cfg);
    decision = flow.decideForTrade(conviction, cfg, "long");
  }
  const flowMult = ignoreFlow ? 1.0 : (decision ? decision.sizeMultiplier : 1.0);
  const flowBlock = ignoreFlow ? false : (decision ? decision.block : false);

  // Flow scales the premium budget: agree -> full, disagree -> small (size mode),
  // or blocks entirely (gate mode).
  const effectiveBudget = Math.max(0, Math.round(riskPremium * flowMult));

  // Always price the exact contract first so the caller can see it.
  const call = await selectCall(ticker, spot, { dteTarget, moneyness });
  const prem = call.mid || call.ask;
  if (!prem) throw new Error("no option quote available to size the trade");
  const budgetForSizing = effectiveBudget > 0 ? effectiveBudget : riskPremium;
  const contracts = Math.max(1, Math.floor(budgetForSizing / (prem * 100)));
  const cost = +(prem * contracts * 100).toFixed(2);

  const triggerNote = triggered
    ? "Trigger met (first 5-min close above pTrans)."
    : fmc == null
      ? "No 09:30 5-min bar yet (market closed / pre-open) — placement needs Force or the open."
      : `First 5-min close ${fmc} is not above pTrans ${snap.levels.pTrans}.`;

  const flowSummary = decision ? {
    stance: decision.stance, mode: decision.mode, block: decision.block,
    sizeMultiplier: decision.sizeMultiplier, direction: decision.flowDirection,
    score: decision.flowScore, conviction,
  } : { stance: "disabled", mode: "off", block: false, sizeMultiplier: 1.0 };

  // STEP 1 — preview only: show exactly what would be bought, place nothing.
  if (!confirm) {
    return {
      status: "PREVIEW",
      ticker, spot: +spot.toFixed(2),
      triggered, firstFiveMinClose: fmc, triggerNote,
      contract: {
        symbol: call.symbol, strike: call.strike, expiry: call.expiry, dte: call.dte,
        moneyness: call.moneyness, bid: call.bid, ask: call.ask, mid: call.mid,
      },
      premium: prem, contracts, cost,
      budget: riskPremium, effectiveBudget, overBudget: cost > budgetForSizing,
      flow: flowSummary,
      flowBlocked: flowBlock,
      levels: { pTrans: snap.levels.pTrans, nTrans: snap.levels.nTrans, t1: snap.levels.plusGEX_T1, t2: snap.levels.T2 },
    };
  }

  // STEP 2 — confirmed: flow gate first, then the price trigger.
  if (flowBlock) {
    return { status: "FLOW_BLOCKED", ticker, spot, flow: flowSummary,
      note: `Flow gate (${decision.mode}): flow ${decision.flowDirection} does not confirm a long — trade blocked.` };
  }
  if (!triggered && !force) {
    return { status: "NOT_TRIGGERED", ticker, spot, firstFiveMinClose: fmc, pTrans: snap.levels.pTrans, note: triggerNote };
  }

  // Marketable LIMIT (a hair through the ask): fills like a market order during
  // RTH, but — unlike an options market order — is accepted/queued off-hours too.
  const limitPrice = +(((call.ask || prem) * 1.02) || 0.05).toFixed(2);
  const order = await alpaca.placeOrder({
    symbol: call.symbol, qty: contracts, side: "buy", type: "limit",
    limit_price: limitPrice, time_in_force: "day",
  });

  const pos = {
    id: `${ticker}-${Date.now()}`,
    ticker,
    optionSymbol: call.symbol,
    strike: call.strike, expiry: call.expiry, dte: call.dte, moneyness: call.moneyness,
    contracts, entryPremium: prem,
    entryDate: iso(new Date()), entrySpot: +spot.toFixed(2),
    pTrans: snap.levels.pTrans, nTrans: snap.levels.nTrans,
    t1: snap.levels.plusGEX_T1, t2: snap.levels.T2,
    lockedToBreakeven: false,
    status: "OPEN", orderId: order.id,
    triggeredBy: triggered ? "5min-close" : "forced",
    entryBudget: riskPremium, effectiveBudget, flowMult,
    flowAtEntry: flowSummary,
  };
  const rows = load(); rows.push(pos); persist(rows);
  return { status: "ENTERED", position: pos, order, flow: flowSummary };
}

// ---- Management ----------------------------------------------------------
function tradingDaysBetween(fromIso, toIso) {
  let d = new Date(fromIso), end = new Date(toIso), n = 0;
  while (d < end) { d = new Date(d.getTime() + 864e5); const wd = d.getUTCDay(); if (wd !== 0 && wd !== 6) n++; }
  return n;
}

export async function evaluatePositions() {
  const rows = load();
  const open = rows.filter((p) => p.status === "OPEN");
  const out = [];
  for (const p of open) {
    let spot = null, optMid = null;
    try { spot = await alpaca.getLatestTrade(p.ticker, "delayed_sip"); } catch {}
    try {
      const q = (await alpaca.getOptionQuotes([p.optionSymbol]))[p.optionSymbol]?.latestQuote;
      if (q) optMid = +(((q.bp + q.ap) / 2) || 0).toFixed(2);
    } catch {}

    const daysHeld = tradingDaysBetween(p.entryDate, iso(new Date()));
    const progress = p.t1 > p.entrySpot ? Math.max(0, Math.min(1, (spot - p.entrySpot) / (p.t1 - p.entrySpot))) : 0;
    const optPnl = optMid != null ? +(((optMid - p.entryPremium) * p.contracts * 100)).toFixed(0) : null;

    let action = "HOLD", reason = "", urgent = false;
    if (spot != null) {
      if (spot < p.nTrans) { action = "EXIT"; reason = `Stop 1: spot ${spot.toFixed(2)} below nTrans ${p.nTrans}`; urgent = true; }
      else if (spot <= p.entrySpot * 0.9 && spot < p.pTrans) { action = "EXIT"; reason = `Stop 2: -10% from entry and below pTrans`; urgent = true; }
      else if (daysHeld >= 7 && progress < 0.5) { action = "EXIT"; reason = `Stop 3: day ${daysHeld}, only ${(progress * 100).toFixed(0)}% to T1`; urgent = true; }
      else if (spot >= p.t1) { action = "T1_HIT"; reason = `T1 reached (${p.t1}) — take profit, or lock stop to entry and ride to T2 ${p.t2}`; }
      else if (spot < p.pTrans) { action = "WATCH"; reason = `below pTrans ${p.pTrans} but above nTrans — hold, add nothing`; }
      else { action = "HOLD"; reason = `above pTrans, ${(progress * 100).toFixed(0)}% to T1`; }
    } else { reason = "no current price"; }

    out.push({ ...p, currentSpot: spot != null ? +spot.toFixed(2) : null, optMid, optPnl, daysHeld, progressPct: +(progress * 100).toFixed(0), action, reason, urgent });
  }
  return out;
}

export function listAll() { return load(); }

// ---- Exit ----------------------------------------------------------------
export async function exitTrade({ id, reason = "manual" }) {
  const rows = load();
  const p = rows.find((x) => x.id === id && x.status === "OPEN");
  if (!p) throw new Error("open position not found");

  // If the entry order never filled (e.g. placed off-hours), there's nothing to
  // sell — cancel the open entry order instead of tripping a wash-trade block.
  let held = null;
  try { held = (await alpaca.getPositions()).find((x) => x.symbol === p.optionSymbol); } catch {}
  if (!held) {
    try { await alpaca.cancelOrder(p.orderId); } catch {}
    p.status = "CANCELED"; p.exitReason = `${reason} (entry unfilled — order canceled)`;
    p.exitDate = iso(new Date());
    persist(rows);
    return { status: "CANCELED", position: p };
  }

  let bid = null, optMid = null;
  try {
    const q = (await alpaca.getOptionQuotes([p.optionSymbol]))[p.optionSymbol]?.latestQuote;
    if (q) { bid = q.bp; optMid = +(((q.bp + q.ap) / 2) || 0).toFixed(2); }
  } catch {}
  // Marketable limit a hair below the bid to sell out cleanly (accepted off-hours too).
  const limitPrice = +(((bid || p.entryPremium || 0.05) * 0.98) || 0.01).toFixed(2);
  const order = await alpaca.placeOrder({
    symbol: p.optionSymbol, qty: p.contracts, side: "sell", type: "limit",
    limit_price: limitPrice, time_in_force: "day",
  });
  p.status = "CLOSED"; p.exitReason = reason; p.exitDate = iso(new Date()); p.exitPremium = optMid; p.exitOrderId = order.id;
  persist(rows);
  return { status: "CLOSED", position: p, order };
}

// Lock stop to breakeven after T1 (records intent; the stop is enforced by evaluate/user).
export function lockToBreakeven({ id }) {
  const rows = load();
  const p = rows.find((x) => x.id === id && x.status === "OPEN");
  if (!p) throw new Error("open position not found");
  p.lockedToBreakeven = true; p.nTrans = Math.max(p.nTrans, p.entrySpot);
  persist(rows);
  return p;
}
