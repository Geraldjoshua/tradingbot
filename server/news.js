// Free news — Benzinga headlines via Alpaca's News API.
//
// This costs nothing beyond the keys already in .env: the News API is included
// on every Alpaca market-data plan, rate-limited to 200 requests/minute on the
// free tier, with history back to 2015. No scraping, no second vendor, no ToS
// problem. It is the answer to "can we get news for free" — you already had it.
//
// WHY THE CLASSIFICATION EXISTS
// For a small cap, WHICH kind of headline it is matters far more than whether
// there is one. A 40% gap on an FDA clearance and a 40% gap on a registered
// direct offering are indistinguishable on a price scanner and are opposite
// trades — in the second the company is selling stock into your buying, which is
// the most reliable way a premarket runner takes money off people who chased it.
// So headlines get bucketed and DILUTION_RISK is surfaced loudly.
//
// These are keyword buckets, not NLP. They are meant to make you LOOK, not to
// decide for you — a headline that says "prices offering" is unambiguous, but
// plenty of dilution arrives worded politely.

import "dotenv/config";

const KEY = process.env.ALPACA_API_KEY || process.env.APCA_API_KEY_ID || "";
const SECRET = process.env.ALPACA_SECRET_KEY || process.env.APCA_API_SECRET_KEY || "";
const DATA = process.env.ALPACA_DATA_BASE || "https://data.alpaca.markets";

const DILUTION = [
  "offering", "pricing of", "registered direct", "shelf", "at-the-market",
  "warrant", "convertible", "dilut", "s-1", "s-3", "424b", "private placement",
  "reverse split", "public offering", "atm program",
];
const BULLISH = [
  "fda", "approval", "clearance", "phase 3", "phase iii", "contract", "award",
  "acquisition", "acquire", "merger", "partnership", "beats", "raises guidance",
  "record revenue", "uplist", "patent", "buyback", "authorization", "granted",
];

export function classify(headline) {
  const h = String(headline || "").toLowerCase();
  if (DILUTION.some((k) => h.includes(k))) return "DILUTION_RISK";
  if (BULLISH.some((k) => h.includes(k))) return "BULLISH";
  return "NEUTRAL";
}

export function newsEnabled() { return Boolean(KEY && SECRET); }

// Returns [] on ANY failure. A dead news call must never take down a scan.
export async function fetchNews({ symbols = [], hours = 24, limit = 50 } = {}) {
  if (!newsEnabled()) return [];
  const u = new URL(`${DATA}/v1beta1/news`);
  if (symbols.length) u.searchParams.set("symbols", symbols.join(","));
  u.searchParams.set("start", new Date(Date.now() - hours * 3600 * 1000).toISOString());
  u.searchParams.set("limit", String(Math.min(limit, 50)));
  u.searchParams.set("sort", "desc");
  u.searchParams.set("include_content", "false");
  try {
    const r = await fetch(u, {
      headers: {
        "APCA-API-KEY-ID": KEY, "APCA-API-SECRET-KEY": SECRET,
        accept: "application/json",
      },
    });
    if (!r.ok) return [];
    const j = await r.json();
    // Shape defensively — Alpaca has revved these payloads before.
    const rows = j.news || j.data || (Array.isArray(j) ? j : []);
    return (Array.isArray(rows) ? rows : []).map((n) => ({
      id: n.id ?? null,
      headline: n.headline || n.title || "",
      summary: n.summary || "",
      at: n.created_at || n.updated_at || null,
      source: n.source || "benzinga",
      url: n.url || null,
      symbols: n.symbols || [],
      kind: classify(n.headline || n.title || ""),
    }));
  } catch {
    return [];
  }
}

// { SYM: { items: [...], flag } } — one batched call for a whole watchlist.
export async function newsBySymbol({ symbols = [], hours = 24, perSymbol = 3 } = {}) {
  const items = await fetchNews({ symbols, hours, limit: 50 });
  const out = {};
  for (const s of symbols) out[s] = { items: [], flag: "NONE" };
  for (const n of items) {
    for (const s of n.symbols) {
      if (!out[s]) continue;
      if (out[s].items.length < perSymbol) out[s].items.push(n);
    }
  }
  for (const s of symbols) {
    const ks = out[s].items.map((i) => i.kind);
    out[s].flag = ks.includes("DILUTION_RISK") ? "DILUTION_RISK"
      : ks.includes("BULLISH") ? "BULLISH"
      : ks.length ? "NEUTRAL" : "NONE";
  }
  return out;
}
