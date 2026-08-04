"""
Shared GEX math for gex.py and voldesk.py.

WHY THIS FILE EXISTS
gex.py and voldesk.py each had their own copy of the wall-picking logic and they
had DIVERGED — voldesk.py constrained walls to the correct side of spot, gex.py
did not. That produced the nonsense you can see on the GEX tab: SPY spot 729 with
a "call wall (resistance)" of 669 (below spot) and a "put wall" of 380 (48% down).
Sharing the code means the display and the trading levels can't disagree again.

THE THREE BUGS THIS FIXES

1. WALLS ON THE WRONG SIDE / FROM THE WRONG SERIES.
   The old code took `max(net_gex_per_strike)` for the call wall and `min(...)`
   for the put wall, across ALL strikes. On an index like SPY put OI dominates
   almost every strike, so net GEX is negative nearly everywhere — and `max()`
   then returns whatever strike is CLOSEST TO ZERO, i.e. a far, illiquid,
   irrelevant strike. That's not resistance, it's noise.
   Fix: the call wall is the largest CALL-side GEX strictly ABOVE spot; the put
   wall is the largest PUT-side GEX strictly BELOW spot. Separate series,
   correct side, which is the standard definition.

2. GARBAGE YAHOO IMPLIED VOLS.
   Free Yahoo chains routinely report absurd IV on illiquid strikes (stale marks
   on deep OTM tails). An inflated IV manufactures synthetic gamma where there
   should be ~none, and because deep OTM index puts carry real tail-hedge OI,
   those fake-gamma strikes win the wall vote. That is how a 0-4 DTE SPY chain
   produces a "put wall" at 380.
   Fix: reject IV outside an absolute sane band, then reject per-expiry IV
   outliers relative to that expiry's ATM IV, then require a minimum OI for a
   strike to be eligible as a WALL (it still counts toward totals).

3. GAMMA FLIP REPORTED AS "—" WITH NO EXPLANATION.
   If net gamma never crosses zero inside the scanned band (again: normal when
   puts dominate), the old code returned None and the UI showed a bare dash, so
   "no crossing in range" was indistinguishable from "computation failed".
   Fix: widen the scan, and when there's genuinely no crossing return the price
   that MINIMISES |net gamma| plus `flipFound: False`, so callers can say which
   case it is.

Also reports gross call and put GEX next to the net. A net near zero (SPY often
nets small because the two sides nearly cancel) previously looked like "barely
any gamma", which is very misleading.

CONVENTION (unchanged, SqueezeMetrics "naive"): dealers are assumed long calls
and short puts, so net = call_gamma*OI - put_gamma*OI, expressed as $ per 1%
move: gamma * OI * 100 * S^2 * 0.01. This is a crude approximation of real dealer
positioning and is the single biggest source of error here — more than any of the
bugs above.
"""

import math, os

R = 0.04          # risk-free
MULT = 100        # contract multiplier

# --- IV / OI sanity thresholds ------------------------------------------------
IV_ABS_MIN = 0.01      # 1% — below this is a stale/zero mark
IV_ABS_MAX = 3.00      # 300% — above this is almost always bad Yahoo data
IV_REL_MAX = 3.0       # reject IV > 3x that expiry's ATM IV
IV_REL_MIN = 0.25      # reject IV < 0.25x that expiry's ATM IV
WALL_MIN_OI = 100      # a strike needs this much OI to define a wall
WALL_BAND_PCT = 0.20   # preferred band for walls (relaxed automatically if empty)
# A wall must stand at least this far from spot, otherwise per-contract gamma
# (which peaks ATM) simply hands us the next strike up every time. See the long
# note in pick_walls. Env-overridable so the Node layer can drive it from config.
WALL_MIN_DIST_PCT = float(os.environ.get("WALL_MIN_DIST_PCT", "0.015"))   # 1.5%
WALL_WEIGHT_BY_OI = os.environ.get("WALL_WEIGHT_BY_OI", "0") == "1"
# The relative-IV filter must never gut a chain — if it would keep fewer than
# this, we assume the ATM baseline was bad and fall back to the absolute filter.
MIN_KEEP = 8
MIN_KEEP_FRACTION = 0.25


def norm_pdf(x):
    return math.exp(-0.5 * x * x) / math.sqrt(2 * math.pi)


def bs_gamma(S, K, T, sigma):
    if S <= 0 or K <= 0 or T <= 0 or sigma <= 0:
        return 0.0
    d1 = (math.log(S / K) + (R + 0.5 * sigma * sigma) * T) / (sigma * math.sqrt(T))
    return norm_pdf(d1) / (S * sigma * math.sqrt(T))


def _is_bad(x):
    return x is None or (isinstance(x, float) and math.isnan(x))


def sanitize_expiry(rows, spot):
    """rows: [(K, T, iv, oi, is_call)] for ONE expiry -> filtered list + stats.

    Drops IVs that are absolutely absurd, then drops IVs that are wild outliers
    relative to this expiry's ATM IV. The relative test is the one that actually
    removes Yahoo's deep-OTM garbage, because a "200% IV" is genuinely normal on
    a 0-DTE tail but not when ATM is printing 12%.
    """
    keep = [r for r in rows if IV_ABS_MIN <= r[2] <= IV_ABS_MAX]
    if not keep:
        return [], {"atmIv": None, "droppedAbs": len(rows), "droppedRel": 0}

    # ATM IV for this expiry = IV of the strike nearest spot (median of the
    # nearest few, to avoid one bad print defining the baseline).
    near = sorted(keep, key=lambda r: abs(r[0] - spot))[:6]
    ivs = sorted(r[2] for r in near)
    atm_iv = ivs[len(ivs) // 2] if ivs else None

    out = keep
    dropped_rel = 0
    if atm_iv and atm_iv > 0:
        filtered = []
        for r in keep:
            ratio = r[2] / atm_iv
            if IV_REL_MIN <= ratio <= IV_REL_MAX:
                filtered.append(r)
            else:
                dropped_rel += 1
        # SAFETY VALVE: the relative filter exists to remove a few garbage prints,
        # not to gut the chain. If it would drop most of the expiry, the baseline
        # ATM IV was probably itself bad — trust the absolute filter instead and
        # keep everything, rather than returning a chain too sparse to locate
        # walls (which used to abort the whole scan).
        if len(filtered) >= max(MIN_KEEP, int(len(keep) * MIN_KEEP_FRACTION)):
            out = filtered
        else:
            out = keep
            dropped_rel = 0
    return out, {
        "atmIv": round(atm_iv, 4) if atm_iv else None,
        "droppedAbs": len(rows) - len(keep),
        "droppedRel": dropped_rel,
    }


def per_strike_gex(contracts, spot):
    """-> {K: {"call": $gex, "put": $gex(positive magnitude), "net": call-put,
              "callOi": n, "putOi": n}}

    Keeping the call and put legs SEPARATE is what makes correct wall selection
    possible; collapsing to a net first is what broke the old code.
    """
    per = {}
    for K, T, iv, oi, is_call in contracts:
        g = bs_gamma(spot, K, T, iv)
        notional = g * oi * MULT * spot * spot * 0.01
        e = per.setdefault(K, {"call": 0.0, "put": 0.0, "callOi": 0.0, "putOi": 0.0})
        if is_call:
            e["call"] += notional; e["callOi"] += oi
        else:
            e["put"] += notional; e["putOi"] += oi
    for K, e in per.items():
        e["net"] = e["call"] - e["put"]
    return per


def pick_walls(per, spot, band_pct=WALL_BAND_PCT, min_oi=WALL_MIN_OI,
               min_dist_pct=WALL_MIN_DIST_PCT, weight_by_oi=WALL_WEIGHT_BY_OI):
    """Call wall = biggest CALL gamma ABOVE spot. Put wall = biggest PUT gamma
    BELOW spot. Both restricted to a moneyness band and an OI floor.

    Returns (call_wall, put_wall, note) where each wall is
    {"strike", "gex", "oi"} or None when nothing qualifies.

    ---- min_dist_pct: why a wall needs to be FAR from spot -------------------

    Per-contract gamma is maximised at-the-money and decays away from spot. So
    "largest call gamma above spot" almost always returns the strike immediately
    above spot, whatever the open interest looks like. Observed live: GOOGL spot
    349.99 -> wall 350, AMZN 271.66 -> 272.5, INTC 92.72 -> 93, DIS 95.86 -> 96.
    Those aren't walls, they're just the next strike up.

    That mattered because the call wall is T1, the profit target. A target 0.3%
    away against a stop at the put wall can never satisfy the rr>=2 entry filter,
    so the strategy rejected almost every name for a reason that was an artefact
    of the selection rule rather than a fact about the market. (COIN was the
    counter-example: genuine OI concentration at 160 with spot at 140, giving
    R/R 39 — the mechanism works when a real wall exists.)

    min_dist_pct excludes strikes within that fraction of spot, so a wall has to
    stand at a distance to count. It is applied as a PREFERENCE inside the
    progressive fallback: if nothing further out qualifies we relax it rather
    than fail, because wall selection must never abort a scan.

    ---- weight_by_oi --------------------------------------------------------

    Off: rank by gamma alone (original). On: rank by gamma x open interest, so a
    large OI cluster further out can outrank the ATM strike's naturally-high
    gamma. Closer to how dealers describe a wall, but a big near-strike OI can
    still win, which is why distance is the primary control.
    """
    notes = []

    def best(side, predicate, key, dist_pct):
        """Degrade gracefully rather than fail closed.

        An earlier version returned None the moment the preferred band+OI filter
        came up empty, and voldesk.py treated that as a fatal error — so a single
        thin chain aborted the whole scan, no snapshot was written, and every
        entry attempt failed forever. Wall selection must never be able to kill a
        scan: try progressively looser criteria and only give up if there is
        genuinely no strike on that side of spot.
        """
        on_side = [(K, e) for K, e in per.items() if predicate(K)]
        if not on_side:
            notes.append(f"no {side} strikes {'above' if side == 'call' else 'below'} spot at all")
            return None

        d = max(0.0, float(dist_pct or 0.0))
        far_enough = (lambda K: abs(K - spot) >= spot * d) if d > 0 else (lambda K: True)

        attempts = [
            (band_pct, min_oi, far_enough, None),
            (band_pct, 0, far_enough, f"{side} wall below OI floor {min_oi}"),
            (band_pct * 2, 0, far_enough, f"{side} wall outside {int(band_pct*100)}% band"),
            # Only now do we give up on distance — an ATM-hugging wall is poor,
            # but it beats no wall and a dead scan.
            (band_pct * 2, 0, lambda K: True,
             f"{side} wall within {d*100:.1f}% of spot (nothing further out qualified)" if d > 0 else None),
            (None, 0, lambda K: True, f"{side} wall unrestricted (thin/unusual chain)"),
        ]
        for band, oi_floor, dist_ok, note in attempts:
            if band is None:
                cands = [(K, e) for K, e in on_side if e[f"{side}Oi"] >= oi_floor and dist_ok(K)]
            else:
                lo, hi = spot * (1 - band), spot * (1 + band)
                cands = [(K, e) for K, e in on_side
                         if lo <= K <= hi and e[f"{side}Oi"] >= oi_floor and dist_ok(K)]
            if cands:
                if note:
                    notes.append(note)
                K, e = max(cands, key=key)
                return {"strike": K, "gex": round(e[side] if side == "call" else -e[side], 0),
                        "oi": int(e[f"{side}Oi"])}
        # on_side was non-empty, so the last attempt cannot fail — belt and braces.
        K, e = max(on_side, key=key)
        notes.append(f"{side} wall fallback")
        return {"strike": K, "gex": round(e[side] if side == "call" else -e[side], 0),
                "oi": int(e[f"{side}Oi"])}

    def ranker(side):
        if weight_by_oi:
            return lambda kv: abs(kv[1][side]) * max(kv[1][f"{side}Oi"], 1)
        return lambda kv: kv[1][side]

    # The distance rule applies to the CALL wall only.
    #
    # It was written to stop the profit target landing on the strike next to spot.
    # Applying the same rule to the put wall pushed the STOP far below spot, and
    # because voldesk.py derived pTrans from nTrans, pTrans then collapsed onto
    # nTrans + one strike: a $2.50 stop on a $487 name, and an R/R of 19 that came
    # from a tiny denominator rather than a good setup.
    #
    # A put wall close to spot is not a defect — a tight structural stop is
    # useful. What matters is that the stop sits a sensible distance BELOW THE
    # ENTRY, which is a different question, and is now answered in voldesk.py
    # where the entry level is actually known.
    call_wall = best("call", lambda K: K > spot, ranker("call"), min_dist_pct)
    put_wall = best("put", lambda K: K < spot, ranker("put"), 0.0)
    return call_wall, put_wall, notes


def net_gamma_at(contracts, S):
    tot = 0.0
    for K, T, iv, oi, is_call in contracts:
        g = bs_gamma(S, K, T, iv)
        tot += (1 if is_call else -1) * g * oi * MULT * S * S * 0.01
    return tot


def gamma_flip(contracts, spot, band=0.30, steps=240):
    """-> (flip_price, found, detail)

    Scans +/-`band` around spot for a sign change in net dealer gamma. If there
    is no crossing (common on index products where put OI dominates every
    strike), returns the price that minimises |net gamma| with found=False,
    instead of a bare None that the UI can't explain.
    """
    lo, hi = spot * (1 - band), spot * (1 + band)
    grid = [lo + (hi - lo) * i / steps for i in range(steps + 1)]
    prev_S = prev_v = None
    crossings = []
    best_S, best_abs = None, float("inf")
    for S in grid:
        v = net_gamma_at(contracts, S)
        if abs(v) < best_abs:
            best_abs, best_S = abs(v), S
        if prev_v is not None and (prev_v <= 0 < v or prev_v >= 0 > v):
            frac = prev_v / (prev_v - v) if (prev_v - v) else 0.5
            crossings.append(prev_S + (S - prev_S) * frac)
        prev_S, prev_v = S, v
    if crossings:
        return min(crossings, key=lambda x: abs(x - spot)), True, {"crossings": len(crossings)}
    return best_S, False, {
        "crossings": 0,
        "reason": f"net gamma never crosses zero within +/-{int(band*100)}% of spot "
                  f"(one side dominates every strike); showing |net gamma| minimum",
        "minAbsGex": round(best_abs, 0),
    }


def totals(per):
    """Gross call / gross put / net, so a small net isn't mistaken for 'no gamma'."""
    call = sum(e["call"] for e in per.values())
    put = sum(e["put"] for e in per.values())
    return {
        "callGex": round(call, 0),
        "putGex": round(-put, 0),
        "netGex": round(call - put, 0),
        "grossGex": round(call + put, 0),
    }
