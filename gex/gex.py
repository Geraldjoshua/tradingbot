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
import sys, json, math, os
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

    try:
        import yfinance as yf
    except Exception as e:
        print(json.dumps({"error": f"yfinance not installed: {e}"}))
        return

    try:
        tk = yf.Ticker(symbol)
        fi = tk.fast_info
        spot = fi.get("lastPrice") or fi.get("last_price")
        if not spot:
            hist = tk.history(period="1d")
            spot = float(hist["Close"].iloc[-1])
        spot = float(spot)

        exps = list(tk.options)
        now = datetime.now(timezone.utc)
        chosen = []
        for e in exps:
            exp_dt = datetime.strptime(e, "%Y-%m-%d").replace(hour=20, tzinfo=timezone.utc)
            dte_days = (exp_dt - now).total_seconds() / 86400
            if dte_days <= 0:
                continue
            if dte_days > max_dte:
                break
            chosen.append((e, exp_dt, dte_days))
            if len(chosen) >= max_exp:
                break
        if not chosen:
            print(json.dumps({"error": f"no expiries within {max_dte} DTE for {symbol}"}))
            return

        # Collect + sanitize PER EXPIRY (the relative-IV filter needs each
        # expiry's own ATM IV as the baseline).
        contracts = []
        used_exps = []
        quality = {"droppedAbsIv": 0, "droppedRelIv": 0, "atmIvByExpiry": {}, "rawRows": 0}
        for e, exp_dt, dte_days in chosen:
            oc = tk.option_chain(e)
            T = dte_days / 365.0
            rows = []
            for df, is_call in ((oc.calls, True), (oc.puts, False)):
                for _, row in df.iterrows():
                    K, oi, iv = row.get("strike"), row.get("openInterest"), row.get("impliedVolatility")
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
