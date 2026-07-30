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
  const s = readJson(STATE, { day: todayISO(), entries: 0, cooldown: {} });
  if (s.day !== todayISO()) { s.day = todayISO(); s.entries = 0; s.cooldown = {}; } // reset daily
  return s;
}
function saveState(s) { writeJson(STATE, s); }

// ---- market-hours guard (ET, 09:30-16:00, Mon-Fri) ------------------------
const fmtET = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", hour12: false, weekday: "short",
  hour: "2-digit", minute: "2-digit",
});
function marketOpen(now = new Date()) {
  const p = Object.fromEntries(fmtET.formatToParts(now).map((o) => [o.type, o.value]));
  const dow = p.weekday;
  if (dow === "Sat" || dow === "Sun") return false;
  let h = parseInt(p.hour, 10); if (h === 24) h = 0;
  const min = h * 60 + parseInt(p.minute, 10);
  return min >= 570 && min < 960; // 09:30 .. 16:00
}

// ---- MANAGE: auto take-profit + auto-stop ---------------------------------
async function manage(cfg) {
  let positions = [];
  try { positions = await vd.evaluatePositions(); } catch (e) { log("error", "evaluate-failed", { error: String(e.message || e) }); return; }
  for (const p of positions) {
    try {
      if (p.action === "EXIT") {
        const r = await vd.exitTrade({ id: p.id, reason: `auto: ${p.reason}` });
        log("trade", "auto-exit-stop", { ticker: p.ticker, id: p.id, status: r.status, reason: p.reason });
      } else if (p.action === "T1_HIT") {
        if (cfg.automation.t1Action === "lock-and-ride") {
          if (!p.lockedToBreakeven) { vd.lockToBreakeven({ id: p.id }); log("trade", "auto-lock-be", { ticker: p.ticker, id: p.id, t1: p.t1 }); }
        } else {
          const r = await vd.exitTrade({ id: p.id, reason: `auto: T1 take-profit @${p.t1}` });
          log("trade", "auto-take-profit", { ticker: p.ticker, id: p.id, status: r.status, t1: p.t1, optPnl: p.optPnl });
        }
      }
    } catch (e) {
      log("error", "manage-action-failed", { ticker: p.ticker, id: p.id, error: String(e.message || e) });
    }
  }
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

// ---- ENTER: trigger + flow gated auto-buy ---------------------------------
async function enter(cfg) {
  const a = cfg.automation;
  if (a.mode !== "full") return;                 // exit-only mode never enters
  if (!a.strategies.voldesk) return;             // only wired strategy for now
  if (a.marketHoursOnly && !marketOpen()) return;

  let st = loadState();
  if (st.entries >= a.maxDailyEntries) return;

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
      const conviction = await flow.getConviction(ticker, cfg);
      const decision = flow.decideForTrade(conviction, cfg, side);

      const r = await vd.enterTrade({
        ticker, side, riskPremium: cfg.risk.basePremium, confirm: true, force: false,
        flowDecision: { conviction, decision },
      });

      if (r.status === "ENTERED") {
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
        log("info", "entry-skip", { ticker, status: r.status, note: r.note || decision.stance });
      }
    } catch (e) {
      log("error", "entry-failed", { ticker, error: String(e.message || e) });
    }
  }
}

// ---- Daily observe-list re-assessment --------------------------------------
// Runs once per day, pre-open if possible, so READY/DROPPED status is fresh
// before the trigger window. This is the "next day, if it still meets every
// requirement, take it — otherwise don't" step.
async function maybeAssess(cfg) {
  try {
    const st = loadState();
    if (st.lastAssessDay === todayISO()) return;
    if (!observe.activeList().length) return;
    const r = await observe.assessAll(cfg);
    const st2 = loadState();
    st2.lastAssessDay = todayISO();
    saveState(st2);
    log("info", "observe-assessed", {
      assessed: r.assessed,
      ready: r.ready.join(",") || "-",
      dropped: r.dropped.map((d) => `${d.ticker}(${d.reason})`).join("; ") || "-",
    });
    observe.prune(30);
  } catch (e) {
    log("error", "observe-assess-failed", { error: String(e.message || e) });
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
    await manage(cfg);                            // always manage exits
    await maybeAssess(cfg);                       // re-vet the observe list (once/day)
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
    dataHealth: (() => { try { return dataHealth(cfg); } catch { return null; } })(),
    observing, ready,
    dailyEntries: st.entries,
    openPositions: open,
    log: readJson(LOG, []).slice(-50).reverse(),
  };
}

export function recentLog(n = 100) { return readJson(LOG, []).slice(-n).reverse(); }
