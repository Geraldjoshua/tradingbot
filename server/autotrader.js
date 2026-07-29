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

// ---- ENTER: trigger + flow gated auto-buy ---------------------------------
async function enter(cfg) {
  const a = cfg.automation;
  if (a.mode !== "full") return;                 // exit-only mode never enters
  if (!a.strategies.voldesk) return;             // only wired strategy for now
  if (a.marketHoursOnly && !marketOpen()) return;

  const watch = (a.watchlist || []).map((t) => String(t).toUpperCase()).filter(Boolean);
  if (!watch.length) return;

  const st = loadState();
  if (st.entries >= a.maxDailyEntries) return;

  let openRows = [];
  try { openRows = vd.listAll().filter((p) => p.status === "OPEN"); } catch {}
  const openTickers = new Set(openRows.map((p) => p.ticker));
  let openCount = openRows.length;

  const now = Date.now();
  const cooldownMs = (a.entryCooldownMin || 0) * 60 * 1000;

  for (const ticker of watch) {
    if (openCount >= a.maxConcurrent) break;
    if (st.entries >= a.maxDailyEntries) break;
    if (openTickers.has(ticker)) continue;                       // already in it
    if (cooldownMs && st.cooldown[ticker] && now - st.cooldown[ticker] < cooldownMs) continue;

    try {
      const conviction = await flow.getConviction(ticker, cfg);
      const decision = flow.decideForTrade(conviction, cfg, "long");

      const r = await vd.enterTrade({
        ticker, riskPremium: cfg.risk.basePremium, confirm: true, force: false,
        flowDecision: { conviction, decision },
      });

      if (r.status === "ENTERED") {
        openCount++; openTickers.add(ticker);
        st.entries++; st.cooldown[ticker] = now; saveState(st);
        log("trade", "auto-entry", {
          ticker, id: r.position.id, contracts: r.position.contracts,
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

// ---- tick ------------------------------------------------------------------
async function tick() {
  if (busy) return;                              // never overlap ticks
  busy = true;
  try {
    const cfg = flow.loadConfig();
    if (!cfg.automation.enabled) { stop(true); return; }
    await manage(cfg);                            // always manage exits
    await enter(cfg);                             // enter only in full + hours
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

// Boot: auto-start only if the config was left enabled.
export function boot() {
  const cfg = flow.loadConfig();
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
  return {
    running: Boolean(timer),
    marketOpen: marketOpen(),
    config: cfg,
    dailyEntries: st.entries,
    openPositions: open,
    log: readJson(LOG, []).slice(-50).reverse(),
  };
}

export function recentLog(n = 100) { return readJson(LOG, []).slice(-n).reverse(); }
