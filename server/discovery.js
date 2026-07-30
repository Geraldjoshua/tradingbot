// Discovery — let the bot FIND names from options flow instead of only grading
// a hand-written watchlist.
//
// Pipeline:
//   1. HARVEST   rank tickers by bullish flow conviction.
//                OptionStrat (master workbooks) when present, else/plus Unusual
//                Whales (live API). Auto-fallback: whichever source has data.
//   2. FILTER    drop names already open, in cooldown, or explicitly excluded.
//                Trim to maxScan (Vol Desk scans are the expensive step).
//   3. VALIDATE  run the real Vol Desk scan on each survivor. This writes the
//                daily snapshot (pTrans/nTrans/T1/T2) that enterTrade() needs
//                AND yields the grade + CONFIRMED/PENDING/BLOCKED tag.
//                Only names passing the tag/grade bar survive.
//
// So flow PROPOSES, the Vol Desk playbook DISPOSES. A huge premium print on a
// structurally broken chart still gets rejected.
//
// Snapshots are cached per ticker per day by voldesk.py, so re-scanning the same
// name later in the session is cheap.

import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import * as uw from "./unusualwhales.js";
import * as vd from "./voldesk_trades.js";
import * as alpaca from "./alpaca.js";
import * as playbook from "./playbook.js";
import { realizedVol } from "./options.js";
import { pythonPath } from "./pythonPath.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Cross-platform (Windows venv lives in Scripts\, not bin/) — see pythonPath.js
const PY = pythonPath();

function runPy(script, args, timeoutMs = 120000) {
  return new Promise((resolve) => {
    const child = spawn(PY, [path.join(ROOT, script), ...args]);
    let out = "", err = "";
    const kill = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", () => { clearTimeout(kill); resolve(null); });
    child.on("close", () => {
      clearTimeout(kill);
      try { resolve(JSON.parse(out)); } catch { resolve(null); }
    });
  });
}

function optionstratDir(cfg) {
  return cfg.flow.optionstratDir || process.env.OPTIONSTRAT_DIR || ROOT;
}

// The dollar floor applied BEFORE anything is sized — a name below it never
// enters the candidate list at all.
//
// This was a live bug. `discovery.minPremium` ($250k) was passed here as a flat
// gate, which meant the per-tier floors underneath it could never bind: the
// micro tier was configured to accept $100k prints, but every $100k print was
// already dropped one step upstream. The effect was a universe that quietly
// excluded smaller companies no matter how the tier table was set.
//
// With tierFloors on (default) the gate drops to the LOWEST floor among enabled
// tiers, and each tier's own floor does the real filtering later in normalize().
// Turning it off restores the single flat gate.
export function harvestFloor(cfg) {
  const d = cfg.discovery;
  if (d.tierFloors === false) return d.minPremium;
  const overrides = d.tiers || {};
  const floors = CAP_TIERS
    .map((t) => ({ ...t, ...(overrides[t.key] || {}) }))
    .filter((t) => t.enabled !== false)
    .map((t) => t.minPremium ?? 0);
  if (!floors.length) return d.minPremium;
  return Math.min(d.minPremium, ...floors);
}

// ---- 1. HARVEST -----------------------------------------------------------
export async function harvest(cfg) {
  const d = cfg.discovery;
  const useOS = d.sources.optionstrat && cfg.flow.sources.optionstrat !== false;
  const useUW = d.sources.unusualwhales;
  const floor = harvestFloor(cfg);
  const merged = new Map();
  const used = [];

  // Which directions may we trade? Shorts are opt-in (cfg.sides.short).
  const allowLong = cfg.sides?.long !== false;
  const allowShort = cfg.sides?.short === true;
  const direction = allowLong && allowShort ? "both" : allowShort ? "bearish" : "bullish";

  if (useOS) {
    const r = await runPy("flow/optionstrat_flow.py", [
      "--discover", optionstratDir(cfg), String(d.maxScan * 2),
      String(floor), String(d.minScore), direction,
    ], 60000);
    if (r && r.candidates?.length) {
      used.push("optionstrat");
      for (const c of r.candidates) merged.set(c.ticker, { ...c, source: "optionstrat", side: c.side || "long" });
    }
  }

  // UW runs when enabled AND (always, or only as a fallback when OptionStrat
  // produced nothing — which is the normal case on a cloud deploy).
  const needFallback = merged.size === 0;
  if (useUW && (!d.uwFallbackOnly || needFallback)) {
    const r = await uw.getTopFlowTickers({
      topN: d.maxScan * 2, minPremium: floor, minScore: d.minScore,
    });
    if (r.candidates?.length) {
      used.push("unusualwhales");
      for (const c of r.candidates) {
        const prev = merged.get(c.ticker);
        // Present in BOTH sources = strongest signal: combine the ranks.
        if (prev) merged.set(c.ticker, { ...prev, rank: prev.rank + c.rank, source: "both" });
        else merged.set(c.ticker, { ...c, source: "unusualwhales" });
      }
    }
  }

  const candidates = [...merged.values()].sort((a, b) => b.rank - a.rank);
  return { sources: used, candidates };
}

// ---- 1b. NORMALIZE by company size / liquidity ----------------------------
// Two failure modes to avoid:
//   * RAW DOLLARS bias to mega-caps: $5M of premium is routine on a $4T name.
//   * FLAT BPS bias to small-caps: a $2B company needs only $400k to print
//     2 bps, while a $4T company needs $800M for the same 2 bps — so on a pure
//     bps ranking mega-caps could never qualify. Flipping the bias isn't fixing it.
//
// So we score each name against what's NORMAL FOR ITS OWN SIZE CLASS, using the
// conventional cap tiers. Each tier carries a reference bps (`refBps`) meaning
// "this much premium, relative to cap, is notable for a company this size", and
// its own absolute `minPremium` floor.
//
//     relBps    = |net_premium| / marketCap * 10,000
//     tierScore = relBps / tier.refBps        → 1.0 = exactly its tier's bar,
//                                               3.0 = 3x normal for its size
//
// tierScore is comparable ACROSS tiers, so a mega-cap at 3x its own baseline
// outranks a small-cap at 1.2x its own baseline — which is the behaviour you
// actually want. Ranking then multiplies by skew and the unusual/knows boosts.
//
//   basis "marketcap" — tiered scoring as above (default)
//   basis "dollarvol" — relative to 20d avg daily dollar volume. Inherently
//                       size-aware (big companies trade more), so it uses a
//                       single reference instead of tiers. Uses Alpaca bars we
//                       already pull — no Yahoo dependency.
//   basis "none"      — raw premium (mega-cap biased; kept for comparison)
//
// NOTE ON CALIBRATION: the refBps values below are seeded from rough
// observation, NOT fitted to data. Watch the discovery log for a few sessions
// and adjust — if every hit is one tier, that tier's refBps is too low.

// Conventional US cap buckets. capMax is exclusive.
const CAP_TIERS = [
  { key: "micro", label: "Micro",  capMin: 0,      capMax: 3e8,   refBps: 15,   minPremium: 100000 },
  { key: "small", label: "Small",  capMin: 3e8,    capMax: 2e9,   refBps: 8,    minPremium: 250000 },
  { key: "mid",   label: "Mid",    capMin: 2e9,    capMax: 1e10,  refBps: 4,    minPremium: 500000 },
  { key: "large", label: "Large",  capMin: 1e10,   capMax: 2e11,  refBps: 1.5,  minPremium: 1000000 },
  { key: "mega",  label: "Mega",   capMin: 2e11,   capMax: Infinity, refBps: 0.3, minPremium: 2000000 },
];

export function tierTable() { return CAP_TIERS; }

function tierFor(cap, cfg) {
  const overrides = cfg.discovery.tiers || {};
  for (const t of CAP_TIERS) {
    if (cap >= t.capMin && cap < t.capMax) {
      const o = overrides[t.key] || {};
      return {
        ...t,
        refBps: o.refBps ?? t.refBps,
        minPremium: o.minPremium ?? t.minPremium,
        enabled: o.enabled !== false,
      };
    }
  }
  return null;
}

async function fetchMarketCaps(tickers, cfg) {
  const cacheDir = path.join(ROOT, "data");
  const r = await runPy("flow/marketcap.py", [...tickers, "--cache", cacheDir], 90000);
  return r && !r.__error__ ? r : {};
}

// Average daily dollar volume over the last ~20 sessions, from Alpaca daily bars.
async function avgDollarVolume(ticker) {
  try {
    const start = new Date(Date.now() - 40 * 864e5).toISOString();
    const bars = await alpaca.getBars(ticker, "1Day", start, null);
    const recent = bars.slice(-20);
    if (!recent.length) return null;
    const sum = recent.reduce((acc, b) => acc + (b.c || 0) * (b.v || 0), 0);
    return sum / recent.length;
  } catch { return null; }
}

async function normalize(candidates, cfg) {
  const d = cfg.discovery;
  const basis = d.normalize || "marketcap";
  if (basis === "none") {
    for (const c of candidates) { c.sizeBasis = null; c.relBps = null; }
    return candidates;
  }

  if (basis === "marketcap") {
    const caps = await fetchMarketCaps(candidates.map((c) => c.ticker), cfg);
    for (const c of candidates) {
      const cap = caps[c.ticker] || null;
      c.marketCap = cap;
      c.sizeBasis = cap;
      // net_premium is SIGNED (negative = bearish). Size relative to the
      // magnitude of the bet; direction is carried separately in c.side.
      c.relBps = cap ? +((Math.abs(c.net_premium) / cap) * 10000).toFixed(4) : null;
      const t = cap ? tierFor(cap, cfg) : null;
      c.tier = t ? t.key : null;
      c.tierLabel = t ? t.label : null;
      c.tierRefBps = t ? t.refBps : null;
      // How many times its OWN size class's normal bar this print represents.
      c.tierScore = (t && c.relBps != null) ? +(c.relBps / t.refBps).toFixed(3) : null;
      c._tier = t;
    }
  } else { // dollarvol — already size-aware, single reference
    const ref = d.dollarVolRefBps ?? 20;
    await Promise.all(candidates.map(async (c) => {
      const addv = await avgDollarVolume(c.ticker);
      c.avgDollarVol = addv;
      c.sizeBasis = addv;
      c.relBps = addv ? +((Math.abs(c.net_premium) / addv) * 10000).toFixed(4) : null;
      c.tier = "flow"; c.tierLabel = "by $vol"; c.tierRefBps = ref;
      c.tierScore = c.relBps != null ? +(c.relBps / ref).toFixed(3) : null;
      c._tier = { enabled: true, minPremium: d.minPremium ?? 0 };
    }));
  }

  const keep = candidates.filter((c) => {
    if (c.tierScore == null) return d.keepUnsized !== false;   // couldn't size it
    const t = c._tier;
    if (!t || !t.enabled) return false;                        // tier switched off
    if (Math.abs(c.net_premium) < (t.minPremium ?? 0)) return false;   // per-tier dollar floor
    if (d.minTierScore && c.tierScore < d.minTierScore) return false;
    return true;
  });

  // Rank on tierScore (comparable across tiers). Clamp so one freak ratio can't
  // monopolize the shortlist.
  const clamp = d.maxTierScore ?? 20;
  for (const c of keep) {
    const ts = c.tierScore == null ? 0 : Math.min(c.tierScore, clamp);
    const boost = (c.in_knows ? 1.5 : 1) * (c.in_unusual ? 1.25 : 1);
    c.rawRank = c.rank;                       // keep the dollar-based rank for display
    c.rank = +(ts * c.score * boost).toFixed(4);
    delete c._tier;
  }
  keep.sort((a, b) => b.rank - a.rank);
  return keep;
}

// ---- 1b. AFFORDABILITY PREFERENCE -----------------------------------------
// Only `maxScan` names get a Vol Desk scan each cycle. If those slots all go to
// $400 stocks, the loop scans them, sizes them, skips them all as TOO_EXPENSIVE,
// and the affordable names never got looked at — "find a cheaper ticker" only
// worked by accident, if the next name down the ranking happened to be cheap.
//
// So affordability becomes a RANKING preference, not a filter. Nothing is
// excluded: a mega-cap with exceptional flow still outranks a cheap name with
// mediocre flow. It just stops price being invisible to the ordering.
//
// Estimating the cost. Two methods are available and the DEFAULT IS THE CRUDE
// ONE, which is not what you'd guess:
//
//   flat (default)  est = spot x premiumPctOfSpot x 100
//   vol-aware       est = spot x 0.4 x vol x sqrt(dte/365) x itmFactor x 100
//
// The vol-aware version is more principled and did NOT measure better. Checked
// against the three fills we have real prices for, the actual cost landed at
// 6.8% (TSLA), 6.5% (MSFT) and 11.0% (GOOGL) of spot — nearly flat across very
// different volatilities. The reason is that the dominant variable isn't vol,
// it's WHICH strike and expiry the R/R selector lands on within its delta band;
// that swamps the vol term. On the one borderline name (MSFT, actually $3,315
// against a $3,000 budget) the flat estimate correctly called it over budget and
// the vol-aware one called it under.
//
// So `useVol` stays available but off. Revisit it with more fills — three data
// points is not enough to conclude much, only enough to refuse the upgrade that
// doesn't pay for itself. Vol comes from Alpaca daily bars, not Yahoo, so
// turning it on doesn't worsen the rate-limit problem.
//
// Either way this is a RANKING input, not a gate. Being wrong reorders the scan
// queue; it never rejects a trade.
//
// `quote` and `bars` are injectable so this is testable without a broker.
export async function applyAffordability(
  candidates, cfg,
  quote = (t) => alpaca.getLatestTrade(t, "delayed_sip"),
  bars = (t) => alpaca.getBars(t, "1Day", new Date(Date.now() - 90 * 864e5).toISOString(), null),
) {
  const af = cfg.discovery?.affordability || {};
  if (af.enabled !== true) return candidates;

  const budget = cfg.risk?.basePremium ?? 300;
  const pct = af.premiumPctOfSpot ?? 0.08;   // fallback only, when vol is unknown
  const dte = cfg.contractSelection?.dteTarget ?? 45;
  const itm = af.itmFactor ?? 1.7;
  const boost = af.boost ?? 2.0;             // multiplier for names that fit
  const penalty = af.penalty ?? 0.5;         // multiplier for names that don't
  const sqrtT = Math.sqrt(dte / 365);

  await Promise.all(candidates.map(async (c) => {
    try {
      const spot = await quote(c.ticker);
      if (!(spot > 0)) return;
      c.spot = +spot.toFixed(2);

      let vol = null;
      if (af.useVol === true) {
        try {
          const daily = await bars(c.ticker);
          if (daily?.length > 5) vol = realizedVol(daily);
        } catch { /* fall through to the flat estimate */ }
      }
      c.estVol = vol ? +vol.toFixed(3) : null;
      c.estContractCost = Math.round(
        vol ? spot * 0.4 * vol * sqrtT * itm * 100
            : spot * pct * 100
      );
      c.affordable = c.estContractCost <= budget;
    } catch { /* leave unscored — treated as neutral below */ }
  }));

  for (const c of candidates) {
    if (c.affordable == null) continue;      // no quote: don't reward or punish
    c.rank = +(c.rank * (c.affordable ? boost : penalty)).toFixed(4);
  }
  candidates.sort((a, b) => b.rank - a.rank);
  return candidates;
}

// ---- 2. FILTER ------------------------------------------------------------
function filterCandidates(candidates, cfg, { openTickers, cooldown }) {
  const d = cfg.discovery;
  const exclude = new Set((d.exclude || []).map((t) => t.toUpperCase()));
  const now = Date.now();
  const cdMs = (cfg.automation.entryCooldownMin || 0) * 60 * 1000;
  return candidates.filter((c) => {
    if (exclude.has(c.ticker)) return false;
    if (openTickers.has(c.ticker)) return false;            // already in it
    if (cdMs && cooldown[c.ticker] && now - cooldown[c.ticker] < cdMs) return false;
    return true;
  }).slice(0, d.maxScan);
}

// ---- 3. VALIDATE through the Vol Desk playbook ----------------------------
async function volDeskScan(ticker, cfg) {
  const dataDir = path.join(ROOT, "data", "voldesk");
  const maxDte = String(cfg.discovery.maxDte || 45);
  const requireDb = cfg.discovery.requireDeltaBalance === false ? "0" : "1";
  return runPy("gex/voldesk.py", [ticker, dataDir, maxDte, requireDb], 120000);
}

// Scan with limited concurrency (Yahoo is rate-limited and free dynos are small).
async function scanAll(tickers, cfg) {
  const out = [];
  // Paced, not bursty — see the note in server/index.js. Yahoo throttles on
  // request RATE, so concurrency alone isn't the knob; the stagger matters too.
  const conc = Math.max(1, Math.min(cfg.discovery.scanConcurrency || 2, 4));
  const staggerMs = cfg.discovery.scanStaggerMs ?? 400;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let i = 0;
  async function worker(slot) {
    await sleep(slot * staggerMs);
    while (i < tickers.length) {
      const t = tickers[i++];
      const r = await volDeskScan(t, cfg);
      out.push(r && !r.error ? { ticker: t, ...r } : { ticker: t, error: r?.error || "scan failed" });
      if (i < tickers.length) await sleep(staggerMs);
    }
  }
  await Promise.all(Array.from({ length: conc }, (_, k) => worker(k)));
  return out;
}

// Scan ONE ticker on demand (writes today's snapshot). Used by the auto-trader
// when a watchlist/READY name has no snapshot yet.
export async function scanTicker(ticker, cfg) {
  const r = await volDeskScan(String(ticker).toUpperCase(), cfg);
  return r || { error: "scan returned nothing" };
}

// ---- Public: full discovery run -------------------------------------------
// Returns { sources, considered, scanned, qualified: [{ticker, tag, grade, flowRank}] }
export async function discover(cfg, { openTickers = new Set(), cooldown = {} } = {}) {
  const d = cfg.discovery;
  if (!d.enabled) return { enabled: false, qualified: [] };

  const { sources, candidates: raw } = await harvest(cfg);
  if (!raw.length) {
    return { enabled: true, sources, considered: 0, scanned: 0, qualified: [],
      note: "no flow candidates (OptionStrat masters missing and/or UW off)" };
  }

  // Size-normalize BEFORE trimming, so a small-cap with a big relative
  // footprint isn't cut just because a mega-cap had more raw dollars.
  const candidates = await normalize(raw, cfg);
  if (!candidates.length) {
    return { enabled: true, sources, considered: raw.length, scanned: 0, qualified: [],
      note: `all candidates filtered by size floors (normalize=${d.normalize || "marketcap"})` };
  }

  await applyAffordability(candidates, cfg);

  const shortlist = filterCandidates(candidates, cfg, { openTickers, cooldown });
  if (!shortlist.length) return { enabled: true, sources, considered: candidates.length, scanned: 0, qualified: [] };

  const scans = await scanAll(shortlist.map((c) => c.ticker), cfg);
  const byTicker = Object.fromEntries(shortlist.map((c) => [c.ticker, c]));

  // TWO thresholds, deliberately different:
  //   acceptTags — tradeable TODAY (default CONFIRMED). Feeds same-session entry.
  //   seedTags   — worth WATCHING (default CONFIRMED + PENDING). Feeds the observe
  //                list, which re-checks daily and promotes when it firms up.
  // Seeding only on CONFIRMED made the observe list pointless: it could only ever
  // hold names that were already tradeable, so nothing was ever "watched".
  const allowTags = new Set(d.acceptTags || ["CONFIRMED"]);
  const seedTags = new Set(d.seedTags || ["CONFIRMED", "PENDING"]);
  const qualified = [];
  const watch = [];
  const tagCounts = {};
  for (const s of scans) {
    if (s.error) continue;
    const c = byTicker[s.ticker] || {};
    const side = c.side || "long";

    // voldesk.py's tag is computed for LONGS ONLY (it tests spot >= pTrans), so
    // it cannot gate a short. Shorts get the mirrored assessment instead.
    let okTag, okGrade, shortRR = null;
    if (side === "short") {
      const lv = playbook.levelsFor(s, "short");
      let spot = null;
      try { spot = await alpaca.getLatestTrade(s.ticker, "delayed_sip"); } catch {}
      const a = playbook.assessShort(s, spot, lv, { minRR: cfg.contractSelection?.minRR ?? 1.5 });
      okTag = allowTags.has(a.tag);
      okGrade = true;                      // no bearish grade exists; R/R is the bar
      shortRR = a.rr;
      s = { ...s, tag: a.tag, bearishReasons: a.reasons };
    } else {
      okTag = allowTags.has(s.tag);
      okGrade = (s.grade ?? 0) >= (d.minGrade ?? 0);
    }
    tagCounts[s.tag] = (tagCounts[s.tag] || 0) + 1;

    // Worth watching? (looser bar — this is what the observe list gets)
    const seedOK = seedTags.has(s.tag) && (side === "short" || (s.grade ?? 0) >= (d.seedMinGrade ?? 0));
    if (seedOK) {
      const c2 = byTicker[s.ticker] || {};
      watch.push({
        ticker: s.ticker, side, tag: s.tag, grade: s.grade ?? null,
        rr: shortRR ?? s.rr ?? null,
        flowRank: c2.rank ?? 0, flowScore: c2.score ?? 0, netPremium: c2.net_premium ?? 0,
        relBps: c2.relBps ?? null, marketCap: c2.marketCap ?? null,
        tier: c2.tier ?? null, tierLabel: c2.tierLabel ?? null, tierScore: c2.tierScore ?? null,
        flowSource: c2.source || "?", inKnows: !!c2.in_knows, inUnusual: !!c2.in_unusual,
        blockers: s.filter_reasons || s.bearishReasons || [],
      });
    }

    if (!okTag || !okGrade) continue;
    qualified.push({
      ticker: s.ticker, side, tag: s.tag, grade: s.grade ?? null,
      rr: shortRR ?? s.rr ?? null,
      flowRank: c.rank ?? 0, flowScore: c.score ?? 0, netPremium: c.net_premium ?? 0,
      relBps: c.relBps ?? null, marketCap: c.marketCap ?? null,
      avgDollarVol: c.avgDollarVol ?? null,
      tier: c.tier ?? null, tierLabel: c.tierLabel ?? null,
      tierScore: c.tierScore ?? null, tierRefBps: c.tierRefBps ?? null,
      flowSource: c.source || "?", inKnows: !!c.in_knows, inUnusual: !!c.in_unusual,
    });
  }
  // Best flow conviction first — the entry stage takes them in this order.
  qualified.sort((a, b) => b.flowRank - a.flowRank);

  watch.sort((a, b) => b.flowRank - a.flowRank);
  return {
    enabled: true, sources, considered: candidates.length,
    scanned: scans.length, qualified, watch, tagCounts,
    rejected: scans.filter((s) => !s.error && !qualified.find((q) => q.ticker === s.ticker))
      .map((s) => ({ ticker: s.ticker, tag: s.tag, grade: s.grade ?? null })),
  };
}
