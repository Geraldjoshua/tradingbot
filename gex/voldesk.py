#!/usr/bin/env python3
"""Vol Desk forward-test scan/grade engine (raw-GEX approximation).

Given a ticker, this computes the Vol Desk setup from FREE data:
  - GEX levels from Yahoo option chains (OI+IV) with our own Black-Scholes gamma
  - price-based Minervini trend score + spike-crash check from Yahoo daily bars
  - regime read (SPY/QQQ basket gate, VIX proxy)
It grades the setup, applies the five entry filters, and tags it
CONFIRMED / PENDING / BLOCKED. A daily snapshot is persisted per ticker so
db_change (delta-balance change vs prior session) and progress can be tracked
forward over time.

IMPORTANT — these are RAW-GEX APPROXIMATIONS, not the proprietary Vol Desk feed:
  pTrans  ≈ nearest strike at/above the gamma-flip (reclaim = bullish gamma)
  nTrans  ≈ put wall (largest negative-GEX strike below spot) — structural stop
  +GEX/T1 ≈ call wall (largest positive-GEX strike above spot) — primary target
  T2      ≈ COTMC (call-OI-weighted strike) beyond +GEX
  zeroGEX  = gamma flip;  COTMP/COTMC = put/call OI-weighted strikes
  grade    = our 11 boolean structural proxies (NOT the vendor's 11 rules)
  db       = call-gamma / (call-gamma + put-gamma) in [0,1]; db_change = today-prior

Usage: voldesk.py TICKER DATA_DIR [max_dte_days]
"""
import sys, json, math, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gexcore as gc, os, glob
from datetime import datetime, timezone, timedelta

# Snapshots are keyed by US market (Eastern) day, not UTC — so an evening scan
# and the next day's scan land on different dates (UTC would merge them).
try:
    from zoneinfo import ZoneInfo
    ET_TZ = ZoneInfo("America/New_York")
except Exception:
    ET_TZ = timezone(timedelta(hours=-4))  # EDT fallback if tz db unavailable

def et_today():
    return datetime.now(ET_TZ).strftime("%Y-%m-%d")

R = 0.04
MULT = 100


def norm_pdf(x):
    return math.exp(-0.5 * x * x) / math.sqrt(2 * math.pi)


def bs_gamma(S, K, T, sigma):
    if S <= 0 or K <= 0 or T <= 0 or sigma <= 0:
        return 0.0
    d1 = (math.log(S / K) + (R + 0.5 * sigma * sigma) * T) / (sigma * math.sqrt(T))
    return norm_pdf(d1) / (S * sigma * math.sqrt(T))


def minervini(closes):
    """Return (count 0-8, details) of the classic trend-template criteria."""
    if len(closes) < 200:
        return 0, {}
    import statistics as st
    def sma(n, off=0):
        seg = closes[-(n + off):len(closes) - off] if off else closes[-n:]
        return sum(seg) / len(seg)
    price = closes[-1]
    s50, s150, s200 = sma(50), sma(150), sma(200)
    s200_prior = sma(200, 20)
    lo52, hi52 = min(closes[-252:]), max(closes[-252:])
    c = {
        "price>150&200": price > s150 and price > s200,
        "150>200": s150 > s200,
        "200_rising": s200 > s200_prior,
        "50>150>200": s50 > s150 > s200,
        "price>50": price > s50,
        "price>=1.3xLow": price >= 1.3 * lo52,
        "price>=0.75xHigh": price >= 0.75 * hi52,
        "6mo_up": len(closes) > 126 and price > closes[-126],
    }
    return sum(c.values()), c


def load_prior(data_dir, ticker):
    files = sorted(glob.glob(os.path.join(data_dir, ticker, "*.json")))
    today = et_today()
    priors = []
    for f in files:
        if os.path.basename(f).replace(".json", "") == today:
            continue
        try:
            priors.append(json.load(open(f)))
        except Exception:
            pass
    return priors  # chronological


def regime(yf):
    out = {}
    for sym in ("SPY", "QQQ", "^VIX"):
        try:
            h = yf.Ticker(sym).history(period="5d")
            if len(h) >= 2:
                chg = (h["Close"].iloc[-1] / h["Close"].iloc[-2] - 1) * 100
                out[sym] = round(float(chg), 2)
        except Exception:
            out[sym] = None
    basket = (out.get("SPY") or -9) > 0.5 or (out.get("QQQ") or -9) > 0.5
    vix_ok = (out.get("^VIX") if out.get("^VIX") is not None else 9) < 0  # vol down = bullish
    return {
        "spy_chg": out.get("SPY"), "qqq_chg": out.get("QQQ"), "vix_chg": out.get("^VIX"),
        "basket_gate": bool(basket),
        "vix_gate": bool(vix_ok),
        "bull_bear_gate": None,  # needs full 700-name universe — not computed
        "gates_passed": int(bool(basket)) + int(bool(vix_ok)),
        "gates_note": "bull:bear across 700 names not computed (needs universe); basket+vix only",
    }


def main():
    if len(sys.argv) < 3:
        print(json.dumps({"error": "usage: voldesk.py TICKER DATA_DIR [max_dte]"}))
        return
    ticker = sys.argv[1].upper()
    data_dir = sys.argv[2]
    max_dte = int(sys.argv[3]) if len(sys.argv) > 3 else 45
    # require_db=0 => "structure-only" mode: db_change is informational, not a hard
    # filter (useful on day 1 when no prior snapshot exists yet). Default: required.
    require_db = (sys.argv[4] != "0") if len(sys.argv) > 4 else True

    try:
        import yfinance as yf
    except Exception as e:
        print(json.dumps({"error": f"yfinance not installed: {e}"}))
        return

    try:
        tk = yf.Ticker(ticker)
        hist = tk.history(period="1y")
        if hist.empty:
            print(json.dumps({"error": f"no price history for {ticker}"}))
            return
        closes = [float(x) for x in hist["Close"].tolist()]
        highs = [float(x) for x in hist["High"].tolist()]
        spot = closes[-1]

        # ---- option chain -> per-strike GEX ----
        exps = list(tk.options)
        now = datetime.now(timezone.utc)
        chosen = []
        for e in exps:
            exp_dt = datetime.strptime(e, "%Y-%m-%d").replace(hour=20, tzinfo=timezone.utc)
            d = (exp_dt - now).total_seconds() / 86400
            if 0 < d <= max_dte:
                chosen.append((e, d))
            if len(chosen) >= 4:
                break
        if not chosen:
            print(json.dumps({"error": f"no expiries within {max_dte} DTE"}))
            return

        # Fetch each expiry's chain ONCE into a cached contract list:
        #   contracts = [(K, T, iv, oi, is_call), ...]
        contracts, used = [], []
        call_g = put_g = call_oi = put_oi = 0.0
        cw_num = cw_den = pw_num = pw_den = 0.0
        iv_dropped = 0
        for e, d in chosen:
            oc = tk.option_chain(e)
            T = d / 365.0
            rows = []
            for df, is_call in ((oc.calls, True), (oc.puts, False)):
                for _, row in df.iterrows():
                    K, oi, iv = row.get("strike"), row.get("openInterest"), row.get("impliedVolatility")
                    if not K or oi is None:
                        continue
                    if (isinstance(oi, float) and math.isnan(oi)) or oi <= 0:
                        continue
                    K, oi = float(K), float(oi)
                    # OI-weighted centers (COTMC/COTMP) use OI regardless of IV validity
                    if is_call:
                        cw_num += K * oi; cw_den += oi; call_oi += oi
                    else:
                        pw_num += K * oi; pw_den += oi; put_oi += oi
                    if iv is None or (isinstance(iv, float) and math.isnan(iv)) or iv <= 0:
                        continue
                    rows.append((K, T, float(iv), oi, is_call))
            # Reject Yahoo's garbage IVs before they manufacture fake gamma at
            # far strikes — those fake-gamma strikes were winning the wall vote
            # and therefore SETTING THE STOP (nTrans). See gex/gexcore.py.
            kept, stats = gc.sanitize_expiry(rows, spot)
            iv_dropped += stats["droppedAbs"] + stats["droppedRel"]
            for (K, T2, iv2, oi2, is_call2) in kept:
                contracts.append((K, T2, iv2, oi2, is_call2))
                g = gc.bs_gamma(spot, K, T2, iv2)
                if is_call2:
                    call_g += g * oi2
                else:
                    put_g += g * oi2
            used.append(e)
        if not contracts:
            print(json.dumps({"error": "no contracts with OI+IV"}))
            return

        # per-strike GEX at spot, call and put legs kept SEPARATE (shared core)
        per = gc.per_strike_gex(contracts, spot)
        per_strike = {k: e["net"] for k, e in per.items()}
        strikes = sorted(per.keys())
        total_gex = sum(per_strike.values())
        # Call wall = largest CALL gamma above spot; put wall = largest PUT gamma
        # below spot, both inside a moneyness band with an OI floor. Taking
        # max/min of NET gex (the old way) returns the least-negative far strike
        # on put-heavy names — that is how a "call wall" ended up below spot.
        cw, pw, wall_notes = gc.pick_walls(per, spot)
        if cw is None or pw is None:
            print(json.dumps({"ticker": ticker,
                              "error": "could not locate walls on both sides of spot after sanity filters",
                              "notes": wall_notes}))
            return
        call_wall = (cw["strike"], cw["gex"])
        put_wall = (pw["strike"], pw["gex"])
        cotmc = cw_num / cw_den if cw_den else spot
        cotmp = pw_num / pw_den if pw_den else spot

        # gamma flip via price grid — iterates the CACHED contracts (no network)
        flip_calc, flip_found, flip_detail = gc.gamma_flip(contracts, spot)
        flip = flip_calc if flip_calc is not None else spot

        # ---- Vol Desk level mapping (approximations) ----
        zeroGEX = round(flip, 2)
        nTrans = round(put_wall[0], 2)               # structural stop (below spot)
        plus_gex = round(call_wall[0], 2)            # T1 target (above spot)
        # pTrans = reclaim/entry level: the gamma flip clamped into (nTrans, spot],
        # snapped to the nearest actual strike, so nTrans < pTrans <= spot < +GEX.
        cand = [k for k in strikes if nTrans < k <= spot]
        if cand:
            target = min(max(flip, nTrans), spot)
            pTrans = round(min(cand, key=lambda k: abs(k - target)), 2)
        else:
            pTrans = round(min(spot, max(flip, nTrans)), 2)
        t2 = round(cotmc, 2)

        # delta/gamma balance in [0,1]
        db = call_g / (call_g + put_g) if (call_g + put_g) else 0.5

        # ---- price-based signals ----
        m_count, m_detail = minervini(closes)
        cushion = (spot - cotmp) / spot  # COTMP cushion

        # R/R to +GEX vs down to pTrans (entry assumed at pTrans)
        upside = plus_gex - pTrans
        downside = pTrans - nTrans
        rr = (upside / downside) if downside > 0 else 0.0

        # spike-crash: is the +GEX target a recent spike high that sold off?
        # A real spike-crash: the +GEX target sits at a prior SWING high that was
        # reached by a sharp run-up (>=5% in a week) and then crashed (>=8% in 3 days).
        spike_crash = False
        for i in range(max(5, len(highs) - 60), len(highs) - 3):
            if abs(highs[i] - plus_gex) / plus_gex >= 0.015:
                continue
            neighbors = highs[i - 3:i] + highs[i + 1:i + 4]
            if not neighbors or highs[i] < max(neighbors):
                continue  # not a local swing high
            runup = (highs[i] - closes[i - 5]) / closes[i - 5]
            crash = (highs[i] - min(closes[i + 1:i + 4])) / highs[i]
            if runup >= 0.05 and crash >= 0.08:
                spike_crash = True
                break

        # ---- db_change from prior snapshot ----
        priors = load_prior(data_dir, ticker)
        prior_db = priors[-1]["db"] if priors else None
        db_change = (db - prior_db) if prior_db is not None else None
        pegged = (len(priors) >= 2 and all(abs(p.get("db", 0) - 1.0) < 0.02 for p in priors[-2:])
                  and abs(db - 1.0) < 0.02)

        # ---- grade (11 boolean proxies) ----
        oi_total = call_oi + put_oi
        rules = {
            "spot>flip": spot > flip,
            "netGEX>0": total_gex > 0,
            "callWall_above": plus_gex > spot,
            "putWall_below": nTrans < spot,
            "rr>=2": rr >= 2.0,
            "cushion>=2%": cushion >= 0.02,
            "db>=0.5": db >= 0.5,
            "callOI>=putOI": call_oi >= put_oi,
            "oi_depth": oi_total >= 5000,
            "spot>COTMP": spot > cotmp,
            "minervini>=5": m_count >= 5,
        }
        grade = sum(rules.values())
        deep = grade == 11

        # ---- filters (with documented exceptions) ----
        db_threshold = 0.30 if deep else 0.50
        db_pass = pegged or (db_change is not None and db_change >= db_threshold)
        db_status = "exempt(pegged)" if pegged else ("no_prior" if db_change is None else ("pass" if db_pass else "fail"))
        cushion_threshold = 0.01 if (deep or (db_change or 0) >= 0.75) else 0.02
        filters = {
            "grade>=9": grade >= 9,
            "cushion": cushion >= cushion_threshold,
            "no_spike_crash": not spike_crash,
            "rr>=2": rr >= 2.0,
        }
        if require_db:
            filters["db_change"] = db_pass          # faithful mode: db_change is a hard filter
        elif db_status in ("no_prior", "fail"):
            db_status += " (not required)"          # structure-only mode: informational
        all_pass = all(filters.values())

        # ---- tag ----
        if not all_pass:
            tag = "BLOCKED"
        elif spot >= pTrans:
            tag = "CONFIRMED"          # greenlit; awaits the 5-min open trigger intraday
        elif spot >= pTrans * 0.995:
            tag = "PENDING"            # within 0.5% below pTrans, watch first candle
        else:
            tag = "BLOCKED"

        reasons = [k for k, v in filters.items() if not v]
        if all_pass and tag == "BLOCKED":
            reasons.append(f"spot {round(spot,2)} >0.5% below pTrans {pTrans}")

        et_date = et_today()
        snapshot = {
            "ticker": ticker, "date": et_date, "asof": now.isoformat(),
            "spot": round(spot, 2),
            "flipFound": flip_found,
            "flipNote": flip_detail.get("reason"),
            "ivDropped": iv_dropped,
            "levels": {"pTrans": pTrans, "nTrans": nTrans, "zeroGEX": zeroGEX,
                       "plusGEX_T1": plus_gex, "T2": t2, "COTMP": round(cotmp, 2), "COTMC": round(cotmc, 2)},
            "db": round(db, 4), "prior_db": prior_db,
            "db_change": None if db_change is None else round(db_change, 4),
            "db_status": db_status, "pegged": pegged,
            "grade": grade, "grade_rules": rules, "deep": deep,
            "minervini": m_count, "minervini_detail": m_detail,
            "cushion_pct": round(cushion * 100, 2), "rr": round(rr, 2),
            "spike_crash": spike_crash,
            "call_oi": int(call_oi), "put_oi": int(put_oi), "total_gex": round(total_gex, 0),
            "filters": filters, "filter_reasons": reasons,
            "regime": regime(yf),
            "require_db": require_db,
            "tag": tag,
        }

        # persist
        os.makedirs(os.path.join(data_dir, ticker), exist_ok=True)
        with open(os.path.join(data_dir, ticker, f"{et_date}.json"), "w") as f:
            json.dump(snapshot, f, indent=2)

        print(json.dumps(snapshot))
    except Exception as e:
        import traceback
        print(json.dumps({"error": f"{type(e).__name__}: {e}", "trace": traceback.format_exc()[-500:]}))


if __name__ == "__main__":
    main()
