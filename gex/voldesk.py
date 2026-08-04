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


# ---- JSON that Node can actually parse -------------------------------------
# Python's json.dumps writes NaN / Infinity as BARE LITERALS. They're legal to
# Python's own parser and illegal to everyone else's — JSON.parse rejects them
# with "Unexpected token 'N'". The Node side then reported
#   gex/voldesk.py failed (code 0): {"ticker...
# i.e. the script succeeded, printed a full snapshot, and the whole scan was
# discarded because one float deep inside it was NaN. Every ticker came back ERR
# with no hint as to which field was at fault.
#
# So: replace non-finite floats with null, and RECORD WHERE THEY WERE. Silently
# nulling them would fix the crash and hide the bug that produced a NaN in the
# first place; `nonFinite` in the output names the offending fields.
def scrub_nonfinite(obj, path="", found=None):
    if found is None:
        found = []
    if isinstance(obj, float):
        if math.isnan(obj) or math.isinf(obj):
            found.append(path or "(root)")
            return None, found
        return obj, found
    if isinstance(obj, dict):
        out = {}
        for k, v in obj.items():
            out[k], found = scrub_nonfinite(v, f"{path}.{k}" if path else str(k), found)
        return out, found
    if isinstance(obj, (list, tuple)):
        out = []
        for i, v in enumerate(obj):
            nv, found = scrub_nonfinite(v, f"{path}[{i}]", found)
            out.append(nv)
        return out, found
    return obj, found


def dumps_safe(obj):
    clean, bad = scrub_nonfinite(obj)
    if bad:
        clean["nonFinite"] = sorted(set(bad))[:12]
    return json.dumps(clean, allow_nan=False)


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


# ---- Yahoo rate-limit protection -------------------------------------------
# Every ticker scan used to re-fetch SPY, QQQ and ^VIX for the regime read. Those
# three values are IDENTICAL for every ticker in a run, so scanning 24 names fired
# 72 redundant requests and Yahoo (correctly) started returning
# YFRateLimitError: Too Many Requests — which showed up as a wall of ERR rows.
#
# Fix: cache the regime on disk with a short TTL, and retry individual Yahoo calls
# with exponential backoff when we do get throttled.
REGIME_TTL_SECONDS = int(os.environ.get("REGIME_TTL_SECONDS", "900"))   # 15 min
YF_RETRIES = int(os.environ.get("YF_RETRIES", "3"))
YF_BACKOFF_BASE = float(os.environ.get("YF_BACKOFF_BASE", "1.5"))


def _is_rate_limit(exc):
    name = type(exc).__name__.lower()
    msg = str(exc).lower()
    return "ratelimit" in name or "too many requests" in msg or "429" in msg


def yf_retry(fn, what="yahoo call"):
    """Run a Yahoo call, backing off on rate limits. Re-raises anything else."""
    import time as _t
    last = None
    for attempt in range(YF_RETRIES):
        try:
            return fn()
        except Exception as e:
            last = e
            if not _is_rate_limit(e) or attempt == YF_RETRIES - 1:
                raise
            wait = YF_BACKOFF_BASE ** (attempt + 1)
            print(f"[voldesk] rate-limited on {what}, retry {attempt+1}/{YF_RETRIES-1} in {wait:.1f}s",
                  file=sys.stderr)
            _t.sleep(wait)
    raise last


def regime(data_dir=None):
    """Market regime read, CACHED — identical for every ticker in a run.

    yfinance is imported HERE, and only on a cache miss. It used to be imported
    unconditionally at the top of main(), which cost ~91 MB of resident memory
    (pandas + numpy) in EVERY scan process. At 8 concurrent scans that's ~730 MB
    on a 512 MB Render instance: the OOM killer took the whole app down and the
    proxy answered 502 on the next request.

    Nothing else needs yfinance once the Alpaca provider is in use, and the
    regime is disk-cached for REGIME_TTL_SECONDS, so on a warm cache a scan now
    imports nothing heavier than urllib.
    """
    import time as _t
    cache_path = os.path.join(data_dir or ".", "_regime_cache.json")
    try:
        blob = json.load(open(cache_path))
        if _t.time() - blob.get("ts", 0) < REGIME_TTL_SECONDS:
            return blob["regime"]
    except Exception:
        pass

    try:
        import yfinance as yf
    except Exception as e:
        # No regime read is survivable; a dead scan is not.
        return {"spy_chg": None, "qqq_chg": None, "vix_chg": None,
                "basket_gate": False, "vix_gate": False, "bull_bear_gate": None,
                "gates_passed": 0, "gates_note": f"regime unavailable ({e})"}

    out = {}
    for sym in ("SPY", "QQQ", "^VIX"):
        try:
            h = yf_retry(lambda: yf.Ticker(sym).history(period="5d"), f"regime {sym}")
            if len(h) >= 2:
                prev = float(h["Close"].iloc[-2])
                last = float(h["Close"].iloc[-1])
                # A NaN or zero close from a partial Yahoo response makes chg NaN.
                # Reject it here rather than storing it: once in the cache it
                # survives the whole TTL and poisons every snapshot written.
                chg = ((last / prev) - 1) * 100 if (prev and math.isfinite(prev) and math.isfinite(last)) else None
                out[sym] = round(chg, 2) if chg is not None and math.isfinite(chg) else None
        except Exception:
            out[sym] = None
    basket = (out.get("SPY") or -9) > 0.5 or (out.get("QQQ") or -9) > 0.5
    vix_ok = (out.get("^VIX") if out.get("^VIX") is not None else 9) < 0  # vol down = bullish
    result = {
        "spy_chg": out.get("SPY"), "qqq_chg": out.get("QQQ"), "vix_chg": out.get("^VIX"),
        "basket_gate": bool(basket),
        "vix_gate": bool(vix_ok),
        "bull_bear_gate": None,  # needs full 700-name universe — not computed
        "gates_passed": int(bool(basket)) + int(bool(vix_ok)),
        "gates_note": "bull:bear across 700 names not computed (needs universe); basket+vix only",
    }
    # Persist so sibling ticker scans in this run reuse it instead of refetching.
    try:
        os.makedirs(os.path.dirname(cache_path) or ".", exist_ok=True)
        # Also scrubbed: this cache is the SOURCE of the NaN. A failed Yahoo
        # fetch leaves a NaN close, chg comes out NaN, and it then persists for
        # the whole TTL and contaminates every snapshot written in that window.
        open(cache_path, "w").write(dumps_safe({"ts": _t.time(), "regime": result}))
    except Exception:
        pass
    return result


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

    # NOTE: yfinance is deliberately NOT imported here any more. It costs ~91 MB
    # per process and is needed only by the Yahoo provider (which imports it
    # itself) and by regime() on a cache miss (which now imports it lazily).
    # Importing it unconditionally is what made 8 concurrent scans exceed the
    # 512 MB Render instance and take the whole app down.

    try:
        # Provider abstraction: Alpaca by default, Yahoo as fallback. See
        # gex/dataprovider.py — Alpaca serves OI, IV, greeks and bars over REST
        # in ~3 calls per ticker instead of Yahoo's ~7, which is what made
        # scanning more than 8 names at a time impossible.
        import dataprovider as dp
        provider = dp.get_provider()

        closes, highs = provider.history(ticker)
        if not closes:
            print(json.dumps({"error": f"no price history for {ticker} (provider {provider.name})"}))
            return
        spot = closes[-1]

        # ---- option chain -> per-strike GEX ----
        chains = provider.chains(ticker, max_dte=max_dte)
        if not chains:
            print(json.dumps({"error": f"no expiries within {max_dte} DTE (provider {provider.name})"}))
            return
        now = datetime.now(timezone.utc)

        # Fetch each expiry's chain ONCE into a cached contract list:
        #   contracts = [(K, T, iv, oi, is_call), ...]
        contracts, used = [], []
        call_g = put_g = call_oi = put_oi = 0.0
        cw_num = cw_den = pw_num = pw_den = 0.0
        iv_dropped = 0
        for e in sorted(chains.keys())[:4]:
            exp_dt = datetime.strptime(e, "%Y-%m-%d").replace(hour=20, tzinfo=timezone.utc)
            d = (exp_dt - now).total_seconds() / 86400
            if d <= 0:
                continue
            T = d / 365.0
            rows = []
            for (K, oi, iv, is_call) in chains[e]:
                # OI-weighted centers (COTMC/COTMP) use OI regardless of IV validity
                if is_call:
                    cw_num += K * oi; cw_den += oi; call_oi += oi
                else:
                    pw_num += K * oi; pw_den += oi; put_oi += oi
                if not iv or iv <= 0:
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
        # pick_walls degrades rather than failing, but a chain can still be
        # one-sided (no strikes at all above or below spot). Synthesise a level a
        # sensible distance away and flag it — a missing wall must never abort the
        # scan, because no snapshot means the trader can never act on this name.
        if cw is None:
            synth = round(spot * 1.05, 2)
            cw = {"strike": synth, "gex": 0, "oi": 0}
            wall_notes.append(f"no call strikes above spot — synthesised +5% ({synth})")
        if pw is None:
            synth = round(spot * 0.95, 2)
            pw = {"strike": synth, "gex": 0, "oi": 0}
            wall_notes.append(f"no put strikes below spot — synthesised -5% ({synth})")
        call_wall = (cw["strike"], cw["gex"])
        put_wall = (pw["strike"], pw["gex"])
        cotmc = cw_num / cw_den if cw_den else spot
        cotmp = pw_num / pw_den if pw_den else spot

        # gamma flip via price grid — iterates the CACHED contracts (no network)
        flip_calc, flip_found, flip_detail = gc.gamma_flip(contracts, spot)
        flip = flip_calc if flip_calc is not None else spot

        # ---- Vol Desk level mapping (approximations) ----
        zeroGEX = round(flip, 2)
        plus_gex = round(call_wall[0], 2)            # T1 target (above spot)

        # ---- pTrans: the gamma flip, and ONLY the gamma flip ------------------
        # This used to be `min(max(flip, nTrans), spot)` — the flip clamped into
        # the band (nTrans, spot]. The clamp was the bug. Once the wall rule moved
        # the put wall further from spot, `max(flip, nTrans)` started returning
        # nTrans on most names, so pTrans snapped to nTrans + one strike:
        #
        #   MSFT  spot 487.57   pTrans 452.50   nTrans 450.00   ->  stop 0.5% wide
        #
        # Two things were wrong with that. The stop became a strike increment
        # rather than a level, which inflated R/R to 19 on a denominator of $2.50.
        # And the ENTRY moved 7% below spot, so names were tagged CONFIRMED on a
        # trigger price had cleared days earlier.
        #
        # pTrans means one thing: the level price must reclaim for dealers to flip
        # long gamma. That's the flip. If it sits above spot, the name simply
        # hasn't reclaimed yet — which the tag logic already expresses as
        # PENDING/BLOCKED. Clamping it below spot forged a confirmation.
        pTrans = round(min(strikes, key=lambda k: abs(k - flip)), 2) if strikes else round(flip, 2)

        # ---- nTrans: the stop, measured from the ENTRY not from spot ----------
        # A stop belongs a sensible distance below the level you enter on. Take
        # the biggest put-gamma strike at least `stop_min_pct` below pTrans, so
        # the risk leg can't collapse to one strike width. Falls back to the
        # unrestricted put wall, and finally to a synthesised level, because a
        # missing stop must never abort the scan.
        stop_min_pct = float(os.environ.get("STOP_MIN_PCT", "0.01"))
        gap = max(spot * stop_min_pct, 1e-9)
        below = [(K, e) for K, e in per.items() if K <= pTrans - gap]
        if below:
            K, _ = max(below, key=lambda kv: kv[1]["put"])
            nTrans = round(K, 2)
        elif put_wall[0] < pTrans:
            nTrans = round(put_wall[0], 2)
        else:
            # Nothing below the entry at all — synthesise so the scan completes,
            # and let the levels_usable filter judge it.
            nTrans = round(pTrans * (1 - max(stop_min_pct, 0.01)), 2)
            wall_notes.append(f"no put strike {stop_min_pct*100:.1f}% below pTrans — synthesised stop {nTrans}")
        t2 = round(cotmc, 2)

        # delta/gamma balance in [0,1]
        db = call_g / (call_g + put_g) if (call_g + put_g) else 0.5

        # ---- price-based signals ----
        m_count, m_detail = minervini(closes)
        cushion = (spot - cotmp) / spot  # COTMP cushion

        # ---- R/R measured from where you would ACTUALLY buy -------------------
        # This was `(plus_gex - pTrans) / (pTrans - nTrans)` — reward and risk
        # both measured from the trigger. That is only honest if you can transact
        # at the trigger, which was roughly true while pTrans hugged spot.
        #
        # Once pTrans became the real gamma flip it moved well below spot, and the
        # formula started reporting fiction: MSFT showed R/R 11 with the flip at
        # 445 and the stock at 487.57. You cannot buy at 445. Buying at market
        # gives risk 47.57 and reward 12.43 — a real R/R of 0.26. Every CONFIRMED
        # name in that scan was under 2.0 once measured this way.
        #
        # So: if price has already reclaimed the trigger, the entry is SPOT. If it
        # hasn't, the entry is the trigger, because that's where the order fires.
        entry_ref = max(spot, pTrans)          # longs: you can't buy below the market
        upside = plus_gex - entry_ref
        downside = entry_ref - nTrans
        rr = (upside / downside) if downside > 0 else 0.0
        # How far past the trigger price has already run. A reclaim setup is about
        # catching the flip; 15% above it, the move being traded already happened.
        # Reported rather than filtered — poor R/R already rejects the stale ones,
        # and this says *why* at a glance.
        extension_pct = ((spot - pTrans) / pTrans * 100) if pTrans else 0.0

        # ---- degenerate levels ----------------------------------------------
        # When the put wall is the nearest strike below spot there is no strike
        # left between it and spot for pTrans to occupy, so pTrans collapses onto
        # nTrans: stop == entry, downside == 0, and rr is reported as 0.0. That
        # reads like "this setup has terrible reward:risk" when the truth is
        # "these levels are unusable" — a data problem wearing a market problem's
        # clothes. Seen live on AMZN (270/270), GOOGL (347.5/347.5), DIS (95/95)
        # and MARA (11.5/11.5) in a single scan.
        #
        # Say so explicitly instead. WALL_MIN_DIST_PCT should prevent most of
        # these by pushing the walls off spot, but the check is the honest
        # backstop for chains where it can't.
        levels_bad = []
        if downside <= 0:
            levels_bad.append(f"stop {nTrans} is not below entry {pTrans}")
        if upside <= 0:
            levels_bad.append(f"target {plus_gex} is not above entry {pTrans}")
        # A stop worth less than one strike-width isn't a level, it's a rounding
        # artefact — and it inflates R/R by shrinking the denominator rather than
        # by improving the trade. Reject rather than report R/R 19 on a $2.50 risk.
        if downside > 0 and downside < spot * stop_min_pct * 0.9:
            levels_bad.append(
                f"stop {nTrans} is only {downside / spot * 100:.2f}% below entry {pTrans} "
                f"(min {stop_min_pct * 100:.1f}%) — R/R would be inflated by a tiny denominator")
        levels_usable = not levels_bad

        # The tradeable R/R bar, configurable so it can be tested against logged
        # results rather than argued about. NOTE this changes only the FILTER —
        # the identically-named criterion inside the 11-point grade stays at 2.0
        # on purpose, so a grade means the same thing across time and remains
        # comparable to snapshots taken before the bar was moved.
        min_rr = float(os.environ.get("SETUP_MIN_RR", "2.0"))
        rr_key = f"rr>={min_rr:g}"

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
            # Checked first so it reads before rr>=2 — if the levels are unusable,
            # the R/R number downstream is meaningless rather than merely poor.
            "levels_usable": levels_usable,
            "grade>=9": grade >= 9,
            "cushion": cushion >= cushion_threshold,
            "no_spike_crash": not spike_crash,
            rr_key: rr >= min_rr,
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
        if levels_bad:
            # Replace the bare filter name with what's actually wrong, and drop
            # rr>=2 — quoting a reward:risk computed from broken levels is noise.
            reasons = [r for r in reasons if r not in ("levels_usable", rr_key)]
            reasons.insert(0, "unusable levels: " + "; ".join(levels_bad))

        et_date = et_today()
        snapshot = {
            "ticker": ticker, "date": et_date, "asof": now.isoformat(),
            "spot": round(spot, 2),
            "flipFound": flip_found,
            "flipNote": flip_detail.get("reason"),
            "ivDropped": iv_dropped,
            "wallNotes": wall_notes,
            "levels": {"pTrans": pTrans, "nTrans": nTrans, "zeroGEX": zeroGEX,
                       "plusGEX_T1": plus_gex, "T2": t2, "COTMP": round(cotmp, 2), "COTMC": round(cotmc, 2)},
            "db": round(db, 4), "prior_db": prior_db,
            "db_change": None if db_change is None else round(db_change, 4),
            "db_status": db_status, "pegged": pegged,
            "grade": grade, "grade_rules": rules, "deep": deep,
            "minervini": m_count, "minervini_detail": m_detail,
            "cushion_pct": round(cushion * 100, 2), "rr": round(rr, 2),
            # Where the R/R above was measured from, and how far price has already
            # run past the trigger. Both exist so a reported R/R can be checked
            # rather than trusted.
            "entry_ref": round(entry_ref, 2), "extension_pct": round(extension_pct, 2),
            "spike_crash": spike_crash,
            "call_oi": int(call_oi), "put_oi": int(put_oi), "total_gex": round(total_gex, 0),
            "filters": filters, "filter_reasons": reasons,
            "regime": regime(data_dir),
            "require_db": require_db,
            # Which feed produced these levels, and how old the open interest is.
            # Yahoo never exposes an OI date, so until now we had no idea whether
            # the gamma was computed from yesterday's book or last week's.
            "data_source": provider.name,
            "oi_date": getattr(provider, "last_oi_date", None),
            "tag": tag,
        }

        # persist
        os.makedirs(os.path.join(data_dir, ticker), exist_ok=True)
        with open(os.path.join(data_dir, ticker, f"{et_date}.json"), "w") as f:
            # dumps_safe, not json.dump — the SNAPSHOT FILE is read back by
            # voldesk_trades.latestSnapshot() with JSON.parse on every entry
            # attempt. Scrubbing only the stdout copy fixed the scan and left the
            # file poisoned: `"spy_chg": NaN` from a failed regime fetch made
            # every subsequent entry die with "Unexpected token 'N'" — one bad
            # float in a field the trade logic never even reads.
            f.write(dumps_safe(snapshot))

        print(dumps_safe(snapshot))
    except Exception as e:
        import traceback
        print(json.dumps({"error": f"{type(e).__name__}: {e}", "trace": traceback.format_exc()[-500:]}))


if __name__ == "__main__":
    main()
