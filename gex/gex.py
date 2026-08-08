#!/usr/bin/env python3
"""Compute dealer Gamma Exposure (GEX) from free Yahoo option chains (yfinance).

Alpaca gives us no greeks/open-interest on this account, so we source per-strike
open interest + implied vol from Yahoo and compute gamma ourselves with
Black-Scholes. The shared math lives in gex/gexcore.py so this display path and
the trading path (voldesk.py) can never disagree again.

Outputs (JSON on stdout):
  spot, gammaFlip (+ flipFound / flipNote), regime,
  callWall / putWall (correct side of spot, from the correct option series),
  callGex / putGex / netGex / grossGex, per-strike profile, dataQuality.

See gexcore.py for the three bugs this replaced — most importantly that the old
version picked walls from NET per-strike GEX across ALL strikes, which on an
index like SPY returns meaningless far strikes (a "call wall" below spot).

Usage: gex.py SYMBOL [max_expiries] [max_dte_days]
"""
import sys, os, json, math
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gexcore as gc


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "usage: gex.py SYMBOL [max_expiries] [max_dte_days]"}))
        return
    symbol = sys.argv[1].upper()
    max_exp = int(sys.argv[2]) if len(sys.argv) > 2 else 4
    max_dte = int(sys.argv[3]) if len(sys.argv) > 3 else 45

    # ---- DATA SOURCE ------------------------------------------------------
    # This used to call yfinance directly, and it was the LAST thing in the
    # project still doing so. voldesk.py was moved to the shared provider because
    # Yahoo rate-limits hard (~19 tickers in a burst was enough to fail) — but
    # gex.py kept its own Yahoo path, so the GEX tab broke exactly when Yahoo was
    # unhappy while every other view carried on fine.
    #
    # Worse, it meant the DISPLAY and the TRADING LEVELS could be computed from
    # different feeds on the same day. gexcore.py exists specifically so those two
    # cannot disagree; sharing the maths and then splitting the data undoes that.
    #
    # Now both go through gex/dataprovider.py: Alpaca first, Yahoo as fallback.
    try:
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        import dataprovider as dp
    except Exception as e:
        print(json.dumps({"error": f"no data provider available: {type(e).__name__}: {e}"}))
        return

    try:
        # Tries every configured provider in turn and only gives up when they all
        # fail — carrying what each one said, so the UI can show a diagnosis
        # instead of one raw URLError.
        try:
            provider, closes, _highs, chains, trace = dp.fetch_chain(symbol, max_dte)
        except dp.ProviderError as pe:
            print(json.dumps({
                "error": f"could not get option data for {symbol} — {pe.summary()}",
                "providerTrace": pe.trace,
                "hint": "If Alpaca was skipped, set ALPACA_API_KEY and ALPACA_SECRET_KEY "
                        "in the Render dashboard (render.yaml marks them sync:false, so they "
                        "are not in the image). If Alpaca failed, check the key is a PAPER "
                        "key and the plan allows option data.",
            }))
            return
        spot = float(closes[-1])
        now = datetime.now(timezone.utc)

        def _dte(e):
            return (datetime.strptime(e, "%Y-%m-%d").replace(hour=20, tzinfo=timezone.utc)
                    - now).total_seconds() / 86400
        chosen = sorted([(e, _dte(e)) for e in chains if _dte(e) > 0],
                        key=lambda x: x[1])[:max_exp]
        if not chosen:
            print(json.dumps({"error": f"no unexpired expiries within {max_dte} DTE"}))
            return

        # Collect + sanitize PER EXPIRY (the relative-IV filter needs each
        # expiry's own ATM IV as the baseline).
        contracts = []
        used_exps = []
        quality = {"droppedAbsIv": 0, "droppedRelIv": 0, "atmIvByExpiry": {}, "rawRows": 0,
                   "provider": provider.name,
                   "providerTrace": trace,
                   "oiDate": getattr(provider, "last_oi_date", None)}
        for e, dte_days in chosen:
            T = dte_days / 365.0
            rows = []
            for (K, oi, iv, is_call) in chains[e]:
                quality["rawRows"] += 1
                if gc._is_bad(K) or not K:
                    continue
                if gc._is_bad(oi) or oi <= 0:
                    continue
                if gc._is_bad(iv) or iv <= 0:
                    continue
                rows.append((float(K), T, float(iv), float(oi), is_call))
            kept, stats = gc.sanitize_expiry(rows, spot)
            contracts.extend(kept)
            quality["droppedAbsIv"] += stats["droppedAbs"]
            quality["droppedRelIv"] += stats["droppedRel"]
            quality["atmIvByExpiry"][e] = stats["atmIv"]
            used_exps.append(e)

        if not contracts:
            print(json.dumps({"error": "no contracts survived IV/OI sanity filters"}))
            return

        per = gc.per_strike_gex(contracts, spot)
        call_wall, put_wall, wall_notes = gc.pick_walls(per, spot)
        tot = gc.totals(per)
        flip, flip_found, flip_detail = gc.gamma_flip(contracts, spot)

        profile = [{"strike": k,
                    "gex": round(per[k]["net"], 0),
                    "callGex": round(per[k]["call"], 0),
                    "putGex": round(-per[k]["put"], 0)}
                   for k in sorted(per.keys())]

        quality["contractsUsed"] = len(contracts)
        quality["strikes"] = len(per)
        if wall_notes:
            quality["wallNotes"] = wall_notes

        print(json.dumps({
            "symbol": symbol,
            "spot": round(spot, 2),
            "asof": now.isoformat(),
            "expiries": used_exps,
            "gammaFlip": round(flip, 2) if flip is not None else None,
            "flipFound": flip_found,
            "flipNote": flip_detail.get("reason"),
            # Regime is only meaningful when a real crossing exists.
            "regime": (("long_gamma" if spot > flip else "short_gamma")
                       if (flip is not None and flip_found) else None),
            "callWall": call_wall,
            "putWall": put_wall,
            **tot,
            "totalGex": tot["netGex"],     # back-compat with the existing UI
            "profile": profile,
            "dataQuality": quality,
        }))
    except Exception as e:
        print(json.dumps({"error": f"{type(e).__name__}: {e}"}))


if __name__ == "__main__":
    main()
