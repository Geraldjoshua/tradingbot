// Storage housekeeping.
//
// Several things in data/ grow without bound and nothing was pruning them:
//
//   data/voldesk/<TICKER>/<YYYY-MM-DD>.json   one snapshot per ticker PER DAY.
//        With discovery scanning ~8 new names every 30 min, this is the fastest
//        grower by file count. latestSnapshot() does a readdirSync + sort on
//        this folder on every evaluation, so thousands of files also make the
//        hot path slower, not just fatter.
//   data/voldesk_trades.json                  every position ever, incl. closed.
//   data/autotrader_log.json                  already capped at 500 entries.
//   data/marketcap_cache.json                 self-pruning (keeps today only).
//
// This module enforces retention and reports usage. It runs once per day from
// the auto-trader tick, and can be triggered via GET /api/storage?sweep=1.
//
// Design choice: we PRUNE rather than archive-to-disk, because the whole point
// is bounding growth. Closed trades are the exception — they're the P&L record,
// so we keep the most recent N and roll the rest into a compact summary.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "data");
const SNAP_DIR = path.join(DATA, "voldesk");
const TRADES = path.join(DATA, "voldesk_trades.json");
const SUMMARY = path.join(DATA, "voldesk_closed_summary.json");

export const RETENTION_DEFAULTS = {
  snapshotDays: 30,        // keep this many days of snapshots per ticker
  snapshotsPerTicker: 40,  // hard cap per ticker regardless of age
  keepClosedTrades: 200,   // most recent closed/canceled positions kept in full
  maxDataMB: 200,          // warn above this
};

function readJson(p, fb) { try { return JSON.parse(fs.readFileSync(p)); } catch { return fb; } }
function writeJson(p, v) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(v, null, 2));
}

function dirSize(dir) {
  let bytes = 0, files = 0;
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        try { bytes += fs.statSync(p).size; files++; } catch {}
      }
    }
  };
  walk(dir);
  return { bytes, files };
}

// ---- Prune per-ticker snapshots -------------------------------------------
function pruneSnapshots(r) {
  if (!fs.existsSync(SNAP_DIR)) return { removed: 0, tickers: 0 };
  const cutoff = new Date(Date.now() - r.snapshotDays * 864e5).toISOString().slice(0, 10);
  let removed = 0, tickers = 0;

  for (const t of fs.readdirSync(SNAP_DIR)) {
    const dir = path.join(SNAP_DIR, t);
    let files;
    try {
      if (!fs.statSync(dir).isDirectory()) continue;
      files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort(); // date-named => lexical = chronological
    } catch { continue; }
    if (!files.length) continue;
    tickers++;

    // Always keep the newest file — latestSnapshot() depends on it existing.
    const newest = files[files.length - 1];
    const doomed = new Set();
    for (const f of files) {
      if (f === newest) continue;
      if (f.slice(0, 10) < cutoff) doomed.add(f);
    }
    // Enforce the per-ticker count cap (oldest first), still sparing newest.
    const survivors = files.filter((f) => !doomed.has(f));
    const excess = survivors.length - r.snapshotsPerTicker;
    if (excess > 0) for (const f of survivors.slice(0, excess)) if (f !== newest) doomed.add(f);

    for (const f of doomed) {
      try { fs.unlinkSync(path.join(dir, f)); removed++; } catch {}
    }
    // Drop the folder entirely if we emptied it.
    try { if (!fs.readdirSync(dir).length) fs.rmdirSync(dir); } catch {}
  }
  return { removed, tickers };
}

// ---- Roll old closed trades into a summary --------------------------------
function pruneTrades(r) {
  const rows = readJson(TRADES, []);
  if (!Array.isArray(rows) || !rows.length) return { kept: 0, rolled: 0 };
  const open = rows.filter((p) => p.status === "OPEN");
  const done = rows.filter((p) => p.status !== "OPEN");
  if (done.length <= r.keepClosedTrades) return { kept: rows.length, rolled: 0 };

  const byDate = [...done].sort((a, b) => String(a.exitDate || a.entryDate).localeCompare(String(b.exitDate || b.entryDate)));
  const roll = byDate.slice(0, done.length - r.keepClosedTrades);
  const keep = byDate.slice(done.length - r.keepClosedTrades);

  // Compact P&L summary so history isn't lost outright.
  const sum = readJson(SUMMARY, { rolledCount: 0, byTicker: {} });
  for (const p of roll) {
    const t = p.ticker || "?";
    const s = sum.byTicker[t] || { n: 0, wins: 0, losses: 0, pnl: 0 };
    const pnl = (p.exitPremium != null && p.entryPremium != null)
      ? (p.exitPremium - p.entryPremium) * (p.contracts || 0) * 100 : 0;
    s.n++; s.pnl = +(s.pnl + pnl).toFixed(2);
    if (pnl > 0) s.wins++; else if (pnl < 0) s.losses++;
    sum.byTicker[t] = s;
  }
  sum.rolledCount += roll.length;
  sum.lastRolled = new Date().toISOString();
  writeJson(SUMMARY, sum);
  writeJson(TRADES, [...open, ...keep]);
  return { kept: open.length + keep.length, rolled: roll.length };
}

// ---- Public ---------------------------------------------------------------
export function usage() {
  const total = dirSize(DATA);
  const snaps = dirSize(SNAP_DIR);
  return {
    dataMB: +(total.bytes / 1048576).toFixed(2),
    dataFiles: total.files,
    snapshotsMB: +(snaps.bytes / 1048576).toFixed(2),
    snapshotFiles: snaps.files,
    tradesKB: +((readJson(TRADES, []).length ? fs.statSync(TRADES).size : 0) / 1024).toFixed(1),
  };
}

export function sweep(cfg = {}) {
  const r = { ...RETENTION_DEFAULTS, ...(cfg.retention || {}) };
  const before = usage();
  const snapshots = pruneSnapshots(r);
  const trades = pruneTrades(r);
  const after = usage();
  return {
    ranAt: new Date().toISOString(),
    retention: r, snapshots, trades, before, after,
    freedMB: +(before.dataMB - after.dataMB).toFixed(2),
    warning: after.dataMB > r.maxDataMB
      ? `data/ is ${after.dataMB}MB, above maxDataMB ${r.maxDataMB} — tighten retention`
      : null,
  };
}
