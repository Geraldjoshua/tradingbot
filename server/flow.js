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
import { pythonPath } from "./pythonPath.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_PATH = path.join(ROOT, "server", "autotrader.config.json");
// Cross-platform (Windows venv lives in Scripts\, not bin/) — see pythonPath.js
const PY = pythonPath();

const DEFAULTS = {
  automation: {
    enabled: false, mode: "full", pollSeconds: 60,
    strategies: { voldesk: true, gapgo: false },
    marketHoursOnly: true, t1Action: "take-profit",
    maxConcurrent: 5, maxDailyEntries: 3, entryCooldownMin: 30, watchlist: [],
    // "open"     — only the 09:30-09:35 close can trigger (original behaviour)
    // "intraday" — a later 5-min bar may also trigger, but only on a genuine
    //              crossing of the level, never merely "price is already past it"
    triggerMode: "open",
    intradayCutoffMin: 840,        // 14:00 ET — no new intraday triggers after this
    // Queued (overnight) exits wait this many minutes after 09:30 before firing,
    // so a stop that crosses the book does not do it into the opening auction.
    queuedExitDelayMin: 5,
  },
  discovery: {
    enabled: true, shadowMode: false,
    sources: { optionstrat: true, unusualwhales: false },
    uwFallbackOnly: true, everyMinutes: 30,
    maxScan: 8, scanConcurrency: 2, scanStaggerMs: 400,
    minPremium: 250000, minScore: 0.3,
    normalize: "marketcap",
    // Let each tier's own minPremium do the filtering instead of one flat gate.
    // With this false, discovery.minPremium is applied to every name regardless
    // of size — which silently made the smaller tiers' floors unreachable.
    tierFloors: true,
    // Rank preference (not a filter) for names whose contracts fit the budget.
    affordability: {
      // useVol is the more principled estimate and measured no better on the
      // fills we have — see the note above applyAffordability(). Left off.
      enabled: false, useVol: false, itmFactor: 1.7,
      premiumPctOfSpot: 0.07,      // ~ what real fills came in at, as % of spot
      boost: 2.0, penalty: 0.5,
    }, minTierScore: 1.0, maxTierScore: 20,
    keepUnsized: false, dollarVolRefBps: 20,
    tiers: {
      micro: { enabled: false, refBps: 15, minPremium: 50000 },
      small: { enabled: true, refBps: 8, minPremium: 100000 },
      mid: { enabled: true, refBps: 4, minPremium: 250000 },
      large: { enabled: true, refBps: 1.5, minPremium: 450000 },
      mega: { enabled: true, refBps: 0.3, minPremium: 650000 },
    },
    acceptTags: ["CONFIRMED"],            // tradeable today
    seedTags: ["CONFIRMED", "PENDING"],   // worth observing
    minGrade: 0, seedMinGrade: 0,
    maxDte: 45, requireDeltaBalance: true, exclude: [], scanRetryMin: 30,
  },
  flow: {
    enabled: false, mode: "size",
    sources: { optionstrat: true, unusualwhales: false },
    optionstratDir: "",
    maxAgeDays: 3, staleAction: "warn",
    sizing: { agree: 1.0, neutral: 0.7, disagree: 0.25 },
    minScore: 0.15,
    boosts: { unusual: 0.1, knows: 0.15 },
    sourceWeights: { optionstrat: 1.0, unusualwhales: 1.0 },
  },
  observe: {
    maxObserving: 25, maxObserveDays: 10,
    dropOnFlowGone: true, dropOnFlowFlip: true, flowDecayRatio: 0.4,
    // Same reasoning as entry.requireTag: a PENDING name is fully vetted and
    // simply hasn't crossed yet. Holding it at OBSERVING until the next scan
    // sees it CONFIRMED guarantees the bot is late.
    blockedStrikes: 3, requireTags: ["CONFIRMED", "PENDING"], minGrade: 0,
    // How often the list is re-vetted. This was hard-wired to once per calendar
    // day, which meant a name that firmed up at 10:15 could not become READY
    // until tomorrow -- by which point the reclaim it was waiting for had
    // happened without us. Discovery already runs every 30 minutes; the
    // assessment it feeds was the bottleneck, not the scan.
    assessEveryMinutes: 60,
    // ---- SIDE IS A CONCLUSION, NOT AN IDENTITY ------------------------------
    // A row used to be stamped `side` once at seed time and never revisited, so
    // a long whose structure broke was DROPPED rather than re-read as a short --
    // and the setup that most reliably produces a good short is a failed long.
    // We threw away the signal at exactly the moment it became informative.
    //
    // Flipping is deliberately narrow. It fires only when the CURRENT side is
    // structurally dead AND the opposite side independently grades out on the
    // same scan. Flow can widen the search; it cannot on its own decide
    // direction, because flow disagreeing with structure is a reason to stand
    // aside, not a reason to reverse.
    allowSideFlip: true,
    maxSideFlips: 1,           // one reversal per row, then it is just noise
  },
  contractSelection: {
    mode: "rr", dteMin: 21, dteMax: 75, dteTarget: 45,
    strikeBandPct: 0.20, maxExpiries: 3, maxCandidates: 60,
    expectedDaysToTarget: 14, minRR: 1.5, maxSpreadPct: 0.15,
    minDelta: 0.35, maxDelta: 0.90,
    requireBreakevenBelowTarget: true, riskFreeRate: 0.04,
    // Liquidity floor for a strike to be considered at all. The contracts
    // endpoint already returns open_interest; selection simply never read it,
    // so a tight-quoting but empty strike was indistinguishable from a real one.
    // Lower it for small-caps if you see "chain too thin" on names you want.
    minOpenInterest: 250,
    // WHAT HAPPENS WHEN NOTHING IN THE CHAIN CLEARS THE BAR.
    // This used to be undefined behaviour with a very bad answer. The R/R
    // selector would reject every contract, a second naive picker would then
    // grab one by DTE/moneyness, and the ONLY thing standing between that pick
    // and a real order was a spread check. A contract the selector had just
    // refused at 0.4:1 got bought anyway. Every filter described as the safety
    // net -- minRR, delta band, breakeven-below-target -- was unreachable on
    // that path, which is the single most likely explanation for a run of poor
    // fills on days the bot did trade.
    //
    //   "shares"   route the thesis into stock instead (default). No spread
    //              problem, no theta, and sizing is risk-based off the stop, so
    //              a full stop-out costs about the same as the premium budget.
    //   "skip"     take no trade at all. Strictest.
    //   "fallback" allow the naive picker -- but it is now SCORED through the
    //              same evaluate() as the grid, so it still has to pass minRR.
    //              This is no longer a bypass, just a second way to nominate.
    onNoQualifyingContract: "shares",
  },
  // Order execution — how hard we work to avoid paying the bid/ask spread.
  execution: {
    enabled: true,
    // PATIENT (entries, take-profits) — non-blocking, worked across ticks by
    // working_orders.js, so a long dwell costs nothing. 90s x 4 rungs = ~6 min.
    patient: { steps: 4, stepSeconds: 90, startAtMidPct: 0.0 },
    maxWorkingMinutes: 12,        // give up and don't trade rather than chase
    // URGENT (stop-losses) — synchronous and fast. Must fit inside one tick,
    // because not filling a stop is the expensive outcome.
    urgent:  { steps: 2, stepSeconds: 4, startAtMidPct: 0.5 },
    maxTotalSeconds: 20, minTickSize: 0.01,
  },
  // Entry quality gate — applies to EVERY entry path (discovery, observe list and
  // the manual watchlist alike). Previously only discovery names were vetted.
  // CONFIRMED means "spot is already past pTrans" — the cross has happened and,
  // by the time the next scan notices, price has usually run. Measured live:
  // NVDA was 8.00:1 at its trigger and 0.36:1 six percent later; TSLA 2.97:1 ->
  // 0.33:1. The setups were not bad, the arrival was.
  //
  // PENDING means "passed grade, cushion, R/R, spike-crash and OI-freshness, and
  // is within 0.5% BELOW pTrans" — everything vetted except the cross itself.
  // triggerBar() already watches 5-min bars live for that cross, so admitting
  // PENDING lets the bot enter AT the reclaim instead of after it. The trigger,
  // not the tag, becomes the last gate — which is what the playbook always said.
  entry: { requireTag: ["CONFIRMED", "PENDING"], minGrade: 0 },
  // The tradeable reward:risk bar for the SETUP (not for picking the contract —
  // that's contractSelection.minRR). Measured from where you'd actually fill, so
  // 2.0 is a real 2:1. Exposed so it can be tested against logged outcomes.
  setup: {
    minRR: 2.0,
    // ---- LIVE ENTRY GATES (anti-chase) --------------------------------------
    // Everything above is computed at SCAN time and cached in the daily
    // snapshot. Entry can happen hours later, after the name has run. The
    // snapshot still says the setup is 1% extended; you are buying it 6%
    // extended. These two gates are re-evaluated against LIVE spot at the
    // moment of entry, which is the only place the question can be answered
    // honestly.
    //
    // minRRAtFill -- reward:risk measured from where the order will actually
    // fill (spot), not from pTrans. Extension hurts twice: it shortens the run
    // to T1 and lengthens the fall to the stop, so this ratio collapses much
    // faster than the extension percentage does. It is the real anti-chase
    // gate; maxExtensionPct is the scan-time approximation of it.
    minRRAtFill: 1.5,
    // minUpsidePctForOptions -- how far T1 has to be from live spot before
    // BUYING PREMIUM makes sense at all. Under this, spread and theta eat the
    // whole move: a 3% run to target cannot pay for a 45-DTE option no matter
    // how clean the structure is. Below the line the trade routes to shares,
    // where there is no spread problem and no clock. 0 disables.
    minUpsidePctForOptions: 0.05,
    // How far past pTrans price may have run and still count as a reclaim.
    // `spot >= pTrans` alone tagged names CONFIRMED 8-25% beyond a trigger they
    // cleared weeks ago — the move was already gone. The short side always had
    // this guard at 0.5%; the long side never did.
    maxExtensionPct: 10.0,
    // Regime gates required (0-3). These were computed and written to every
    // snapshot from the start, and never actually enforced.
    minRegimeGates: 0,
  },
  // Which directions the bot may trade. Shorts (puts) are OPT-IN because the
  // bearish playbook is a mirror heuristic with far less forward-testing than
  // the long side — see server/playbook.js.
  // GEX wall selection. Per-contract gamma peaks at-the-money, so ranking
  // strikes by gamma alone hands back the strike nearest spot every time — the
  // "call wall" (= T1 target) landed 0.3% away and rr>=2 could never pass.
  walls: {
    minDistancePct: 0.015,   // CALL wall must be >=1.5% from spot (the target)
    weightByOi: false,       // rank by gamma x OI instead of gamma alone
    // Minimum distance from the ENTRY down to the stop. Without this the stop
    // collapses to one strike width and R/R is inflated by a tiny denominator
    // rather than earned — MSFT showed R/R 19 on a $2.50 risk leg.
    stopMinPct: 0.01,
  },
  // Where the GEX engine gets open interest, IV and bars. Alpaca is ~3 REST
  // calls per ticker against a generous limit; Yahoo is ~7 and rate-limits at
  // around 19 tickers. Yahoo stays as an automatic fallback when Alpaca keys
  // are missing or the API is down — a data outage should degrade the scan,
  // not abort it and leave the trader with no snapshot at all.
  data: { provider: "alpaca" },
  // Partial exit at T1: bank most of it, move the stop to entry, let the rest
  // run to T2. Needs >= 2 contracts — you cannot sell 80% of one contract.
  scaleOut: { enabled: false, firstPct: 0.8, moveStopToBreakeven: true },
  // ---- OPEN-POSITION MANAGEMENT --------------------------------------------
  // The original exit framework was all-or-nothing: the stop sat at nTrans from
  // entry to exit, so a position could travel 80% of the way to T1 and then give
  // the entire move back through its original stop. Stops 1-4 govern when to
  // abandon a loser; nothing governed protecting a winner.
  management: {
    // Progressive stop ratchet. Each rung fires once progress toward T1 reaches
    // `at`, and locks `lock` of the entry->T1 span. lock 0 = breakeven.
    // The stop only ever TIGHTENS -- a rung can never loosen a stop that some
    // other rule already moved up.
    //
    // Honest limit, same as the scale-out note: breakeven on the UNDERLYING is
    // not breakeven on the OPTION. Theta ran while you waited, so a stop-out at
    // your entry spot still books a premium loss. It caps the damage; it does
    // not eliminate it.
    stopRatchet: [
      { at: 0.50, lock: 0.00 },   // half way -> stop to entry
      { at: 0.75, lock: 0.40 },   // three quarters -> lock 40% of the move
    ],
    // Catastrophic premium backstop. Stops 1-4 are all measured on the
    // UNDERLYING, which is correct for the thesis but blind to what the option
    // is worth. A vol crush or a gap can halve the premium while spot is still
    // comfortably above nTrans. This is a backstop, not a strategy stop -- set
    // wide enough that structure gets to be wrong first. 0 disables.
    maxPremiumLossPct: 0.60,
    // Never carry a long-premium position into the gamma/theta cliff. If the
    // thesis needed 45 days and has had 35 of them, it isn't working.
    minDteExit: 10,
    // ---- PROFIT RATCHET: a trailing stop that knows nothing about the thesis --
    // stopRatchet above measures progress toward T1, which is fine for a trade
    // the bot planned and meaningless for one you placed yourself — T1 is not
    // your target. But "don't let a +150% winner become a loser" is not a view
    // about where price is going; it is risk management, and risk applies to
    // every position regardless of who opened it.
    //
    // So this trails the position's OWN P&L. It arms only after a real gain, and
    // then refuses to give back more than `giveBackPct` OF THAT GAIN (not of the
    // premium). Entry 8.00, peak 16.00 -> floor 12.80, still +60%. It never
    // decides when to take profit; it decides when a profit has been handed back.
    //
    // Options are noisy, so armAtGainPct is deliberately high — a trailing stop
    // that arms at +15% would be stopped out by ordinary two-day chop.
    // ON IN BOTH MODES. I originally left this off in full mode reasoning that
    // "T1 plus the stopRatchet already cover it". They do not, and the gap is
    // exactly the "went green then closed red" pattern:
    //
    //   stopRatchet measures the UNDERLYING's progress toward T1.
    //   Your P&L is in the OPTION, which moves ~6x that.
    //
    //   underlying +4%  ->  33% of the way to T1  ->  ratchet NOT armed
    //                   ->  but the option is already up ~24%
    //
    // So a position can be up 24%, round-trip the lot, and exit at Stop 1/3/4
    // for a loss having never once been protected. The underlying ratchet only
    // arms at the halfway mark, which on a 12% target means a 6% move — by which
    // point the option is up ~36% and has had plenty of chances to give it back.
    //
    // This one trails the option's own P&L, so it does not care where T1 is.
    // TIERED, because a single (arm, giveback) pair conflates two different jobs:
    //
    //   a +25% gain  -> the job is "do not let this become a LOSS"
    //   a +100% gain -> the job is "bank most of it"
    //
    // Those want opposite givebacks, so one pair has to pick a side. Armed at
    // +50% it ignored every smaller winner; armed at +25% with a tight giveback
    // it would clip real trends, because a 45-DTE 0.6-delta call swings 20-30%
    // intraday on a 3-4% underlying move.
    //
    // Tiers resolve it. The lowest tier gives back 90% — it only fires when a
    // gain has almost entirely evaporated, so ordinary chop cannot reach it, but
    // a winner can no longer round-trip into a loser. Higher tiers tighten as
    // there is more to protect. Highest tier reached wins.
    profitRatchet: {
      enabled: true,
      alsoInFullMode: true,   // the bot's own trades need this MOST
      tiers: [
        { atGainPct: 0.25, giveBackPct: 0.90 },   // +25% peak -> floor ~ +2%   (no losers)
        { atGainPct: 0.50, giveBackPct: 0.40 },   // +50% peak -> floor ~ +30%
        { atGainPct: 1.00, giveBackPct: 0.30 },   // +100% peak -> floor ~ +70%
      ],
      // Fallback if `tiers` is removed — the old single-pair behaviour.
      armAtGainPct: 0.50,
      giveBackPct: 0.40,
    },
  },
  // Keeping the local store honest against the broker.
  reconcile: {
    everyMinutes: 30,
    // Two categories, opposite defaults.
    //
    // orphanMode — positions the BOT opened and lost track of. data/ is
    //   gitignored and wiped on redeploy, so this happens routinely. These were
    //   placed under the framework and belong back under it: "full".
    //
    // adoptUntracked — positions the bot has never seen, i.e. yours. "protect"
    //   applies risk controls only (structural stop, drawdown, premium and DTE
    //   backstops) and deliberately withholds the time stop, the stall stop, the
    //   ratchet and auto-take-profit — those encode the GEX playbook's thesis,
    //   not yours. "full" hands them over completely; "off" leaves them alone.
    //
    // Either way, levels are RE-DERIVED from a fresh Vol Desk scan and the entry
    // is recovered from the broker's own fill ledger — nothing is invented.
    orphanMode: "full",              // "full" | "protect" | "off"
    adoptUntracked: "protect",       // "protect" | "full" | "off"
  },
  sides: { long: true, short: false },
  shares: {
    enabled: true, minShares: 1,
    // Notional <= this x the trade's budget. Was missing entirely, so the only
    // ceiling was maxNotionalPct of buying power — on a paper account that meant
    // a $6,000 budget could buy $25,000 of stock. See server/shares.js.
    maxNotionalMultiple: 1.0,
    maxNotionalPct: 0.10,
    allowShort: true, requireEasyToBorrow: true,
  },
  risk: {
    // ---- DAILY LOSS CIRCUIT BREAKER -----------------------------------------
    // maxDailyEntries caps how many trades can be OPENED; nothing capped how much
    // could be LOST before opening the next one.
    //
    // Expressed as a MULTIPLE of basePremium, not as a fixed dollar amount, and
    // that matters. A hard-coded $600 paired with a $300 budget is sane; the same
    // $600 paired with a $6,000 budget halts the bot after its first loser,
    // because one option stopped at -60% premium loses $3,600 on its own. The two
    // numbers silently desynced the moment the budget changed, and nothing said
    // so. A multiple cannot drift out of step.
    //
    // 1.5 means "stop after roughly two-and-a-half full stop-outs". Set
    // maxDailyLossMultiple to 0 to use the absolute maxDailyLoss instead; set
    // both to 0 to disable the breaker entirely.
    maxDailyLossMultiple: 1.5,
    maxDailyLoss: 0,            // absolute $ fallback, used only when the multiple is 0
    // ---- BUDGET AS A HARD CAP -----------------------------------------------
    // One switch for "never spend more than the budget", because the three flags
    // that actually control it (enforceBudget / findCheaper / allowBudgetOverrun)
    // interact in a way that is easy to get wrong — leaving overrun on with a
    // tolerance of 2 quietly permits double the budget.
    //
    // ON  -> the budget behaves like a buying-power ceiling. The chain is
    //        re-ranked so only contracts that FIT are considered, and if nothing
    //        fits the trade is skipped rather than bought at a premium.
    // OFF -> the older behaviour: the budget guides sizing, and the overrun
    //        settings below decide how far past it a single contract may go.
    hardBudgetCap: true,
    // (a) The budget, and whether it actually binds. Buying power is checked
    //     separately and ALWAYS binds — we never order what the account can't pay for.
    // How basePremium is READ. This was implicitly "per trade" and the field name
    // does not say so, which matters a lot at larger numbers: with maxConcurrent
    // 5, a $16,000 per-trade budget permits $80,000 of premium.
    //   "per-trade"  each entry may spend up to basePremium (original behaviour)
    //   "portfolio"  basePremium is the TOTAL across all open positions. It is
    //                divided into equal slots, and capital already committed is
    //                subtracted, so the book can never exceed the figure typed.
    budgetMode: "per-trade",
    portfolioSlots: 0,         // 0 = use automation.maxConcurrent
    basePremium: 300,          // $ of premium (see budgetMode for per-trade vs total)
    enforceBudget: true,       // false = budget is advisory, size comes from fixedContracts
    // (b) Buy exactly N contracts per trade instead of "as many as the budget fits".
    fixedContracts: { enabled: false, count: 1 },
    maxContracts: 10,          // hard cap regardless of everything else
    // (c) What to do when ONE contract already costs more than the budget:
    //   allowBudgetOverrun true  -> buy 1 anyway (old behaviour, logged loudly)
    //   allowBudgetOverrun false -> skip the trade as TOO_EXPENSIVE
    allowBudgetOverrun: true,
    // With overrun allowed, still refuse beyond this multiple. This was 15,
    // which quietly made every other sizing control decorative: a $300 budget
    // could buy a $4,500 contract, so the budget, the flow size multipliers and
    // the daily loss cap were all describing a position ten times smaller than
    // the one actually held. findCheaper already re-ranks the chain for
    // affordability before this ever binds, so a tight tolerance costs far less
    // participation than it looks like it should.
    overrunTolerance: 2,
    // (d) Before giving up on price, re-rank the chain with the budget as a
    //     per-contract ceiling and take the best contract that FITS. If nothing
    //     fits, the trade is skipped and the loop moves to the next ticker.
    findCheaper: true,
  },
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

// The GEX scripts are separate Python processes spawned from several places
// (discovery.js, observe.js, index.js), each with its own runPy. Rather than
// thread wall settings through every call site as argv, publish them on
// process.env — children inherit it — and let gexcore.py read them.
function syncGexEnv(cfg) {
  const w = cfg.walls || {};
  process.env.WALL_MIN_DIST_PCT = String(w.minDistancePct ?? 0.015);
  process.env.WALL_WEIGHT_BY_OI = w.weightByOi === true ? "1" : "0";
  process.env.GEX_DATA_PROVIDER = (cfg.data?.provider || "alpaca").toLowerCase();
  process.env.STOP_MIN_PCT = String(cfg.walls?.stopMinPct ?? 0.01);
  process.env.SETUP_MIN_RR = String(cfg.setup?.minRR ?? 2.0);
  process.env.MAX_EXTENSION_PCT = String(cfg.setup?.maxExtensionPct ?? 3.0);
  process.env.MIN_REGIME_GATES = String(cfg.setup?.minRegimeGates ?? 2);
  // "yahoo" = real ^VIX but costs a yfinance import on a cache miss;
  // "vixy" = Alpaca ETF proxy over plain urllib, no pandas. See voldesk.regime().
  process.env.REGIME_VIX_SOURCE = String(cfg.setup?.vixSource ?? "yahoo");
}

export function loadConfig() {
  let cfg;
  try {
    cfg = deepMerge(DEFAULTS, JSON.parse(fs.readFileSync(CONFIG_PATH)));
  } catch {
    cfg = deepMerge(DEFAULTS, {});
  }
  syncGexEnv(cfg);
  return cfg;
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

// ---- Flow freshness guard --------------------------------------------------
// You upload flow at night. If an upload is missed (travel, forgot, scraper
// died), the cache silently goes stale and the bot would keep trading on a
// week-old book as if it were current. That's the dangerous failure mode: not
// an error, just quietly wrong conviction.
//
// So we read the cache's own `generated` stamp and report the age. What happens
// past maxAgeDays is YOUR choice (flow.staleAction, switchable in the UI):
//   "off"   — ignore age entirely
//   "warn"  — DEFAULT: banner only, trading continues untouched
//   "block" — refuse new entries until you upload
// Exits are never blocked in any mode — managing an open position must not
// depend on flow freshness.
export function cacheStatus(cfg = loadConfig()) {
  const dir = optionstratDir(cfg);
  const p = path.join(dir, "flow_cache.json");
  const maxAgeDays = cfg.flow.maxAgeDays ?? 3;
  const action = cfg.flow.staleAction || "warn";
  if (!fs.existsSync(p)) {
    return { present: false, stale: true, ageHours: null, maxAgeDays, action,
      note: "no flow_cache.json — upload flow or enable Unusual Whales" };
  }
  let generated = null;
  try { generated = JSON.parse(fs.readFileSync(p)).generated || null; } catch {}
  // Fall back to file mtime if the blob has no stamp.
  const ts = generated ? Date.parse(generated) : fs.statSync(p).mtimeMs;
  const ageHours = +((Date.now() - ts) / 3.6e6).toFixed(1);
  const stale = ageHours > maxAgeDays * 24;
  return {
    present: true, generated, ageHours,
    ageDays: +(ageHours / 24).toFixed(2),
    maxAgeDays, action, stale,
    note: stale ? `flow is ${(ageHours / 24).toFixed(1)}d old (limit ${maxAgeDays}d)` : null,
  };
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

  // STALE GUARD — only meaningful when OptionStrat (a file that ages) is the
  // source. Unusual Whales is live, so if UW supplied this conviction we don't
  // penalise it for a stale file.
// staleAction: "off"   -> guard disabled entirely; age is reported but ignored
//              "warn"  -> DEFAULT. Banner tells you it's stale; trading unaffected.
//              "block" -> refuse new entries until you upload.
  const uwLive = f.sources.unusualwhales && conv.sources?.unusualwhales?.found;
  const action = f.staleAction || "warn";
  if (!uwLive && action === "block") {
    const cs = cacheStatus(cfg);
    if (cs.stale) {
      const v = verdict("flow-stale", "neutral", 0, true, conv, cfg);
      v.stale = true; v.staleNote = cs.note; v.ageDays = cs.ageDays;
      return v;
    }
  }

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
