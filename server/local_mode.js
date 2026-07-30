// LOCAL MODE — one command runs the whole thing on your laptop.
//
// The cloud deployment needed three separate moving parts because Render can't
// run a browser and its disks don't span services: you ran the scraper yourself,
// then uploaded workbooks, then the bot ingested them. Locally that's all one
// filesystem, so the whole chain collapses into a single process tree:
//
//   npm start
//     ├── Express + built UI            http://localhost:3001
//     ├── auto-trader loop              (entries, exits, daily re-assessment)
//     └── LOCAL MODE (this file)
//           ├── scraper supervisor      flow/scraper_service.py as a child:
//           │     scrapes 09:25-16:05 ET, restarts if it dies, and after the
//           │     close builds masters -> flow_cache.json IN PLACE
//           └── cache watcher           notices flow_cache.json change ->
//                 runs discovery -> seeds the observe list automatically
//
// No upload step. No push token. No keep-alive (nothing to keep awake).
//
// The watcher is the neat part: it reacts to the cache file changing regardless
// of WHO wrote it — the local scraper, a manual upload through the UI, or a push
// from another machine. One code path feeds the bot in every case.

import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import * as flow from "./flow.js";
import * as discovery from "./discovery.js";
import * as observe from "./observe.js";
import * as vdTrades from "./voldesk_trades.js";
import { pythonPath } from "./pythonPath.js";
import * as wakelock from "./wakelock.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOG_PREFIX = "[local]";

let scraper = null;
let watcher = null;
let ingestTimer = null;
let lastIngestAt = 0;
let stopping = false;

const log = (...a) => console.log(LOG_PREFIX, ...a);

function flowDir(cfg = flow.loadConfig()) {
  // Default to <project>/data/flow so everything the app owns lives under data/.
  return cfg.flow.optionstratDir || process.env.OPTIONSTRAT_DIR || path.join(ROOT, "data", "flow");
}

// ---- Scraper supervisor ----------------------------------------------------
// scraper_service.py already handles market-hours gating, restarting the browser
// if it dies, and the post-close build. We just keep IT alive and hand it the
// right directory. If it exits (crash, Playwright missing) we back off and retry
// rather than spinning.
function startScraper(cfg) {
  if (process.env.LOCAL_SCRAPER === "off") { log("scraper disabled (LOCAL_SCRAPER=off)"); return; }
  const dir = flowDir(cfg);
  fs.mkdirSync(dir, { recursive: true });

  const env = {
    ...process.env,
    OPTIONSTRAT_DIR: dir,
    SCRAPER_HEADLESS: process.env.SCRAPER_HEADLESS || "true",
    SCRAPER_FEEDS: process.env.SCRAPER_FEEDS || "live",
    MARKET_HOURS_ONLY: process.env.MARKET_HOURS_ONLY || "true",
    BUILD_EVERY_MIN: process.env.BUILD_EVERY_MIN || "15",
    OPTIONSTRAT_PROFILE_DIR: path.join(dir, "optionstrat_profile"),
    PYTHONUNBUFFERED: "1",
  };
  // No FLOW_PUSH_URL locally — the cache is already where the bot reads it.
  delete env.FLOW_PUSH_URL;

  log(`starting scraper -> ${dir} (feeds=${env.SCRAPER_FEEDS}, headless=${env.SCRAPER_HEADLESS})`);
  scraper = spawn(pythonPath(), [path.join(ROOT, "flow", "scraper_service.py")], { env });

  scraper.stdout.on("data", (d) => process.stdout.write(`[scraper] ${d}`));
  scraper.stderr.on("data", (d) => process.stderr.write(`[scraper] ${d}`));
  scraper.on("error", (e) => log(`scraper spawn failed: ${e.message} — is Playwright installed? (npm run setup)`));
  scraper.on("close", (code) => {
    scraper = null;
    if (stopping) return;
    log(`scraper exited (code ${code}) — retrying in 60s`);
    setTimeout(() => { if (!stopping) startScraper(flow.loadConfig()); }, 60000);
  });
}

// ---- Auto-ingest on cache change ------------------------------------------
// Debounced: the builder writes the file once but editors/OS can emit several
// events, and a rebuild mid-write would give us a truncated JSON.
async function ingestNow(reason) {
  const cfg = flow.loadConfig();
  try {
    const openTickers = new Set(
      vdTrades.listAll().filter((p) => p.status === "OPEN").map((p) => p.ticker));
    const disc = await discovery.discover(cfg, { openTickers, cooldown: {} });
    const seeded = observe.seed(disc.watch || disc.qualified || [], cfg);
    log(`auto-ingest (${reason}): ${disc.considered ?? 0} considered, ${disc.scanned ?? 0} scanned, `
      + `tags ${JSON.stringify(disc.tagCounts || {})}, `
      + `+${seeded.added.length ? seeded.added.join("/") : "none"} observing (${seeded.observing} total)`);
    lastIngestAt = Date.now();
  } catch (e) {
    log(`auto-ingest failed: ${String(e.message || e)}`);
  }
}

function scheduleIngest(reason, delayMs = 4000) {
  if (ingestTimer) clearTimeout(ingestTimer);
  ingestTimer = setTimeout(() => { ingestTimer = null; ingestNow(reason); }, delayMs);
}

function watchCache(cfg) {
  const dir = flowDir(cfg);
  fs.mkdirSync(dir, { recursive: true });
  const target = "flow_cache.json";
  try {
    watcher = fs.watch(dir, (event, filename) => {
      if (filename === target) scheduleIngest("flow_cache.json changed");
    });
    log(`watching ${path.join(dir, target)} — ingest runs automatically when it updates`);
  } catch (e) {
    log(`could not watch ${dir}: ${e.message} — falling back to polling`);
    let lastMtime = 0;
    setInterval(() => {
      try {
        const m = fs.statSync(path.join(dir, target)).mtimeMs;
        if (m > lastMtime) { lastMtime = m; scheduleIngest("cache mtime changed"); }
      } catch {}
    }, 60000).unref?.();
  }
}

// ---- Boot: re-read the master workbooks ------------------------------------
// Rebuilds flow_cache.json from flow_master.xlsx (+ unusual/knows) and then
// ingests. Idempotent and safe to run on every start.
function rebuildFromMasters(dir) {
  return new Promise((resolve) => {
    const masters = ["flow_master.xlsx", "flow_unusual_master.xlsx", "flow_knows_master.xlsx"]
      .filter((f) => fs.existsSync(path.join(dir, f)));
    const dayCsvs = (() => {
      try { return fs.readdirSync(dir).filter((f) => /^flow_.*\.csv$/i.test(f)); } catch { return []; }
    })();

    if (!masters.length && !dayCsvs.length) {
      log("no master workbooks yet — the scraper will create them after today's close");
      return resolve(false);
    }
    log(`re-reading ${masters.length ? masters.join(", ") : `${dayCsvs.length} day-csv(s)`} …`);

    const child = spawn(pythonPath(), [path.join(ROOT, "flow", "build_flow_cache.py"), dir],
      { env: { ...process.env, OPTIONSTRAT_DIR: dir } });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => { log(`cache rebuild failed to start: ${e.message}`); resolve(false); });
    child.on("close", (code) => {
      const line = (out || err).trim().split("\n").pop() || "";
      if (code === 0) {
        log(`cache rebuilt from masters: ${line}`);
        scheduleIngest("cache rebuilt from masters on boot", 1500);
        resolve(true);
      } else {
        log(`cache rebuild failed (code ${code}): ${line.slice(0, 200)}`);
        // Still try to ingest — a previous cache may be usable.
        if (fs.existsSync(path.join(dir, "flow_cache.json"))) scheduleIngest("existing cache on boot", 3000);
        resolve(false);
      }
    });
  });
}

// ---- Public ---------------------------------------------------------------
export function startLocalMode() {
  const cfg = flow.loadConfig();
  const dir = flowDir(cfg);
  log("LOCAL MODE on — scraper + auto-ingest + trading loop in one process");
  log(`flow dir: ${dir}`);

  // Persist the resolved dir so the UI, upload route and flow reader all agree.
  if (!cfg.flow.optionstratDir) {
    try { flow.saveConfig({ flow: { optionstratDir: dir } }); log("pinned flow.optionstratDir in config"); }
    catch {}
  }

  // Keep the machine awake — a sleeping laptop cannot fire a stop-loss.
  wakelock.acquire();

  watchCache(cfg);

  // EVERY BOOT: rebuild the cache straight from the master workbooks, then ingest.
  // You shut the laptop down each evening, so each morning is a cold start — the
  // masters on disk are the durable record, and re-reading them means the observe
  // list is repopulated from your full accumulated history without waiting for the
  // first scrape cycle (or caring whether yesterday's cache survived).
  rebuildFromMasters(dir).then(() => startScraper(cfg));

  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    log("shutting down…");
    try { watcher?.close(); } catch {}
    try { wakelock.release(); } catch {}
    if (scraper && scraper.exitCode == null) {
      try { scraper.kill(); } catch {}
    }
    setTimeout(() => process.exit(0), 1500);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

export function localStatus() {
  const cfg = flow.loadConfig();
  return {
    enabled: true,
    flowDir: flowDir(cfg),
    scraperRunning: Boolean(scraper && scraper.exitCode == null),
    scraperPid: scraper?.pid ?? null,
    scraperDisabled: process.env.LOCAL_SCRAPER === "off",
    watching: Boolean(watcher),
    lastAutoIngest: lastIngestAt ? new Date(lastIngestAt).toISOString() : null,
    wakelock: wakelock.status(),
  };
}

export function triggerIngest() { scheduleIngest("manual trigger", 0); return { ok: true }; }

// Re-read the master workbooks on demand (the same thing that runs at boot).
export async function triggerRebuild() {
  const dir = flowDir();
  const ok = await rebuildFromMasters(dir);
  return { ok, dir, note: ok ? "cache rebuilt from masters; ingest queued" : "no masters found yet" };
}
