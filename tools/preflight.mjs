#!/usr/bin/env node
// Sanity checks that run automatically in CI on every push. Nothing to remember.
//
// These are not unit tests — they are the "would this deploy be broken?"
// questions that actually bit us: a config value silently flipped by a stray
// write, a budget that makes every trade unfillable, a tag list that quietly
// disables entries. Cheap to check, expensive to discover live.
import { readFileSync } from "fs";

const cfg = JSON.parse(readFileSync(new URL("../server/autotrader.config.json", import.meta.url)));
let bad = 0;
const check = (ok, msg, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${msg}${detail ? `  — ${detail}` : ""}`);
  if (!ok) bad++;
};

console.log("\nconfig sanity");

const bp = cfg.risk?.basePremium;
check(bp > 0, "basePremium is set", `${bp}`);

// The one that would have shipped today: portfolio mode splits basePremium
// across slots, so a small budget makes every trade unfillable.
const mode = cfg.risk?.budgetMode;
check(["per-trade", "portfolio"].includes(mode), "budgetMode is valid", mode);
if (mode === "portfolio") {
  const slots = cfg.risk?.portfolioSlots || cfg.automation?.maxConcurrent || 1;
  const per = bp / slots;
  check(per >= 250, "portfolio mode leaves a usable per-trade budget",
    `$${bp} / ${slots} slots = $${Math.round(per)} each`);
}

const tags = cfg.entry?.requireTag || [];
check(Array.isArray(tags) && tags.length > 0, "entry.requireTag is not empty",
  JSON.stringify(tags));
check(tags.includes("CONFIRMED"), "entry.requireTag still admits CONFIRMED",
  JSON.stringify(tags));

const mult = cfg.risk?.maxDailyLossMultiple ?? 0;
const worst = bp * (cfg.management?.maxPremiumLossPct ?? 0.6);
check(mult === 0 || mult * bp > worst, "daily loss limit survives one full stop-out",
  `halt $${Math.round(mult * bp)} vs worst single loss ~$${Math.round(worst)}`);

const tiers = cfg.management?.profitRatchet?.tiers;
if (Array.isArray(tiers)) {
  const sorted = [...tiers].sort((a, b) => a.atGainPct - b.atGainPct);
  check(sorted.every((t, i, a) => i === 0 || t.giveBackPct <= a[i - 1].giveBackPct),
    "profit-ratchet tiers tighten as gains grow",
    sorted.map((t) => `+${t.atGainPct * 100}%→keep${Math.round((1 - t.giveBackPct) * 100)}%`).join(" "));
}

check((cfg.setup?.minRRAtFill ?? 0) > 0, "minRRAtFill is set (anti-chase active)",
  `${cfg.setup?.minRRAtFill}`);

console.log(`\n${bad === 0 ? "config OK" : `${bad} problem(s) — deploy would be broken`}\n`);
process.exit(bad ? 1 : 0);
