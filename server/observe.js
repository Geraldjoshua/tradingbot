// The observe list — a self-managing watchlist.
//
// You upload flow at night; this decides what to watch, re-checks it every day,
// and only lets a name become tradeable when EVERY requirement lines up. You
// never type a ticker.
//
//   SEED      flow ingest -> discovery ranks tickers -> new names enter as
//             OBSERVING, with the flow evidence that got them in.
//   ASSESS    once per day (and on demand) each observed name is re-scanned:
//                * is the flow still there and still bullish?
//                * does the Vol Desk scan still grade it CONFIRMED?
//             Verdict is recorded with reasons, so there's an audit trail.
//   PROMOTE   passes everything -> READY. The auto-trader may enter READY names
//             when the intraday trigger fires (that's the last gate, checked live).
//   DROP      flow decayed / structure broke / went stale -> DROPPED with a
//             reason. This is the "if it isn't good anymore, remove it" rule.
//
// Status flow:  OBSERVING <-> READY -> ENTERED
//                    \__________________> DROPPED
//
// Persisted to data/observe_list.json. Entering a trade removes the name (it's a
// position now, managed by voldesk_trades.js).

import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import * as flow from "./flow.js";
import * as alpaca from "./alpaca.js";
import * as playbook from "./playbook.js";
import { pythonPath } from "./pythonPath.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STORE = path.join(ROOT, "data", "observe_list.json");
// Cross-platform (Windows venv lives in Scripts\, not bin/) — see pythonPath.js
const PY = pythonPath();

export const DEFAULTS = {
  maxObserving: 25,          // cap the list so daily assessment stays cheap
  maxObserveDays: 10,        // never became READY in this many days -> drop
  dropOnFlowGone: true,      // ticker vanished from the flow cache
  dropOnFlowFlip: true,      // flow turned bearish on a long candidate
  flowDecayRatio: 0.4,       // drop if score falls below 40% of its seed score
  blockedStrikes: 3,         // consecutive BLOCKED scans before dropping
  requireTags: ["CONFIRMED"],
  minGrade: 0,
};

const today = () => new Date().toISOString().slice(0, 10);
const cfgFor = (cfg) => ({ ...DEFAULTS, ...(cfg?.observe || {}) });

function load() { try { return JSON.parse(fs.readFileSync(STORE)); } catch { return []; } }
function save(rows) {
  fs.mkdirSync(path.dirname(STORE), { recursive: true });
  fs.writeFileSync(STORE, JSON.stringify(rows, null, 2));
}

function runPy(script, args, timeoutMs = 120000) {
  return new Promise((resolve) => {
    const child = spawn(PY, [path.join(ROOT, script), ...args]);
    let out = "";
    const t = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.on("error", () => { clearTimeout(t); resolve(null); });
    child.on("close", () => { clearTimeout(t); try { resolve(JSON.parse(out)); } catch { resolve(null); } });
  });
}

// ---- SEED: add newly discovered names -------------------------------------
// candidates: the `qualified` array from discovery.discover()
export function seed(candidates, cfg = flow.loadConfig()) {
  const o = cfgFor(cfg);
  const rows = load();
  const known = new Set(rows.filter((r) => r.status !== "DROPPED").map((r) => r.ticker));
  const added = [];

  const room = Math.max(0, o.maxObserving - known.size);
  for (const c of candidates.slice(0, room)) {
    if (known.has(c.ticker)) continue;
    rows.push({
      ticker: c.ticker,
      side: c.side || "long",          // long -> calls, short -> puts
      status: "OBSERVING",
      addedAt: new Date().toISOString(),
      addedOn: today(),
      seed: {
        netPremium: c.netPremium ?? null, flowScore: c.flowScore ?? null,
        tier: c.tierLabel ?? null, tierScore: c.tierScore ?? null,
        source: c.flowSource ?? "flow", tag: c.tag ?? null, grade: c.grade ?? null,
      },
      seedTag: c.tag ?? null,
      blockers: c.blockers || [],
      assessments: [],
      blockedRun: 0,
      lastAssessed: null,
    });
    known.add(c.ticker);
    added.push(c.ticker);
  }
  if (added.length) save(rows);
  return { added, observing: rows.filter((r) => r.status !== "DROPPED" && r.status !== "ENTERED").length };
}

// ---- ASSESS: re-check every observed name ---------------------------------
async function volDeskScan(ticker, cfg) {
  const dataDir = path.join(ROOT, "data", "voldesk");
  const maxDte = String(cfg.discovery?.maxDte || 45);
  const requireDb = cfg.discovery?.requireDeltaBalance === false ? "0" : "1";
  return runPy("gex/voldesk.py", [ticker, dataDir, maxDte, requireDb]);
}

function daysSince(iso) {
  return Math.floor((Date.now() - Date.parse(iso)) / 864e5);
}

export async function assessAll(cfg = flow.loadConfig(), { force = false } = {}) {
  const o = cfgFor(cfg);
  const rows = load();
  const active = rows.filter((r) => r.status === "OBSERVING" || r.status === "READY");
  const results = [];

  // If the flow book itself is stale, nothing may be promoted to READY — but we
  // also must NOT drop names for "flow gone" when the real problem is a missed
  // upload. Stale flow means "hold everything as-is", not "purge the list".
  // Only honoured when the staleness guard is actually on (staleAction != "off").
  const cacheState = flow.cacheStatus(cfg);
  const guardOn = (cfg.flow.staleAction || "warn") !== "off";
  const flowStale = guardOn && cacheState.stale && !(cfg.flow.sources.unusualwhales);

  for (const r of active) {
    if (!force && r.lastAssessed === today()) { results.push({ ticker: r.ticker, skipped: "already assessed today" }); continue; }

    const reasons = [];
    let drop = null;

    // 1) Is the flow still behind it?
    const side = r.side || "long";
    const conv = await flow.getConviction(r.ticker, cfg);
    const decision = flow.decideForTrade(conv, cfg, side);
    // With flow conviction switched off, getConviction() legitimately returns
    // found:false. Dropping every name as "flow gone" in that case would empty
    // the list the moment you toggle flow off — so skip the flow rules entirely.
    const flowOn = cfg.flow?.enabled !== false;
    if (!flowOn) {
      // no flow input: structure alone decides
    } else if (flowStale) {
      // Missed upload — freeze judgement rather than punish the list.
      reasons.push(`flow stale ${cacheState.ageDays}d — upload to refresh`);
    } else if (!conv.found) {
      if (o.dropOnFlowGone) drop = "flow gone (not in latest upload)";
      else reasons.push("no current flow");
    } else if (flowOn && o.dropOnFlowFlip &&
               ((side === "long" && conv.direction === "bearish") ||
                (side === "short" && conv.direction === "bullish"))) {
      drop = `flow flipped ${conv.direction} against a ${side} (score ${conv.combinedScore})`;
    } else if (flowOn && r.seed.flowScore && conv.combinedScore < r.seed.flowScore * o.flowDecayRatio) {
      drop = `flow decayed ${r.seed.flowScore} -> ${conv.combinedScore}`;
    }

    // 2) Does the structure still grade out?
    let scan = null;
    if (!drop) {
      scan = await volDeskScan(r.ticker, cfg);
      if (!scan || scan.error) {
        reasons.push(`scan failed: ${scan?.error || "no data"}`);
      } else {
        // voldesk.py's tag/grade are LONG-only. For shorts use the mirrored gate.
        let effTag = scan.tag, effGrade = scan.grade;
        if (side === "short") {
          let sp = null;
          try { sp = await alpaca.getLatestTrade(r.ticker, "delayed_sip"); } catch {}
          const a = playbook.assessShort(scan, sp, playbook.levelsFor(scan, "short"),
            { minRR: cfg.contractSelection?.minRR ?? 1.5 });
          effTag = a.tag; effGrade = o.minGrade ?? 0;      // R/R is the bar, not grade
          if (a.reasons.length) reasons.push(...a.reasons);
        }
        const tagOK = (o.requireTags || ["CONFIRMED"]).includes(effTag);
        const gradeOK = (effGrade ?? 0) >= (o.minGrade ?? 0);
        scan = { ...scan, tag: effTag };
        if (scan.tag === "BLOCKED") {
          r.blockedRun = (r.blockedRun || 0) + 1;
          if (r.blockedRun >= o.blockedStrikes) drop = `BLOCKED ${r.blockedRun} scans running`;
        } else {
          r.blockedRun = 0;
        }
        if (!tagOK) reasons.push(`tag ${scan.tag}`);
        if (!gradeOK) reasons.push(`grade ${scan.grade} < ${o.minGrade}`);

        // 3) Structure invalidated outright — spot already under the stop.
        if (!drop && scan.levels) {
          try {
            const lv = playbook.levelsFor(scan, side);
            const spot = await alpaca.getLatestTrade(r.ticker, "delayed_sip");
            if (spot && lv && playbook.adverse(side, spot, lv.stop)) {
              drop = `spot ${spot.toFixed(2)} already past the ${side} stop ${lv.stop} pre-entry`;
            }
            if (!drop && lv) r.pendingLevels = lv;
          } catch {}
        }
      }
    }

    // 4) Went stale without ever being tradeable.
    if (!drop && r.status === "OBSERVING" && daysSince(r.addedAt) >= o.maxObserveDays) {
      drop = `stale ${daysSince(r.addedAt)}d without qualifying`;
    }

    const ready = !drop && reasons.length === 0 && !decision.block;
    if (decision.block) reasons.push(`flow gate: ${decision.stance}`);

    const record = {
      date: today(),
      verdict: drop ? "DROP" : ready ? "READY" : "WAIT",
      tag: scan?.tag ?? null, grade: scan?.grade ?? null, rr: scan?.rr ?? null,
      flowDir: conv.direction, flowScore: conv.combinedScore,
      sizeMult: decision.sizeMultiplier,
      reasons: drop ? [drop] : reasons,
    };
    r.assessments = [...(r.assessments || []).slice(-9), record];
    r.lastAssessed = today();

    if (drop) {
      r.status = "DROPPED"; r.dropReason = drop; r.droppedOn = today();
    } else {
      r.status = ready ? "READY" : "OBSERVING";
      if (ready && scan?.levels) r.levels = scan.levels;
    }
    results.push({ ticker: r.ticker, side, status: r.status, ...record });
  }

  save(rows);
  return {
    assessed: results.length,
    ready: results.filter((x) => x.status === "READY").map((x) => x.ticker),
    dropped: results.filter((x) => x.status === "DROPPED").map((x) => ({ ticker: x.ticker, reason: x.reasons?.[0] })),
    results,
  };
}

// ---- Queries / mutations --------------------------------------------------
export function list() { return load(); }
export function activeList() { return load().filter((r) => r.status === "OBSERVING" || r.status === "READY"); }
export function readyTickers() { return load().filter((r) => r.status === "READY").map((r) => r.ticker); }
// [{ticker, side}] — the loop needs the side to know calls vs puts.
export function readyTrades() {
  return load().filter((r) => r.status === "READY").map((r) => ({ ticker: r.ticker, side: r.side || "long" }));
}

export function markEntered(ticker, positionId) {
  const rows = load();
  const r = rows.find((x) => x.ticker === ticker && (x.status === "READY" || x.status === "OBSERVING"));
  if (!r) return null;
  r.status = "ENTERED"; r.enteredOn = today(); r.positionId = positionId || null;
  save(rows);
  return r;
}

export function drop(ticker, reason = "manual") {
  const rows = load();
  const r = rows.find((x) => x.ticker === ticker && x.status !== "DROPPED");
  if (!r) return null;
  r.status = "DROPPED"; r.dropReason = reason; r.droppedOn = today();
  save(rows);
  return r;
}

// Keep the file bounded: forget DROPPED/ENTERED rows after a while.
export function prune(keepDays = 30) {
  const rows = load();
  const cutoff = new Date(Date.now() - keepDays * 864e5).toISOString().slice(0, 10);
  const keep = rows.filter((r) => {
    if (r.status === "OBSERVING" || r.status === "READY") return true;
    return (r.droppedOn || r.enteredOn || r.addedOn || today()) >= cutoff;
  });
  const removed = rows.length - keep.length;
  if (removed) save(keep);
  return { removed, remaining: keep.length };
}
