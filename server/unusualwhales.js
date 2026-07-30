// Unusual Whales live-flow client — a SECOND, optional conviction source.
//
// This is deliberately defensive: it is OFF unless UW_API_KEY is set, and every
// path returns { found:false } instead of throwing, so a bad key / rate-limit /
// schema drift can never take down the auto-trader loop. The auto-trader treats
// "no UW signal" exactly like "UW disabled".
//
// Output shape matches the OptionStrat reader so server/flow.js can blend them:
//   { ticker, found, bullish_premium, bearish_premium, net_premium,
//     direction: "bullish"|"bearish"|"neutral", score: 0..1, source: "unusualwhales" }
//
// Directional proxy: call premium counts bullish, put premium counts bearish —
// the same crude call/put skew the OptionStrat aggregate uses. If the endpoint
// exposes an explicit bid/ask side or sentiment tag we prefer that.

import "dotenv/config";

const KEY = process.env.UW_API_KEY || "";
const BASE = process.env.UW_API_BASE || "https://api.unusualwhales.com";
// Endpoint that returns recent option flow alerts for a ticker. Overridable
// because UW has revved these paths; default is the current flow-alerts route.
const FLOW_PATH = process.env.UW_FLOW_PATH || "/api/stock/{ticker}/flow-alerts";
const LOOKBACK_MIN = parseInt(process.env.UW_LOOKBACK_MIN || "240", 10);

export function uwEnabled() {
  return Boolean(KEY);
}

function num(x) {
  if (x == null) return 0;
  const n = typeof x === "number" ? x : parseFloat(String(x).replace(/[$,]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

// Best-effort premium extraction across schema variants.
function premiumOf(a) {
  return num(a.total_premium ?? a.premium ?? a.total_size_premium ?? a.notional ?? 0);
}

// Best-effort side: returns "bullish" | "bearish" | null.
function sideOf(a) {
  const sent = String(a.sentiment ?? a.direction ?? "").toLowerCase();
  if (sent.includes("bull")) return "bullish";
  if (sent.includes("bear")) return "bearish";
  const type = String(a.type ?? a.option_type ?? a.put_call ?? "").toLowerCase();
  const side = String(a.side ?? a.aggressor_side ?? "").toLowerCase(); // ask=buyer, bid=seller
  if (type.startsWith("c")) return side === "bid" ? "bearish" : "bullish"; // bought calls = bullish
  if (type.startsWith("p")) return side === "bid" ? "bullish" : "bearish"; // bought puts = bearish
  return null;
}

async function fetchAlerts(ticker) {
  const path = FLOW_PATH.replace("{ticker}", encodeURIComponent(ticker));
  const url = new URL(BASE + path);
  if (!path.includes(ticker)) url.searchParams.set("ticker", ticker);
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${KEY}`, Accept: "application/json" },
  });
  if (!r.ok) throw new Error(`UW ${r.status}`);
  const j = await r.json();
  // Accept {data:[...]}, {flow_alerts:[...]}, or a bare array.
  return j.data || j.flow_alerts || j.alerts || (Array.isArray(j) ? j : []) || [];
}

// ---- Discovery: rank the whole market's flow, not one ticker ---------------
// Pulls the market-wide flow-alert feed and aggregates premium per ticker, so
// the auto-trader can SURFACE names instead of only grading a watchlist.
// Returns [] on any failure / missing key — discovery just finds nothing.
const MARKET_PATH = process.env.UW_MARKET_FLOW_PATH || "/api/option-trades/flow-alerts";

export async function getTopFlowTickers({ topN = 10, minPremium = 250000, minScore = 0.3 } = {}) {
  if (!KEY) return { source: "unusualwhales", count: 0, candidates: [], reason: "UW_API_KEY not set" };
  try {
    const url = new URL(BASE + MARKET_PATH);
    url.searchParams.set("limit", "500");
    const r = await fetch(url, { headers: { Authorization: `Bearer ${KEY}`, Accept: "application/json" } });
    if (!r.ok) throw new Error(`UW ${r.status}`);
    const j = await r.json();
    const alerts = j.data || j.flow_alerts || j.alerts || (Array.isArray(j) ? j : []) || [];

    const cutoff = Date.now() - LOOKBACK_MIN * 60 * 1000;
    const agg = new Map(); // ticker -> { bull, bear }
    for (const a of alerts) {
      const t = String(a.ticker ?? a.underlying_symbol ?? a.symbol ?? "").toUpperCase();
      if (!t) continue;
      const ts = Date.parse(a.created_at ?? a.executed_at ?? a.timestamp ?? "") || Date.now();
      if (ts < cutoff) continue;
      const prem = premiumOf(a); const side = sideOf(a);
      if (!prem || !side) continue;
      const cur = agg.get(t) || { bull: 0, bear: 0 };
      if (side === "bullish") cur.bull += prem; else cur.bear += prem;
      agg.set(t, cur);
    }

    const candidates = [];
    for (const [ticker, { bull, bear }] of agg) {
      const net = bull - bear, total = bull + bear;
      if (net <= 0 || total <= 0) continue;            // long-only discovery
      const score = Math.abs(net) / total;
      if (net < minPremium || score < minScore) continue;
      candidates.push({
        ticker, bullish_premium: +bull.toFixed(2), bearish_premium: +bear.toFixed(2),
        net_premium: +net.toFixed(2), score: +score.toFixed(4),
        in_unusual: false, in_knows: false, rank: +(net * score).toFixed(2),
      });
    }
    candidates.sort((a, b) => b.rank - a.rank);
    return { source: "unusualwhales", count: candidates.length, candidates: candidates.slice(0, topN) };
  } catch (e) {
    return { source: "unusualwhales", count: 0, candidates: [], error: String(e.message || e) };
  }
}

export async function getConviction(ticker) {
  ticker = String(ticker).toUpperCase();
  if (!KEY) return { ticker, found: false, reason: "UW_API_KEY not set", source: "unusualwhales", direction: "neutral", score: 0 };
  try {
    const alerts = await fetchAlerts(ticker);
    const cutoff = Date.now() - LOOKBACK_MIN * 60 * 1000;
    let bullish = 0, bearish = 0, n = 0;
    for (const a of alerts) {
      const ts = Date.parse(a.created_at ?? a.executed_at ?? a.timestamp ?? "") || Date.now();
      if (ts < cutoff) continue;
      const prem = premiumOf(a);
      const side = sideOf(a);
      if (!prem || !side) continue;
      if (side === "bullish") bullish += prem; else bearish += prem;
      n++;
    }
    if (!n) return { ticker, found: false, reason: "no recent UW alerts", source: "unusualwhales", direction: "neutral", score: 0 };
    const net = bullish - bearish, total = bullish + bearish;
    const score = total > 0 ? +(Math.abs(net) / total).toFixed(4) : 0;
    const direction = net > 0 ? "bullish" : net < 0 ? "bearish" : "neutral";
    return {
      ticker, found: true, source: "unusualwhales",
      bullish_premium: +bullish.toFixed(2), bearish_premium: +bearish.toFixed(2),
      net_premium: +net.toFixed(2), alerts: n, direction, score,
    };
  } catch (e) {
    return { ticker, found: false, error: String(e.message || e), source: "unusualwhales", direction: "neutral", score: 0 };
  }
}
