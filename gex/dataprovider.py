"""Market-data providers for the GEX engine.

WHY THIS EXISTS
The Vol Desk scan needs four things: daily bars, the list of expiries, and per
strike the open interest and implied volatility. All of it came from Yahoo via
yfinance, which cost ~7 requests per ticker and rate-limited hard — 19 tickers in
one burst was enough to get YFRateLimitError on nearly all of them. That ceiling
is what kept `maxScan` at 8 and made scanning the whole flow book impossible.

Alpaca serves the same inputs over plain REST:

    open interest   GET /v2/options/contracts        (open_interest per contract,
                                                      plus open_interest_date)
    IV + greeks     GET /v1beta1/options/snapshots/{underlying}
    daily bars      GET /v2/stocks/{symbol}/bars
    spot            last close from the bars call — no extra request

That's ~3 calls per ticker against a far more generous limit, and the whole chain
arrives in one paginated sweep rather than one request per expiry.

Yahoo is kept as a fallback, not deleted. Two reasons: it needs no credentials,
and it's an independent second opinion when Alpaca's `open_interest_date` looks
stale. Cross-checking two sources has already caught one bug in this project.

Both providers return IDENTICAL shapes so voldesk.py doesn't branch:

    history(ticker)            -> (closes[], highs[])       oldest..newest
    chains(ticker, max_dte)    -> {"YYYY-MM-DD": [(K, oi, iv, is_call), ...]}

`oi` and `iv` are floats; rows with unusable values are dropped by the caller,
which already knows how to sanitise them.
"""

import os
import json
import math
import urllib.request
import urllib.parse
from datetime import datetime, timezone, timedelta

# ---- Alpaca ---------------------------------------------------------------
# Accept both naming conventions: the Node side uses ALPACA_*, Alpaca's own SDKs
# use APCA_*. Reading both means one .env works for the whole project.
def _key():
    return os.environ.get("ALPACA_API_KEY") or os.environ.get("APCA_API_KEY_ID") or ""


def _secret():
    return os.environ.get("ALPACA_SECRET_KEY") or os.environ.get("APCA_API_SECRET_KEY") or ""


TRADE_BASE = os.environ.get("ALPACA_PAPER_BASE", "https://paper-api.alpaca.markets")
DATA_BASE = "https://data.alpaca.markets"
FEED = os.environ.get("ALPACA_FEED", "iex")


def _get(url, timeout=30):
    req = urllib.request.Request(url, headers={
        "APCA-API-KEY-ID": _key(),
        "APCA-API-SECRET-KEY": _secret(),
        "accept": "application/json",
    })
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def _paged(url_base, params, key, limit_pages=12):
    """Walk next_page_token. Bounded so a bad filter can't loop forever."""
    out = []
    token = None
    for _ in range(limit_pages):
        p = dict(params)
        if token:
            p["page_token"] = token
        data = _get(f"{url_base}?{urllib.parse.urlencode(p)}")
        chunk = data.get(key)
        if isinstance(chunk, dict):
            out.extend(chunk.items())
        elif isinstance(chunk, list):
            out.extend(chunk)
        token = data.get("next_page_token")
        if not token:
            break
    return out


class AlpacaProvider:
    name = "alpaca"

    def available(self):
        return bool(_key() and _secret())

    def history(self, ticker, days=365):
        start = (datetime.now(timezone.utc) - timedelta(days=days + 40)).strftime("%Y-%m-%d")
        rows = _paged(f"{DATA_BASE}/v2/stocks/{ticker}/bars",
                      {"timeframe": "1Day", "start": start, "limit": 10000, "feed": FEED},
                      "bars")
        closes = [float(b["c"]) for b in rows if b.get("c")]
        highs = [float(b["h"]) for b in rows if b.get("h")]
        return closes, highs

    def chains(self, ticker, max_dte=45, band_pct=0.35):
        """Open interest from the contracts endpoint, IV from the snapshots
        endpoint, joined on the OCC symbol.

        Strikes are limited to a band around spot because the full chain of a
        liquid name runs to thousands of contracts and every one of them costs
        pagination. The band is deliberately wider than the wall search band so
        wall selection still has room to look outward.
        """
        closes, _ = self.history(ticker, days=10)
        spot = closes[-1] if closes else None
        today = datetime.now(timezone.utc).date()
        exp_lte = (today + timedelta(days=int(max_dte))).strftime("%Y-%m-%d")
        exp_gte = today.strftime("%Y-%m-%d")

        cparams = {
            "underlying_symbols": ticker,
            "expiration_date_gte": exp_gte,
            "expiration_date_lte": exp_lte,
            "limit": 10000,
            "status": "active",
        }
        if spot:
            cparams["strike_price_gte"] = round(spot * (1 - band_pct), 2)
            cparams["strike_price_lte"] = round(spot * (1 + band_pct), 2)
        contracts = _paged(f"{TRADE_BASE}/v2/options/contracts", cparams, "option_contracts")

        # OI per OCC symbol. Alpaca returns these as strings.
        oi_by_symbol, meta = {}, {}
        oi_dates = set()
        for c in contracts:
            sym = c.get("symbol")
            if not sym:
                continue
            try:
                oi = float(c.get("open_interest") or 0)
            except (TypeError, ValueError):
                oi = 0.0
            oi_by_symbol[sym] = oi
            if c.get("open_interest_date"):
                oi_dates.add(c["open_interest_date"])
            meta[sym] = (float(c["strike_price"]), c["expiration_date"], c["type"] == "call")

        # IV per OCC symbol, one sweep for the whole underlying.
        sparams = {"limit": 1000, "expiration_date_gte": exp_gte, "expiration_date_lte": exp_lte}
        snaps = _paged(f"{DATA_BASE}/v1beta1/options/snapshots/{ticker}", sparams, "snapshots")
        iv_by_symbol = {}
        for sym, s in snaps:
            iv = (s or {}).get("impliedVolatility")
            if iv:
                iv_by_symbol[sym] = float(iv)

        out = {}
        for sym, (K, exp, is_call) in meta.items():
            oi = oi_by_symbol.get(sym, 0.0)
            iv = iv_by_symbol.get(sym)
            if oi <= 0 or not iv:
                continue
            out.setdefault(exp, []).append((K, oi, iv, is_call))
        # Surfaced so the caller can report how old the OI actually is — Yahoo
        # never tells you this, so we were computing gamma on unknown-age data.
        self.last_oi_date = max(oi_dates) if oi_dates else None
        return out


# ---- Yahoo (fallback) ------------------------------------------------------
class YahooProvider:
    name = "yahoo"

    def available(self):
        try:
            import yfinance  # noqa: F401
            return True
        except Exception:
            return False

    def history(self, ticker, days=365):
        import yfinance as yf
        h = yf.Ticker(ticker).history(period="1y")
        if h.empty:
            return [], []
        return [float(x) for x in h["Close"].tolist()], [float(x) for x in h["High"].tolist()]

    def chains(self, ticker, max_dte=45, band_pct=0.35):
        import yfinance as yf
        tk = yf.Ticker(ticker)
        now = datetime.now(timezone.utc)
        out = {}
        for e in list(tk.options):
            exp_dt = datetime.strptime(e, "%Y-%m-%d").replace(hour=20, tzinfo=timezone.utc)
            d = (exp_dt - now).total_seconds() / 86400
            if not (0 < d <= max_dte):
                continue
            oc = tk.option_chain(e)
            rows = []
            for df, is_call in ((oc.calls, True), (oc.puts, False)):
                for _, row in df.iterrows():
                    K, oi, iv = row.get("strike"), row.get("openInterest"), row.get("impliedVolatility")
                    if not K or oi is None:
                        continue
                    if (isinstance(oi, float) and math.isnan(oi)) or oi <= 0:
                        continue
                    if iv is None or (isinstance(iv, float) and math.isnan(iv)) or iv <= 0:
                        continue
                    rows.append((float(K), float(oi), float(iv), is_call))
            if rows:
                out[e] = rows
            if len(out) >= 4:
                break
        self.last_oi_date = None      # Yahoo doesn't tell us
        return out


def get_provider(preferred=None):
    """Pick a provider, falling back rather than failing.

    Falling back matters: a missing Alpaca key or a transient outage should
    degrade to Yahoo and keep scanning, not abort the run and leave the trader
    with no snapshot — that failure mode has bitten this project before.
    """
    preferred = (preferred or os.environ.get("GEX_DATA_PROVIDER") or "alpaca").lower()
    alpaca, yahoo = AlpacaProvider(), YahooProvider()
    order = [alpaca, yahoo] if preferred == "alpaca" else [yahoo, alpaca]
    for p in order:
        if p.available():
            return p
    return yahoo
