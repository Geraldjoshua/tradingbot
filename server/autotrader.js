// Auto-trader — the background loop that closes the manual gap.
//
// Every `pollSeconds` it:
//   MANAGE (always):  evaluates open Vol Desk positions and AUTO-EXECUTES the
//                     recommended action — take profit at T1, and hard-exit on
//                     any Stop 1-4 (urgent). No clicks.
//   ENTER  (mode "full", market hours only): for each watchlist ticker, checks
//                     the price trigger AND the flow verdict, then auto-buys —
//                     sized up when flow agrees, tiny when it disagrees, or
//                     skipped entirely under a hard gate.
//
// Everything is paper-only and bounded by caps (maxConcurrent, maxDailyEntries,
// per-ticker cooldown). Toggle the whole thing with automation.enabled, or drop
// to MANAGE-only with mode "exit-only". Actions are logged to
// data/autotrader_log.json; counters to data/autotrader_state.json.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import * as flow from "./flow.js";
import * as vd from "./voldesk_trades.js";
import * as discovery from "./discovery.js";
import * as housekeeping from "./housekeeping.js";
import * as observe from "./observe.js";
import { pingStatus } from "./keepalive.js";
import * as reconcile from "./reconcile.js";
import * as working from "./working_orders.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOG = path.join(ROOT, "data", "autotrader_log.json");
const STATE = path.join(ROOT, "data", "autotrader_state.json");
const MAX_LOG = 500;

let timer = null;
let busy = false;

// ---- persistence ----------------------------------------------------------
function readJson(p, fallback) { try { return JSON.parse(fs.readFileSync(p)); } catch { return fallback; } }
function writeJson(p, v) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(v, null, 2)); }

function log(level, event, extra = {}) {
  const rows = readJson(LOG, []);
  const rec = { ts: new Date().toISOString(), level, event, ...extra };
  rows.push(rec);
  writeJson(LOG, rows.slice(-MAX_LOG));
  const tag = level === "error" ? "ERR" : level === "trade" ? "TRADE" : "info";
  console.log(`[autotrader ${tag}] ${event}`, Object.keys(extra).length ? JSON.stringify(extra) : "");
  return rec;
}

const todayISO = () => new Date().toISOString().slice(0, 10);

function loadState() {
  const s = readJson(STATE, { day: todayISO(), entries: 0, cooldown: {}, queuedExits: {} });
  // Daily reset — but NOT queuedExits. A stop that breached after the close on
  // Thursday has to survive into Friday's session; that overnight gap is the
  // entire reason the queue exists.
  if (s.day !== todayISO()) { s.day = todayISO(); s.entries = 0; s.cooldown = {}; }
  if (!s.queuedExits) s.queuedExits = {};
  return s;
}
function saveState(s) { writeJson(STATE, s); }

// ---- market-hours guard (ET, 09:30-16:00, Mon-Fri) ------------------------
const fmtET = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", hour12: false, weekday: "short",
  hour: "2-digit", minute: "2-digit",
});
function etMinutes(now = new Date()) {
  const p = Object.fromEntries(fmtET.formatToParts(now).map((o) => [o.type, o.value]));
  let h = parseInt(p.hour, 10); if (h === 24) h = 0;
  return { dow: p.weekday, min: h * 60 + parseInt(p.minute, 10) };
}
function marketOpen(now = new Date()) {
  const { dow, min } = etMinutes(now);
  if (dow === "Sat" || dow === "Sun") return false;
  return min >= 570 && min < 960; // 09:30 .. 16:00
  // NOTE: this does not know market holidays. On roughly nine days a year it
  // will believe the market is open. Orders simply won't fill, as before.
}
// Minutes elapsed since 09:30 ET, or null when the market isn't open.
function minutesSinceOpen(now = new Date()) {
  if (!marketOpen(now)) return null;
  return etMinutes(now).min - 570;
}

// ---- Patient ladders: step them along, open positions when they fill --------
async function advanceWorkingOrders(cfg) {
  try {
    const events = await working.process(cfg, {
      onFilled: async (w) => {
        if (w.kind === "entry") {
          const pos = vd.createPositionFromFill(w);
          try { observe.markEntered(w.ticker, pos.id); } catch {}
          return;
        }
        if (w.kind === "exit") {
          // Patient exits now ride the same ladder as entries, so the close-out
          // is finalized here rather than inline in exitTrade.
          const r = vd.finalizeExitFromWorking(w);
          log("trade", "exit-filled", {
            ticker: w.ticker, id: w.intent?.positionId, status: r.status,
            price: w.filledPrice, realizedPnl: r.realizedPnl ?? null,
            reason: w.intent?.reason || null,
            ...(r.pnlIsEstimate ? { note: "P&L estimated — the entry leg had not filled" } : {}),
          });
        }
      },
    });
    for (const e of events) {
      const level = e.event === "working-filled" ? "trade" : e.error ? "error" : "info";
      log(level, e.event, Object.fromEntries(Object.entries(e).filter(([k]) => k !== "event")));
    }
  } catch (e) {
    log("error", "working-orders-failed", { error: String(e.message || e) });
  }
}

// ---- MANAGE: auto take-profit + auto-stop ---------------------------------
//
// The market-hours guard used to apply only to enter(). manage() ran around the
// clock, so a stop that breached near the close kept placing orders into a shut
// market and retrying every 60s — observed live on INTC at 16:18, 16:19, 16:20
// and 16:23, all EXIT_NOT_FILLED, because US options stopped trading at 16:00.
// None of those could ever have filled, and the noise buried real failures.
//
// Now a breach outside hours is QUEUED rather than fired: recorded once against
// the position, then executed at the next tick the market is open — and because
// a queued stop is by definition already in trouble, the fill is verified rather
// than assumed. The overnight exposure is real either way; this at least makes
// it visible instead of pretending an order is working.
// Persisted in the state file, not held in memory: the free tier restarts
// overnight, which is precisely the window a queued stop has to survive.
async function manage(cfg) {
  let positions = [];
  try { positions = await vd.evaluatePositions(); } catch (e) { log("error", "evaluate-failed", { error: String(e.message || e) }); return; }
  const open = marketOpen();
  const st = loadState();
  let stDirty = false;

  // Fire anything that queued while we were closed, before the routine pass.
  // A queued stop is by definition already in trouble, so it stays queued until
  // we've actually seen it close — "placed" is not "filled".
  // Wait out the opening auction before firing queued exits. The first minutes
  // carry the widest spreads of the day, and a queued stop crosses the book by
  // design — so firing at 09:30:05 pays the worst spread available precisely
  // when the position is already in trouble. A few minutes lets the book settle.
  // It does NOT improve the price on a real gap: the option is worth what it's
  // worth. It only avoids paying an opening-auction spread on top of the gap.
  const delayMin = cfg.automation?.queuedExitDelayMin ?? 5;
  const sinceOpen = minutesSinceOpen();
  const holdForOpen = open && sinceOpen != null && sinceOpen < delayMin;

  // Say it once, not on every tick of the wait.
  if (open && holdForOpen && Object.keys(st.queuedExits).length && st.queuedWaitDay !== todayISO()) {
    st.queuedWaitDay = todayISO(); stDirty = true;
    log("info", "queued-exit-waiting", {
      count: Object.keys(st.queuedExits).length,
      note: `holding for the opening spread to settle — fires at `
        + `09:${String(30 + delayMin).padStart(2, "0")} ET`,
    });
  }

  if (open && !holdForOpen) {
    for (const [id, q] of Object.entries(st.queuedExits)) {
      const pos = positions.find((x) => x.id === id);
      if (!pos) { delete st.queuedExits[id]; stDirty = true; continue; }
      try {
        const r = await vd.exitTrade({ id, reason: `${q.reason} (queued while closed)`, urgency: q.urgency });
        const done = r.status === "CLOSED" || r.status === "CANCELED";
        log("trade", "queued-exit-fired", {
          ticker: pos.ticker, id, status: r.status,
          queuedFor: `${Math.round((Date.now() - q.queuedAt) / 60000)} min`,
          realizedPnl: r.realizedPnl ?? null, reason: q.reason,
          ...(done ? {} : { note: "NOT filled yet — stays queued and retries every tick until it closes" }),
        });
        if (done) { delete st.queuedExits[id]; stDirty = true; }
      } catch (e) {
        log("error", "queued-exit-failed", { ticker: pos.ticker, id, error: String(e.message || e) });
      }
    }
  }

  for (const p of positions) {
    try {
      if (p.action === "EXIT") {
        if (!open) {
          // Queue it, and say so exactly once.
          if (!st.queuedExits[p.id]) {
            st.queuedExits[p.id] = { reason: `auto: ${p.reason}`, urgency: "urgent", queuedAt: Date.now() };
            stDirty = true;
            log("trade", "exit-queued", {
              ticker: p.ticker, id: p.id, reason: p.reason,
              note: "market closed — order will be placed and verified at the next open. "
                + "The position is unprotected until then.",
            });
          }
          continue;
        }
        const r = await vd.exitTrade({ id: p.id, reason: `auto: ${p.reason}`, urgency: "urgent" });
        log("trade", "auto-exit-stop", {
          ticker: p.ticker, id: p.id, status: r.status,
          realizedPnl: r.realizedPnl ?? null,
          ...(r.pnlIsEstimate ? { note: "P&L estimated — a leg had not filled yet" } : {}),
          reason: p.reason,
        });
      } else if (!open) {
        continue;                 // nothing else is actionable with the market shut
      } else if (p.action === "T1_INFO") {
        // Protect mode: the bot will not bank a trade it did not plan. Say so
        // once per day rather than every 60-second tick.
        const st4 = loadState();
        st4.t1Notified = st4.t1Notified || {};
        if (st4.t1Notified[p.id] !== todayISO()) {
          st4.t1Notified[p.id] = todayISO(); saveState(st4);
          log("trade", "T1-reached-not-taken", {
            ticker: p.ticker, id: p.id, t1: p.t1,
            spot: p.currentSpot, unrealized: p.optPnl,
            note: "protect mode — this position is yours to close. The structural stop "
              + "is still being enforced.",
          });
        }
      } else if (p.action === "T2_HIT") {
        // The runner left over from a scale-out has reached T2 — close it out.
        const r = await vd.exitTrade({ id: p.id, reason: `auto: T2 runner @${p.t2}`, urgency: "patient" });
        if (!(r.status === "EXIT_WORKING" && !r.firstRungPrice)) {
          log("trade", "auto-runner-exit", {
            ticker: p.ticker, id: p.id, status: r.status, t2: p.t2, contracts: p.contracts,
            ...(r.firstRungPrice ? { firstRung: r.firstRungPrice } : {}),
            realizedPnl: r.realizedPnl ?? null,
          });
        }
      } else if (p.action === "T1_HIT") {
        if (cfg.automation.t1Action === "lock-and-ride") {
          if (!p.lockedToBreakeven) { vd.lockToBreakeven({ id: p.id }); log("trade", "auto-lock-be", { ticker: p.ticker, id: p.id, t1: p.t1 }); }
        } else {
          // Scale-out: bank most of it at T1, move the stop to entry, let the
          // rest run to T2. planScaleOut returns null when it can't apply —
          // disabled, or a single contract, which cannot be split.
          const plan = vd.planScaleOut(p.contracts, cfg);
          if (plan) {
            const r = await vd.exitTrade({
              id: p.id, reason: `auto: T1 scale-out @${p.t1}`, urgency: "patient",
              qty: plan.first, moveStopToBreakeven: cfg.scaleOut?.moveStopToBreakeven !== false,
            });
            if (!(r.status === "EXIT_WORKING" && !r.firstRungPrice)) {
              log("trade", "auto-scale-out", {
                ticker: p.ticker, id: p.id, status: r.status, t1: p.t1,
                selling: `${plan.first}/${p.contracts} (${Math.round(plan.pct * 100)}%)`,
                runner: plan.runner, nextTarget: p.t2,
                ...(r.firstRungPrice ? { firstRung: r.firstRungPrice } : {}),
                realizedPnl: r.realizedPnl ?? null,
              });
            }
            continue;
          }
          const r = await vd.exitTrade({ id: p.id, reason: `auto: T1 take-profit @${p.t1}`, urgency: "patient" });
          // A patient exit returns EXIT_WORKING and then keeps returning it every
          // tick while the ladder runs. Log the START of the ladder, not each
          // re-confirmation — the old code logged one line a minute for ten
          // minutes with a mid-price estimate swinging +33 to -180, which read
          // like repeated failures rather than one order patiently working.
          // The fill itself is logged by advanceWorkingOrders as `exit-filled`.
          const quiet = r.status === "EXIT_WORKING" && !r.firstRungPrice;
          if (!quiet) {
            log("trade", "auto-take-profit", {
              ticker: p.ticker, id: p.id, status: r.status, t1: p.t1,
              ...(r.firstRungPrice ? { firstRung: r.firstRungPrice } : {}),
              realizedPnl: r.realizedPnl ?? null,
              estimateWas: p.optPnl ?? null,
              ...(r.pnlIsEstimate ? { note: "P&L estimated — a leg had not filled yet" } : {}),
            });
          }
        }
      }
    } catch (e) {
      log("error", "manage-action-failed", { ticker: p.ticker, id: p.id, error: String(e.message || e) });
    }
  }
  if (stDirty) saveState(st);
}

// ---- DISCOVER: let flow surface new names ---------------------------------
// Runs at most every discovery.everyMinutes (Vol Desk scans are expensive).
// Returns the discovered tickers, which get appended to the watchlist for this
// tick's entry pass. In shadowMode it only logs them and returns nothing.
async function discoverNames(cfg, ctx) {
  const d = cfg.discovery || {};
  if (!d.enabled) return [];
  const st = loadState();
  const gapMs = Math.max(1, d.everyMinutes || 30) * 60 * 1000;
  if (st.lastDiscovery && Date.now() - st.lastDiscovery < gapMs) return st.lastQualified || [];

  const res = await discovery.discover(cfg, ctx);
  st.lastDiscovery = Date.now();
  const names = (res.qualified || []).map((q) => q.ticker);
  st.lastQualified = names;
  saveState(st);

  if (res.qualified?.length) {
    log(d.shadowMode ? "info" : "trade", d.shadowMode ? "discovery-shadow" : "discovery-hit", {
      sources: (res.sources || []).join("+"),
      considered: res.considered, scanned: res.scanned,
      qualified: res.qualified.map((q) => `${q.ticker}(${q.tag},g${q.grade},$${Math.round(q.netPremium / 1000)}k)`).join(" "),
    });
  } else {
    log("info", "discovery-none", {
      sources: (res.sources || []).join("+") || "none",
      considered: res.considered ?? 0, scanned: res.scanned ?? 0, note: res.note || "",
    });
  }
  return d.shadowMode ? [] : names;     // shadow: surface nothing to the buyer
}

// ---- Ensure a fresh snapshot exists before we try to enter ----------------
// enterTrade() needs today's Vol Desk snapshot for its levels. If a name reaches
// the entry stage without one (manual watchlist entry, or a scan that failed
// earlier), the old behaviour was to throw "run a Vol Desk scan first" EVERY
// tick — an error the user cannot act on, repeated once a minute forever.
// Instead: scan it on demand, and back off per-ticker if the scan itself fails
// so a genuinely broken symbol doesn't spin.
async function ensureSnapshot(ticker, cfg, st) {
  if (vd.latestSnapshot(ticker)) return true;

  const backoffMin = cfg.discovery?.scanRetryMin ?? 30;
  st.scanFail = st.scanFail || {};
  const last = st.scanFail[ticker];
  if (last && Date.now() - last < backoffMin * 60 * 1000) return false;   // still backing off

  const r = await discovery.scanTicker(ticker, cfg);
  if (r && !r.error) {
    log("info", "auto-scan", { ticker, tag: r.tag, grade: r.grade ?? null, reason: "no snapshot yet" });
    delete st.scanFail[ticker];
    saveState(st);
    return Boolean(vd.latestSnapshot(ticker));
  }
  st.scanFail[ticker] = Date.now();
  saveState(st);
  log("error", "auto-scan-failed", {
    ticker, error: r?.error || "scan produced no snapshot",
    note: `backing off ${backoffMin}m for this ticker`,
  });
  return false;
}

// ---- ENTER: trigger + flow gated auto-buy ---------------------------------
async function enter(cfg) {
  const a = cfg.automation;
  if (a.mode !== "full") return;                 // exit-only mode never enters
  if (!a.strategies.voldesk) return;             // only wired strategy for now
  if (a.marketHoursOnly && !marketOpen()) return;

  let st = loadState();
  if (st.entries >= a.maxDailyEntries) return;

  // ---- DAILY LOSS CIRCUIT BREAKER -----------------------------------------
  // maxDailyEntries caps how many trades can be OPENED. Nothing capped how much
  // could be lost before opening the next one, so three stop-outs in a row was
  // not an input to the decision to place the fourth. On a day where the tape is
  // simply wrong for a gamma-reclaim system — and there are such days; that is
  // what "bad days" means — the entries cap lets it keep paying to find out.
  //
  // Realized only. Open drawdown is noise until it closes, and marking it would
  // halt entries every time an existing position breathed.
  // Derived from basePremium so it cannot desync when the budget changes. See
  // the note on maxDailyLossMultiple in flow.js — a fixed dollar figure paired
  // with a raised budget halts the bot after its first loser.
  const rkA = cfg.risk || {};
  const mult = rkA.maxDailyLossMultiple ?? 0;
  const maxLoss = mult > 0
    ? Math.abs((rkA.basePremium ?? 0) * mult)
    : Math.abs(rkA.maxDailyLoss ?? 0);
  if (maxLoss > 0) {
    let realizedToday = 0;
    try {
      realizedToday = vd.listAll()
        .filter((p) => p.exitDate === todayISO() && Number.isFinite(p.realizedPnl))
        .reduce((acc, p) => acc + p.realizedPnl, 0);
    } catch {}
    if (realizedToday <= -maxLoss) {
      if (st.lossHaltDay !== todayISO()) {
        st.lossHaltDay = todayISO(); saveState(st);
        log("trade", "daily-loss-halt", {
          realizedToday: Math.round(realizedToday), limit: -Math.round(maxLoss),
          basis: mult > 0 ? `${mult}x basePremium $${rkA.basePremium}` : "absolute",
          note: "no new entries for the rest of the session. Open positions are still "
            + "managed normally — this stops adding risk, it does not stop exits.",
        });
      }
      return;
    }
  }

  let openRows = [];
  try { openRows = vd.listAll().filter((p) => p.status === "OPEN"); } catch {}
  const openTickers = new Set(openRows.map((p) => p.ticker));
  let openCount = openRows.length;

  const now = Date.now();
  const cooldownMs = (a.entryCooldownMin || 0) * 60 * 1000;

  // Candidates, in priority order:
  //   1. READY names from the observe list — vetted over one or more days
  //      (flow still valid + Vol Desk CONFIRMED). This is the main path.
  //   2. Any manual watchlist entries you added by hand.
  //   3. Same-session discovery, if enabled (faster but less vetted).
  const readyTrades = observe.readyTrades();                    // [{ticker, side}]
  const manual = (a.watchlist || []).map((t) => String(t).toUpperCase()).filter(Boolean);
  const found = await discoverNames(cfg, { openTickers, cooldown: st.cooldown || {} });
  // discoverNames persists its own fields — re-read so we don't clobber them.
  st = loadState();
  // Merge into {ticker -> side}; observe wins (it's the vetted source).
  const plan = new Map();
  for (const t of [...manual, ...found]) plan.set(t, "long");
  for (const r of readyTrades) plan.set(r.ticker, r.side);
  const watch = [...plan.keys()];
  if (!watch.length) return;

  for (const ticker of watch) {
    if (openCount >= a.maxConcurrent) break;
    if (st.entries >= a.maxDailyEntries) break;
    if (openTickers.has(ticker)) continue;                       // already in it
    if (cooldownMs && st.cooldown[ticker] && now - st.cooldown[ticker] < cooldownMs) continue;

    try {
      const side = plan.get(ticker) || "long";
      // No snapshot -> scan now rather than failing every tick.
      if (!(await ensureSnapshot(ticker, cfg, st))) continue;
      const conviction = await flow.getConviction(ticker, cfg);
      const decision = flow.decideForTrade(conviction, cfg, side);

      const r = await vd.enterTrade({
        ticker, side, riskPremium: cfg.risk.basePremium, confirm: true, force: false,
        flowDecision: { conviction, decision },
      });

      if (r.status === "WORKING") {
        // Ladder started — not a position yet. Count it against the daily cap so
        // we don't queue five ladders at once, and let the loop work it.
        st.entries++; st.cooldown[ticker] = now; saveState(st);
        log("trade", "entry-working", {
          ticker, side, contracts: r.contracts,
          firstRung: r.firstRungPrice,
          ...(r.sizing ? {
            costPerContract: r.sizing.costPerContract,
            budget: r.sizing.budget, sizingMode: r.sizing.mode,
            ...(r.sizing.notes ? { sizingNotes: r.sizing.notes.join("; ") } : {}),
            ...(r.sizing.cheaperSearch?.found ? { foundCheaper: `under $${r.sizing.cheaperSearch.ceiling}` } : {}),
            ...(r.sizing.budgetClampedByCash
              ? { CASH_CAPPED: `budget cut to $${r.sizing.budget} by buying power` } : {}),
            ...(r.sizing.budgetBusted
              ? { OVER_BUDGET: `${r.sizing.overrunRatio}x — 1 contract costs more than the budget` }
              : {}),
          } : {}),
          note: r.note,
        });
      } else if (r.status === "ENTERED") {
        openCount++; openTickers.add(ticker);
        st.entries++; st.cooldown[ticker] = now; saveState(st);
        try { observe.markEntered(ticker, r.position?.id); } catch {}   // off the list, it's a position now
        log("trade", "auto-entry", {
          ticker, side, instrument: r.instrument || "option",
          id: r.position.id, contracts: r.position.contracts ?? r.position.shares,
          flowStance: decision.stance, flowMult: decision.sizeMultiplier,
          flowDir: decision.flowDirection, flowScore: decision.flowScore,
          budget: r.position.effectiveBudget,
        });
      } else {
        // NOT_TRIGGERED / FLOW_BLOCKED — normal, quiet. Cooldown so we don't
        // re-price the same reject every single poll.
        st.cooldown[ticker] = now; saveState(st);
        // A broken structure is not a "try again in 30 minutes" — spot is
        // through the stop, so there is no entry left at any price today. Leaving
        // it on the observe list just re-prices a dead setup every cooldown.
        if (r.status === "STRUCTURE_BROKEN") {
          try { observe.drop(ticker, r.note || "structure broken pre-entry"); } catch {}
        }
        log("info", "entry-skip", {
          ticker, side, status: r.status,
          // The anti-chase and instrument-routing rejections carry the numbers
          // that explain them. Logging the status alone turns a diagnosis into a
          // shrug, and these are exactly the ones worth reading back over a week
          // to see whether the thresholds are set right.
          ...(r.status === "CHASED"
            ? { rrAtFill: r.rrAtFill, floor: r.minRRAtFill, extension: `${r.extensionPct}%`,
                spot: r.spot, trigger: r.trigger, t1: r.t1,
                // Not a permanent no — the loop keeps re-checking. This is the
                // level to watch for.
                ...(r.entersAt != null
                  ? { WATCH: `enters at ${r.entersAt} (${r.needsMovePct}%)` } : {}) }
            : {}),
          ...(r.status === "STRUCTURE_BROKEN" ? { spot: r.spot, stop: r.stop } : {}),
          ...(r.status === "NO_QUALIFYING_CONTRACT"
            ? { evaluated: r.evaluated ?? 0, rrAtFill: r.rrAtFill,
                whyRejected: (r.rejected || []).slice(0, 3)
                  .map((x) => `${x.strike}:${(x.reasons || []).join("/")}`).join(" | ") || "-" }
            : {}),
          ...(r.status === "NO_UPSIDE" ? { spot: r.spot, t1: r.t1 } : {}),
          ...(r.status === "TOO_EXPENSIVE" || r.status === "INSUFFICIENT_FUNDS"
            ? {
                costPerContract: r.costPerContract, budget: r.budget,
                ...(r.buyingPower != null ? { buyingPower: r.buyingPower } : {}),
                ...(r.overrunRatio != null ? { overrun: `${r.overrunRatio}x` } : {}),
                ...(r.cheaperSearch ? { noCheaperUnder: `$${r.cheaperSearch.ceiling}` } : {}),
              }
            : {}),
          ...(r.status === "NOT_CONFIRMED"
            ? { tag: r.tag, grade: r.grade, blockers: (r.blockers || []).join(",") }
            : {}),
          note: r.note || decision.stance,
        });
      }
    } catch (e) {
      log("error", "entry-failed", { ticker, error: String(e.message || e) });
    }
  }
}

// ---- Observe-list re-assessment --------------------------------------------
// This used to be gated by `st.lastAssessDay === todayISO()` — once per calendar
// day, full stop. That single line was the reason the list felt frozen: a name
// that firmed up at 10:15 could not be promoted to READY until tomorrow, and by
// tomorrow the reclaim it was waiting for had happened without us. Discovery was
// already running every 30 minutes and feeding an assessment that ran once.
//
// Now it runs on a cadence. observe.assessAll() does its own per-row throttling
// (observe.assessEveryMinutes), so calling it more often is cheap — rows that
// were read recently return "skipped" without spawning a scan. The gate here
// only exists to keep the log readable and to leave headroom in the tick.
async function maybeAssess(cfg) {
  try {
    const st = loadState();
    const rowGap = cfg.observe?.assessEveryMinutes ?? 60;
    const gapMs = Math.max(5, Math.floor(rowGap / 2)) * 60 * 1000;
    if (st.lastAssessAt && Date.now() - st.lastAssessAt < gapMs) return;
    if (!observe.activeList().length) return;

    const r = await observe.assessAll(cfg);
    const st2 = loadState();
    st2.lastAssessAt = Date.now();
    const firstToday = st2.lastAssessDay !== todayISO();
    st2.lastAssessDay = todayISO();
    saveState(st2);

    // Silence when nothing moved. A pass where every row was throttled is not
    // news, and burying real drops under identical hourly lines is how you stop
    // reading the log.
    if (r.assessed || r.dropped.length || r.flipped.length) {
      log("info", "observe-assessed", {
        assessed: r.assessed, skipped: r.skipped ?? 0,
        ready: r.ready.join(",") || "-",
        ...(r.flipped.length ? { SIDE_FLIPPED: r.flipped.join(" ") } : {}),
        dropped: r.dropped.map((d) => `${d.ticker}(${d.reason})`).join("; ") || "-",
      });
    }
    if (firstToday) observe.prune(30);
  } catch (e) {
    log("error", "observe-assess-failed", { error: String(e.message || e) });
  }
}

// ---- Periodic reconcile ----------------------------------------------------
// This used to run ONCE, on boot. Everything it detects — a position closed by
// hand, an entry that filled after we stopped looking, something at the broker
// the store has never heard of — can happen at any point in a session, and until
// the next restart the bot simply would not know. On a host that redeploys (and
// wipes data/) that window can be the whole day.
//
// It is a handful of GETs, so running it every `reconcileEveryMin` is cheap. The
// untracked warning is repeated on every pass rather than logged once at boot,
// because an unmanaged position is an ongoing condition, not a startup event.
async function maybeReconcile(cfg) {
  try {
    const st = loadState();
    const gapMin = cfg.reconcile?.everyMinutes ?? 30;
    if (st.lastReconcileAt && Date.now() - st.lastReconcileAt < gapMin * 60 * 1000) return;

    const r = await reconcile.reconcile({ apply: true, cfg });
    const st2 = loadState();
    st2.lastReconcileAt = Date.now();
    saveState(st2);

    if (r.phantomsClosed.length || r.entriesResolved.length || r.adopted?.length) {
      log("trade", "reconciled", {
        summary: reconcile.summarize(r),
        ...(r.adopted?.length
          ? { ADOPTED: r.adopted.map((a) => `${a.symbol}(stop ${a.stop} t1 ${a.t1})`).join(" ") }
          : {}),
        ...(r.phantomsClosed.length
          ? { closed: r.phantomsClosed.map((x) => x.ticker).join(" ") } : {}),
      });
    }
    const st3 = loadState();
    st3.lastUntracked = r.untracked.map((u) => ({
      symbol: u.symbol, qty: u.qty, unrealizedPl: u.unrealizedPl,
      marketValue: u.marketValue, adoptFailed: u.adoptFailed || null,
    }));
    saveState(st3);

    if (r.untracked.length) {
      log("error", "UNTRACKED-POSITIONS", {
        count: r.untracked.length,
        positions: r.untracked.map((u) => `${u.symbol}x${u.qty}(${u.unrealizedPl})`).join(" "),
        ...(r.untracked.some((u) => u.adoptFailed)
          ? { adoptFailed: r.untracked.filter((u) => u.adoptFailed)
              .map((u) => `${u.symbol}:${u.adoptFailed}`).join("; ") } : {}),
        note: "these are held at the broker with NO stop, target or time limit being "
          + "applied. Set reconcile.adoptUntracked=true to manage them, or close by hand.",
      });
    }
  } catch (e) {
    log("error", "reconcile-failed", { error: String(e.message || e) });
  }
}

// ---- Housekeeping: prune data/ once per day --------------------------------
function maybeSweep(cfg) {
  try {
    const st = loadState();
    if (st.lastSweepDay === todayISO()) return;
    const r = housekeeping.sweep(cfg);
    st.lastSweepDay = todayISO();
    saveState(st);
    log("info", "housekeeping", {
      snapshotsRemoved: r.snapshots.removed, tradesRolled: r.trades.rolled,
      dataMB: r.after.dataMB, freedMB: r.freedMB, ...(r.warning ? { warning: r.warning } : {}),
    });
  } catch (e) {
    log("error", "housekeeping-failed", { error: String(e.message || e) });
  }
}

// ---- tick ------------------------------------------------------------------
async function tick() {
  if (busy) return;                              // never overlap ticks
  busy = true;
  try {
    const cfg = flow.loadConfig();
    if (!cfg.automation.enabled) { stop(true); return; }
    // Advance any patient ladders FIRST — they're non-blocking, so this is quick,
    // and a fill here should be managed in the same tick.
    await advanceWorkingOrders(cfg);
    await manage(cfg);                            // always manage exits
    await maybeReconcile(cfg);                    // broker truth, not just at boot
    await maybeAssess(cfg);                       // re-vet the observe list
    await enter(cfg);                             // enter only in full + hours
    maybeSweep(cfg);                              // bound disk growth (once/day)
  } catch (e) {
    log("error", "tick-failed", { error: String(e.message || e) });
  } finally {
    busy = false;
  }
}

// ---- control ---------------------------------------------------------------
export function start() {
  const cfg = flow.saveConfig({ automation: { enabled: true } });
  if (timer) return status();
  const ms = Math.max(10, cfg.automation.pollSeconds) * 1000;
  timer = setInterval(tick, ms);
  log("info", "started", { mode: cfg.automation.mode, pollSeconds: cfg.automation.pollSeconds });
  tick();                                          // run one immediately
  return status();
}

export function stop(silent = false) {
  if (timer) { clearInterval(timer); timer = null; }
  flow.saveConfig({ automation: { enabled: false } });
  if (!silent) log("info", "stopped", {});
  return status();
}

// ---- Data-loss detection ---------------------------------------------------
// On a host without a persistent disk (Render free), every restart/redeploy wipes
// data/ — the uploaded flow cache AND the observe list vanish. That's silent
// unless we say so, and a silent empty observe list looks identical to "nothing
// qualified today". So on boot we check for the telltale signs and raise a flag
// the UI shows prominently until you re-upload.
export function dataHealth(cfg = flow.loadConfig()) {
  const cs = flow.cacheStatus(cfg);
  let observing = 0, everTraded = 0;
  try { observing = observe.activeList().length; } catch {}
  try { everTraded = vd.listAll().length; } catch {}
  const usingOptionStrat = cfg.flow.sources.optionstrat && !cfg.flow.sources.unusualwhales;
  const needsUpload = usingOptionStrat && !cs.present;
  return {
    needsUpload,
    flowPresent: cs.present,
    flowAgeDays: cs.ageDays ?? null,
    observing,
    knownPositions: everTraded,
    message: needsUpload
      ? (observing === 0 && everTraded === 0
        ? "No flow data and nothing tracked — if this follows a restart/redeploy, your data was reset. Re-upload tonight's flow to resume finding trades."
        : "No flow_cache.json on the server — upload flow to keep discovery running.")
      : null,
  };
}

// Boot: auto-start only if the config was left enabled.
export function boot() {
  const cfg = flow.loadConfig();
  // Overnight (or any downtime) the broker kept living while we didn't. Sync the
  // local store to reality BEFORE the loop starts managing anything, so we never
  // chase a position that no longer exists or ignore one that silently filled.
  // Collapse any duplicate rows written before adoptPosition became idempotent.
  try {
    const d = vd.dedupeOpen();
    if (d.collapsed.length) {
      log("info", "duplicates-collapsed", {
        count: d.collapsed.length,
        symbols: d.collapsed.map((x) => x.symbol).join(" "),
        note: "written by two reconciles racing at boot; now prevented at the source",
      });
    }
  } catch {}

  reconcile.reconcile({ apply: true })
    .then((r) => {
      // Stamp the clock so the first tick does not immediately reconcile again.
      // Not doing so is half of why positions were adopted twice.
      try { const st = loadState(); st.lastReconcileAt = Date.now(); saveState(st); } catch {}
      log(r.untracked.length || r.phantomsClosed.length ? "error" : "info",
        "reconciled-with-broker", {
          summary: reconcile.summarize(r),
          ...(r.phantomsClosed.length ? { closed: r.phantomsClosed.map((x) => `${x.ticker}:${x.orderStatus || "?"}`).join(" ") } : {}),
          ...(r.entriesResolved.length ? { entries: r.entriesResolved.map((x) => `${x.ticker}:${x.action}`).join(" ") } : {}),
          ...(r.untracked.length ? { untracked: r.untracked.map((x) => `${x.symbol}x${x.qty}`).join(" ") } : {}),
        });
    })
    .catch((e) => log("error", "reconcile-failed", { error: String(e.message || e) }));
  try {
    const h = dataHealth(cfg);
    if (h.needsUpload) log("error", "needs-flow-upload", { message: h.message, observing: h.observing });
    else log("info", "boot-data-ok", { flowAgeDays: h.flowAgeDays, observing: h.observing });
  } catch {}
  if (cfg.automation.enabled) {
    const ms = Math.max(10, cfg.automation.pollSeconds) * 1000;
    timer = setInterval(tick, ms);
    log("info", "auto-started-on-boot", { mode: cfg.automation.mode });
    tick();
  }
}

export function status() {
  const cfg = flow.loadConfig();
  const st = loadState();
  let open = 0;
  try { open = vd.listAll().filter((p) => p.status === "OPEN").length; } catch {}
  let flowCache = null, observing = 0, ready = [];
  try { flowCache = flow.cacheStatus(cfg); } catch {}
  try { observing = observe.activeList().length; ready = observe.readyTickers(); } catch {}
  return {
    running: Boolean(timer),
    marketOpen: marketOpen(),
    config: cfg,
    flowCache,                                  // freshness of the uploaded book
    keepAlive: (() => { try { return pingStatus(); } catch { return null; } })(),
    dataHealth: (() => { try { return dataHealth(cfg); } catch { return null; } })(),
    observing, ready,
    dailyEntries: st.entries,
    openPositions: open,
    // Last known unmanaged positions, so the UI can show them rather than
    // leaving the condition buried in a log line from boot.
    untracked: st.lastUntracked || [],
    lastReconcileAt: st.lastReconcileAt || null,
    log: readJson(LOG, []).slice(-50).reverse(),
  };
}

export function recentLog(n = 100) { return readJson(LOG, []).slice(-n).reverse(); }
