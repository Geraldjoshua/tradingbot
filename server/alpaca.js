import "dotenv/config";

const KEY = process.env.ALPACA_API_KEY;
const SECRET = process.env.ALPACA_SECRET_KEY;
const DATA = process.env.ALPACA_DATA_BASE || "https://data.alpaca.markets";
const TRADE = process.env.ALPACA_PAPER_BASE || "https://paper-api.alpaca.markets";
const FEED = process.env.ALPACA_FEED || "iex";

function headers() {
  return {
    "APCA-API-KEY-ID": KEY,
    "APCA-API-SECRET-KEY": SECRET,
    accept: "application/json",
    "content-type": "application/json",
  };
}

export function keysPresent() {
  return Boolean(KEY && SECRET);
}

async function req(url, opts = {}) {
  const r = await fetch(url, { ...opts, headers: headers() });
  const text = await r.text();
  if (!r.ok) throw new Error(`${r.status} ${url}: ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : {};
}

// ---- Market data ----------------------------------------------------------

// Paginated bar fetch — Alpaca caps ~10k bars/page and returns next_page_token.
export async function getBars(symbol, timeframe, start, end, feed = FEED) {
  // SIP (and delayed) plans block the most recent ~15 min of data. Clamp the
  // end time to 16 minutes ago so a backtest that runs up to "now" never asks
  // for that forbidden window. Harmless for historical ranges.
  const cutoff = new Date(Date.now() - 16 * 60 * 1000).toISOString();
  if (!end || end > cutoff) end = cutoff;
  let all = [];
  let pageToken = null;
  try {
    do {
      const u = new URL(`${DATA}/v2/stocks/bars`);
      u.searchParams.set("symbols", symbol);
      u.searchParams.set("timeframe", timeframe);
      if (start) u.searchParams.set("start", start);
      if (end) u.searchParams.set("end", end);
      u.searchParams.set("feed", feed);
      u.searchParams.set("adjustment", "split");
      u.searchParams.set("limit", "10000");
      if (pageToken) u.searchParams.set("page_token", pageToken);
      const j = await req(u);
      const arr = (j.bars && j.bars[symbol]) || [];
      all = all.concat(arr);
      pageToken = j.next_page_token;
    } while (pageToken);
    return all;
  } catch (e) {
    // If SIP is not permitted for this account/window, fall back to the free IEX feed.
    if (feed === "sip" && /403|subscription/i.test(String(e.message))) {
      return getBars(symbol, timeframe, start, end, "iex");
    }
    throw e;
  }
}

export async function getMostActives(top = 25) {
  const u = new URL(`${DATA}/v1beta1/screener/stocks/most-actives`);
  u.searchParams.set("top", String(top));
  const j = await req(u);
  return (j.most_actives || []).map((m) => m.symbol);
}

export async function getSnapshots(symbols) {
  if (!symbols.length) return {};
  const u = new URL(`${DATA}/v2/stocks/snapshots`);
  u.searchParams.set("symbols", symbols.join(","));
  u.searchParams.set("feed", FEED);
  const j = await req(u);
  return j.snapshots || j; // shape: { SYM: { latestTrade, dailyBar, prevDailyBar, ... } }
}

export async function getLatestTrade(symbol, feed = FEED) {
  const u = new URL(`${DATA}/v2/stocks/trades/latest`);
  u.searchParams.set("symbols", symbol);
  u.searchParams.set("feed", feed);
  const j = await req(u);
  return j.trades && j.trades[symbol] ? j.trades[symbol].p : null;
}

// List tradable option contracts near the money for one expiry (trading API).
export async function getOptionContracts({ underlying, type, expGte, expLte, strikeGte, strikeLte, limit = 100 }) {
  const u = new URL(`${TRADE}/v2/options/contracts`);
  u.searchParams.set("underlying_symbols", underlying);
  u.searchParams.set("status", "active");
  if (type) u.searchParams.set("type", type);
  if (expGte) u.searchParams.set("expiration_date_gte", expGte);
  if (expLte) u.searchParams.set("expiration_date_lte", expLte);
  if (strikeGte != null) u.searchParams.set("strike_price_gte", String(strikeGte));
  if (strikeLte != null) u.searchParams.set("strike_price_lte", String(strikeLte));
  u.searchParams.set("limit", String(limit));
  const j = await req(u);
  return j.option_contracts || [];
}

// Quotes for specific option contract symbols (indicative feed is fine for selection).
export async function getOptionQuotes(symbols) {
  if (!symbols.length) return {};
  const u = new URL(`${DATA}/v1beta1/options/snapshots`);
  u.searchParams.set("symbols", symbols.join(","));
  u.searchParams.set("feed", "indicative");
  const j = await req(u);
  return j.snapshots || {};
}

// ---- Trading (paper) ------------------------------------------------------

export async function getAccount() {
  return req(`${TRADE}/v2/account`);
}
// Asset metadata — needed by the share fallback to check tradable / shortable /
// easy-to-borrow before placing a stock order (especially for shorts).
export async function getAsset(symbol) {
  return req(`${TRADE}/v2/assets/${encodeURIComponent(symbol.toUpperCase())}`);
}
export async function getPositions() {
  return req(`${TRADE}/v2/positions`);
}
export async function getOrders(status = "open") {
  const u = new URL(`${TRADE}/v2/orders`);
  u.searchParams.set("status", status);
  u.searchParams.set("limit", "100");
  u.searchParams.set("nested", "true");
  return req(u);
}
export async function placeOrder(body) {
  return req(`${TRADE}/v2/orders`, { method: "POST", body: JSON.stringify(body) });
}
export async function cancelOrder(id) {
  return req(`${TRADE}/v2/orders/${id}`, { method: "DELETE" });
}
export async function closePosition(symbol) {
  return req(`${TRADE}/v2/positions/${symbol}`, { method: "DELETE" });
}

export const config = { FEED, TRADE, DATA };
