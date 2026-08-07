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
  // Walk backwards from the newest and skip anything unparseable instead of
  // throwing. A single corrupt file used to kill every entry attempt forever
  // ("Unexpected token 'N'" from a NaN written by an older build), and because
  // the file existed, ensureSnapshot() saw no reason to re-scan — a permanent
  // deadlock over one bad float. Falling back to an older snapshot, or to null
  // (which triggers a fresh scan), both recover on their own.
  for (let i = files.length - 1; i >= 0; i--) {
    const p = path.join(dir, files[i]);
    try {
      return JSON.parse(fs.readFileSync(p));
    } catch {
      try { fs.unlinkSync(p); } catch {}   // poison: drop it so it can be rebuilt
    }
  }
  return null;
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

// Today's regular-hours 5-min bars, in order.
async function todays5MinBars(ticker) {
  const start = new Date(Date.now() - 2 * 864e5).toISOString();
  const end = new Date().toISOString();
  let bars;
  try { bars = await alpaca.getBars(ticker, "5Min", start, end); } catch { return []; }
  const todayET = etParts(new Date().toISOString()).date;
  return bars
    .map((b) => ({ ...b, ...etParts(b.t) }))
    .filter((b) => b.date === todayET && b.hm >= 570 && b.hm < 960)   // 09:30-16:00
    .sort((a, b) => a.hm - b.hm);
}

// Close of the first regular-hours 5-min bar today (09:30-09:35 ET), or null.
async function firstFiveMinClose(ticker) {
  const bars = await todays5MinBars(ticker);
  const first = bars.find((b) => b.hm === 570);          // 570 = 09:30
  return first ? first.c : null;
}

// ---- Entry trigger -------------------------------------------------------
// Two modes.
//
// "open" (default, original): only the 09:30-09:35 close is ever tested. That
// one number decides the whole session — a name that reclaims pTrans at 11:15
// cannot be taken today no matter how it trades.
//
// "intraday": a later bar may trigger, but it must be a genuine CROSSING —
// the previous bar at/below the level, this bar beyond it. That distinction
// matters more than it looks: if we merely asked "is the latest close beyond
// the trigger", the test would be true on every bar of an already-trending
// name, and the trigger would collapse into "spot is past pTrans" — which is
// exactly what the CONFIRMED tag already checks. We'd have deleted a gate
// rather than relaxed it. Requiring the crossing keeps the trigger meaning
// "it reclaimed the level", just no longer only at the open.
//
// `cutoffMin` stops new triggers late in the day (default 14:00 ET), because a
// reclaim at 15:50 gives the thesis no time to work before the close.
async function triggerBar(ticker, levels, cfg) {
  // "both" and "intraday" are the same setting. The intraday path has ALWAYS
  // checked the opening bar first and only scanned 5-min crossings if that
  // failed, so it was never an alternative to the open trigger — it was the
  // open trigger plus a fallback. "intraday" as a name hid that, and reading
  // the dropdown as either/or is the natural mistake. Accepting "both" lets
  // the config say what the code does.
  const raw = cfg?.automation?.triggerMode || "open";
  const mode = raw === "both" ? "intraday" : raw;
  const bars = await todays5MinBars(ticker);
  if (!bars.length) return { close: null, triggered: false, source: "no-bars" };

  const open = bars.find((b) => b.hm === 570) || null;
  const openClose = open ? open.c : null;

  if (mode !== "intraday") {
    return {
      close: openClose,
      triggered: playbook.triggerMet(openClose, levels),
      source: "open-bar", at: open ? "09:30" : null,
    };
  }

  // The opening bar still counts first — an open-driven trigger is the cleanest.
  if (playbook.triggerMet(openClose, levels)) {
    return { close: openClose, triggered: true, source: "open-bar", at: "09:30" };
  }

  const cutoff = cfg?.automation?.intradayCutoffMin ?? 840;   // 14:00 ET
  for (let i = 1; i < bars.length; i++) {
    const prev = bars[i - 1], cur = bars[i];
    if (cur.hm > cutoff) break;
    if (!playbook.triggerMet(prev.c, levels) && playbook.triggerMet(cur.c, levels)) {
      const hh = String(Math.floor(cur.hm / 60)).padStart(2, "0");
      const mm = String(cur.hm % 60).padStart(2, "0");
      return { close: cur.c, triggered: true, source: "intraday-cross", at: `${hh}:${mm}` };
    }
  }
  const last = bars[bars.length - 1];
  return { close: openClose ?? last.c, triggered: false, source: "intraday-no-cross" };
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

// ---- Position sizing -------------------------------------------------------
// Pure, so it can be tested without a broker. Returns either a refusal
// ({ status }) or { contracts, cost, sizing }.
//
// The bug this replaced: `Math.max(1, Math.floor(budget / costPerContract))`
// forced a minimum of one contract even when one contract cost many times the
// budget. A $300 budget against a $29 premium bought a $2,910 position — ~10x
// over — and it made flow sizing inert too, since 0.25x of $300 still rounded
// up to the same single contract.
//
// Order of constraints:
//   1. want      — fixed count if set, else "as many as the budget fits", else 1
//   2. budget    — trims, but only when enforceBudget is on
//   3. overrun   — the only way to end up above budget, and only ever 1 contract
//   4. buying power — always binds, whatever the toggles say
export function sizeOrder({ prem, budget, budgetTarget = budget, buyingPower = 0, rk = {}, cheaperSearch = null }) {
  const enforceBudget = rk.enforceBudget !== false;
  const fixedOn = rk.fixedContracts?.enabled === true;
  const fixedN = Math.max(1, Math.floor(rk.fixedContracts?.count ?? 1));
  const maxContracts = Math.max(1, rk.maxContracts ?? 10);

  const costPerContract = prem * 100;
  const affordable = Math.floor(budget / costPerContract);
  const overrunRatio = costPerContract / Math.max(budget, 1);
  const capacity = buyingPower > 0 ? Math.floor(buyingPower / costPerContract) : Infinity;
  const bp = Math.round(buyingPower);

  const tooPoor = {
    status: "INSUFFICIENT_FUNDS", premium: prem,
    costPerContract: +costPerContract.toFixed(2), buyingPower: bp,
    note: `1 contract costs $${costPerContract.toFixed(0)} but buying power is $${bp}.`,
  };

  // 1. What do we want? With the budget off and no fixed count, "want" stays 1 —
  //    turning a constraint off should remove a limit, not start buying ten.
  let contracts = fixedOn
    ? Math.min(fixedN, maxContracts)
    : enforceBudget ? Math.min(maxContracts, affordable) : 1;
  const wanted = contracts;
  const notes = [];

  // 2. Budget trims.
  if (enforceBudget && contracts > affordable) {
    contracts = affordable;
    if (contracts >= 1) notes.push(`trimmed ${wanted}->${contracts} to fit the $${budget} budget`);
  }

  // 3. Even one contract busts the budget. findCheaper already had its shot (it
  //    re-ranked the chain on affordability and came back empty), so it's now
  //    "buy 1 anyway" or "skip and let the loop try the next ticker" — which is
  //    the other half of finding a cheaper name.
  if (enforceBudget && contracts < 1) {
    const tolerance = rk.overrunTolerance ?? 1.0;   // 1.0 = no overrun permitted
    const allowed = rk.allowBudgetOverrun !== false && overrunRatio <= Math.max(tolerance, 1);
    if (capacity < 1) return tooPoor;
    if (!allowed) {
      return {
        status: "TOO_EXPENSIVE", premium: prem,
        costPerContract: +costPerContract.toFixed(2),
        budget, buyingPower: bp, overrunRatio: +overrunRatio.toFixed(2), cheaperSearch,
        note: `1 contract costs $${costPerContract.toFixed(0)} but the budget is $${budget} `
          + `(${overrunRatio.toFixed(1)}x over)`
          + (cheaperSearch ? ` and nothing under $${cheaperSearch.ceiling} passed the R/R filters` : "")
          + ".",
      };
    }
    contracts = 1;
    notes.push(`over budget ${overrunRatio.toFixed(1)}x — bought 1 anyway (overrun allowed)`);
  }

  // 4. Buying power is the hard ceiling — it binds even with the budget off.
  if (contracts > capacity) {
    if (capacity < 1) return tooPoor;
    notes.push(`cut ${contracts}->${capacity} to stay inside $${bp} buying power`);
    contracts = capacity;
  }
  contracts = Math.max(1, Math.min(contracts, maxContracts));

  return {
    contracts,
    cost: +(prem * contracts * 100).toFixed(2),
    sizing: {
      budget, budgetTarget, costPerContract: +costPerContract.toFixed(2),
      affordable, wanted, contracts, maxContracts,
      cost: +(prem * contracts * 100).toFixed(2),
      mode: fixedOn ? `fixed ${fixedN}` : enforceBudget ? "fit budget" : "budget off",
      enforceBudget, overrunRatio: +overrunRatio.toFixed(2),
      budgetBusted: enforceBudget && affordable < 1,
      ...(buyingPower > 0 ? { buyingPower: bp } : {}),
      ...(cheaperSearch ? { cheaperSearch } : {}),
      ...(notes.length ? { notes } : {}),
    },
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

  // Side-specific levels + trigger (long: reclaim pTrans; short: lose nTrans).
  // Levels are resolved BEFORE the trigger now, because intraday mode needs the
  // level to spot a crossing — it isn't just reading one fixed bar any more.
  const lv = playbook.levelsFor(snap, side);
  if (!lv) throw new Error(`snapshot for ${ticker} lacks usable levels`);
  const cfg0 = flow.loadConfig();
  const trig = await triggerBar(ticker, lv, cfg0);
  const fmc = trig.close;
  const triggered = trig.triggered;

  // ---- Is there any reward left? ------------------------------------------
  // The trigger is decided from an earlier bar, but price keeps moving. If spot
  // has already reached T1 by the time we get here, the target is behind us and
  // there is nothing to capture — manage() will see spot >= t1 on its very next
  // pass and immediately try to take profit. Observed live on NVDA: filled at
  // 13:48:15, T1_HIT logged at 13:48:37, twenty-two seconds later, then the same
  // thing again on a re-entry twenty minutes on. Both closed at a loss, because
  // the only thing the position could do was pay the spread twice.
  //
  // Refuse the trade instead. This is not the same as the trigger check: the
  // trigger asks "did it reclaim the level?", this asks "is the reward still
  // ahead of us?".
  if (!force && lv.t1 != null && playbook.favourable(side, spot, lv.t1)) {
    return {
      status: "NO_UPSIDE", ticker, side,
      spot: +spot.toFixed(2), t1: lv.t1, trigger: lv.trigger,
      note: `spot ${spot.toFixed(2)} has already reached T1 ${lv.t1} — no reward left to capture, `
        + "the position would hit take-profit immediately. Skipping.",
    };
  }

  // ---- LIVE ENTRY GATES: is this still the trade we graded? ----------------
  // Every number the setup was approved on -- extension, R/R, cushion -- was
  // computed by voldesk.py at SCAN time and frozen into the daily snapshot.
  // Entry happens later, sometimes hours later, and price does not wait. The
  // snapshot can honestly report a 1% extension on a name we are about to buy
  // 6% extended, because the snapshot is describing a moment that has passed.
  //
  // The scan-time filters cannot fix this; only a check against live spot at the
  // moment of entry can. These three are that check.
  const stopDist = Math.abs(spot - lv.stop);
  const upsideAbs = lv.t1 != null ? Math.abs(lv.t1 - spot) : null;
  const rrAtFill = stopDist > 0 && upsideAbs != null ? +(upsideAbs / stopDist).toFixed(2) : null;
  const upsidePct = upsideAbs != null && spot > 0 ? upsideAbs / spot : null;

  // 1. Spot is already through the stop. The setup is dead, not late -- there is
  //    no version of this trade left. Cheap to check and it catches the case
  //    where a name gapped down between the scan and the trigger window.
  if (!force && playbook.adverse(side, spot, lv.stop)) {
    return {
      status: "STRUCTURE_BROKEN", ticker, side,
      spot: +spot.toFixed(2), stop: lv.stop, t1: lv.t1,
      note: `spot ${spot.toFixed(2)} is already ${side === "short" ? "above" : "below"} the stop `
        + `${lv.stop} — the setup is invalidated, not merely late. Not entering.`,
    };
  }

  // 2. THE ANTI-CHASE GATE. Extension is the symptom; this is the disease.
  //    Running past the trigger costs twice over -- it shortens the distance to
  //    T1 and lengthens the distance to the stop at the same time -- so the
  //    ratio you actually own falls far faster than the extension suggests.
  //    voldesk.py already records this as `rr_at_fill` and explicitly declines
  //    to filter on it, on the reasoning that filtering would mask bad entry
  //    TIMING rather than fix it. That reasoning is right about the scan and
  //    wrong about the order: at scan time it is a diagnostic, but at the
  //    instant of committing capital it is simply the trade's reward:risk, and
  //    refusing a 1.1:1 is not masking anything.
  const minRRFill = cfg0.setup?.minRRAtFill ?? 1.5;
  if (!force && minRRFill > 0 && rrAtFill != null && rrAtFill < minRRFill) {
    return {
      status: "CHASED", ticker, side,
      spot: +spot.toFixed(2), trigger: lv.trigger, stop: lv.stop, t1: lv.t1,
      rrAtFill, minRRAtFill: minRRFill,
      extensionPct: lv.trigger ? +(((spot - lv.trigger) / lv.trigger) * 100).toFixed(2) : null,
      note: `R/R from the actual fill is ${rrAtFill}:1 against a ${minRRFill}:1 floor — price has `
        + `run too far past ${lv.trigger} for the remaining move to pay for the risk. `
        + "The setup was valid; the entry is not.",
    };
  }

  // 3. Is there enough move here to justify BUYING PREMIUM at all? A 3% run to
  //    target is a fine share trade and a losing option trade: spread and theta
  //    take the whole thing. This is the cleanest signal we have for when the
  //    share path is the right instrument rather than a consolation prize.
  const minUpside = cfg0.setup?.minUpsidePctForOptions ?? 0;
  const thinForOptions = minUpside > 0 && upsidePct != null && upsidePct < minUpside;

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
  const cfg = cfg0;
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

  // ---- Budget, resolved BEFORE we pick a contract -------------------------
  // Four independent controls, in the order they bind:
  //   enforceBudget   — is the premium budget a real constraint at all?
  //   fixedContracts  — buy exactly N per trade instead of "as many as fit"
  //   findCheaper     — if the best contract busts the budget, rank only the
  //                     contracts that FIT rather than the best outright
  //   allowBudgetOverrun — last resort: buy 1 anyway
  // Buying power sits above all four: we never order more than the account can
  // pay for, whatever the toggles say.
  const rk = cfg.risk || {};
  const enforceBudget = rk.enforceBudget !== false;
  const findCheaper = rk.findCheaper !== false;
  const fixedOn = rk.fixedContracts?.enabled === true;
  const fixedN = Math.max(1, Math.floor(rk.fixedContracts?.count ?? 1));
  const maxContracts = Math.max(1, rk.maxContracts ?? 10);

  let buyingPower = 0;
  try { buyingPower = parseFloat((await alpaca.getAccount()).buying_power) || 0; } catch {}
  const budgetTarget = effectiveBudget > 0 ? effectiveBudget : riskPremium;
  const budgetForSizing = buyingPower > 0 ? Math.min(budgetTarget, buyingPower) : budgetTarget;
  const budgetClampedByCash = buyingPower > 0 && budgetTarget > buyingPower;

  // Per-contract ceiling handed to the selector. With a fixed count of 3 and a
  // $6,000 budget each contract has to come in under $2,000, not $6,000.
  const wantContracts = fixedOn ? fixedN : 1;
  const priceCeiling = enforceBudget && findCheaper ? budgetForSizing / wantContracts : 0;

  let call = null, rrPick = null, cheaperSearch = null, selectionPath = null;
  // `thinForOptions` short-circuits the whole chain fetch: if T1 is too close to
  // pay for premium, no strike in the chain can rescue it, so there is nothing
  // to evaluate. Skipping straight to shares also saves a quote burst per name.
  if (csMode === "rr" && !thinForOptions) {
    try {
      rrPick = await contractSelect.selectByRiskReward(
        ticker, spot, { target: lv.t1, stop: lv.stop }, cfg, optType,
        { maxPremium: priceCeiling }
      );
      if (priceCeiling > 0) {
        cheaperSearch = { ceiling: Math.round(priceCeiling), found: Boolean(rrPick.best) };
        if (!rrPick.best) {
          // Nothing affordable passed. Re-rank WITHOUT the ceiling — not to buy
          // it, but so the overrun / TOO_EXPENSIVE decision below is made against
          // the real cheapest qualifying contract and can say what it costs.
          const uncapped = await contractSelect.selectByRiskReward(
            ticker, spot, { target: lv.t1, stop: lv.stop }, cfg, optType
          );
          if (uncapped.best) {
            rrPick = { ...uncapped, note: `no contract under $${Math.round(priceCeiling)}; best overall: ${uncapped.note}` };
            cheaperSearch.fellBackToBest = true;
          }
        }
      }
      if (rrPick.best) {
        selectionPath = "rr";
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
  // ---- WHAT HAPPENS WHEN NOTHING CLEARS THE BAR ---------------------------
  // This is where the system was leaking, and it leaked quietly.
  //
  // The R/R selector rejects a contract for good reasons: reward:risk under
  // minRR, delta outside the band, breakeven sitting past our own target, a
  // spread that eats the edge twice. When it came back empty, a SECOND picker
  // then chose a contract by DTE and moneyness alone, and the only thing
  // checked before that contract was sized and ordered was its spread. So a
  // contract the selector had just refused at 0.4:1 was bought thirty lines
  // later at 0.4:1. Every filter described as the safety net was, on that path,
  // decorative.
  //
  // Worse, it was the path that ran most often. `noOption` below tested whether
  // a contract with a quote EXISTED, and on any liquid name one always does --
  // so the share fallback it guarded was structurally unreachable, and the
  // bypass fired instead. "We could not find a good contract" silently became
  // "buy an arbitrary one".
  //
  // Three honest answers now, chosen by contractSelection.onNoQualifyingContract:
  //   shares    express the same thesis in stock (default). No spread, no theta,
  //             sized off the distance to the stop.
  //   skip      take nothing. The strictest reading, and defensible: if the
  //             chain cannot pay you for this risk, that IS the answer.
  //   fallback  let the legacy picker nominate -- but its pick is now scored
  //             through the same evaluate() as the grid and must pass minRR.
  //             A nomination, not a pardon.
  const onNone = cfg.contractSelection?.onNoQualifyingContract || "shares";
  if (!call && !thinForOptions && onNone === "fallback") {
    try {
      const pick = optType === "put"
        ? await selectPut(ticker, spot, { dteTarget, moneyness })
        : await selectCall(ticker, spot, { dteTarget, moneyness });
      const verdict = contractSelect.evaluatePick(pick, {
        spot, target: lv.t1, stop: lv.stop, type: optType, cfg,
        maxPremium: priceCeiling,
      });
      rrPick = rrPick || {};
      if (!verdict) {
        rrPick.note = `${rrPick.note ? rrPick.note + "; " : ""}fallback pick has no two-sided market — rejected`;
      } else if (!verdict.ok) {
        // Say WHICH bar it failed. "no contract" is unactionable; "every strike
        // breaks even past T1" tells you the target is too close for premium.
        rrPick.note = `${rrPick.note ? rrPick.note + "; " : ""}fallback pick ${pick.strike} `
          + `${pick.expiry} rejected: ${verdict.reasons.join(", ")}`;
        rrPick.fallbackRejected = {
          symbol: pick.symbol, rr: verdict.rr,
          spreadPct: verdict.spreadPct, reasons: verdict.reasons,
        };
      } else {
        selectionPath = "fallback-scored";
        call = { ...pick, spreadPct: verdict.spreadPct, viaFallback: true };
        rrPick.best = verdict;
        rrPick.note = `${rrPick.note ? rrPick.note + "; " : ""}fallback pick passed scoring `
          + `(R/R ${verdict.rr}, delta ${verdict.delta})`;
      }
    } catch (e) {
      rrPick = rrPick || {};
      rrPick.note = `${rrPick.note ? rrPick.note + "; " : ""}fallback picker failed: ${String(e.message || e)}`;
    }
  }

  // ---- SHARE FALLBACK ----------------------------------------------------
  // No usable contract (no chain, no quotes, nothing clears R/R). Express the
  // same thesis in stock, sized off the distance to the stop.
  const shareCfg = { ...shares.DEFAULTS, ...(cfg.shares || {}) };
  // The old test was `!call || !(call.mid || call.ask)` — "does a contract with a
  // quote exist at all". On a liquid name that is always true, so this branch
  // never ran and the bypass above ran instead. The question that matters is not
  // whether a contract exists; it is whether one QUALIFIES.
  const needShares = !call || !(call.mid || call.ask);
  const shareReason = thinForOptions
    ? `T1 is only ${(upsidePct * 100).toFixed(1)}% from spot — under the `
      + `${(minUpside * 100).toFixed(1)}% floor where option frictions can be paid for`
    : `no ${optType} contract cleared the R/R bar`;

  // "skip" means skip. Do not quietly become a share trade because the option
  // route failed — that is a different trade with a different risk profile, and
  // it should be a choice, not a consolation.
  if (needShares && onNone === "skip" && !thinForOptions) {
    return {
      status: "NO_QUALIFYING_CONTRACT", ticker, side,
      spot: +spot.toFixed(2), t1: lv.t1, stop: lv.stop, rrAtFill,
      evaluated: rrPick?.evaluated ?? 0,
      rejected: rrPick?.rejected || [],
      note: `${shareReason} and onNoQualifyingContract="skip". `
        + (rrPick?.note || "No trade."),
    };
  }

  if (needShares) {
    if (!shareCfg.enabled) {
      return {
        status: "NO_QUALIFYING_CONTRACT", ticker, side,
        spot: +spot.toFixed(2), t1: lv.t1, stop: lv.stop, rrAtFill,
        note: `${shareReason}, and the share route is disabled. No trade.`,
      };
    }
    // A short expressed in stock needs borrow, and shares.allowShort is off by
    // default. Refusing here — before the trigger and sizing work — keeps the
    // log honest: the reason is "cannot short this", not "order rejected".
    if (side === "short" && shareCfg.allowShort === false) {
      return {
        status: "NO_QUALIFYING_CONTRACT", ticker, side,
        spot: +spot.toFixed(2), t1: lv.t1, stop: lv.stop, rrAtFill,
        note: `${shareReason}, and short stock is disabled (shares.allowShort). `
          + "A bearish thesis with no usable put is no trade.",
      };
    }
    if (!confirm) {
      const sized = shares.size(spot, lv.stop, riskPremium * flowMult, buyingPower, cfg);
      return {
        status: "PREVIEW", instrument: "shares", ticker, side, spot: +spot.toFixed(2),
        triggered, firstFiveMinClose: fmc,
        triggerNote: `${side} trigger: ${lv.triggerDir} ${lv.trigger}`,
        levels: lv, shares: sized,
        flow: decision ? { stance: decision.stance, sizeMultiplier: decision.sizeMultiplier } : null,
        note: `${shareReason} — would trade shares instead`,
        rrAtFill,
        selection: {
          mode: csMode, note: rrPick?.note || null, routedToShares: true,
          reason: shareReason, evaluated: rrPick?.evaluated ?? 0,
          rejected: rrPick?.rejected || [],
        },
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
      // Why this is stock and not an option. Without it the trade log cannot
      // distinguish "we chose shares" from "the option leg silently failed",
      // and those two need very different follow-up.
      selection: { mode: "shares", reason: shareReason, rrAtFill },
      rrAtFill,
    };
    const rows0 = load(); rows0.push(pos); persist(rows0);
    return { status: "ENTERED", instrument: "shares", position: pos, order: res.order };
  }

  const prem = call.mid || call.ask;
  if (!prem) throw new Error("no option quote available to size the trade");

  const sized = sizeOrder({ prem, budget: budgetForSizing, budgetTarget, buyingPower, rk, cheaperSearch });
  if (sized.status) {
    return {
      ...sized, ticker, side,
      contract: { symbol: call.symbol, strike: call.strike, expiry: call.expiry },
      note: sized.note + (sized.status === "TOO_EXPENSIVE" ? ` Skipping ${ticker}.` : ""),
    };
  }
  const { contracts, cost, sizing } = sized;
  if (budgetClampedByCash) sizing.budgetClampedByCash = true;

  const triggerNote = triggered
    ? (trig.source === "intraday-cross"
        ? `Trigger met — crossed ${lv.triggerDir} ${lv.trigger} on the ${trig.at} 5-min bar (close ${fmc}).`
        : `Trigger met (09:30 5-min close ${fmc} ${lv.triggerDir} ${lv.trigger}).`)
    : trig.source === "no-bars" || fmc == null
      ? "No 5-min bars yet today (market closed / pre-open) — placement needs Force or the open."
      : trig.source === "intraday-no-cross"
        ? `No crossing ${lv.triggerDir} ${lv.trigger} on any 5-min bar today (before the `
          + `${Math.floor((cfg.automation?.intradayCutoffMin ?? 840) / 60)}:00 cutoff).`
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
      premium: prem, contracts, cost, sizing,
      budget: riskPremium, effectiveBudget, overBudget: cost > budgetForSizing,
      flow: flowSummary,
      flowBlocked: flowBlock,
      selection: rrPick ? {
        mode: csMode, note: rrPick.note, evaluated: rrPick.evaluated ?? 0,
        best: rrPick.best, alternatives: rrPick.alternatives || [],
        rejected: rrPick.rejected || [],
        path: selectionPath || "none",
        rrAtFill,
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
      contracts, quotedMid: prem, sizing,
      levels: { trigger: lv.trigger, stop: lv.stop, t1: lv.t1, t2: lv.t2 },
      snapLevels: { pTrans: snap.levels.pTrans, nTrans: snap.levels.nTrans },
      entryBudget: riskPremium, effectiveBudget, flowMult,
      flowAtEntry: flowSummary,
      triggeredBy: triggered ? "5min-close" : "forced",
      rrAtFill,
      selection: rrPick?.best ? {
        mode: selectionPath || "rr", rr: rrPick.best.rr, delta: rrPick.best.delta,
        iv: rrPick.best.iv, breakeven: rrPick.best.breakeven,
        spreadPct: rrPick.best.spreadPct,
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
  const cfgM = flow.loadConfig();
  const mgmt = cfgM.management || {};
  let dirty = false;
  const out = [];
  for (const p of open) {
    const side = p.side || "long";
    const isShares = p.instrument === "shares";
    // Backfill for positions opened before side/level fields existed.
    // `let`, not `const`: the ratchet below can move this mid-evaluation, and the
    // stop test further down has to see the moved level, not the entry one.
    let stopLevel = p.stopLevel ?? (side === "short" ? p.pTrans : p.nTrans);
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

    // Stop 4 needs progress HISTORY, not just today's number, so each evaluation
    // appends today's reading. Three consecutive sessions under 10%/day is the
    // stall signal. Stored on the position so it survives restarts.
    const today = iso(new Date());
    const priorLog = JSON.stringify(p.progressLog || []);
    p.progressLog = (p.progressLog || []).filter((e) => e.d !== today);
    p.progressLog.push({ d: today, p: +(progress * 100).toFixed(1) });
    p.progressLog = p.progressLog.slice(-6);
    // THIS WAS THE BUG THAT KILLED STOP 4. The log was built on every pass and
    // never written back — `rows` comes from load(), which re-reads the file, so
    // each evaluation started from whatever was last persisted, which was
    // nothing. progressLog therefore never reached the four entries the stall
    // test requires, and `stalled` was permanently false. Stop 4 has been dead
    // code since it was written: it reads correctly, logs nothing, and fires
    // never. Marking the rows dirty and persisting at the end is the whole fix.
    if (JSON.stringify(p.progressLog) !== priorLog) dirty = true;
    let stalled = false;
    if (p.progressLog.length >= 4 && daysHeld >= 3) {
      const last4 = p.progressLog.slice(-4);
      const gains = last4.slice(1).map((e, i) => e.p - last4[i].p);
      stalled = gains.length === 3 && gains.every((g) => g < 10);
    }

    // ---- STOP RATCHET: protect a winner, not just abandon a loser ---------
    // Stops 1-4 all answer "when do I give up on this?". Nothing answered "when
    // do I stop being willing to give the whole move back?" — so a position
    // could travel 80% of the way to T1 and stop out at its original nTrans for
    // a loss, having been right the entire time. The ratchet only ever tightens,
    // and it is capped at the position's own entry-to-T1 span so it can never
    // jump ahead of price.
    const ratchet = Array.isArray(mgmt.stopRatchet) ? mgmt.stopRatchet : [];
    if (ratchet.length && spot != null && p.entrySpot != null && p.t1 != null) {
      const span = side === "short" ? p.entrySpot - p.t1 : p.t1 - p.entrySpot;
      if (span > 0) {
        // Highest rung whose progress threshold we have already cleared.
        const hit = ratchet
          .filter((r) => progress >= (r.at ?? 1))
          .sort((a, b) => (a.at ?? 0) - (b.at ?? 0))
          .pop();
        if (hit) {
          const lock = Math.min(Math.max(hit.lock ?? 0, 0), 0.9);
          const want = side === "short"
            ? +(p.entrySpot - span * lock).toFixed(2)
            : +(p.entrySpot + span * lock).toFixed(2);
          // Tighten only. A rung must never undo a stop some other rule raised.
          const tighter = side === "short" ? want < stopLevel : want > stopLevel;
          if (tighter) {
            stopLevel = want;
            p.stopLevel = want;
            p.lockedToBreakeven = true;
            p.stopRatchet = {
              at: hit.at, lock, movedTo: want, on: today,
              progressPct: +(progress * 100).toFixed(0),
            };
            if (side === "long") p.nTrans = want; else p.pTrans = want;
            dirty = true;
          }
        }
      }
    }

    // Catastrophic premium backstop. Every stop above is measured on the
    // UNDERLYING, which is right for the thesis and blind to the instrument: a
    // vol crush or an overnight gap can halve the option while spot still sits
    // comfortably inside structure. Set wide on purpose — structure should get
    // to be wrong first — but not infinite.
    const maxPremLoss = mgmt.maxPremiumLossPct ?? 0;
    const premiumBreach = !isShares && maxPremLoss > 0 && optMid != null
      && p.entryPremium > 0 && optMid <= p.entryPremium * (1 - maxPremLoss);

    // Never carry long premium into the theta/gamma cliff. If the thesis needed
    // 45 days and has burned 35 of them, it is not about to start working.
    const minDte = mgmt.minDteExit ?? 0;
    const dteLeft = !isShares && p.expiry
      ? Math.floor((Date.parse(p.expiry + "T20:00:00Z") - Date.now()) / 864e5)
      : null;
    const dteBreach = minDte > 0 && dteLeft != null && dteLeft <= minDte;

    let action = "HOLD", reason = "", urgent = false;
    if (spot != null) {
      if (adverse(stopLevel)) {
        action = "EXIT"; urgent = true;
        reason = `Stop 1: spot ${spot.toFixed(2)} ${side === "short" ? "above" : "below"} stop ${stopLevel}`;
      } else if (drawdownHit && adverse(trigger)) {
        action = "EXIT"; urgent = true;
        reason = `Stop 2: 10% adverse from entry and back ${side === "short" ? "above" : "below"} trigger`;
      } else if (premiumBreach) {
        action = "EXIT"; urgent = true;
        reason = `Stop 5: premium ${optMid} is ${Math.round((1 - optMid / p.entryPremium) * 100)}% `
          + `below entry ${p.entryPremium} — instrument stop, structure still intact at ${spot.toFixed(2)}`;
      } else if (dteBreach) {
        action = "EXIT"; urgent = false;
        reason = `Stop 6: ${dteLeft}d to expiry — closing before the theta cliff `
          + `(${(progress * 100).toFixed(0)}% to T1)`;
      } else if (daysHeld >= 7 && progress < 0.5) {
        action = "EXIT"; urgent = true;
        reason = `Stop 3: day ${daysHeld}, only ${(progress * 100).toFixed(0)}% to T1`;
      } else if (stalled) {
        // Stop 4 — the stalling rule, which was missing. Under 10% progress per
        // day for three consecutive sessions means the thesis isn't playing out,
        // and waiting for Stop 3 on day 7 spends four more days of theta finding
        // that out. Capital tied to a position going nowhere is the quiet cost
        // that doesn't show up as a loss until expiry.
        action = "EXIT"; urgent = true;
        reason = `Stop 4: stalled — under 10%/day progress for 3 sessions (now ${(progress * 100).toFixed(0)}% to T1)`;
      } else if (p.t1 != null && favourable(p.t1) && !p.t1Taken) {
        action = "T1_HIT";
        reason = `T1 reached (${p.t1}) — take profit, or lock stop to entry and ride to T2 ${p.t2}`;
      } else if (p.t1Taken && p.t2 != null && favourable(p.t2)) {
        // Scale-out runner: the first tranche went at T1, the remainder is
        // riding to T2 on a breakeven stop.
        action = "T2_HIT";
        reason = `T2 reached (${p.t2}) — close the remaining ${p.contracts} contract(s)`;
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
      effectiveStop: stopLevel, dteLeft,
      progressPct: +(progress * 100).toFixed(0), action, reason, urgent });
  }
  // Write back the progress history and any ratcheted stop. Without this the
  // whole evaluation is amnesiac: Stop 4 needs four sessions of history and the
  // ratchet needs its moved stop to survive the next tick, let alone a restart
  // on a host that redeploys nightly.
  if (dirty) persist(rows);
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
// `qty` sells only part of the position (scale-out); omit it to close fully.
// `moveStopToBreakeven` is applied once the partial actually fills.
export async function exitTrade({ id, reason = "manual", urgency = null, qty = null, moveStopToBreakeven = false }) {
  const rows = load();
  const p = rows.find((x) => x.id === id && x.status === "OPEN");
  if (!p) throw new Error("open position not found");
  const sellQty = qty != null ? Math.min(Math.max(1, Math.floor(qty)), p.contracts || 1) : null;
  const isPartial = sellQty != null && sellQty < (p.contracts || 0);

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

  // ---- PATIENT EXIT: non-blocking, same as entries -------------------------
  // This used to call execution.execute() synchronously, and the interaction of
  // two settings made it structurally unable to fill:
  //
  //   patient = { steps: 4, stepSeconds: 90 }   -> a 6-minute ladder
  //   maxTotalSeconds = 20                      -> the whole call is capped at 20s
  //
  // execute() computes `budget = min(stepSeconds, deadline - now)` for each rung,
  // so rung 1 sat at the mid for the entire 20-second allowance, failed, cancelled,
  // hit `if (Date.now() >= deadline) break` and returned unfilled — having never
  // reached rungs 2-4 and therefore never stepped toward the bid at all. The next
  // 60s tick repeated the identical 20-second mid-post. Observed live: ten minutes
  // of EXIT_NOT_FILLED on NVDA while the estimate swung from +33 to -180, finally
  // closing at -45 only because the market came to us.
  //
  // Entries didn't suffer because they were already moved onto working_orders.js.
  // Exits are now on the same path: post at the mid, advance one rung per tick,
  // cross on the last rung. The loop never blocks, so dwell can be minutes.
  //
  // Stops stay synchronous and urgent below — for a stop, not filling is the
  // expensive outcome, so paying the spread is correct.
  if (urg === "patient" && cfgX.execution?.enabled !== false) {
    const already = working.list().find(
      (w) => w.status === "working" && w.kind === "exit" && w.intent?.positionId === p.id);
    if (already) {
      return {
        status: "EXIT_WORKING", position: p, working: already,
        note: `exit ladder already working (rung ${already.rung + 1}/${already.totalRungs}) — leaving it alone`,
      };
    }
    const started = await working.start({
      ticker: p.ticker, symbol: p.optionSymbol, qty: sellQty ?? p.contracts, side: "sell",
      isOption: true, kind: "exit",
      intent: { positionId: p.id, reason, quotedMid: optMid, partial: isPartial, moveStopToBreakeven },
    }, cfgX);
    if (started.started) {
      p.exitWorkingId = started.working.id;
      persist(rows);
      return {
        status: "EXIT_WORKING", position: p, working: started.working, firstRungPrice: started.price,
        note: `patient exit ladder started at ${started.price} — repriced each tick until filled`,
      };
    }
    // Couldn't place a resting order (no quote, etc.) — fall through and cross.
  }

  const xexec = await execution.execute({
    symbol: p.optionSymbol, qty: sellQty ?? p.contracts, side: "sell",
    urgency: urg, isOption: true, cfg: cfgX,
  });
  if (!xexec.filled) {
    return {
      status: "EXIT_NOT_FILLED", position: p, urgency: urg,
      rungs: xexec.rungs, mid: xexec.mid, bid: xexec.bid, ask: xexec.ask,
      note: xexec.note || "exit ladder expired unfilled — position still OPEN, will retry",
    };
  }
  if (isPartial) {
    const r = bookPartialExit(p, rows, {
      qty: sellQty, exitPrice: xexec.price, reason, orderId: xexec.orderId,
      mid: xexec.mid ?? optMid, rung: `${xexec.rung}/${xexec.of}`,
    });
    if (moveStopToBreakeven) { try { lockToBreakeven({ id: p.id }); } catch {} r.stopMovedToBreakeven = true; }
    return r;
  }
  return finalizeOptionExit(p, rows, {
    exitPrice: xexec.price, mid: xexec.mid ?? optMid, vsMid: xexec.vsMid,
    vsCross: xexec.vsCross, rung: `${xexec.rung}/${xexec.of}`,
    urgency: urg, orderId: xexec.orderId, reason,
  });
}

// Write the close-out onto the position. Shared by the synchronous (urgent) path
// and the working-order (patient) path so P&L is computed identically in both —
// always from ACTUAL fill prices, never from quoted mids.
function finalizeOptionExit(p, rows, { exitPrice, mid, vsMid, vsCross, rung, urgency, orderId, reason }) {
  p.status = "CLOSED";
  p.exitReason = reason;
  p.exitDate = iso(new Date());
  p.exitPremium = exitPrice;
  p.exitQuotedMid = mid ?? null;
  p.exitFilled = true;
  p.exitSlippage = vsMid ?? null;         // + = sold below mid
  p.exitSavedVsCross = vsCross ?? null;   // + = better than hitting the bid
  p.exitRung = rung ?? null;
  p.exitUrgency = urgency;
  p.exitOrderId = orderId ?? null;
  // Long premium either way (a long call and a long put are both bought), so the
  // formula is the same for both sides.
  p.realizedPnl = (p.entryPremium != null && exitPrice != null)
    ? +(((exitPrice - p.entryPremium) * (p.contracts || 0) * 100)).toFixed(2)
    : null;
  p.pnlIsEstimate = !p.entryFilled;       // the exit leg definitely filled here
  persist(rows);
  return { status: "CLOSED", position: p, order: { id: orderId }, realizedPnl: p.realizedPnl, pnlIsEstimate: p.pnlIsEstimate };
}

// ---- Scale-out ------------------------------------------------------------
// Sell most of the position at T1, move the stop to breakeven, and let the rest
// run to T2. The appeal is asymmetry: you bank the move that actually happened
// and the remainder becomes a free option — worst case it stops at entry.
//
// Two honest limits:
//   * It needs at least 2 contracts. 80% of one contract is zero; you cannot
//     sell part of a contract. With one contract we sell it all at T1 and say so.
//   * Breakeven is not risk-free. The stop is on the UNDERLYING at your entry
//     spot; the option can still be worth less there than you paid, because
//     theta ran while you waited.
//
// Returns { first, runner } contract counts, or null when it can't apply.
export function planScaleOut(contracts, cfg) {
  const s = cfg.scaleOut || {};
  if (s.enabled !== true) return null;
  const n = Math.floor(contracts || 0);
  if (n < 2) return null;                        // can't split one contract
  const pct = Math.min(0.95, Math.max(0.05, s.firstPct ?? 0.8));
  let first = Math.round(n * pct);
  first = Math.min(n - 1, Math.max(1, first));   // always leave a runner, always take something
  return { first, runner: n - first, pct };
}

// Book a partial close: `qty` contracts are gone at `exitPrice`, the position
// stays OPEN with the remainder. Realized P&L accumulates across tranches.
function bookPartialExit(p, rows, { qty, exitPrice, reason, orderId, mid, rung }) {
  const pnl = p.entryPremium != null && exitPrice != null
    ? +(((exitPrice - p.entryPremium) * qty * 100)).toFixed(2) : null;
  p.scaleOuts = p.scaleOuts || [];
  p.scaleOuts.push({
    at: reason, contracts: qty, exitPremium: exitPrice, quotedMid: mid ?? null,
    rung: rung ?? null, pnl, date: iso(new Date()), orderId: orderId ?? null,
  });
  p.contracts = Math.max(0, (p.contracts || 0) - qty);
  p.realizedPnl = +(((p.realizedPnl || 0) + (pnl || 0))).toFixed(2);
  // Scale-outs only ever fire at T1 in this design, so booking one means T1 is
  // done. Without this the position would re-trigger T1_HIT on the next tick and
  // keep selling the runner off a slice at a time.
  p.t1Taken = true;
  persist(rows);
  return { status: "SCALED_OUT", position: p, soldContracts: qty, remaining: p.contracts, tranchePnl: pnl, realizedPnl: p.realizedPnl };
}

// Called by the auto-trader when a working EXIT order fills.
export function finalizeExitFromWorking(w) {
  const rows = load();
  const p = rows.find((x) => x.id === w.intent?.positionId);
  if (!p) return { status: "NOT_FOUND", note: `no position ${w.intent?.positionId}` };
  if (p.status !== "OPEN") return { status: p.status, position: p, note: "already closed" };

  // Partial tranche — position survives with the runner.
  if (w.intent?.partial && w.qty < (p.contracts || 0)) {
    const r = bookPartialExit(p, rows, {
      qty: w.qty, exitPrice: w.filledPrice, reason: w.intent.reason || "scale-out",
      orderId: w.orderId, mid: w.mid, rung: `${w.rung + 1}/${w.totalRungs}`,
    });
    if (w.intent.moveStopToBreakeven) {
      try { lockToBreakeven({ id: p.id }); } catch {}
      r.stopMovedToBreakeven = true;
    }
    return r;
  }

  return finalizeOptionExit(p, rows, {
    exitPrice: w.filledPrice, mid: w.mid ?? w.intent?.quotedMid,
    vsMid: w.mid != null ? +(w.mid - w.filledPrice).toFixed(2) : null,
    vsCross: null, rung: `${w.rung + 1}/${w.totalRungs}`,
    urgency: "patient", orderId: w.orderId, reason: w.intent?.reason || "patient exit",
  });
}

// Lock stop to breakeven after T1 (records intent; the stop is enforced by evaluate/user).
export function lockToBreakeven({ id }) {
  const rows = load();
  const p = rows.find((x) => x.id === id && x.status === "OPEN");
  if (!p) throw new Error("open position not found");

  // (Three lines that belonged to exitTrade used to sit here — they referenced
  // `reason` and `urgency`, which are not parameters of this function, so any
  // call to lockToBreakeven threw ReferenceError. Only reachable with
  // t1Action = "lock-and-ride", which is why it never surfaced.)

  // Move the stop to entry — for a short that means bringing it DOWN.
  p.lockedToBreakeven = true;
  const side = p.side || "long";
  const cur = p.stopLevel ?? (side === "short" ? p.pTrans : p.nTrans);
  p.stopLevel = side === "short" ? Math.min(cur, p.entrySpot) : Math.max(cur, p.entrySpot);
  if (side === "long") p.nTrans = p.stopLevel; else p.pTrans = p.stopLevel;
  persist(rows);
  return p;
}
