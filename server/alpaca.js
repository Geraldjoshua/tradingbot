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
export async function getOrder(id) {
  return req(`${TRADE}/v2/orders/${id}`);
}

// Wait for an order to reach a terminal state and return the REAL fill price.
//
// Why this exists: entry/exit prices were previously recorded as the quoted MID
// at the moment we placed the order. On a wide options spread the mid can sit
// dollars away from where a marketable limit actually fills, so every P&L figure
// was an estimate of an estimate — badly enough that a losing trade could be
// reported as a winner. Alpaca knows the truth; ask it.
export async function waitForFill(id, { timeoutMs = 20000, pollMs = 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      last = await getOrder(id);
      const filled = parseFloat(last.filled_avg_price);
      if (last.status === "filled" && Number.isFinite(filled) && filled > 0) {
        return { filled: true, price: filled, qty: parseFloat(last.filled_qty) || 0, status: last.status };
      }
      if (["canceled", "expired", "rejected"].includes(last.status)) {
        return { filled: false, price: null, qty: 0, status: last.status };
      }
    } catch { /* transient — keep polling */ }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  // Still working (normal off-hours). Caller keeps its estimate and reconcile
  // will correct it on the next boot.
  return { filled: false, price: null, qty: 0, status: last?.status || "pending", timedOut: true };
}
// ---- Account activities (the broker's ledger) -----------------------------
//
// This is the only complete record of what actually happened on the account:
// every fill, every option expiration, every assignment — including trades the
// bot never knew about (placed by hand, or before the local store existed).
// Positions and orders both forget; activities don't.
//
// Paging is by opaque `page_token` = the id of the last row you saw. A page that
// comes back short of page_size is the last page.
export async function getActivities({ types = [], after = null, until = null, pageSize = 100, maxPages = 100 } = {}) {
  let all = [], pageToken = null, pages = 0;
  do {
    const u = new URL(`${TRADE}/v2/account/activities`);
    if (types.length) u.searchParams.set("activity_types", types.join(","));
    if (after) u.searchParams.set("after", after);
    if (until) u.searchParams.set("until", until);
    u.searchParams.set("direction", "asc");
    u.searchParams.set("page_size", String(pageSize));
    if (pageToken) u.searchParams.set("page_token", pageToken);
    const j = await req(u);
    const arr = Array.isArray(j) ? j : [];
    all = all.concat(arr);
    pageToken = arr.length === pageSize ? arr[arr.length - 1].id : null;
  } while (pageToken && ++pages < maxPages);
  return all;
}

// Paginated closed-order history — the fallback when activities are unavailable.
// Orders page backwards from `until`, so we walk the window oldest-ward.
export async function getClosedOrders({ after = null, maxPages = 20 } = {}) {
  let all = [], until = null, pages = 0;
  const seen = new Set();
  do {
    const u = new URL(`${TRADE}/v2/orders`);
    u.searchParams.set("status", "closed");
    u.searchParams.set("limit", "500");
    u.searchParams.set("direction", "desc");
    if (after) u.searchParams.set("after", after);
    if (until) u.searchParams.set("until", until);
    const page = await req(u);
    if (!Array.isArray(page) || !page.length) break;
    let added = 0;
    for (const o of page) if (!seen.has(o.id)) { seen.add(o.id); all.push(o); added++; }
    if (!added) break;                                    // same page again — stop
    until = page[page.length - 1].submitted_at || page[page.length - 1].created_at;
    if (page.length < 500) break;
  } while (++pages < maxPages);
  return all;
}

export async function cancelOrder(id) {
  return req(`${TRADE}/v2/orders/${id}`, { method: "DELETE" });
}
export async function closePosition(symbol) {
  return req(`${TRADE}/v2/positions/${symbol}`, { method: "DELETE" });
}

export const config = { FEED, TRADE, DATA };
