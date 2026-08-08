#!/usr/bin/env python3
"""Verify credentials AND discover what this account is actually entitled to.

    python3 scanner/check_setup.py

Run this first. It answers the questions that otherwise only surface at 09:31:
does the key work, which market-data feeds does it get, is the free News API
live, and does the option chain still carry the open-interest date the GEX
engine now enforces.

Nothing here places an order or mutates anything — every call is a GET.
"""

import sys
import os
import urllib.parse
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import alpaca_client as ac
import momentum_scanner as ms

OK, BAD, WARN = "  OK  ", " FAIL ", " WARN "
results = {"ok": 0, "fail": 0}


def probe(name, fn, critical=True):
    try:
        msg = fn()
        print(f"{OK}{name:<46} {msg}")
        results["ok"] += 1
        return True
    except Exception as e:
        print(f"{BAD if critical else WARN}{name:<46} {str(e)[:120]}")
        if critical:
            results["fail"] += 1
        return False


def main():
    ms.load_dotenv()
    if not ac.keys_present():
        print(f"{BAD}no credentials. Put ALPACA_API_KEY / ALPACA_SECRET_KEY in .env "
              f"at the project root.")
        return 2
    k = ac.key()
    print(f"\nkey {k[:6]}…{k[-4:]}  ({'PAPER' if k.startswith('PK') else 'LIVE — be careful'})\n")

    print("account")
    probe("GET /v2/account", lambda: (lambda a:
          f"{a.get('status')}  buying_power=${float(a.get('buying_power') or 0):,.0f}  "
          f"cash=${float(a.get('cash') or 0):,.0f}")(
              ac._get(f"{ac.TRADE_BASE}/v2/account", retries=1)))
    probe("GET /v2/assets (scanner universe)",
          lambda: f"{len(ac.assets()):,} tradable US equities", critical=False)

    print("\nmarket-data feeds — which does this key actually get?")
    for feed in ("iex", "delayed_sip", "sip"):
        probe(f"snapshots feed={feed}",
              lambda f=feed: (lambda d:
                  (_ for _ in ()).throw(RuntimeError("returned 0 symbols"))
                  if not d else
                  f"{len(d)} symbols back, AAPL last="
                  f"{((d.get('AAPL') or {}).get('latestTrade') or {}).get('p')}")(
                      ac.snapshots(["AAPL", "SPY", "F"], feed=f)),
              critical=(feed != "sip"))
    print("       (sip failing is NORMAL on the free plan — the scanner is built to use")
    print("        delayed_sip for volume and iex for price precisely because of that.)")

    print("\nbars — needed for VWAP, premarket high and RVOL")
    start = (datetime.now(timezone.utc) - timedelta(days=4)).strftime("%Y-%m-%dT%H:%M:%SZ")
    probe("1Min multi-symbol bars",
          lambda: (lambda b:
              (_ for _ in ()).throw(RuntimeError("returned 0 bars"))
              if not b else
              f"{sum(len(v) for v in b.values())} bars / {len(b)} symbols")(
                  ac.bars_multi(["AAPL", "F"], "1Min", start)))

    print("\noption chain — the fields the GEX engine depends on")

    def oi():
        p = {"underlying_symbols": "AAPL", "status": "active", "limit": "5"}
        j = ac._get(f"{ac.TRADE_BASE}/v2/options/contracts?{urllib.parse.urlencode(p)}")
        cs = j.get("option_contracts") or []
        if not cs:
            raise RuntimeError("no contracts returned")
        c = cs[0]
        d = c.get("open_interest_date")
        note = "" if d else "  <- no OI date: the oi_age gate will not enforce"
        return f"open_interest={c.get('open_interest')} date={d}{note}"
    probe("contracts: open_interest + open_interest_date", oi)

    def greeks():
        j = ac._get(f"{ac.DATA_BASE}/v1beta1/options/snapshots/AAPL?limit=3")
        sn = j.get("snapshots") or {}
        if not sn:
            raise RuntimeError("no snapshots returned")
        _, v = next(iter(sn.items()))
        return (f"impliedVolatility={v.get('impliedVolatility')}  "
                f"greeks={'present' if v.get('greeks') else 'absent'}")
    probe("snapshots: implied vol (+ greeks, unused by design)", greeks)

    print("\nnews — the free Benzinga feed")

    def news():
        n = ac.news(symbols=["AAPL", "TSLA", "NVDA"], limit=5)
        if not n:
            raise RuntimeError("0 items — off-hours, or this key lacks news access")
        return f"{len(n)} items | latest: {(n[0].get('headline') or '')[:64]!r}"
    probe("GET /v1beta1/news", news, critical=False)

    print(f"\n{results['ok']} ok, {results['fail']} failed\n")
    if results["fail"] == 0:
        print("  Ready. Next:  python3 scanner/momentum_scanner.py --once\n")
    return 1 if results["fail"] else 0


if __name__ == "__main__":
    sys.exit(main())
