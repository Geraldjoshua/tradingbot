// Risk/reward contract selection.
//
// The old selectCall() just took the expiry nearest a DTE target and the strike
// nearest ~5% ITM. Reasonable, but arbitrary: it never asked "which of these
// contracts actually pays best if the thesis works, and loses least if it
// doesn't?" Two contracts on the same underlying can have wildly different R/R
// once spread, theta and convexity are accounted for.
//
// This module scores a GRID of candidates (several expiries x several strikes)
// against the Vol Desk levels we already have:
//
//   reward = value(spot -> T1, clock advanced) - entry premium
//   risk   = entry premium - value(spot -> stop, clock advanced)
//   R/R    = reward / risk
//
// Method per candidate:
//   1. Take the live mid as the entry price (spread is charged separately).
//   2. Back out the IV the market is pricing into THAT strike (options.impliedVol),
//      so we respect the real skew instead of assuming one vol for the chain.
//   3. Re-price with Black-Scholes at the target and at the stop, with the clock
//      advanced by the expected holding period (theta is a real cost).
//   4. Reject contracts that are structurally bad regardless of R/R:
//        - bid/ask spread too wide (you lose the edge on entry+exit)
//        - breakeven above T1 (you literally cannot profit at your own target)
//        - delta outside band (lottery tickets / capital-hogging deep ITM)
//        - no bid (can't get out)
//   5. Rank on R/R, lightly penalised by spread.
//
// Everything is an ESTIMATE (constant IV, no skew evolution, a single expected
// holding period). It's a comparison tool for ranking contracts against each
// other — not a promise of fills.

import * as alpaca from "./alpaca.js";
import { bs, impliedVol, realizedVol } from "./options.js";

const iso = (d) => d.toISOString().slice(0, 10);
const YEAR_MS = 365 * 24 * 3600 * 1000;

export const DEFAULTS = {
  mode: "rr",                  // "rr" | "legacy"
  dteMin: 21,
  dteMax: 75,
  dteTarget: 45,
  strikeBandPct: 0.20,         // consider strikes +/-20% around spot
  maxExpiries: 3,              // how many expiries to price (each costs a quote call)
  maxCandidates: 24,           // hard cap on contracts priced
  expectedDaysToTarget: 14,    // calendar days assumed to reach T1 (theta drag)
  minRR: 1.5,                  // reject anything below this reward:risk
  maxSpreadPct: 0.15,          // (ask-bid)/mid
  minDelta: 0.35,              // avoid far-OTM lottery tickets
  maxDelta: 0.90,              // avoid deep ITM (ties up premium, low convexity)
  requireBreakevenBelowTarget: true,
  riskFreeRate: 0.04,
};

function cfgFor(cfg) {
  return { ...DEFAULTS, ...(cfg?.contractSelection || {}) };
}

// Pull a grid of contracts around spot across a few expiries.
async function candidateGrid(ticker, spot, type, c) {
  const expGte = iso(new Date(Date.now() + c.dteMin * 864e5));
  const expLte = iso(new Date(Date.now() + c.dteMax * 864e5));
  const band = spot * c.strikeBandPct;
  const contracts = await alpaca.getOptionContracts({
    underlying: ticker, type, expGte, expLte,
    strikeGte: spot - band, strikeLte: spot + band, limit: 800,
  });
  if (!contracts.length) return [];

  const dte = (e) => (Date.parse(e + "T20:00:00Z") - Date.now()) / 864e5;
  // Keep the expiries closest to the DTE target.
  const exps = [...new Set(contracts.map((x) => x.expiration_date))]
    .sort((a, b) => Math.abs(dte(a) - c.dteTarget) - Math.abs(dte(b) - c.dteTarget))
    .slice(0, c.maxExpiries);

  // Within each expiry keep strikes nearest spot, so we price a sane grid.
  const perExp = Math.max(3, Math.floor(c.maxCandidates / exps.length));
  const grid = [];
  for (const e of exps) {
    const forExp = contracts
      .filter((x) => x.expiration_date === e)
      .sort((a, b) => Math.abs(+a.strike_price - spot) - Math.abs(+b.strike_price - spot))
      .slice(0, perExp);
    for (const x of forExp) grid.push({ ...x, _dte: dte(e) });
  }
  return grid.slice(0, c.maxCandidates);
}

// Score one contract. Returns null if it can't be evaluated at all.
// Exported so the scoring can be inspected/tested without hitting the broker.
export function evaluate(k, { spot, target, stop, type, c, fallbackVol }) {
  const K = +k.strike_price;
  const T = Math.max(k._dte / 365, 1e-5);
  const bid = k._bid, ask = k._ask;
  if (!(ask > 0)) return null;
  const mid = bid > 0 ? (bid + ask) / 2 : ask;
  if (!(mid > 0)) return null;

  const spreadPct = bid > 0 ? (ask - bid) / mid : 1;

  // IV implied by this specific strike (respects skew); fall back to realized.
  const iv = impliedVol(type, mid, spot, K, T, c.riskFreeRate) || fallbackVol;

  // Advance the clock by the expected holding period — theta is a real cost.
  const heldYears = Math.min(c.expectedDaysToTarget, k._dte * 0.9) / 365;
  const Tafter = Math.max(T - heldYears, 1e-5);

  const atTarget = bs(type, target, K, Tafter, c.riskFreeRate, iv).price;
  const atStop = bs(type, stop, K, Tafter, c.riskFreeRate, iv).price;
  const entryLeg = bs(type, spot, K, T, c.riskFreeRate, iv);

  // Charge the spread: you buy near ask, you exit near bid.
  const entryCost = ask > 0 ? (mid + (ask - mid) * 0.5) : mid;
  const exitAtTarget = atTarget * (1 - spreadPct / 2);
  const exitAtStop = atStop * (1 - spreadPct / 2);

  const reward = exitAtTarget - entryCost;
  const risk = Math.max(entryCost - exitAtStop, 0.01);   // never divide by ~0
  const rr = reward / risk;

  const breakeven = type === "call" ? K + entryCost : K - entryCost;
  const delta = Math.abs(entryLeg.delta);

  const reasons = [];
  // Price ceiling: "find a cheaper contract" mode passes the budget down here, so
  // instead of picking the best contract and *then* discovering we can't afford
  // it, we only ever rank contracts that fit. A contract is 100 shares, so the
  // cash cost is entryCost x 100.
  if (c.maxPremium > 0 && entryCost * 100 > c.maxPremium) {
    reasons.push(`costs $${Math.round(entryCost * 100)} > budget $${Math.round(c.maxPremium)}`);
  }
  if (spreadPct > c.maxSpreadPct) reasons.push(`spread ${(spreadPct * 100).toFixed(0)}%`);
  if (!(bid > 0)) reasons.push("no bid");
  if (delta < c.minDelta) reasons.push(`delta ${delta.toFixed(2)} too low`);
  if (delta > c.maxDelta) reasons.push(`delta ${delta.toFixed(2)} too deep`);
  if (c.requireBreakevenBelowTarget) {
    const bad = type === "call" ? breakeven > target : breakeven < target;
    if (bad) reasons.push(`breakeven ${breakeven.toFixed(2)} beyond target ${target.toFixed(2)}`);
  }
  if (rr < c.minRR) reasons.push(`R/R ${rr.toFixed(2)} < ${c.minRR}`);

  // Rank on R/R, lightly penalised for spread (a wide market erodes edge twice).
  const score = rr * (1 - Math.min(spreadPct, 0.5));

  return {
    symbol: k.symbol, strike: K, expiry: k.expiration_date, dte: Math.round(k._dte),
    type, bid: bid ?? null, ask, mid: +mid.toFixed(2),
    spreadPct: +(spreadPct * 100).toFixed(1),
    iv: +iv.toFixed(4), delta: +delta.toFixed(3),
    breakeven: +breakeven.toFixed(2),
    entryCost: +entryCost.toFixed(2),
    valueAtTarget: +exitAtTarget.toFixed(2),
    valueAtStop: +exitAtStop.toFixed(2),
    reward: +reward.toFixed(2), risk: +risk.toFixed(2),
    rr: +rr.toFixed(2), score: +score.toFixed(3),
    ok: reasons.length === 0, reasons,
  };
}

// ---- Public ---------------------------------------------------------------
// levels: { target, stop } — for Vol Desk longs, target = T1, stop = nTrans.
// Returns { best, alternatives, rejected, note }.
// opts.maxPremium — dollar ceiling for ONE contract (premium x 100). Contracts
// above it are rejected outright, so the winner is the best contract you can
// actually afford rather than the best contract full stop.
export async function selectByRiskReward(ticker, spot, levels, cfg, type = "call", opts = {}) {
  const c = { ...cfgFor(cfg), ...(opts.maxPremium > 0 ? { maxPremium: opts.maxPremium } : {}) };
  const target = levels.target, stop = levels.stop;
  if (!(target > 0) || !(stop > 0)) throw new Error("selectByRiskReward needs target and stop levels");

  const grid = await candidateGrid(ticker, spot, type, c);
  if (!grid.length) throw new Error(`no ${type} contracts in ${c.dteMin}-${c.dteMax} DTE window`);

  // Batch-quote the whole grid in one call.
  const quotes = await alpaca.getOptionQuotes(grid.map((g) => g.symbol));
  for (const g of grid) {
    const q = quotes[g.symbol]?.latestQuote;
    g._bid = q?.bp ?? null;
    g._ask = q?.ap ?? null;
  }

  // Fallback vol if a strike's IV won't solve.
  let fallbackVol = 0.45;
  try {
    const daily = await alpaca.getBars(ticker, "1Day", new Date(Date.now() - 90 * 864e5).toISOString(), null);
    if (daily?.length > 5) fallbackVol = realizedVol(daily);
  } catch {}

  const scored = grid
    .map((g) => evaluate(g, { spot, target, stop, type, c, fallbackVol }))
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);

  const passing = scored.filter((s) => s.ok);
  const best = passing[0] || null;

  return {
    best,
    alternatives: passing.slice(1, 4),
    rejected: scored.filter((s) => !s.ok).slice(0, 6)
      .map((s) => ({ symbol: s.symbol, strike: s.strike, expiry: s.expiry, rr: s.rr, reasons: s.reasons })),
    evaluated: scored.length,
    note: best
      ? `best R/R ${best.rr} (${best.strike} ${best.expiry}, ${best.dte}d, delta ${best.delta})`
      : `no contract passed filters out of ${scored.length} evaluated`,
  };
}
