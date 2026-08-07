// How often would the regime gate have let you trade?
//
// Every name in a scan can block on `regime>=N/3` while the setups themselves
// are fine. This replays the gate over real daily bars and reports what
// fraction of sessions each threshold would have allowed. It answers one
// question: is the gate selecting good days, or just refusing most of them?
//
// IMPORTANT: only two of the three gates exist. bull_bear (3:1 across ~700
// names) is not computed, so it is a permanent FAIL. A threshold of 2 therefore
// means BOTH remaining gates on the same session, which is strictly harder than
// the 2-of-3 the reference system runs.
//
// Usage (from the project root, with .env holding your Alpaca keys):
//   node tools/regime_test.mjs
//   node tools/regime_test.mjs --days 1095
//
// Standalone on purpose: no dotenv, no imports from server/.
import fs from "fs";
import path from "path";
import { pathToFileURL } from "node:url";

for (const dir of [process.cwd(), path.resolve(process.cwd(), "..")]) {
  const f = path.join(dir, ".env");
  if (!fs.existsSync(f)) continue;
  for (const line of fs.readFileSync(f, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  break;
}

const KEY = process.env.ALPACA_API_KEY || process.env.APCA_API_KEY_ID;
const SECRET = process.env.ALPACA_SECRET_KEY || process.env.APCA_API_SECRET_KEY;
const FEED = process.env.ALPACA_FEED || "iex";
// The key check lives in main(), not at module scope: exiting on import makes
// evaluate() impossible to unit-test, and a tool whose logic can't be tested
// without live credentials is a tool you have to trust rather than check.
function requireKeys() {
  if (KEY && SECRET) return;
  console.error("\nNo Alpaca keys found. Run from the folder holding .env, or:\n"
    + "  ALPACA_API_KEY=... ALPACA_SECRET_KEY=... node tools/regime_test.mjs\n");
  process.exit(1);
}

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const DAYS = parseInt(arg("days", "730"), 10);

async function getBars(symbol, start) {
  const out = [];
  let token = null;
  for (let page = 0; page < 20; page++) {
    const u = new URL(`https://data.alpaca.markets/v2/stocks/${symbol}/bars`);
    u.searchParams.set("timeframe", "1Day");
    u.searchParams.set("start", start);
    u.searchParams.set("limit", "10000");
    u.searchParams.set("feed", FEED);
    if (token) u.searchParams.set("page_token", token);
    const r = await fetch(u, { headers: { "APCA-API-KEY-ID": KEY, "APCA-API-SECRET-KEY": SECRET } });
    if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 120)}`);
    const j = await r.json();
    out.push(...(j.bars || []));
    token = j.next_page_token;
    if (!token) break;
  }
  return out;
}

// Same rule as gex/voldesk.py regime(): basket = SPY or QQQ up > 0.5%,
// vix_gate = vol down. VIXY stands in for ^VIX (Alpaca has no index), which is
// fine here because both are sign tests.
export function evaluate(byDate) {
  const days = [...byDate.keys()].sort();
  const rows = [];
  for (const d of days) {
    const r = byDate.get(d);
    if (r.SPY == null && r.QQQ == null) continue;
    const basket = (r.SPY ?? -9) > 0.5 || (r.QQQ ?? -9) > 0.5;
    const vix = r.VIXY == null ? false : r.VIXY < 0;
    rows.push({ d, basket, vix, passed: (basket ? 1 : 0) + (vix ? 1 : 0) });
  }
  return rows;
}

const pct = (a, b) => (b ? ((a / b) * 100).toFixed(1) + "%" : "—");

async function main() {
  requireKeys();
  const start = new Date(Date.now() - DAYS * 864e5).toISOString();
  const byDate = new Map();
  for (const sym of ["SPY", "QQQ", "VIXY"]) {
    let bars;
    try { bars = await getBars(sym, start); }
    catch (e) { console.error(`${sym} fetch failed: ${e.message}`); process.exit(1); }
    for (let i = 1; i < bars.length; i++) {
      const d = bars[i].t.slice(0, 10);
      const prev = bars[i - 1].c, last = bars[i].c;
      if (!(prev > 0)) continue;
      if (!byDate.has(d)) byDate.set(d, {});
      byDate.get(d)[sym] = ((last / prev) - 1) * 100;
    }
  }

  const rows = evaluate(byDate);
  const n = rows.length;
  const basketN = rows.filter((r) => r.basket).length;
  const vixN = rows.filter((r) => r.vix).length;
  const bothN = rows.filter((r) => r.passed >= 2).length;
  const eitherN = rows.filter((r) => r.passed >= 1).length;

  console.log(`\nRegime gate replay — ${n} sessions over the last ${DAYS} days\n`);
  console.log(`  basket (SPY or QQQ > +0.5%)      ${String(basketN).padStart(4)}   ${pct(basketN, n)}`);
  console.log(`  vix down                         ${String(vixN).padStart(4)}   ${pct(vixN, n)}`);
  console.log(`  bull:bear 3:1                       0   0.0%   <- NOT COMPUTED, always fails\n`);
  console.log(`  minRegimeGates = 0   trade on   ${String(n).padStart(4)} days   ${pct(n, n)}`);
  console.log(`  minRegimeGates = 1   trade on   ${String(eitherN).padStart(4)} days   ${pct(eitherN, n)}`);
  console.log(`  minRegimeGates = 2   trade on   ${String(bothN).padStart(4)} days   ${pct(bothN, n)}   <- current`);
  console.log(`  minRegimeGates = 3   trade on      0 days   0.0%   (impossible while bull:bear is missing)`);

  // Does the gate actually select better days? If SPY's NEXT-day return is no
  // better after a pass than after a fail, the gate is costing you days without
  // buying anything — which is the only question that matters.
  const dates = [...byDate.keys()].sort();
  const fwd = new Map();
  for (let i = 0; i < dates.length - 1; i++) fwd.set(dates[i], byDate.get(dates[i + 1])?.SPY);
  const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
  const pass2 = rows.filter((r) => r.passed >= 2).map((r) => fwd.get(r.d)).filter((x) => x != null);
  const fail2 = rows.filter((r) => r.passed < 2).map((r) => fwd.get(r.d)).filter((x) => x != null);
  const pass1 = rows.filter((r) => r.passed >= 1).map((r) => fwd.get(r.d)).filter((x) => x != null);
  const fail1 = rows.filter((r) => r.passed < 1).map((r) => fwd.get(r.d)).filter((x) => x != null);

  console.log(`\nNext-day SPY return after each verdict (is the gate picking better days?)`);
  console.log(`  after >=2 gates pass   ${avg(pass2).toFixed(3)}%   (n=${pass2.length})`);
  console.log(`  after  <2 gates pass   ${avg(fail2).toFixed(3)}%   (n=${fail2.length})`);
  console.log(`  after >=1 gate  pass   ${avg(pass1).toFixed(3)}%   (n=${pass1.length})`);
  console.log(`  after  <1 gate  pass   ${avg(fail1).toFixed(3)}%   (n=${fail1.length})`);
  const edge2 = avg(pass2) - avg(fail2);
  // A difference in means is meaningless without its error bar. Daily equity
  // returns have a standard deviation near 1%, so with a few hundred sessions
  // the noise floor is ~0.1% — the same size as any edge worth finding here.
  // Printing the difference alone invites reading a coin flip as a conclusion,
  // which is exactly what the first version of this tool did.
  const sd = (xs) => {
    const m = avg(xs);
    return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, xs.length - 1));
  };
  const se = Math.sqrt(sd(pass2) ** 2 / pass2.length + sd(fail2) ** 2 / fail2.length);
  const t = edge2 / se;
  console.log(`\n  edge from requiring 2 gates: ${edge2 >= 0 ? "+" : ""}${edge2.toFixed(3)}% next-day`);
  console.log(`  standard error ${se.toFixed(3)}%   t = ${t.toFixed(2)}`);
  if (Math.abs(t) < 2) {
    console.log("  -> NOT distinguishable from chance. There is no evidence the gate selects");
    console.log("     better days — but none that it selects worse ones either. What is solid");
    console.log("     is the COST above: sessions given up for no measured benefit.");
  } else if (edge2 > 0) {
    console.log("  -> the gate does select better days, beyond what chance explains.");
    console.log("     The cost in missed sessions may be worth paying.");
  } else {
    console.log("  -> days the gate REJECTS did better, beyond what chance explains.");
    console.log("     It is filtering out the wrong sessions.");
  }
  console.log("\nNOTE: this is a same-day momentum filter, so a pass tends to mean you are");
  console.log("      buying after a move has already happened — the same extension problem");
  console.log("      the ext<=3% filter exists to solve. Read the two together.\n");
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) main();
