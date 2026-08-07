// Self-test for the changes made to entry gating, contract scoring and the stop
// ratchet. Pure functions only — no broker, no network, no data dir.
import assert from "node:assert";
import * as cs from "../server/contract_select.js";
import * as playbook from "../server/playbook.js";

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; }
};

const cfg = {
  contractSelection: {
    minRR: 1.5, maxSpreadPct: 0.15, minDelta: 0.35, maxDelta: 0.90,
    requireBreakevenBelowTarget: true, riskFreeRate: 0.04, expectedDaysToTarget: 14,
  },
};
const exp = new Date(Date.now() + 45 * 864e5).toISOString().slice(0, 10);

console.log("\n(e) the legacy picker can no longer bypass the R/R bar");

t("a wide-spread pick is rejected with a spread reason", () => {
  const v = cs.evaluatePick(
    { symbol: "X", strike: 95, expiry: exp, dte: 45, bid: 19.8, ask: 27.2 },
    { spot: 100, target: 108, stop: 96, type: "call", cfg });
  assert.ok(v, "should still be priceable");
  assert.strictEqual(v.ok, false);
  assert.ok(v.reasons.some((r) => r.includes("spread")), `reasons: ${v.reasons}`);
});

t("a pick whose breakeven sits past T1 is rejected", () => {
  // Deep OTM-ish strike + fat premium: breakeven above the target.
  const v = cs.evaluatePick(
    { symbol: "X", strike: 106, expiry: exp, dte: 45, bid: 5.0, ask: 5.2 },
    { spot: 100, target: 108, stop: 96, type: "call", cfg });
  assert.strictEqual(v.ok, false);
  assert.ok(v.reasons.some((r) => r.includes("breakeven")), `reasons: ${v.reasons}`);
});

t("a genuinely poor R/R is rejected rather than bought", () => {
  const v = cs.evaluatePick(
    { symbol: "X", strike: 90, expiry: exp, dte: 45, bid: 12.0, ask: 12.2 },
    { spot: 100, target: 102, stop: 96, type: "call", cfg });
  assert.strictEqual(v.ok, false);
  assert.ok(v.reasons.some((r) => r.startsWith("R/R")), `reasons: ${v.reasons}`);
});

t("a contract over the per-contract budget ceiling is rejected", () => {
  const v = cs.evaluatePick(
    { symbol: "X", strike: 95, expiry: exp, dte: 45, bid: 8.0, ask: 8.2 },
    { spot: 100, target: 115, stop: 96, type: "call", cfg, maxPremium: 300 });
  assert.strictEqual(v.ok, false);
  assert.ok(v.reasons.some((r) => r.includes("budget")), `reasons: ${v.reasons}`);
});

t("an unquoted pick returns null instead of a free pass", () => {
  assert.strictEqual(cs.evaluatePick({ symbol: "X", strike: 95, expiry: exp, ask: 0 },
    { spot: 100, target: 108, stop: 96, type: "call", cfg }), null);
});

t("a clean contract still passes — the bar is not simply unreachable", () => {
  const v = cs.evaluatePick(
    { symbol: "X", strike: 95, expiry: exp, dte: 45, bid: 8.0, ask: 8.2 },
    { spot: 100, target: 115, stop: 96, type: "call", cfg });
  assert.strictEqual(v.ok, true, `unexpectedly rejected: ${v.reasons}`);
  assert.ok(v.rr >= 1.5);
});

console.log("\n(a) anti-chase: R/R measured from the actual fill");

const rrAtFill = (side, spot, t1, stop) => {
  const d = Math.abs(spot - stop);
  return d > 0 ? +(Math.abs(t1 - spot) / d).toFixed(2) : null;
};

t("an on-time entry near the trigger clears the floor", () => {
  // pTrans 100, nTrans 96, T1 112. Filled at 100.5.
  assert.ok(rrAtFill("long", 100.5, 112, 96) >= 1.5);
});

t("the same setup entered 6% extended is refused", () => {
  // Extension shortens the run to T1 and lengthens the fall to the stop at once.
  const rr = rrAtFill("long", 106, 112, 96);
  assert.ok(rr < 1.5, `rr at fill was ${rr}, expected < 1.5`);
});

t("the scan-time R/R would still have said 4:1 on that same trade", () => {
  const scanRR = (112 - 100) / (100 - 96);
  assert.ok(scanRR >= 2.0, "scan R/R passes — which is exactly the blind spot");
});

t("spot already through the stop is caught by playbook.adverse", () => {
  assert.strictEqual(playbook.adverse("long", 95.5, 96), true);
  assert.strictEqual(playbook.adverse("short", 100.5, 100), true);
  assert.strictEqual(playbook.adverse("long", 97, 96), false);
});

console.log("\n(b) stop ratchet arithmetic");

// Mirror of the logic added to evaluatePositions.
function ratchet(side, entrySpot, t1, curStop, progress, rungs) {
  const span = side === "short" ? entrySpot - t1 : t1 - entrySpot;
  if (!(span > 0)) return curStop;
  const hit = rungs.filter((r) => progress >= r.at).sort((a, b) => a.at - b.at).pop();
  if (!hit) return curStop;
  const want = side === "short"
    ? +(entrySpot - span * hit.lock).toFixed(2)
    : +(entrySpot + span * hit.lock).toFixed(2);
  const tighter = side === "short" ? want < curStop : want > curStop;
  return tighter ? want : curStop;
}
const rungs = [{ at: 0.5, lock: 0 }, { at: 0.75, lock: 0.4 }];

t("below the first rung the stop is untouched", () => {
  assert.strictEqual(ratchet("long", 100, 112, 96, 0.30, rungs), 96);
});
t("at half way the stop moves to entry", () => {
  assert.strictEqual(ratchet("long", 100, 112, 96, 0.55, rungs), 100);
});
t("at three quarters it locks 40% of the move", () => {
  assert.strictEqual(ratchet("long", 100, 112, 100, 0.80, rungs), 104.8);
});
t("it never loosens a stop that is already tighter", () => {
  assert.strictEqual(ratchet("long", 100, 112, 106, 0.55, rungs), 106);
});
t("shorts ratchet downward, not upward", () => {
  assert.strictEqual(ratchet("short", 100, 88, 104, 0.55, rungs), 100);
  assert.strictEqual(ratchet("short", 100, 88, 100, 0.80, rungs), 95.2);
});
t("a degenerate span (t1 at entry) is left alone", () => {
  assert.strictEqual(ratchet("long", 100, 100, 96, 0.9, rungs), 96);
});

console.log("\n(b) Stop 4 stall detection, given progress history actually persists");

function stalled(log, daysHeld) {
  if (!(log.length >= 4 && daysHeld >= 3)) return false;
  const last4 = log.slice(-4);
  const gains = last4.slice(1).map((e, i) => e.p - last4[i].p);
  return gains.length === 3 && gains.every((g) => g < 10);
}
t("three flat sessions trigger the stall stop", () => {
  assert.strictEqual(stalled([{p:5},{p:8},{p:11},{p:14}], 4), true);
});
t("a session that ran does not", () => {
  assert.strictEqual(stalled([{p:5},{p:8},{p:30},{p:34}], 4), false);
});
t("with an empty log — the old, unpersisted state — it can never fire", () => {
  assert.strictEqual(stalled([], 9), false);
  assert.strictEqual(stalled([{p:5}], 9), false);
});

console.log("\n(d) side flip is narrow: opposite side must stand on its own");

t("a broken long yields short levels that grade independently", () => {
  const snap = { levels: { pTrans: 100, nTrans: 96, plusGEX_T1: 112, T2: 118, COTMP: 86 } };
  const lvL = playbook.levelsFor(snap, "long");
  const lvS = playbook.levelsFor(snap, "short");
  assert.strictEqual(lvL.stop, 96);
  assert.strictEqual(lvS.trigger, 96);
  assert.strictEqual(lvS.stop, 100);
  // Spot at 95.5 broke the long stop and is through the short trigger.
  assert.strictEqual(playbook.adverse("long", 95.5, lvL.stop), true);
  assert.strictEqual(playbook.adverse("short", 95.5, lvS.stop), false);
  const a = playbook.assessShort(snap, 95.5, lvS, { minRR: 1.5 });
  assert.ok(["CONFIRMED", "PENDING"].includes(a.tag), `short tag was ${a.tag}: ${a.reasons}`);
});

t("a marginally-profitable short is refused, not taken as a consolation", () => {
  // Same broken long, but COTMP only 90: R/R from the fill is 1.22 against a
  // 1.5 floor. The flip must NOT fire — "the long failed" is not on its own a
  // reason to be short, which is the entire point of grading the other side
  // independently rather than just reversing the sign.
  const snap = { levels: { pTrans: 100, nTrans: 96, plusGEX_T1: 112, COTMP: 90 } };
  const lvS = playbook.levelsFor(snap, "short");
  const a = playbook.assessShort(snap, 95.5, lvS, { minRR: 1.5 });
  assert.strictEqual(a.tag, "BLOCKED", `reasons: ${a.reasons}`);
  assert.ok(a.reasons.some((r) => r.startsWith("R/R")), `reasons: ${a.reasons}`);
});

t("a short with no real target below is NOT flipped into", () => {
  const snap = { levels: { pTrans: 100, nTrans: 99.9, plusGEX_T1: 112, COTMP: 99.95 } };
  const lvS = playbook.levelsFor(snap, "short");
  const a = playbook.assessShort(snap, 99.8, lvS, { minRR: 1.5 });
  assert.strictEqual(a.tag, "BLOCKED", `reasons: ${a.reasons}`);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
