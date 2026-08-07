// Session-aware momentum scanner for the UI (/api/scan).
//
// WHAT THE OLD SCANNER DID, AND WHY IT COULD NOT SCAN PREMARKET
// It asked Alpaca for 40 most-active symbols, then kept the ones where
//     gap = (dailyBar.open - prevDailyBar.close) / prevDailyBar.close
// landed between 1% and 2.5%. Two structural problems:
//
//   1. `dailyBar.open` does not exist before 09:30. There is no open yet. So
//      premarket the gap was either undefined or computed from yesterday's bar
//      wearing today's date — the scanner did not fail loudly, it just returned
//      nothing useful, which is worse.
//   2. "Most actives" is a raw-volume leaderboard, so it returns mega-caps every
//      day. A small cap cannot appear on it BY DEFINITION. Ranking it will never
//      surface the names this is wanted for.
//
// Both are fixed here: gap is measured from the LAST TRADE against the prior
// close (defined in every session), and the universe is the full tradable list
// filtered down rather than a leaderboard filtered up.
//
// The heavy lifting — RVOL, VWAP, premarket high, setup levels — lives in the
// standalone Python scanner, which is the one to run for serious small-cap work.
// This endpoint is the quick in-app view over the same idea.

import * as alpaca from "./alpaca.js";
import * as news from "./news.js";

const ET = "America/New_York";
const fmtET = new Intl.DateTimeFormat("en-US", {
  timeZone: ET, hour12: false, weekday: "short", hour: "2-digit", minute: "2-digit",
});

export function sessionNow(now = new Date()) {
  const p = Object.fromEntries(fmtET.formatToParts(now).map((o) => [o.type, o.value]));
  let h = parseInt(p.hour, 10); if (h === 24) h = 0;
  const m = h * 60 + parseInt(p.minute, 10);
  if (p.weekday === "Sat" || p.weekday === "Sun") return { session: "CLOSED", min: m };
  if (m >= 240 && m < 570) return { session: "PRE", min: m };
  if (m >= 570 && m < 960) return { session: "RTH", min: m };
  if (m >= 960 && m < 1200) return { session: "POST", min: m };
  return { session: "CLOSED", min: m };
}

let universeCache = { at: 0, symbols: [] };

// Tradable US equities, minus warrants/units/rights (5-char symbols) which gap
// violently on nothing and quote terribly. Cached for the day — it is ~11k rows
// that change slowly, and re-pulling it per scan is the most expensive thing
// here for the least benefit.
async function universe() {
  if (Date.now() - universeCache.at < 20 * 3600 * 1000 && universeCache.symbols.length) {
    return universeCache.symbols;
  }
  const rows = await alpaca.getAssets();
  const syms = rows
    .filter((a) => a.tradable && a.exchange !== "OTC")
    .map((a) => a.symbol)
    .filter((s) => s && /^[A-Z]{1,4}$/.test(s));
  universeCache = { at: Date.now(), symbols: [...new Set(syms)].sort() };
  return universeCache.symbols;
}

export async function scan({
  minPrice = 1, maxPrice = 20, minGapPct = 5, minDollarVolume = 250000,
  top = 40, withNews = true, universeMode = "all",
} = {}) {
  const { session } = sessionNow();
  const symbols = universeMode === "actives"
    ? await alpaca.getMostActives(100)
    : await universe();

  // Snapshots on the consolidated (delayed) feed: premarket VOLUME is the whole
  // signal and the free real-time IEX feed sees only a small, erratic slice of
  // it. Fifteen-minute-old consolidated volume is a much better estimate of "how
  // much is trading" than real-time 2%. Prices are a different matter, which is
  // why the scanner reports the snapshot's own latest trade alongside.
  const snaps = await alpaca.getSnapshotsChunked(symbols, "delayed_sip");

  const rows = [];
  for (const [sym, s] of Object.entries(snaps)) {
    if (!s) continue;
    const prevClose = s.prevDailyBar?.c;
    const last = s.latestTrade?.p ?? s.dailyBar?.c;
    if (!prevClose || !last || prevClose <= 0) continue;
    if (last < minPrice || last > maxPrice) continue;

    // Defined in EVERY session, unlike the open-based gap this replaces.
    const gapPct = ((last - prevClose) / prevClose) * 100;
    if (Math.abs(gapPct) < minGapPct) continue;

    const vol = s.dailyBar?.v || 0;
    const dollarVolume = vol * last;
    if (dollarVolume < minDollarVolume) continue;

    rows.push({
      symbol: sym, last: +last.toFixed(4), prevClose,
      gapPct: +gapPct.toFixed(2),
      volume: vol, dollarVolume: Math.round(dollarVolume),
      dayHigh: s.dailyBar?.h ?? null, dayLow: s.dailyBar?.l ?? null,
      vwap: s.dailyBar?.vw ?? null,
      side: gapPct > 0 ? "long" : "short",
    });
  }

  rows.sort((a, b) => b.dollarVolume - a.dollarVolume);
  const out = rows.slice(0, top);

  if (withNews && out.length && news.newsEnabled()) {
    try {
      const byS = await news.newsBySymbol({ symbols: out.map((r) => r.symbol), hours: 24 });
      for (const r of out) {
        r.news = byS[r.symbol]?.items || [];
        r.newsFlag = byS[r.symbol]?.flag || "NONE";
      }
    } catch { /* headlines are a bonus, never a dependency */ }
  }

  return {
    session, asof: new Date().toISOString(),
    universe: symbols.length, matched: rows.length,
    filters: { minPrice, maxPrice, minGapPct, minDollarVolume },
    rows: out,
    note: session === "CLOSED"
      ? "market closed — showing the last session's numbers"
      : session === "PRE"
        ? "premarket: gap is measured from the last trade against the prior close, "
          + "and volume is 15-min-delayed consolidated (the free real-time feed sees "
          + "too small a slice of premarket to rank on)"
        : null,
  };
}
