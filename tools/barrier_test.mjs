// Does a target% get hit before a stop% — and what does that pay?
//
// WHAT THIS CAN AND CANNOT TELL YOU
//
// It CANNOT backtest the Vol Desk strategy. That would need historical open
// interest per strike to reconstruct pTrans/nTrans/T1 on past dates, and Alpaca
// serves only CURRENT open interest. No provider we have offers historical OI,
// so the levels on any past day are unrecoverable. Anyone claiming to backtest
// this without that data is fitting to something else.
//
// What it CAN tell you is whether the GEOMETRY pays. Enter on every bar, exit at
// +target% or -stop% or after maxHold days, and measure the result. That is the
// BASELINE: what a coin-flip entry earns with this stop/target pair.
//
// The baseline is the number that matters. If random entries hit the target 40%
// of the time at R/R 2, the strategy has to beat 40% to be worth anything — and
// if it doesn't, the "edge" is just the payoff shape.
//
// Usage (from the project root, with .env holding your Alpaca keys):
//   node tools/barrier_test.mjs --stop 2.5 --target 5 --hold 30 --days 730
//   node tools/barrier_test.mjs --stop 2 --target 4 --tickers NVDA,GOOGL,MU
//
// Entries are taken on EVERY bar, which overlaps trades heavily. That inflates
// the sample and correlates outcomes; treat the win rate as indicative, not as a
// confidence interval.

// Standalone on purpose: no dotenv, no imports from server/. Unzipping the
// project somewhere without `npm install` used to fail here with
// ERR_MODULE_NOT_FOUND before printing anything useful. A diagnostic tool that
// needs a build step isn't much of a diagnostic tool.
import fs from "fs";
import path from "path";
import { pathToFileURL } from "node:url";

// Minimal .env reader — looks in the cwd and one level up.
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
if (!KEY || !SECRET) {
  console.error("\nNo Alpaca keys found.\n"
    + "  Run this from your project folder (the one with .env), or pass them inline:\n"
    + "    ALPACA_API_KEY=... ALPACA_SECRET_KEY=... node tools/barrier_test.mjs\n");
  process.exit(1);
}

// Daily bars, paginated. Only the stock bars endpoint is needed.
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
const alpaca = { getBars: (s, _tf, start) => getBars(s, start) };

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d;
};

const STOP = parseFloat(arg("stop", "2.5")) / 100;
const TARGET = parseFloat(arg("target", "5")) / 100;
const HOLD = parseInt(arg("hold", "30"), 10);
const DAYS = parseInt(arg("days", "730"), 10);
const TICKERS = arg("tickers",
  "NVDA,GOOGL,MSFT,AMZN,META,TSLA,AMD,AVGO,COIN,MU,BA,DIS,UBER,NFLX,INTC,SOFI,PLTR,AAPL"
).split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);

// One entry per bar. Walk forward until a barrier is touched.
//
// When a single day's range spans BOTH barriers we assume the stop hit first.
// Daily bars can't order intraday touches, and assuming the good outcome is how
// backtests flatter themselves. This makes the result conservative on purpose.
export function simulate(bars, { stop = STOP, target = TARGET, hold = HOLD } = {}) {
  const out = { n: 0, wins: 0, losses: 0, timeouts: 0, rSum: 0, holdSum: 0, ambiguous: 0 };
  for (let i = 0; i < bars.length - 1; i++) {
    const entry = bars[i].c;
    if (!(entry > 0)) continue;
    const tp = entry * (1 + target), sl = entry * (1 - stop);
    let done = false;

    for (let j = i + 1; j < Math.min(i + 1 + hold, bars.length); j++) {
      const b = bars[j];
      const hitTp = b.h >= tp, hitSl = b.l <= sl;
      if (hitTp && hitSl) out.ambiguous++;
      if (hitSl) {                       // stop assumed first — see note above
        out.n++; out.losses++; out.rSum += -1; out.holdSum += j - i; done = true; break;
      }
      if (hitTp) {
        out.n++; out.wins++; out.rSum += target / stop; out.holdSum += j - i; done = true; break;
      }
    }
    if (!done) {                         // time stop: mark out at the last close
      const last = bars[Math.min(i + hold, bars.length - 1)];
      const r = ((last.c - entry) / entry) / stop;
      out.n++; out.timeouts++; out.rSum += r; out.holdSum += hold;
    }
  }
  return out;
}

const pct = (a, b) => (b ? ((a / b) * 100).toFixed(1) + "%" : "—");

async function main() {
  console.log(`\nBarrier test — target +${(TARGET * 100).toFixed(1)}%  stop -${(STOP * 100).toFixed(1)}%  `
    + `max hold ${HOLD}d  lookback ${DAYS}d`);
  console.log(`R/R by construction: ${(TARGET / STOP).toFixed(2)}   `
    + `break-even win rate: ${(100 / (1 + TARGET / STOP)).toFixed(1)}%\n`);
  console.log("ticker   trades   wins   losses  timeout   win%    avg R    total R   avg hold");
  console.log("-".repeat(86));

  const start = new Date(Date.now() - DAYS * 864e5).toISOString();
  const totals = { n: 0, wins: 0, losses: 0, timeouts: 0, rSum: 0, holdSum: 0, ambiguous: 0 };

  for (const t of TICKERS) {
    let bars = [];
    try { bars = await alpaca.getBars(t, "1Day", start, null); }
    catch (e) { console.log(`${t.padEnd(8)} fetch failed: ${String(e.message || e).slice(0, 40)}`); continue; }
    if (!bars || bars.length < 60) { console.log(`${t.padEnd(8)} not enough bars (${bars?.length || 0})`); continue; }

    const r = simulate(bars);
    for (const k of Object.keys(totals)) totals[k] += r[k];
    console.log(
      t.padEnd(8), String(r.n).padStart(6), String(r.wins).padStart(6), String(r.losses).padStart(7),
      String(r.timeouts).padStart(8), pct(r.wins, r.n).padStart(7),
      (r.rSum / r.n).toFixed(3).padStart(8), r.rSum.toFixed(1).padStart(10),
      (r.holdSum / r.n).toFixed(1).padStart(10) + "d");
  }

  console.log("-".repeat(86));
  console.log("TOTAL".padEnd(8), String(totals.n).padStart(6), String(totals.wins).padStart(6),
    String(totals.losses).padStart(7), String(totals.timeouts).padStart(8),
    pct(totals.wins, totals.n).padStart(7),
    (totals.rSum / totals.n).toFixed(3).padStart(8), totals.rSum.toFixed(1).padStart(10),
    (totals.holdSum / totals.n).toFixed(1).padStart(10) + "d");

  const exp = totals.rSum / totals.n;
  const be = 100 / (1 + TARGET / STOP);
  const wr = (totals.wins / totals.n) * 100;
  console.log(`\nBreak-even win rate ${be.toFixed(1)}%   ·   actual ${wr.toFixed(1)}%   ·   `
    + `expectancy ${exp >= 0 ? "+" : ""}${exp.toFixed(3)}R per trade`);
  console.log(exp > 0.05
    ? "  -> the geometry is positive even on random entries. GEX selection must beat THIS to add value."
    : exp < -0.05
      ? "  -> the geometry LOSES on random entries. Selection has to overcome a negative baseline."
      : "  -> roughly break-even, as an efficient market implies. Any edge must come from selection.");
  console.log(`\n${totals.ambiguous} days touched both barriers (stop assumed first — the pessimistic read).`);
  console.log("NOTE: this measures the stop/target geometry on STOCK, not the option you'd actually buy.");
  console.log("      Options add theta and spread, so real results will be worse than these numbers.\n");
}

// pathToFileURL, not string concatenation. `file://${process.argv[1]}` breaks on
// any path containing a character that needs URL-encoding — and every macOS
// Claude/Cowork path contains "Application Support", whose space becomes %20 in
// import.meta.url but stays a literal space in argv. The comparison silently
// failed, main() never ran, and the script exited printing NOTHING AT ALL:
// no error, no header, just a new prompt. A guard that fails closed and silent
// is worse than no guard.
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) main();
