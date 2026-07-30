"""
Market caps for a batch of tickers, cached per day.

Used by discovery to normalize option premium by company size: $800k of premium
on a $2B company is ~4 bps of the whole company (a real signal), while the same
$800k on a $4T mega-cap is 0.002 bps (noise). Ranking on raw premium
systematically biases toward mega-caps; ranking on RELATIVE premium doesn't.

    python flow/marketcap.py TSLA NVDA AAPL [--cache /path/to/dir]
    {"TSLA": 1234567890000, "NVDA": ..., "AAPL": ...}

Uses yfinance `fast_info` (a cheap quote-level call) and falls back to `.info`
only when needed. Results are cached to <cache>/marketcap_cache.json with a
date stamp, so a given ticker is fetched at most once per day — important on a
small dyno and to stay under Yahoo's rate limits.

Never raises: unknown tickers simply come back null and the caller treats them
as "unknown size" (see discovery.js).
"""

import json
import sys
from datetime import datetime
from pathlib import Path

CACHE_NAME = "marketcap_cache.json"


def _load_cache(cache_dir):
    path = Path(cache_dir) / CACHE_NAME
    try:
        blob = json.loads(path.read_text())
    except Exception:
        return {}, path
    # Drop entries not from today so caps stay reasonably fresh.
    today = datetime.now().strftime("%Y-%m-%d")
    fresh = {k: v for k, v in blob.items() if isinstance(v, dict) and v.get("day") == today}
    return fresh, path


def _save_cache(path, cache):
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(cache))
    except Exception:
        pass


def _fetch_one(ticker):
    import yfinance as yf
    t = yf.Ticker(ticker)
    # fast_info is much cheaper than .info and usually carries market_cap.
    try:
        fi = t.fast_info
        cap = None
        for key in ("market_cap", "marketCap"):
            try:
                cap = fi[key]
            except Exception:
                cap = getattr(fi, key, None)
            if cap:
                break
        if cap:
            return float(cap)
    except Exception:
        pass
    try:
        cap = (t.info or {}).get("marketCap")
        return float(cap) if cap else None
    except Exception:
        return None


def market_caps(tickers, cache_dir="."):
    cache, path = _load_cache(cache_dir)
    today = datetime.now().strftime("%Y-%m-%d")
    out = {}
    dirty = False
    for tk in tickers:
        tk = tk.upper()
        hit = cache.get(tk)
        if hit is not None:
            out[tk] = hit.get("cap")
            continue
        cap = None
        try:
            cap = _fetch_one(tk)
        except Exception:
            cap = None
        out[tk] = cap
        cache[tk] = {"day": today, "cap": cap}
        dirty = True
    if dirty:
        _save_cache(path, cache)
    return out


def main():
    args = [a for a in sys.argv[1:]]
    cache_dir = "."
    if "--cache" in args:
        i = args.index("--cache")
        try:
            cache_dir = args[i + 1]
            del args[i:i + 2]
        except IndexError:
            del args[i:]
    if not args:
        print(json.dumps({}))
        return
    try:
        print(json.dumps(market_caps(args, cache_dir)))
    except Exception as e:
        print(json.dumps({"__error__": str(e)}))


if __name__ == "__main__":
    main()
