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

// Grade ONE side of a scan. voldesk.py's tag/grade are computed for LONGS ONLY
// (the tag literally tests spot >= pTrans), so a short cannot reuse them — it
// gets the mirrored assessment from playbook.assessShort instead. Pulling this
// out of the loop is what makes re-reading a name as the OTHER side possible at
// all: before, the long branch and the short branch were inline and the row's
// side was decided before either ran.
async function gradeSide(scan, spot, side, cfg, o) {
  const lv = playbook.levelsFor(scan, side);
  if (!lv) return { ok: false, tag: "BLOCKED", grade: null, rr: null, levels: null,
    reasons: ["no usable levels for this side"] };

  if (side === "short") {
    const a = playbook.assessShort(scan, spot, lv,
      { minRR: cfg.contractSelection?.minRR ?? 1.5 });
    return {
      ok: a.tag !== "BLOCKED", tag: a.tag, grade: null, rr: a.rr, levels: lv,
      reasons: a.reasons || [],
    };
  }
  const reasons = [];
  const tagOK = (o.requireTags || ["CONFIRMED"]).includes(scan.tag);
  const gradeOK = (scan.grade ?? 0) >= (o.minGrade ?? 0);
  if (!tagOK) reasons.push(`tag ${scan.tag}`);
  if (!gradeOK) reasons.push(`grade ${scan.grade} < ${o.minGrade}`);
  return { ok: scan.tag !== "BLOCKED", tag: scan.tag, grade: scan.grade ?? null,
    rr: scan.rr ?? null, levels: lv, reasons };
}

const opposite = (side) => (side === "short" ? "long" : "short");
const sideEnabled = (side, cfg) =>
  side === "short" ? cfg.sides?.short === true : cfg.sides?.long !== false;

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
  const flowOn = cfg.flow?.enabled !== false;
  const gapMs = Math.max(1, o.assessEveryMinutes ?? 60) * 60 * 1000;

  for (const r of active) {
    // Cadence, not calendar. The old test was `r.lastAssessed === today()`, which
    // meant a name could be re-read exactly once per day: something that firmed
    // up at 10:15 sat as OBSERVING until tomorrow, by which point the reclaim we
    // were waiting for had already happened. Discovery runs every 30 minutes;
    // the assessment it feeds was the bottleneck.
    const since = r.lastAssessedAt ? Date.now() - Date.parse(r.lastAssessedAt) : Infinity;
    if (!force && since < gapMs) {
      results.push({ ticker: r.ticker, skipped: `assessed ${Math.round(since / 60000)}m ago` });
      continue;
    }

    let side = r.side || "long";
    const reasons = [];
    let drop = null;
    let flipNote = null;

    // ---- 1. Structure first ------------------------------------------------
    // The scan now runs BEFORE the flow rules rather than after, and only
    // because of them. To decide whether a name that flow abandoned should be
    // dropped or re-read as the other side, we need the structural picture in
    // hand at the moment we make that call — the old order (flow decides, then
    // maybe scan) made the flip physically impossible to evaluate.
    const scan = await volDeskScan(r.ticker, cfg);
    let spot = null;
    try { spot = await alpaca.getLatestTrade(r.ticker, "delayed_sip"); } catch {}

    if (!scan || scan.error) {
      // A failed scan is missing information, not bad news. Record and wait.
      reasons.push(`scan failed: ${scan?.error || "no data"}`);
      r.lastAssessed = today();
      r.lastAssessedAt = new Date().toISOString();
      const rec = { date: today(), verdict: "WAIT", reasons, tag: null, grade: null };
      r.assessments = [...(r.assessments || []).slice(-9), rec];
      results.push({ ticker: r.ticker, side, status: r.status, ...rec });
      continue;
    }

    let graded = await gradeSide(scan, spot, side, cfg, o);
    let conv = await flow.getConviction(r.ticker, cfg);
    let decision = flow.decideForTrade(conv, cfg, side);

    // ---- 2. Is this side structurally dead? --------------------------------
    // Spot already past the stop means there is no entry left, not a worse one.
    const structDead = Boolean(
      graded.levels && spot != null && playbook.adverse(side, spot, graded.levels.stop));

    // ---- 3. Flow verdict ---------------------------------------------------
    let flowKill = null;
    if (!flowOn) {
      // no flow input: structure alone decides
    } else if (flowStale) {
      // Missed upload — freeze judgement rather than punish the list.
      reasons.push(`flow stale ${cacheState.ageDays}d — upload to refresh`);
    } else if (!conv.found) {
      if (o.dropOnFlowGone) flowKill = "flow gone (not in latest upload)";
      else reasons.push("no current flow");
    } else if (o.dropOnFlowFlip &&
               ((side === "long" && conv.direction === "bearish") ||
                (side === "short" && conv.direction === "bullish"))) {
      flowKill = `flow flipped ${conv.direction} against a ${side} (score ${conv.combinedScore})`;
    } else if (r.seed.flowScore && conv.combinedScore < r.seed.flowScore * o.flowDecayRatio) {
      flowKill = `flow decayed ${r.seed.flowScore} -> ${conv.combinedScore}`;
    }

    // ---- 4. SIDE UNFREEZING -------------------------------------------------
    // Side was stamped once at seed time and never revisited, so a long that
    // broke its stop was DROPPED — throwing the name away at precisely the
    // moment it became interesting, because a failed long IS the setup that
    // most reliably produces a good short. Same for flow reversing on us: the
    // old code read that as "this idea is over" when it plainly means "this
    // idea may have changed direction".
    //
    // The flip is deliberately narrow. It requires the current side to be dead
    // (structurally, or abandoned by flow) AND the opposite side to grade out on
    // its own merits on the SAME scan. Flow widens the search; it never decides
    // direction by itself, because flow disagreeing with structure is a reason
    // to stand aside, not a reason to reverse. One flip per row — a name that
    // wants to reverse twice is chop, and chop is not a setup.
    if ((structDead || flowKill) && o.allowSideFlip !== false) {
      const opp = opposite(side);
      const flipsUsed = r.sideFlips || 0;
      if (sideEnabled(opp, cfg) && flipsUsed < (o.maxSideFlips ?? 1)) {
        const oppGraded = await gradeSide(scan, spot, opp, cfg, o);
        const oppAlive = oppGraded.levels && spot != null
          && !playbook.adverse(opp, spot, oppGraded.levels.stop);
        const oppOK = oppAlive && ["CONFIRMED", "PENDING"].includes(oppGraded.tag);
        if (oppOK) {
          const oppDecision = flow.decideForTrade(conv, cfg, opp);
          // Don't flip into a direction the flow gate would immediately block.
          if (!oppDecision.block) {
            flipNote = `flipped ${side} -> ${opp}: ${structDead
              ? `spot ${spot?.toFixed(2)} broke the ${side} stop ${graded.levels?.stop}`
              : flowKill} — ${opp} grades ${oppGraded.tag}`;
            side = opp;
            r.side = opp;
            r.sideFlips = flipsUsed + 1;
            r.flipHistory = [...(r.flipHistory || []), { on: today(), note: flipNote }];
            r.blockedRun = 0;
            graded = oppGraded;
            decision = oppDecision;
            flowKill = null;
            reasons.push(flipNote);
          }
        }
      }
    }

    // ---- 5. Resolve --------------------------------------------------------
    if (flowKill) drop = flowKill;
    if (!drop && structDead && !flipNote) {
      drop = `spot ${spot?.toFixed(2)} already past the ${side} stop ${graded.levels?.stop} pre-entry`;
    }

    if (!drop) {
      if (graded.tag === "BLOCKED") {
        r.blockedRun = (r.blockedRun || 0) + 1;
        if (r.blockedRun >= o.blockedStrikes) drop = `BLOCKED ${r.blockedRun} scans running`;
      } else {
        r.blockedRun = 0;
      }
      if (graded.reasons.length) reasons.push(...graded.reasons);
      if (graded.levels) r.pendingLevels = graded.levels;
    }

    // Went stale without ever being tradeable.
    if (!drop && r.status === "OBSERVING" && daysSince(r.addedAt) >= o.maxObserveDays) {
      drop = `stale ${daysSince(r.addedAt)}d without qualifying`;
    }

    if (decision.block) reasons.push(`flow gate: ${decision.stance}`);
    // A flip note is an explanation, not a defect — it must not by itself keep a
    // freshly-flipped name out of READY.
    const blocking = reasons.filter((x) => x !== flipNote);
    const ready = !drop && blocking.length === 0 && !decision.block;

    const record = {
      date: today(),
      verdict: drop ? "DROP" : ready ? "READY" : "WAIT",
      side,
      tag: graded.tag ?? null, grade: graded.grade ?? null, rr: graded.rr ?? null,
      flowDir: conv.direction, flowScore: conv.combinedScore,
      sizeMult: decision.sizeMultiplier,
      ...(flipNote ? { flipped: flipNote } : {}),
      reasons: drop ? [drop] : reasons,
    };
    r.assessments = [...(r.assessments || []).slice(-9), record];
    r.lastAssessed = today();
    r.lastAssessedAt = new Date().toISOString();

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
    assessed: results.filter((x) => !x.skipped).length,
    skipped: results.filter((x) => x.skipped).length,
    ready: results.filter((x) => x.status === "READY").map((x) => x.ticker),
    flipped: results.filter((x) => x.flipped).map((x) => `${x.ticker}->${x.side}`),
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
