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
import * as contractSelect from "./contract_select.js";
import * as playbook from "./playbook.js";
import * as shares from "./shares.js";
import * as execution from "./execution.js";
import * as working from "./working_orders.js";

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

// Compact flow record stamped onto positions and returned to callers.
function flowSummary0(decision, conviction) {
  return decision ? {
    stance: decision.stance, mode: decision.mode, block: decision.block,
    sizeMultiplier: decision.sizeMultiplier, direction: decision.flowDirection,
    score: decision.flowScore, conviction,
  } : { stance: "disabled", mode: "off", block: false, sizeMultiplier: 1.0 };
}

// Pick a put by DTE + moneyness (mirror of selectCall, used as the bearish fallback).
async function selectPut(ticker, spot, { dteTarget = 45, moneyness = "ITM" } = {}) {
  const lo = Math.max(7, dteTarget - 20), hi = dteTarget + 30;
  const expGte = iso(new Date(Date.now() + lo * 864e5));
  const expLte = iso(new Date(Date.now() + hi * 864e5));
  const band = spot * 0.15;
  const contracts = await alpaca.getOptionContracts({
    underlying: ticker, type: "put", expGte, expLte,
    strikeGte: spot - band, strikeLte: spot + band, limit: 600,
  });
  if (!contracts.length) throw new Error(`no put contracts in ${lo}-${hi} DTE window`);
  const dte = (e) => (Date.parse(e + "T20:00:00Z") - Date.now()) / 864e5;
  const exps = [...new Set(contracts.map((c) => c.expiration_date))];
  const exp = exps.sort((a, b) => Math.abs(dte(a) - dteTarget) - Math.abs(dte(b) - dteTarget))[0];
  // For PUTS the moneyness signs invert: ITM = strike ABOVE spot.
  const targetStrike = moneyness === "ITM" ? spot * 1.05 : moneyness === "OTM" ? spot * 0.95 : spot;
  let pool = contracts.filter((c) => c.expiration_date === exp);
  if (moneyness === "ITM") { const s = pool.filter((c) => +c.strike_price > spot); if (s.length) pool = s; }
  else if (moneyness === "OTM") { const s = pool.filter((c) => +c.strike_price < spot); if (s.length) pool = s; }
  const pick = pool.sort((a, b) => Math.abs(+a.strike_price - targetStrike) - Math.abs(+b.strike_price - targetStrike))[0];
  const q = (await alpaca.getOptionQuotes([pick.symbol]))[pick.symbol]?.latestQuote;
  const mid = q ? +(((q.bp + q.ap) / 2) || 0).toFixed(2) : null;
  return { symbol: pick.symbol, strike: +pick.strike_price, expiry: exp, dte: Math.round(dte(exp)),
    moneyness, bid: q?.bp ?? null, ask: q?.ap ?? null, mid };
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
export async function enterTrade({ ticker, riskPremium = 300, force = false, confirm = false, dteTarget = 45, moneyness = "ITM", flowDecision = null, ignoreFlow = false, side = "long", ignoreSetup = false }) {
  ticker = ticker.toUpperCase();
  const snap = latestSnapshot(ticker);
  if (!snap) throw new Error(`no snapshot for ${ticker} — run a Vol Desk scan first`);

  const spot = await alpaca.getLatestTrade(ticker, "delayed_sip");
  const fmc = await firstFiveMinClose(ticker);

  // Side-specific levels + trigger (long: reclaim pTrans; short: lose nTrans).
  const lv = playbook.levelsFor(snap, side);
  if (!lv) throw new Error(`snapshot for ${ticker} lacks usable levels`);
  const triggered = playbook.triggerMet(fmc, lv);

  // --- SETUP QUALITY GATE ---------------------------------------------------
  // This check was missing, and the omission was serious: entry gated ONLY on the
  // flow decision and the price trigger, never on the Vol Desk verdict. Discovery
  // candidates had to reach CONFIRMED to be offered at all, but anything placed on
  // the manual watchlist went straight to the buy path — so the bot would happily
  // buy a setup its own engine had graded BLOCKED (failing grade, R/R, db_change).
  // Two sources of trades, two completely different standards.
  //
  // Now every entry is held to the same bar. Opt out per-call with ignoreSetup, or
  // globally with entry.requireTag = [] if you really want the old behaviour.
  const cfg = flow.loadConfig();
  const requireTags = force ? [] : (cfg.entry?.requireTag ?? ["CONFIRMED"]);
  const minGrade = cfg.entry?.minGrade ?? 0;
  if (!ignoreSetup && requireTags.length) {
    const tagOK = requireTags.includes(snap.tag);
    const gradeOK = (snap.grade ?? 0) >= minGrade;
    if (!tagOK || !gradeOK) {
      return {
        status: "NOT_CONFIRMED", ticker, side,
        tag: snap.tag ?? null, grade: snap.grade ?? null,
        requiredTags: requireTags, minGrade,
        blockers: snap.filter_reasons || [],
        note: `Vol Desk graded this ${snap.tag ?? "ungraded"}`
          + (snap.grade != null ? ` (grade ${snap.grade}/11)` : "")
          + (snap.filter_reasons?.length ? ` — failing: ${snap.filter_reasons.join(", ")}` : "")
          + ". Not entering. Use Force/ignoreSetup to override, or loosen entry.requireTag.",
      };
    }
  }
  let conviction = flowDecision?.conviction || null;
  let decision = flowDecision?.decision || null;
  if (!ignoreFlow && !decision) {
    conviction = await flow.getConviction(ticker, cfg);
    decision = flow.decideForTrade(conviction, cfg, side);
  }
  const flowMult = ignoreFlow ? 1.0 : (decision ? decision.sizeMultiplier : 1.0);
  const flowBlock = ignoreFlow ? false : (decision ? decision.block : false);

  // Flow scales the premium budget: agree -> full, disagree -> small (size mode),
  // or blocks entirely (gate mode).
  const effectiveBudget = Math.max(0, Math.round(riskPremium * flowMult));

  // ---- Contract selection -------------------------------------------------
  // Default: score a grid of strikes x expiries on true reward:risk against the
  // Vol Desk target (T1) and stop (nTrans), charging the bid/ask spread and
  // theta. Falls back to the simple DTE/moneyness pick if R/R finds nothing
  // acceptable (or if contractSelection.mode is "legacy").
  const csMode = (cfg.contractSelection?.mode) || "rr";
  const optType = lv.optionType;                       // "call" for long, "put" for short
  let call = null, rrPick = null;
  if (csMode === "rr") {
    try {
      rrPick = await contractSelect.selectByRiskReward(
        ticker, spot, { target: lv.t1, stop: lv.stop }, cfg, optType
      );
      if (rrPick.best) {
        call = {
          symbol: rrPick.best.symbol, strike: rrPick.best.strike, expiry: rrPick.best.expiry,
          dte: rrPick.best.dte,
          moneyness: optType === "call"
            ? (rrPick.best.strike < spot ? "ITM" : "OTM")
            : (rrPick.best.strike > spot ? "ITM" : "OTM"),
          bid: rrPick.best.bid, ask: rrPick.best.ask, mid: rrPick.best.mid,
        };
      }
    } catch (e) {
      rrPick = { best: null, note: `R/R selection failed: ${String(e.message || e)}` };
    }
  }
  // Simple picker as the second choice.
  if (!call) {
    try {
      call = optType === "put"
        ? await selectPut(ticker, spot, { dteTarget, moneyness })
        : await selectCall(ticker, spot, { dteTarget, moneyness });
    } catch (e) {
      rrPick = rrPick || {};
      rrPick.note = `${rrPick.note ? rrPick.note + "; " : ""}fallback picker failed: ${String(e.message || e)}`;
    }
  }

  // ---- SHARE FALLBACK ----------------------------------------------------
  // No usable contract (no chain, no quotes, nothing clears R/R). Express the
  // same thesis in stock, sized off the distance to the stop.
  const shareCfg = { ...shares.DEFAULTS, ...(cfg.shares || {}) };
  const noOption = !call || !(call.mid || call.ask);
  if (noOption) {
    if (!shareCfg.enabled) throw new Error(`no usable ${optType} contract and share fallback disabled`);
    if (!confirm) {
      const bp = await alpaca.getAccount().then((a) => parseFloat(a.buying_power) || 0).catch(() => 0);
      const sized = shares.size(spot, lv.stop, riskPremium * flowMult, bp, cfg);
      return {
        status: "PREVIEW", instrument: "shares", ticker, side, spot: +spot.toFixed(2),
        triggered, firstFiveMinClose: fmc,
        triggerNote: `${side} trigger: ${lv.triggerDir} ${lv.trigger}`,
        levels: lv, shares: sized,
        flow: decision ? { stance: decision.stance, sizeMultiplier: decision.sizeMultiplier } : null,
        note: `no usable ${optType} contract — would trade shares instead`,
        selection: { mode: csMode, note: rrPick?.note || null, usedFallback: true },
      };
    }
    if (flowBlock) return { status: "FLOW_BLOCKED", ticker, side, flow: flowSummary0(decision, conviction) };
    if (!triggered && !force) {
      return { status: "NOT_TRIGGERED", ticker, side, spot, firstFiveMinClose: fmc,
        trigger: lv.trigger, note: `needs 5-min close ${lv.triggerDir} ${lv.trigger}` };
    }
    const res = await shares.enter({ ticker, side, spot, stop: lv.stop, riskBudget: riskPremium * flowMult, cfg });
    const sf = await alpaca.waitForFill(res.order.id).catch(() => ({ filled: false, price: null }));
    const shareEntry = sf.filled && sf.price ? sf.price : +spot.toFixed(2);
    const pos = {
      id: `${ticker}-${Date.now()}`, ticker, side, instrument: "shares",
      shares: res.sized.shares, entryPrice: shareEntry,
      entryQuotedPrice: +spot.toFixed(2), entryFilled: Boolean(sf.filled),
      entryDate: iso(new Date()), entrySpot: +spot.toFixed(2),
      pTrans: snap.levels.pTrans, nTrans: snap.levels.nTrans,
      trigger: lv.trigger, stopLevel: lv.stop, t1: lv.t1, t2: lv.t2,
      lockedToBreakeven: false, status: "OPEN", orderId: res.order.id,
      triggeredBy: triggered ? "5min-close" : "forced",
      entryBudget: riskPremium, flowMult, flowAtEntry: flowSummary0(decision, conviction),
      riskAtStop: res.sized.riskAtStop,
    };
    const rows0 = load(); rows0.push(pos); persist(rows0);
    return { status: "ENTERED", instrument: "shares", position: pos, order: res.order };
  }

  const prem = call.mid || call.ask;
  if (!prem) throw new Error("no option quote available to size the trade");
  const budgetForSizing = effectiveBudget > 0 ? effectiveBudget : riskPremium;
  const contracts = Math.max(1, Math.floor(budgetForSizing / (prem * 100)));
  const cost = +(prem * contracts * 100).toFixed(2);

  const triggerNote = triggered
    ? `Trigger met (first 5-min close ${lv.triggerDir} ${lv.trigger}).`
    : fmc == null
      ? "No 09:30 5-min bar yet (market closed / pre-open) — placement needs Force or the open."
      : `First 5-min close ${fmc} is not ${lv.triggerDir} ${lv.trigger}.`;

  const flowSummary = flowSummary0(decision, conviction);

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
      selection: rrPick ? {
        mode: csMode, note: rrPick.note, evaluated: rrPick.evaluated ?? 0,
        best: rrPick.best, alternatives: rrPick.alternatives || [],
        rejected: rrPick.rejected || [],
        usedFallback: !rrPick.best,
      } : { mode: "legacy" },
      side, instrument: "option",
      levels: { ...lv, pTrans: snap.levels.pTrans, nTrans: snap.levels.nTrans },
    };
  }

  // STEP 2 — confirmed: flow gate first, then the price trigger.
  if (flowBlock) {
    return { status: "FLOW_BLOCKED", ticker, side, spot, flow: flowSummary,
      note: `Flow gate (${decision.mode}): flow ${decision.flowDirection} does not confirm a ${side} — trade blocked.` };
  }
  if (!triggered && !force) {
    return { status: "NOT_TRIGGERED", ticker, side, spot, firstFiveMinClose: fmc, trigger: lv.trigger, note: triggerNote };
  }

  // Start a PATIENT limit ladder and return immediately. The trader loop advances
  // it each tick (see working_orders.js) so a multi-minute dwell never blocks
  // stop-loss management. The position is created only when it actually fills.
  if (working.activeFor(ticker)) {
    return { status: "ALREADY_WORKING", ticker, side, note: `an order is already working for ${ticker}` };
  }
  const started = await working.start({
    ticker, symbol: call.symbol, qty: contracts, side: "buy", isOption: true, kind: "entry",
    intent: {
      ticker, side, optionType: optType,
      contract: {
        symbol: call.symbol, strike: call.strike, expiry: call.expiry,
        dte: call.dte, moneyness: call.moneyness,
      },
      contracts, quotedMid: prem,
      levels: { trigger: lv.trigger, stop: lv.stop, t1: lv.t1, t2: lv.t2 },
      snapLevels: { pTrans: snap.levels.pTrans, nTrans: snap.levels.nTrans },
      entryBudget: riskPremium, effectiveBudget, flowMult,
      flowAtEntry: flowSummary,
      triggeredBy: triggered ? "5min-close" : "forced",
      selection: rrPick?.best ? {
        mode: "rr", rr: rrPick.best.rr, delta: rrPick.best.delta, iv: rrPick.best.iv,
        breakeven: rrPick.best.breakeven, spreadPct: rrPick.best.spreadPct,
      } : { mode: "legacy" },
    },
  }, cfg);
  if (!started.started) {
    return { status: "NOT_FILLED", ticker, side, note: `could not start ladder: ${started.reason}` };
  }
  return {
    status: "WORKING", ticker, side,
    contract: { symbol: call.symbol, strike: call.strike, expiry: call.expiry },
    contracts, firstRungPrice: started.price,
    note: `patient ladder started at ${started.price} — repriced each tick, position opens on fill`,
  };

  // The ladder already confirmed the fill and its price — that IS the truth.
  const fill = { filled: true, price: exec.price };
  const entryPrice = exec.price;

  const pos = {
    id: `${ticker}-${Date.now()}`,
    ticker, side, instrument: "option", optionType: optType,
    optionSymbol: call.symbol,
    strike: call.strike, expiry: call.expiry, dte: call.dte, moneyness: call.moneyness,
    contracts,
    entryPremium: entryPrice,
    entryQuotedMid: exec.mid ?? prem,      // book mid at the time we worked the order
    entryFilled: true,
    entrySlippage: exec.vsMid,             // + = paid above mid
    entrySavedVsCross: exec.vsCross,       // + = better than crossing the spread
    entryRung: `${exec.rung}/${exec.of}`,  // which ladder step filled
    entryDate: iso(new Date()), entrySpot: +spot.toFixed(2),
    pTrans: snap.levels.pTrans, nTrans: snap.levels.nTrans,
    trigger: lv.trigger, stopLevel: lv.stop,
    t1: lv.t1, t2: lv.t2,
    lockedToBreakeven: false,
    status: "OPEN", orderId: order.id,
    triggeredBy: triggered ? "5min-close" : "forced",
    entryBudget: riskPremium, effectiveBudget, flowMult,
    flowAtEntry: flowSummary,
    selection: rrPick?.best ? {
      mode: "rr", rr: rrPick.best.rr, delta: rrPick.best.delta, iv: rrPick.best.iv,
      breakeven: rrPick.best.breakeven, spreadPct: rrPick.best.spreadPct,
      valueAtTarget: rrPick.best.valueAtTarget, valueAtStop: rrPick.best.valueAtStop,
    } : { mode: "legacy" },
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
    const side = p.side || "long";
    const isShares = p.instrument === "shares";
    // Backfill for positions opened before side/level fields existed.
    const stopLevel = p.stopLevel ?? (side === "short" ? p.pTrans : p.nTrans);
    const trigger = p.trigger ?? (side === "short" ? p.nTrans : p.pTrans);

    let spot = null, optMid = null;
    try { spot = await alpaca.getLatestTrade(p.ticker, "delayed_sip"); } catch {}
    if (!isShares) {
      try {
        const q = (await alpaca.getOptionQuotes([p.optionSymbol]))[p.optionSymbol]?.latestQuote;
        if (q) optMid = +(((q.bp + q.ap) / 2) || 0).toFixed(2);
      } catch {}
    }

    const daysHeld = tradingDaysBetween(p.entryDate, iso(new Date()));
    const progress = playbook.progressToTarget(side, spot, p.entrySpot, p.t1);
    // Long options and short options are both LONG PREMIUM, so P&L is the same
    // formula either way. Shares invert with side.
    const optPnl = isShares
      ? (spot != null ? +(((side === "short" ? p.entryPrice - spot : spot - p.entryPrice) * p.shares)).toFixed(0) : null)
      : (optMid != null ? +(((optMid - p.entryPremium) * p.contracts * 100)).toFixed(0) : null);

    // Adverse/favourable are direction-aware: for a short, "spot above stop" is
    // the stop-out and "spot at/below t1" is the target.
    const adverse = (lvl) => playbook.adverse(side, spot, lvl);
    const favourable = (lvl) => playbook.favourable(side, spot, lvl);
    const drawdownHit = side === "short" ? spot >= p.entrySpot * 1.1 : spot <= p.entrySpot * 0.9;

    let action = "HOLD", reason = "", urgent = false;
    if (spot != null) {
      if (adverse(stopLevel)) {
        action = "EXIT"; urgent = true;
        reason = `Stop 1: spot ${spot.toFixed(2)} ${side === "short" ? "above" : "below"} stop ${stopLevel}`;
      } else if (drawdownHit && adverse(trigger)) {
        action = "EXIT"; urgent = true;
        reason = `Stop 2: 10% adverse from entry and back ${side === "short" ? "above" : "below"} trigger`;
      } else if (daysHeld >= 7 && progress < 0.5) {
        action = "EXIT"; urgent = true;
        reason = `Stop 3: day ${daysHeld}, only ${(progress * 100).toFixed(0)}% to T1`;
      } else if (p.t1 != null && favourable(p.t1)) {
        action = "T1_HIT";
        reason = `T1 reached (${p.t1}) — take profit, or lock stop to entry and ride to T2 ${p.t2}`;
      } else if (adverse(trigger)) {
        action = "WATCH";
        reason = `back ${side === "short" ? "above" : "below"} trigger ${trigger} but stop intact — hold, add nothing`;
      } else {
        action = "HOLD";
        reason = `${side} intact, ${(progress * 100).toFixed(0)}% to T1`;
      }
    } else { reason = "no current price"; }

    out.push({ ...p, side, instrument: p.instrument || "option",
      currentSpot: spot != null ? +spot.toFixed(2) : null, optMid, optPnl, daysHeld,
      progressPct: +(progress * 100).toFixed(0), action, reason, urgent });
  }
  return out;
}

// Called by working_orders.js when a patient entry ladder finally fills. The
// position is created HERE, at the real fill price — never before, so we never
// track a position we don't actually hold.
export function createPositionFromFill(w) {
  const i = w.intent || {};
  const pos = {
    id: `${i.ticker}-${Date.now()}`,
    ticker: i.ticker, side: i.side, instrument: "option", optionType: i.optionType,
    optionSymbol: i.contract?.symbol,
    strike: i.contract?.strike, expiry: i.contract?.expiry,
    dte: i.contract?.dte, moneyness: i.contract?.moneyness,
    contracts: i.contracts,
    entryPremium: w.filledPrice,          // REAL fill
    entryQuotedMid: w.mid ?? i.quotedMid,
    entryFilled: true,
    entrySlippage: +(w.filledPrice - (w.mid ?? i.quotedMid ?? w.filledPrice)).toFixed(2),
    entryRung: `${(w.rung ?? 0) + 1}/${w.totalRungs}`,
    entryWaitedSec: Math.round(((w.filledAt || Date.now()) - w.startedAt) / 1000),
    entryDate: iso(new Date()), entrySpot: i.entrySpot ?? null,
    pTrans: i.snapLevels?.pTrans, nTrans: i.snapLevels?.nTrans,
    trigger: i.levels?.trigger, stopLevel: i.levels?.stop,
    t1: i.levels?.t1, t2: i.levels?.t2,
    lockedToBreakeven: false,
    status: "OPEN", orderId: w.orderId,
    triggeredBy: i.triggeredBy,
    entryBudget: i.entryBudget, effectiveBudget: i.effectiveBudget, flowMult: i.flowMult,
    flowAtEntry: i.flowAtEntry,
    selection: i.selection,
  };
  const rows = load(); rows.push(pos); persist(rows);
  return pos;
}

export function listAll() { return load(); }

// ---- Store maintenance (used by reconcile.js) -----------------------------
// Deliberately narrow: set a terminal status, or patch a few fields. Kept here so
// all writes to the store go through one module.
export function markStatus(id, status, reason) {
  const rows = load();
  const p = rows.find((x) => x.id === id);
  if (!p) return null;
  p.status = status;
  p.exitReason = reason || p.exitReason || status.toLowerCase();
  p.exitDate = p.exitDate || iso(new Date());
  p.reconciledAt = new Date().toISOString();
  persist(rows);
  return p;
}

export function patchPosition(id, fields = {}) {
  const rows = load();
  const p = rows.find((x) => x.id === id);
  if (!p) return null;
  Object.assign(p, fields, { reconciledAt: new Date().toISOString() });
  persist(rows);
  return p;
}

// ---- Exit ----------------------------------------------------------------
// urgency: "urgent" for stop-losses (must get out — cross fast), "patient" for
// take-profits and manual exits (work the ladder, keep the spread).
export async function exitTrade({ id, reason = "manual", urgency = null }) {
  const rows = load();
  const p = rows.find((x) => x.id === id && x.status === "OPEN");
  if (!p) throw new Error("open position not found");

  // A stop-out is the one case where paying the spread beats not filling.
  const isStop = /stop\s*[1-4]|stop:|below stop|above stop|10% adverse/i.test(reason);
  const urg = urgency || (isStop ? "urgent" : "patient");
  const cfgX = flow.loadConfig();

  // ---- shares: flatten via the stock path -------------------------------
  if (p.instrument === "shares") {
    let held = null;
    try { held = (await alpaca.getPositions()).find((x) => x.symbol === p.ticker); } catch {}
    if (!held) {
      try { await alpaca.cancelOrder(p.orderId); } catch {}
      p.status = "CANCELED"; p.exitReason = `${reason} (entry unfilled — order canceled)`;
      p.exitDate = iso(new Date()); persist(rows);
      return { status: "CANCELED", position: p };
    }
    const order = await shares.exit({ ticker: p.ticker, side: p.side || "long", shares: p.shares });
    const xf = await alpaca.waitForFill(order.id).catch(() => ({ filled: false, price: null }));
    let last = null;
    try { last = await alpaca.getLatestTrade(p.ticker, "delayed_sip"); } catch {}
    const exitPx = xf.filled && xf.price ? xf.price : (last != null ? +last.toFixed(2) : null);
    p.status = "CLOSED"; p.exitReason = reason; p.exitDate = iso(new Date());
    p.exitPrice = exitPx; p.exitFilled = Boolean(xf.filled); p.exitOrderId = order.id;
    // Shares DO invert with side (unlike long-premium options).
    p.realizedPnl = (p.entryPrice != null && exitPx != null)
      ? +((((p.side === "short" ? p.entryPrice - exitPx : exitPx - p.entryPrice)) * (p.shares || 0))).toFixed(2)
      : null;
    p.pnlIsEstimate = !xf.filled;
    persist(rows);
    return { status: "CLOSED", instrument: "shares", position: p, order, realizedPnl: p.realizedPnl };
  }

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
  const xexec = await execution.execute({
    symbol: p.optionSymbol, qty: p.contracts, side: "sell",
    urgency: urg, isOption: true, cfg: cfgX,
  });
  if (!xexec.filled) {
    // Patient exits can wait for the next tick; an urgent one that still didn't
    // fill is worth surfacing loudly rather than silently marking it closed.
    return {
      status: "EXIT_NOT_FILLED", position: p, urgency: urg,
      rungs: xexec.rungs, mid: xexec.mid, bid: xexec.bid, ask: xexec.ask,
      note: xexec.note || "exit ladder expired unfilled — position still OPEN, will retry",
    };
  }
  const order = { id: xexec.orderId };
  const xfill = { filled: true, price: xexec.price };
  const exitPrice = xexec.price;

  p.status = "CLOSED";
  p.exitReason = reason;
  p.exitDate = iso(new Date());
  p.exitPremium = exitPrice;
  p.exitQuotedMid = xexec.mid ?? optMid;
  p.exitFilled = true;
  p.exitSlippage = xexec.vsMid;          // + = sold below mid
  p.exitSavedVsCross = xexec.vsCross;    // + = better than hitting the bid
  p.exitRung = `${xexec.rung}/${xexec.of}`;
  p.exitUrgency = urg;
  p.exitOrderId = order.id;
  // Realized P&L from ACTUAL fills on both legs. Long premium either way (a long
  // call and a long put are both bought), so the formula is the same for both sides.
  p.realizedPnl = (p.entryPremium != null && exitPrice != null)
    ? +(((exitPrice - p.entryPremium) * (p.contracts || 0) * 100)).toFixed(2)
    : null;
  p.pnlIsEstimate = !(p.entryFilled && xfill.filled);   // flag if either leg is a guess
  persist(rows);
  return { status: "CLOSED", position: p, order, realizedPnl: p.realizedPnl, pnlIsEstimate: p.pnlIsEstimate };
}

// Lock stop to breakeven after T1 (records intent; the stop is enforced by evaluate/user).
export function lockToBreakeven({ id }) {
  const rows = load();
  const p = rows.find((x) => x.id === id && x.status === "OPEN");
  if (!p) throw new Error("open position not found");

  // A stop-out is the one case where paying the spread beats not filling.
  const isStop = /stop\s*[1-4]|stop:|below stop|above stop|10% adverse/i.test(reason);
  const urg = urgency || (isStop ? "urgent" : "patient");
  const cfgX = flow.loadConfig();
  // Move the stop to entry — for a short that means bringing it DOWN.
  p.lockedToBreakeven = true;
  const side = p.side || "long";
  const cur = p.stopLevel ?? (side === "short" ? p.pTrans : p.nTrans);
  p.stopLevel = side === "short" ? Math.min(cur, p.entrySpot) : Math.max(cur, p.entrySpot);
  if (side === "long") p.nTrans = p.stopLevel; else p.pTrans = p.stopLevel;
  persist(rows);
  return p;
}
