"""Scanner maths — pure functions, no network, no globals.

Everything here takes data in and returns numbers out, so the whole ranking can
be unit-tested without an API key. That is the only reason the scoring is
trustworthy: the parts that decide what you look at in the morning are the parts
that can be checked.
"""

from datetime import datetime, timedelta, timezone

try:
    from zoneinfo import ZoneInfo
    ET = ZoneInfo("America/New_York")
except Exception:                                  # tzdata missing on slim images
    ET = timezone(timedelta(hours=-4))             # EDT fallback, same as gex/

# US equity session boundaries, in minutes past ET midnight.
PRE_OPEN = 4 * 60           # 04:00 — Alpaca serves extended-hours bars from here
RTH_OPEN = 9 * 60 + 30      # 09:30
RTH_CLOSE = 16 * 60         # 16:00
POST_CLOSE = 20 * 60        # 20:00


def et_now():
    return datetime.now(timezone.utc).astimezone(ET)


def et_minutes(dt=None):
    dt = dt or et_now()
    return dt.hour * 60 + dt.minute


def session_of(dt=None):
    """PRE | RTH | POST | CLOSED.

    The old /api/scan had no concept of this at all. It computed
    gap = (dailyBar.open - prevDailyBar.close) / prevDailyBar.close, which is
    undefined before 09:30 because there IS no open yet — so premarket it
    returned either nothing or yesterday's numbers wearing today's date. That is
    not a scanner you can trade a premarket runner from.
    """
    dt = dt or et_now()
    if dt.weekday() >= 5:
        return "CLOSED"                            # holidays are not modelled
    m = et_minutes(dt)
    if PRE_OPEN <= m < RTH_OPEN:
        return "PRE"
    if RTH_OPEN <= m < RTH_CLOSE:
        return "RTH"
    if RTH_CLOSE <= m < POST_CLOSE:
        return "POST"
    return "CLOSED"


def session_start_iso(dt=None, session=None):
    """UTC ISO timestamp for the start of the bar window we care about.

    PRE  -> 04:00 today (the whole premarket)
    RTH  -> 04:00 today (we still want the premarket high — it is the level the
            entire opening plays off; discarding it at 09:30 throws away the
            reference the trade is built on)
    POST -> 04:00 today (full day context)
    """
    dt = dt or et_now()
    base = dt.replace(hour=4, minute=0, second=0, microsecond=0)
    if session == "CLOSED" and et_minutes(dt) < PRE_OPEN:
        base = base - timedelta(days=1)            # small hours: show last session
    return base.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ---- Intraday volume curve -------------------------------------------------
# Cumulative share of a normal session's volume by minutes past 09:30. Needed to
# make RVOL mean anything intraday: 500k shares by 09:45 and 500k shares by 15:45
# are wildly different statements, and dividing both by average DAILY volume says
# they are the same.
#
# HONESTY: this is the standard U-shape (heavy open, dead midday, closing-auction
# bump) eyeballed to round numbers, NOT fitted to your tape. It is good enough to
# rank names against each other at the same moment — which is all it is used for.
# It is not good enough to say "this name is doing exactly 3.2x normal".
_VOL_CURVE = [
    (0, 0.00), (15, 0.08), (30, 0.13), (60, 0.21), (90, 0.28), (120, 0.34),
    (150, 0.39), (180, 0.44), (210, 0.49), (240, 0.55), (270, 0.61),
    (300, 0.68), (330, 0.77), (360, 0.88), (390, 1.00),
]


def expected_volume_fraction(minutes_since_open):
    m = max(0.0, min(float(minutes_since_open), 390.0))
    for i in range(1, len(_VOL_CURVE)):
        x0, y0 = _VOL_CURVE[i - 1]
        x1, y1 = _VOL_CURVE[i]
        if m <= x1:
            span = x1 - x0
            return y0 if span <= 0 else y0 + (y1 - y0) * (m - x0) / span
    return 1.0


def relative_volume(session_volume, adv, session, dt=None):
    """How busy is this name, right now, relative to itself?

    RVOL is the single most predictive number in small-cap momentum trading, and
    it is the one the old scanner did not compute at all. Gap size tells you
    something happened overnight; RVOL tells you whether anyone actually showed
    up to trade it, which is what decides whether the move continues or fades in
    the first ten minutes.

    PRE  -> premarket volume as a fraction of an average FULL day. Above ~0.10
            (10% of a normal day traded before the bell) is genuinely unusual.
    RTH  -> classic pace-adjusted RVOL. 1.0 = exactly normal for this time of day.
    """
    if not adv or adv <= 0 or session_volume is None:
        return None
    if session in ("PRE", "CLOSED"):
        return round(session_volume / adv, 3)
    if session == "POST":
        return round(session_volume / adv, 3)
    frac = expected_volume_fraction(et_minutes(dt) - RTH_OPEN)
    if frac <= 0.005:
        frac = 0.005                               # first seconds: don't divide by ~0
    return round(session_volume / (adv * frac), 2)


# ---- Bar aggregation -------------------------------------------------------
def bar_vwap(bars):
    """Volume-weighted average price over the given bars.

    Prefers Alpaca's own per-bar `vw`; falls back to the typical price. VWAP is
    the reference every intraday momentum trader actually uses — above it the
    name is in control, below it you are fighting the tape.
    """
    num = den = 0.0
    for b in bars:
        v = float(b.get("v") or 0)
        if v <= 0:
            continue
        px = b.get("vw")
        if px is None:
            px = (float(b.get("h", 0)) + float(b.get("l", 0)) + float(b.get("c", 0))) / 3.0
        num += float(px) * v
        den += v
    return round(num / den, 4) if den > 0 else None


def split_bars(bars):
    """Separate a day's bars into premarket and regular-hours.

    Bar timestamps are UTC ISO; convert once and bucket.
    """
    pre, rth, post = [], [], []
    for b in bars:
        t = b.get("t")
        if not t:
            continue
        try:
            dt = datetime.fromisoformat(t.replace("Z", "+00:00")).astimezone(ET)
        except Exception:
            continue
        m = dt.hour * 60 + dt.minute
        if PRE_OPEN <= m < RTH_OPEN:
            pre.append(b)
        elif RTH_OPEN <= m < RTH_CLOSE:
            rth.append(b)
        elif RTH_CLOSE <= m < POST_CLOSE:
            post.append(b)
    return pre, rth, post


def summarize(bars):
    """high / low / last / volume / vwap for a bucket of bars."""
    if not bars:
        return {"high": None, "low": None, "last": None, "volume": 0, "vwap": None, "bars": 0}
    highs = [float(b["h"]) for b in bars if b.get("h") is not None]
    lows = [float(b["l"]) for b in bars if b.get("l") is not None]
    vol = sum(float(b.get("v") or 0) for b in bars)
    return {
        "high": max(highs) if highs else None,
        "low": min(lows) if lows else None,
        "last": float(bars[-1].get("c")) if bars[-1].get("c") is not None else None,
        "volume": vol,
        "vwap": bar_vwap(bars),
        "bars": len(bars),
    }


def average_daily_volume(daily_bars, days=20):
    rows = [float(b.get("v") or 0) for b in daily_bars[-days:] if b.get("v")]
    return sum(rows) / len(rows) if rows else None


def atr(daily_bars, days=14):
    """Average true range — used for sanity-checking stop width, not for entry."""
    rows = daily_bars[-(days + 1):]
    if len(rows) < 2:
        return None
    trs = []
    for i in range(1, len(rows)):
        h, l = float(rows[i]["h"]), float(rows[i]["l"])
        pc = float(rows[i - 1]["c"])
        trs.append(max(h - l, abs(h - pc), abs(l - pc)))
    return round(sum(trs) / len(trs), 4) if trs else None


# ---- Scoring ---------------------------------------------------------------
# WHY A COMPOSITE AND NOT JUST GAP SIZE
# The old scanner ranked on one number, |gap|, inside a 1-2.5% band. That band is
# correct for what it was built for — a Gap-and-Go opening-range backtest on
# liquid names, where small gaps behave and large ones are exhaustion. It is the
# wrong instrument entirely for small-cap momentum, where the names you want gap
# 20-100% and the 1-2.5% band excludes every one of them by construction.
#
# What actually separates a runner from a fade is not gap size, it is whether
# volume showed up. So RVOL carries the most weight, gap is a qualifier, and the
# rest are the things that decide whether you can trade it and whether you should.
#
# HONESTY ABOUT THE WEIGHTS: these are desk judgement, not a fit. There is no
# backtest behind them because you have no labelled outcomes yet. That is exactly
# why every component is returned alongside the total — you can see which term
# ranked a name and disagree with it. Do not treat the composite as an edge; treat
# it as a sort order for your own eyes.

def _log_score(x, lo, hi):
    """Map x onto 0..1 logarithmically between lo and hi."""
    import math
    if x is None or x <= 0:
        return 0.0
    if x <= lo:
        return max(0.0, 0.2 * (x / lo))
    if x >= hi:
        return 1.0
    return 0.2 + 0.8 * (math.log(x / lo) / math.log(hi / lo))


def gap_score(gap_pct):
    """Gap as a QUALIFIER, not a ranking. Peaks in the band where a move is big
    enough to matter and small enough to still be tradeable.

    The decay above ~60% is not squeamishness. Those names get halted on
    volatility, are usually impossible to borrow, and the spread you cross on the
    way out is often larger than the edge — the same "you cannot pay for this
    move" arithmetic that routes thin option chains to shares in the main bot.
    """
    if gap_pct is None:
        return 0.0
    g = abs(gap_pct)
    if g < 2:
        return g / 2 * 0.3
    if g <= 40:
        return 0.3 + 0.7 * min((g - 2) / 18.0, 1.0)
    if g <= 60:
        return 1.0
    return max(0.35, 1.0 - (g - 60) / 120.0)


def score_row(r, session, weights=None):
    """Composite 0..1 plus its components. `r` is a metrics dict."""
    w = weights or {"rvol": 0.40, "gap": 0.20, "liquidity": 0.15,
                    "catalyst": 0.15, "extension": 0.10}
    rv = r.get("rvol")
    # Upper bounds are deliberately generous. Set too low they SATURATE — every
    # name in play scores 1.00 on volume and the composite stops discriminating
    # exactly when it matters most, on the busiest mornings. 20x normal pace and
    # 2x a full day's volume traded before the bell are both real, and both
    # should still have somewhere to go on the scale.
    if session == "RTH":
        rvol_s = _log_score(rv, 1.0, 20.0)          # pace-adjusted: 1.0 = normal
    else:
        rvol_s = _log_score(rv, 0.02, 2.00)         # share of an average full day

    liq_s = _log_score(r.get("dollarVolume"), 1e5, 5e7)
    gap_s = gap_score(r.get("gapPct"))

    # CATALYST IS SIGNED, NOT BINARY. The first version of this scored "has a
    # headline" = 1.0, which ranked a $25M registered direct offering as a
    # POSITIVE — the scanner was rewarding the single most reliable way a
    # premarket runner kills the people who chased it. Having news is not the
    # signal; having the right KIND of news is.
    flag = r.get("newsFlag") or ("NEUTRAL" if r.get("hasCatalyst") else "NONE")
    cat_s = {"BULLISH": 1.0, "NEUTRAL": 0.50, "NONE": 0.30, "DILUTION_RISK": 0.05}.get(flag, 0.5)

    # Extension: being above VWAP is the point; being 20% above it is the
    # problem. Same lesson as the options bot's anti-chase gate — the move you
    # can still capture shrinks exactly as the risk to your stop grows.
    ext = r.get("extensionVsVwapPct")
    if ext is None:
        ext_s = 0.5
    elif ext < 0:
        ext_s = 0.15                                 # below VWAP: not a long
    elif ext <= 5:
        ext_s = 1.0
    elif ext <= 15:
        ext_s = 1.0 - (ext - 5) / 20.0
    else:
        ext_s = max(0.1, 0.5 - (ext - 15) / 60.0)

    parts = {"rvol": rvol_s, "gap": gap_s, "liquidity": liq_s,
             "catalyst": cat_s, "extension": ext_s}
    total = sum(parts[k] * w[k] for k in w)
    return round(total, 4), {k: round(v, 3) for k, v in parts.items()}


# ---- Setup / trigger -------------------------------------------------------
# This returns a CHECKLIST WITH LEVELS, not a buy signal, and the distinction is
# deliberate. A scanner can tell you a name is in play and where the line is; it
# cannot see the tape, the halt, the offer sitting on the level, or the fact that
# the catalyst is a dilutive offering. Every field below is something you could
# verify yourself in five seconds — that is the point.
#
# The structure is the standard momentum long: reclaim/hold VWAP, break the
# premarket high, stop back under VWAP.

def setup_for(r, min_stop_pct=1.0, max_stop_pct=8.0, r_target=2.0):
    """VWAP decides WHETHER you are long; the base decides WHERE the stop goes.

    The first version used VWAP as both, and on the names this scanner exists to
    find that does not work. A small cap up 40% premarket has a session VWAP
    dragged far below the current price by the whole ramp, so a VWAP stop is
    routinely 8-15% wide — which is not a stop anyone honours, and it made almost
    every genuine candidate come back STOP_TOO_WIDE.

    What momentum traders actually use is the low of the consolidation being
    broken out of, with VWAP as the trend filter underneath. So: must be above
    VWAP to be long at all, but the stop goes at the tighter of (recent base low,
    VWAP), and the trade is only rejected when even the TIGHTEST sane stop is
    too far away.
    """
    last = r.get("last")
    vwap = r.get("vwap")
    ref_high = r.get("refHigh")
    if last is None or vwap is None or ref_high is None or last <= 0:
        return {"state": "NO_DATA", "reason": "missing price, VWAP or reference high"}

    above_vwap = last > vwap
    if not above_vwap:
        return {"state": "BELOW_VWAP",
                "reason": f"last {last:.2f} under VWAP {vwap:.2f} — no long here",
                "vwap": vwap, "refHigh": ref_high}

    entry = ref_high
    if entry <= vwap:
        entry = last                                 # already through the level

    # Candidate stops, tightest first. `recentLow` is the low of the last few
    # minutes — the base being broken. VWAP is the backstop below it.
    recent_low = r.get("recentLow")
    candidates = []
    if recent_low is not None and recent_low < entry:
        candidates.append(("base low", float(recent_low)))
    if vwap < entry:
        candidates.append(("VWAP", float(vwap)))
    if not candidates:
        return {"state": "NO_STRUCTURE", "reason": "no level below the break to stop against"}

    # Tightest stop that is still outside the noise; if none qualifies, take the
    # tightest available and let the min/max checks below label it honestly.
    usable = [(n, p) for n, p in candidates if (entry - p) / entry * 100 >= min_stop_pct]
    stop_name, stop = max(usable, key=lambda x: x[1]) if usable else max(candidates, key=lambda x: x[1])

    risk = entry - stop
    stop_pct = (risk / entry * 100) if entry > 0 else None

    if stop_pct is None or stop_pct <= 0:
        return {"state": "NO_STRUCTURE", "reason": "stop is not below the break level"}
    if stop_pct < min_stop_pct:
        return {"state": "TOO_TIGHT",
                "reason": f"stop only {stop_pct:.1f}% away — inside the noise",
                "entry": round(entry, 2), "stop": round(stop, 2),
                "stopPct": round(stop_pct, 2), "stopFrom": stop_name}
    if stop_pct > max_stop_pct:
        return {"state": "STOP_TOO_WIDE",
                "reason": f"tightest sane stop ({stop_name}) is {stop_pct:.1f}% below the break "
                          f"— wider than the {max_stop_pct:.0f}% cap, so size would be tiny",
                "entry": round(entry, 2), "stop": round(stop, 2),
                "stopPct": round(stop_pct, 2), "stopFrom": stop_name,
                "vwap": round(vwap, 2), "refHigh": round(ref_high, 2)}

    target = entry + r_target * risk
    dist = (last - ref_high) / ref_high * 100

    if last > ref_high * 1.03:
        state = "EXTENDED"
        reason = f"already {dist:.1f}% through {ref_high:.2f} — the break happened without you"
    elif last > ref_high:
        state = "TRIGGERED"
        reason = f"through {ref_high:.2f} and holding VWAP {vwap:.2f}"
    elif last > ref_high * 0.98:
        state = "COILED"
        reason = f"{abs(dist):.1f}% under {ref_high:.2f}, above VWAP — this is the one to watch"
    else:
        state = "BUILDING"
        reason = f"{abs(dist):.1f}% under {ref_high:.2f} — above VWAP but not near the level"

    return {
        "state": state, "reason": reason,
        "entry": round(entry, 2), "stop": round(stop, 2), "target": round(target, 2),
        "riskPerShare": round(risk, 3), "stopPct": round(stop_pct, 2),
        "stopFrom": stop_name,
        "rMultiple": r_target, "vwap": round(vwap, 2), "refHigh": round(ref_high, 2),
    }


# ---- Catalyst classification ----------------------------------------------
# For a small cap, WHICH kind of news it is matters more than whether there is
# news. An offering and an FDA approval both produce a headline and a gap; only
# one of them is a trade. These are crude keyword buckets, not NLP, and they are
# meant to make you look — not to decide for you.
DILUTION_WORDS = (
    "offering", "pricing of", "registered direct", "shelf", "atm ", "at-the-market",
    "warrant", "convertible", "dilut", "s-1", "s-3", "424b", "private placement",
    "reverse split", "public offering",
)
BULLISH_WORDS = (
    "fda", "approval", "clearance", "phase 3", "phase iii", "contract", "award",
    "acquisition", "acquire", "merger", "partnership", "beats", "raises guidance",
    "record revenue", "uplist", "patent", "buyback", "authorization",
)


def classify_headline(headline):
    h = (headline or "").lower()
    if any(k in h for k in DILUTION_WORDS):
        return "DILUTION_RISK"
    if any(k in h for k in BULLISH_WORDS):
        return "BULLISH"
    return "NEUTRAL"
