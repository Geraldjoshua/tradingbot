// Flow conviction layer.
//
// Blends up to two options-flow sources into ONE directional verdict for a
// ticker, then translates that verdict into a trade decision (block? size up /
// down?) according to the toggleable config. This is the "does the flow cement
// my conviction?" check the auto-trader (and the Vol Desk ticket) run before
// buying.
//
//   OptionStrat  -> flow/optionstrat_flow.py (reads the master workbooks)
//   Unusual Whales -> server/unusualwhales.js (live API, off unless UW_API_KEY)
//
// Both are optional and independently toggleable. Config lives in
// server/autotrader.config.json and is hot-read on every call so UI toggles take
// effect immediately.

import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import * as uw from "./unusualwhales.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_PATH = path.join(ROOT, "server", "autotrader.config.json");
const PY = fs.existsSync(path.join(ROOT, ".venv/bin/python"))
  ? path.join(ROOT, ".venv/bin/python")
  : "python3";

const DEFAULTS = {
  automation: {
    enabled: false, mode: "full", pollSeconds: 60,
    strategies: { voldesk: true, gapgo: false },
    marketHoursOnly: true, t1Action: "take-profit",
    maxConcurrent: 5, maxDailyEntries: 3, entryCooldownMin: 30, watchlist: [],
  },
  flow: {
    enabled: true, mode: "size",
    sources: { optionstrat: true, unusualwhales: false },
    optionstratDir: "",
    sizing: { agree: 1.0, neutral: 0.7, disagree: 0.25 },
    minScore: 0.15,
    boosts: { unusual: 0.1, knows: 0.15 },
    sourceWeights: { optionstrat: 1.0, unusualwhales: 1.0 },
  },
  risk: { basePremium: 300 },
};

function deepMerge(base, over) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const k of Object.keys(over || {})) {
    if (over[k] && typeof over[k] === "object" && !Array.isArray(over[k])) {
      out[k] = deepMerge(base[k] || {}, over[k]);
    } else {
      out[k] = over[k];
    }
  }
  return out;
}

export function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH));
    return deepMerge(DEFAULTS, raw);
  } catch {
    return deepMerge(DEFAULTS, {});
  }
}

export function saveConfig(partial) {
  const merged = deepMerge(loadConfig(), partial || {});
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2));
  return merged;
}

// Where the OptionStrat masters live. Config wins; else OPTIONSTRAT_DIR env; else
// project root (where you'd typically run the scraper from).
function optionstratDir(cfg) {
  return cfg.flow.optionstratDir || process.env.OPTIONSTRAT_DIR || ROOT;
}

function runOptionStrat(ticker, dir) {
  return new Promise((resolve) => {
    const child = spawn(PY, [path.join(ROOT, "flow", "optionstrat_flow.py"), ticker, dir]);
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", () => resolve({ found: false, source: "optionstrat", direction: "neutral", score: 0, error: "spawn failed" }));
    child.on("close", () => {
      try { resolve({ source: "optionstrat", ...JSON.parse(out) }); }
      catch { resolve({ found: false, source: "optionstrat", direction: "neutral", score: 0, error: (err || out).slice(0, 200) }); }
    });
  });
}

// Signed conviction in [-1, 1]: +bullish, -bearish.
function signed(v) {
  if (!v || !v.found) return 0;
  const s = Number(v.score) || 0;
  return v.direction === "bullish" ? s : v.direction === "bearish" ? -s : 0;
}

// ---- Public: raw conviction for a ticker (source blend) -------------------
export async function getConviction(ticker, cfg = loadConfig()) {
  ticker = String(ticker).toUpperCase();
  const f = cfg.flow;
  const jobs = [];
  if (f.enabled && f.sources.optionstrat) jobs.push(runOptionStrat(ticker, optionstratDir(cfg)).then((r) => ["optionstrat", r]));
  if (f.enabled && f.sources.unusualwhales) jobs.push(uw.getConviction(ticker).then((r) => ["unusualwhales", r]));

  const settled = await Promise.all(jobs);
  const sources = {};
  let wsum = 0, acc = 0, anyFound = false;
  for (const [name, v] of settled) {
    sources[name] = v;
    if (v && v.found) {
      anyFound = true;
      let s = signed(v);
      // OptionStrat booster feeds: extra weight if the ticker also shows up in
      // the "unusual" / "knows" books (higher-signal presets).
      if (name === "optionstrat") {
        if (v.in_unusual) s += Math.sign(s || 1) * (f.boosts.unusual || 0);
        if (v.in_knows) s += Math.sign(s || 1) * (f.boosts.knows || 0);
        s = Math.max(-1, Math.min(1, s));
      }
      const w = f.sourceWeights[name] ?? 1.0;
      acc += s * w; wsum += w;
    }
  }
  const combined = wsum > 0 ? acc / wsum : 0;
  const direction = !anyFound ? "none" : combined > 0 ? "bullish" : combined < 0 ? "bearish" : "neutral";
  return {
    ticker,
    enabled: !!f.enabled,
    found: anyFound,
    combinedScore: +Math.abs(combined).toFixed(4),
    combinedSigned: +combined.toFixed(4),
    direction,
    sources,
  };
}

// ---- Public: turn conviction into a trade decision for a LONG (call) trade -
// side defaults to "long" (Vol Desk always buys calls). Returns the sizing
// multiplier and whether the trade is blocked, per the configured effect mode.
export function decideForTrade(conv, cfg = loadConfig(), side = "long") {
  const f = cfg.flow;
  const wantBullish = side !== "short";

  // Flow off, or nothing found -> neutral: full size, never block.
  if (!f.enabled) return verdict("flow-disabled", "neutral", 1.0, false, conv, cfg);
  if (!conv.found) return verdict("no-flow-data", "neutral", modeNeutralMult(cfg), false, conv, cfg);

  const agrees = wantBullish ? conv.direction === "bullish" : conv.direction === "bearish";
  const opposes = wantBullish ? conv.direction === "bearish" : conv.direction === "bullish";
  const strong = conv.combinedScore >= (f.minScore || 0);

  let stance = "neutral";
  if (agrees && strong) stance = "agree";
  else if (opposes && strong) stance = "disagree";

  if (f.mode === "display") {
    return verdict(stance, stance, 1.0, false, conv, cfg);
  }
  if (f.mode === "gate") {
    // Hard gate: only take the trade when flow agrees. Otherwise block.
    const block = stance !== "agree";
    return verdict(stance, stance, block ? 0 : 1.0, block, conv, cfg);
  }
  // "size" (default): agree = full, disagree = very small (going against flow),
  // neutral = reduced.
  const mult = stance === "agree" ? f.sizing.agree
    : stance === "disagree" ? f.sizing.disagree
    : f.sizing.neutral;
  return verdict(stance, stance, mult, false, conv, cfg);
}

function modeNeutralMult(cfg) {
  const f = cfg.flow;
  if (f.mode === "display") return 1.0;
  if (f.mode === "gate") return 0;          // no confirming flow -> gate blocks
  return f.sizing.neutral;                    // size mode
}

function verdict(reason, stance, sizeMultiplier, block, conv, cfg) {
  return {
    mode: cfg.flow.mode,
    stance,                                   // agree | disagree | neutral
    reason,
    sizeMultiplier: +Number(sizeMultiplier).toFixed(3),
    block,
    flowDirection: conv.direction,
    flowScore: conv.combinedScore ?? 0,
  };
}
