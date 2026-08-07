"""Thin Alpaca REST client for the momentum scanner — stdlib only.

Deliberately no pandas, no alpaca-py, no requests. Same reasoning as
gex/dataprovider.py: this has to start fast, run on a small box, and not drag a
90 MB dependency tree in for what is fundamentally a few HTTP GETs.

WHICH FEED, AND WHY IT MATTERS MORE PREMARKET THAN IT DOES INTRADAY
Alpaca's free plan gives you two views of the same tape:

    feed=iex           real time, but ONLY IEX's own prints — a low single-digit
                       share of consolidated volume.
    feed=delayed_sip   the full consolidated tape, 15 minutes late.

Intraday that distinction is mostly cosmetic. Premarket it is not. A small-cap
runner's premarket volume is the entire signal, and IEX sees a small and erratic
slice of it, so ranking names by IEX volume ranks them partly by which venue
happened to print. Fifteen-minute-old CONSOLIDATED volume is a far better
estimate of "how much is trading" than real-time 2%.

So the scanner uses both, on purpose:
    * delayed_sip for VOLUME and RVOL      (accurate, 15 min stale — fine, the
                                            question is "is this name active")
    * iex        for the LAST PRICE        (stale prices are dangerous, stale
                                            volume is not)
Set SCANNER_VOL_FEED / SCANNER_PRICE_FEED to override.
"""

import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request

DATA_BASE = os.environ.get("ALPACA_DATA_BASE", "https://data.alpaca.markets")
TRADE_BASE = os.environ.get("ALPACA_PAPER_BASE", "https://paper-api.alpaca.markets")

VOL_FEED = os.environ.get("SCANNER_VOL_FEED", "delayed_sip")
PRICE_FEED = os.environ.get("SCANNER_PRICE_FEED", "iex")


def key():
    return os.environ.get("ALPACA_API_KEY") or os.environ.get("APCA_API_KEY_ID") or ""


def secret():
    return os.environ.get("ALPACA_SECRET_KEY") or os.environ.get("APCA_API_SECRET_KEY") or ""


def keys_present():
    return bool(key() and secret())


class AlpacaError(RuntimeError):
    pass


def _get(url, timeout=30, retries=3):
    """GET with backoff. 429 and 5xx are retried; 4xx are not (they won't fix
    themselves, and retrying a bad request just burns the rate limit)."""
    last = None
    for attempt in range(retries):
        req = urllib.request.Request(url, headers={
            "APCA-API-KEY-ID": key(),
            "APCA-API-SECRET-KEY": secret(),
            "accept": "application/json",
        })
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read().decode())
        except urllib.error.HTTPError as e:
            body = ""
            try:
                body = e.read().decode()[:300]
            except Exception:
                pass
            last = AlpacaError(f"{e.code} {url.split('?')[0]}: {body}")
            if e.code not in (429, 500, 502, 503, 504):
                raise last
        except Exception as e:                       # timeouts, DNS, resets
            last = AlpacaError(f"{type(e).__name__}: {e}")
        time.sleep(1.5 ** attempt)
    raise last


def _paged(base, params, key_name, max_pages=40):
    out, token = [], None
    for _ in range(max_pages):
        p = dict(params)
        if token:
            p["page_token"] = token
        data = _get(f"{base}?{urllib.parse.urlencode(p)}")
        chunk = data.get(key_name)
        if isinstance(chunk, list):
            out.extend(chunk)
        elif isinstance(chunk, dict):
            out.append(chunk)
        token = data.get("next_page_token")
        if not token:
            break
    return out


def chunked(seq, n):
    for i in range(0, len(seq), n):
        yield seq[i:i + n]


# ---- Universe -------------------------------------------------------------
def assets():
    """Every active, tradable US equity. One call, ~11k rows.

    This is the piece the old /api/scan was missing. It ranked `getMostActives`,
    which is a volume leaderboard — so it returned AAPL, TSLA, NVDA and friends
    every single day. A small-cap scanner built on it cannot work, because a
    small cap by definition never appears on a raw-volume leaderboard. You have
    to start from the whole market and filter DOWN.
    """
    rows = _get(f"{TRADE_BASE}/v2/assets?status=active&asset_class=us_equity")
    return [a for a in rows if a.get("tradable")]


# ---- Snapshots ------------------------------------------------------------
def snapshots(symbols, feed=None):
    """{symbol: snapshot}. Chunked — the URL is the limit, not the API."""
    out = {}
    for group in chunked(list(symbols), 400):
        params = {"symbols": ",".join(group), "feed": feed or VOL_FEED}
        try:
            data = _get(f"{DATA_BASE}/v2/stocks/snapshots?{urllib.parse.urlencode(params)}")
        except AlpacaError:
            continue                                  # skip the chunk, keep the scan alive
        out.update(data.get("snapshots") or data or {})
    return out


# ---- Bars -----------------------------------------------------------------
def bars_multi(symbols, timeframe, start, end=None, feed=None, limit=10000):
    """Multi-symbol bars: {symbol: [bar, ...]} oldest-first.

    The multi-symbol form of this endpoint is what makes a premarket scan
    affordable. Fetching 1-minute extended-hours bars one name at a time is
    ~100 round trips; batched it is three or four.
    """
    out = {}
    for group in chunked(list(symbols), 100):
        params = {
            "symbols": ",".join(group), "timeframe": timeframe,
            "start": start, "limit": limit, "feed": feed or VOL_FEED,
            "adjustment": "split",
        }
        if end:
            params["end"] = end
        token = None
        for _ in range(20):
            p = dict(params)
            if token:
                p["page_token"] = token
            try:
                data = _get(f"{DATA_BASE}/v2/stocks/bars?{urllib.parse.urlencode(p)}")
            except AlpacaError:
                break
            for sym, arr in (data.get("bars") or {}).items():
                out.setdefault(sym, []).extend(arr)
            token = data.get("next_page_token")
            if not token:
                break
    for sym in out:
        out[sym].sort(key=lambda b: b.get("t", ""))
    return out


# ---- News (free — Benzinga via Alpaca) ------------------------------------
def news(symbols=None, start=None, limit=50, include_content=False):
    """Headlines. Free on every Alpaca market-data plan (rate-limited to 200
    req/min on the free tier), sourced from Benzinga, history back to 2015.

    Returns [] on ANY failure. A scanner that dies because a news call
    timed out is worse than a scanner with no headlines.
    """
    params = {"limit": min(int(limit), 50), "sort": "desc",
              "include_content": "true" if include_content else "false"}
    if symbols:
        params["symbols"] = ",".join(symbols) if not isinstance(symbols, str) else symbols
    if start:
        params["start"] = start
    try:
        data = _get(f"{DATA_BASE}/v1beta1/news?{urllib.parse.urlencode(params)}")
    except Exception:
        return []
    # Shape defensively: Alpaca has revved these payloads before.
    rows = data.get("news") or data.get("data") or (data if isinstance(data, list) else [])
    return rows if isinstance(rows, list) else []
