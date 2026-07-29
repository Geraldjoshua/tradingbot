#!/usr/bin/env python3
"""Compute dealer Gamma Exposure (GEX) from free Yahoo option chains (yfinance).

Alpaca gives us no greeks/open-interest on this account, so we source per-strike
open interest + implied vol from Yahoo and compute gamma ourselves with
Black-Scholes. Outputs (as JSON on stdout):

  - spot
  - gamma flip (zero-gamma level): the underlying price where net dealer gamma
    crosses zero — above it dealers are long gamma (vol-dampening), below it
    short gamma (vol-amplifying).
  - call wall / put wall: strikes with the largest positive / negative GEX
    (classic resistance / support).
  - per-strike GEX profile for charting.

Convention (SqueezeMetrics "naive"): dealers long calls, short puts, so
  net gamma = gamma_call * OI_call  -  gamma_put * OI_put
GEX per strike is expressed as $ per 1% move: gamma * OI * 100 * S^2 * 0.01.

Usage: gex.py SYMBOL [max_expiries] [max_dte_days]
"""
import sys, json, math
from datetime import datetime, timezone

R = 0.04  # risk-free
MULT = 100  # contract multiplier


def norm_pdf(x):
    return math.exp(-0.5 * x * x) / math.sqrt(2 * math.pi)


def bs_gamma(S, K, T, sigma):
    if S <= 0 or K <= 0 or T <= 0 or sigma <= 0:
        return 0.0
    d1 = (math.log(S / K) + (R + 0.5 * sigma * sigma) * T) / (sigma * math.sqrt(T))
    return norm_pdf(d1) / (S * sigma * math.sqrt(T))


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
        # keep expiries within max_dte, up to max_exp of them
        chosen = []
        for e in exps:
            exp_dt = datetime.strptime(e, "%Y-%m-%d").replace(hour=20, tzinfo=timezone.utc)  # ~16:00 ET
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

        # Collect contracts: list of (K, T, sigma, OI, is_call)
        contracts = []
        used_exps = []
        for e, exp_dt, dte_days in chosen:
            oc = tk.option_chain(e)
            T = dte_days / 365.0
            for df, is_call in ((oc.calls, True), (oc.puts, False)):
                for _, row in df.iterrows():
                    oi = row.get("openInterest")
                    iv = row.get("impliedVolatility")
                    K = row.get("strike")
                    if oi is None or (isinstance(oi, float) and math.isnan(oi)):
                        oi = 0
                    if iv is None or (isinstance(iv, float) and math.isnan(iv)) or iv <= 0:
                        continue
                    if not K or oi <= 0:
                        continue
                    contracts.append((float(K), T, float(iv), float(oi), is_call))
            used_exps.append(e)

        if not contracts:
            print(json.dumps({"error": "no contracts with OI+IV found"}))
            return

        def net_gamma_at(S):
            """Signed dealer gamma notional ($/1% move) summed over all contracts at price S."""
            tot = 0.0
            for K, T, sigma, oi, is_call in contracts:
                g = bs_gamma(S, K, T, sigma)
                sign = 1.0 if is_call else -1.0
                tot += sign * g * oi * MULT * S * S * 0.01
            return tot

        # Per-strike GEX at current spot (aggregate calls - puts per strike)
        per_strike = {}
        for K, T, sigma, oi, is_call in contracts:
            g = bs_gamma(spot, K, T, sigma)
            sign = 1.0 if is_call else -1.0
            per_strike[K] = per_strike.get(K, 0.0) + sign * g * oi * MULT * spot * spot * 0.01
        strikes = sorted(per_strike.keys())
        profile = [{"strike": k, "gex": round(per_strike[k], 0)} for k in strikes]

        call_wall = max(per_strike.items(), key=lambda kv: kv[1])
        put_wall = min(per_strike.items(), key=lambda kv: kv[1])
        total_gex = sum(per_strike.values())

        # Gamma flip: scan a price grid, find sign change of net gamma nearest to spot
        lo, hi = spot * 0.80, spot * 1.20
        steps = 200
        grid = [lo + (hi - lo) * i / steps for i in range(steps + 1)]
        prev_S, prev_g = None, None
        crossings = []
        for S in grid:
            g = net_gamma_at(S)
            if prev_g is not None and (prev_g <= 0 < g or prev_g >= 0 > g):
                # linear interpolation of the zero crossing
                frac = prev_g / (prev_g - g) if (prev_g - g) != 0 else 0.5
                crossings.append(prev_S + (S - prev_S) * frac)
            prev_S, prev_g = S, g
        flip = min(crossings, key=lambda x: abs(x - spot)) if crossings else None

        print(json.dumps({
            "symbol": symbol,
            "spot": round(spot, 2),
            "asof": now.isoformat(),
            "expiries": used_exps,
            "gammaFlip": round(flip, 2) if flip is not None else None,
            "regime": (None if flip is None else ("long_gamma" if spot > flip else "short_gamma")),
            "callWall": {"strike": call_wall[0], "gex": round(call_wall[1], 0)},
            "putWall": {"strike": put_wall[0], "gex": round(put_wall[1], 0)},
            "totalGex": round(total_gex, 0),
            "profile": profile,
        }))
    except Exception as e:
        print(json.dumps({"error": f"{type(e).__name__}: {e}"}))


if __name__ == "__main__":
    main()
