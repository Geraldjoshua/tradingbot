// Side-aware playbook: one place that answers "for a LONG or a SHORT on this
// GEX structure, what are my entry trigger, stop, and targets?"
//
// The Vol Desk engine was written long-only. Its levels are:
//
//   nTrans      put wall — largest negative-GEX strike BELOW spot
//   pTrans      gamma-flip reclaim level, clamped into (nTrans, spot]
//   plusGEX_T1  call wall ABOVE spot           <- long target
//   T2 / COTMC  call-OI-weighted strike        <- long runner
//   COTMP       put-OI-weighted strike         <- the DOWNSIDE analog
//
// LONG (calls) — unchanged, this is the original playbook:
//   trigger  first 5-min close ABOVE pTrans   (reclaiming positive gamma)
//   stop     nTrans                            (put wall fails)
//   T1/T2    plusGEX_T1 / T2
//
// SHORT (puts) — the mirror. Losing the put wall means dealers flip from
//   supportive to accelerant, so:
//   trigger  first 5-min close BELOW nTrans   (put wall breaks)
//   stop     pTrans                            (reclaiming the flip kills the idea)
//   T1       COTMP if it sits below nTrans, else a measured move equal to the
//            pTrans-nTrans band projected down from nTrans
//   T2       1.5x that measured move
//
// ⚠ HONESTY: the CONFIRMED/PENDING/BLOCKED tag from voldesk.py is computed for
// LONGS ONLY (it literally tests spot >= pTrans). It is NOT valid for shorts, so
// we do not reuse it — `assessShort()` below does its own gating. The bearish
// side is a symmetric heuristic on the same raw GEX levels, not a vendor rule
// set, and it has had far less forward-testing than the long side. Treat it as
// more experimental.

export function levelsFor(snap, side = "long") {
  const L = snap?.levels || {};
  const { pTrans, nTrans, plusGEX_T1, T2, COTMP } = L;
  if (pTrans == null || nTrans == null) return null;

  if (side !== "short") {
    return {
      side: "long", optionType: "call",
      trigger: pTrans, triggerDir: "above",
      stop: nTrans,
      t1: plusGEX_T1 ?? null,
      t2: T2 ?? null,
      band: +(pTrans - nTrans).toFixed(2),
    };
  }

  // Bearish mirror.
  const band = Math.max(pTrans - nTrans, 0.01);
  const measured = +(nTrans - band).toFixed(2);
  const t1 = (COTMP != null && COTMP < nTrans) ? COTMP : measured;
  // T2 must be a genuine runner BEYOND T1, never equal to it (COTMP can land
  // exactly on the measured move, which would collapse the two).
  const t2 = +Math.min(nTrans - band * 1.5, t1 - band * 0.5).toFixed(2);
  return {
    side: "short", optionType: "put",
    trigger: nTrans, triggerDir: "below",
    stop: pTrans,
    t1, t2: Math.max(t2, 0.01),        // floor at a positive price
    band: +band.toFixed(2),
    t1Source: (COTMP != null && COTMP < nTrans) ? "COTMP" : "measured-move",
  };
}

// Has the intraday trigger fired? `close` is the first regular-hours 5-min close.
export function triggerMet(close, levels) {
  if (close == null || !levels) return false;
  return levels.triggerDir === "above" ? close > levels.trigger : close < levels.trigger;
}

// Long gating is voldesk.py's own tag. Short gating is ours.
//
// Requirements for a short:
//   * spot at/below the put wall (broken) or within `pendingPct` above it
//   * a real target below (t1 must be meaningfully under the trigger)
//   * risk:reward to t1 at least minRR, measured trigger->stop vs trigger->t1
export function assessShort(snap, spot, levels, { pendingPct = 0.005, minRR = 1.5 } = {}) {
  const reasons = [];
  if (!levels || levels.side !== "short") return { ok: false, tag: "BLOCKED", reasons: ["no bearish levels"] };
  if (spot == null) return { ok: false, tag: "BLOCKED", reasons: ["no spot"] };

  const broken = spot <= levels.trigger;
  const near = spot <= levels.trigger * (1 + pendingPct);
  if (!near) reasons.push(`spot ${spot.toFixed(2)} >${(pendingPct * 100).toFixed(1)}% above put wall ${levels.trigger}`);

  // Measured from where the order would actually fill, not from the trigger.
  // Selling above the market isn't possible, so once price is already through
  // the put wall the entry is spot. The long side had exactly this bug and it
  // was severe there (R/R 11 reported vs 0.26 real) because nothing kept spot
  // near the trigger. Here the `near` check above bounds the gap to pendingPct,
  // so the error was small — but there's no reason to carry it.
  const entryRef = Math.min(spot, levels.trigger);
  const risk = levels.stop - entryRef;            // adverse move to invalidation
  const reward = entryRef - levels.t1;            // favourable move to target
  const rr = risk > 0 ? +(reward / risk).toFixed(2) : null;
  if (!(reward > 0)) reasons.push("no downside target below the put wall");
  if (rr != null && rr < minRR) reasons.push(`R/R ${rr} < ${minRR}`);
  if (rr == null) reasons.push("stop not above trigger (degenerate levels)");

  const tag = reasons.length === 0 ? (broken ? "CONFIRMED" : "PENDING") : "BLOCKED";
  return { ok: reasons.length === 0 && broken, tag, rr, reasons, broken, near };
}

// Which way should we trade this name, given flow? Returns null if the enabled
// set doesn't allow the direction flow is pointing.
export function sideFromFlow(conviction, cfg) {
  const allowLong = cfg.sides?.long !== false;
  const allowShort = cfg.sides?.short === true;      // opt-in
  const dir = conviction?.direction;
  if (dir === "bearish" && allowShort) return "short";
  if (dir === "bullish" && allowLong) return "long";
  // No flow signal: default to long only if longs are enabled.
  if (!conviction?.found && allowLong) return "long";
  return null;
}

// Directional P&L helpers so position management doesn't repeat sign logic.
export const adverse = (side, spot, level) => (side === "short" ? spot > level : spot < level);
export const favourable = (side, spot, level) => (side === "short" ? spot <= level : spot >= level);

// Progress from entry toward t1, 0..1, correct for both directions.
export function progressToTarget(side, spot, entrySpot, t1) {
  if (spot == null || entrySpot == null || t1 == null) return 0;
  const span = side === "short" ? entrySpot - t1 : t1 - entrySpot;
  if (!(span > 0)) return 0;
  const moved = side === "short" ? entrySpot - spot : spot - entrySpot;
  return Math.max(0, Math.min(1, moved / span));
}
