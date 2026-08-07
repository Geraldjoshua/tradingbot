#!/usr/bin/env python3
"""Unit tests for the scanner maths. No network, no keys.

    python3 scanner/test_core.py
"""
import os, sys
from datetime import datetime, timedelta
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import core

P, F = 0, 0
def t(name, cond, extra=""):
    global P, F
    if cond: print(f"  ok   {name}"); P += 1
    else:    print(f"  FAIL {name}\n       {extra}"); F += 1

def at(h, m, weekday=2):
    d = datetime(2026, 8, 5, h, m, tzinfo=core.ET)   # a Wednesday
    return d

print("\nsession detection")
t("04:30 is premarket",           core.session_of(at(4, 30))  == "PRE")
t("09:29 is still premarket",     core.session_of(at(9, 29))  == "PRE")
t("09:30 is regular hours",       core.session_of(at(9, 30))  == "RTH")
t("15:59 is regular hours",       core.session_of(at(15, 59)) == "RTH")
t("16:00 is post-market",         core.session_of(at(16, 0))  == "POST")
t("19:59 is post-market",         core.session_of(at(19, 59)) == "POST")
t("20:00 is closed",              core.session_of(at(20, 0))  == "CLOSED")
t("03:00 is closed",              core.session_of(at(3, 0))   == "CLOSED")
t("Saturday is closed",           core.session_of(datetime(2026, 8, 8, 11, 0, tzinfo=core.ET)) == "CLOSED")

print("\nintraday volume curve (makes RVOL mean something at 09:45 vs 15:45)")
f = core.expected_volume_fraction
t("nothing has traded at the bell",      f(0) == 0.0)
t("~13% of the day is done by 10:00",    0.10 < f(30) < 0.16, f"got {f(30)}")
t("~half the day by 13:30",              0.50 < f(240) < 0.60, f"got {f(240)}")
t("full day at the close",               f(390) == 1.0)
t("monotonically increasing",            all(f(m) <= f(m+10) for m in range(0, 380, 10)))
t("clamps past the close",               f(999) == 1.0)

print("\nrelative volume")
t("premarket: 500k on a 5M ADV = 0.10",  core.relative_volume(500_000, 5_000_000, "PRE") == 0.1)
t("no ADV -> None, not a fake number",   core.relative_volume(500_000, None, "PRE") is None)
rv_early = core.relative_volume(650_000, 5_000_000, "RTH", at(10, 0))
rv_late  = core.relative_volume(650_000, 5_000_000, "RTH", at(15, 45))
t("same volume is EXTREME at 10:00",     rv_early > 0.9, f"got {rv_early}")
t("...and unremarkable at 15:45",        rv_late < 0.2, f"got {rv_late}")
t("...the whole point: early >> late",   rv_early > 5 * rv_late, f"{rv_early} vs {rv_late}")

print("\nVWAP + bar bucketing")
def bar(h, m, o, hi, lo, c, v):
    dt = datetime(2026, 8, 5, h, m, tzinfo=core.ET).astimezone(core.timezone.utc)
    return {"t": dt.strftime("%Y-%m-%dT%H:%M:%SZ"), "o": o, "h": hi, "l": lo, "c": c, "v": v}
bars = [bar(5, 0, 2.0, 2.2, 1.9, 2.1, 100_000),
        bar(8, 0, 2.1, 2.6, 2.05, 2.5, 400_000),
        bar(10, 0, 2.5, 3.0, 2.4, 2.9, 900_000),
        bar(17, 0, 2.9, 3.1, 2.8, 3.0, 50_000)]
pre, rth, post = core.split_bars(bars)
t("2 premarket bars bucketed",  len(pre) == 2, f"got {len(pre)}")
t("1 regular-hours bar",        len(rth) == 1, f"got {len(rth)}")
t("1 post-market bar",          len(post) == 1, f"got {len(post)}")
ps = core.summarize(pre)
t("premarket high is 2.6",      ps["high"] == 2.6, f"got {ps['high']}")
t("premarket volume is 500k",   ps["volume"] == 500_000)
t("premarket VWAP inside range", 1.9 < ps["vwap"] < 2.6, f"got {ps['vwap']}")
t("empty bucket is safe",       core.summarize([])["high"] is None)

print("\ngap scoring (the 1-2.5% band is gone on purpose)")
g = core.gap_score
t("a 1.5% gap barely registers",       g(1.5) < 0.25, f"got {g(1.5)}")
t("a 25% gap scores near the top",     g(25) > 0.85, f"got {g(25)}")
t("a 200% gap is DISCOUNTED, not top", g(200) < g(25), f"{g(200)} vs {g(25)}")
t("...but never zero — it is on the list", g(200) > 0.3)
t("direction-agnostic",                g(-25) == g(25))

print("\nsetup levels")
s = core.setup_for({"last": 5.20, "vwap": 5.00, "refHigh": 5.15})
t("through the level, holding VWAP -> TRIGGERED", s["state"] == "TRIGGERED", s)
t("stop is VWAP",                       s["stop"] == 5.00, s)
t("2R target from a 0.15 risk",         abs(s["target"] - 5.45) < 0.01, s)
s2 = core.setup_for({"last": 5.10, "vwap": 5.00, "refHigh": 5.15})
t("just under the level -> COILED",     s2["state"] == "COILED", s2)
s3 = core.setup_for({"last": 4.90, "vwap": 5.00, "refHigh": 5.15})
t("under VWAP -> no long at all",       s3["state"] == "BELOW_VWAP", s3)
s4 = core.setup_for({"last": 6.00, "vwap": 5.00, "refHigh": 5.15})
t("10% through the level -> EXTENDED",  s4["state"] == "EXTENDED", s4)
s5 = core.setup_for({"last": 5.20, "vwap": 4.20, "refHigh": 5.15})
t("VWAP 18% away -> STOP_TOO_WIDE",     s5["state"] == "STOP_TOO_WIDE", s5)
s6 = core.setup_for({"last": 5.20, "vwap": 5.145, "refHigh": 5.15})
t("stop inside the noise -> TOO_TIGHT", s6["state"] == "TOO_TIGHT", s6)
t("missing data is stated, not guessed", core.setup_for({"last": 5.0})["state"] == "NO_DATA")

print("\nheadline classification (the one that saves money)")
c = core.classify_headline
t("registered direct -> DILUTION_RISK", c("XYZ announces $12M registered direct offering") == "DILUTION_RISK")
t("424B5 -> DILUTION_RISK",             c("Prospectus filed under 424B5") == "DILUTION_RISK")
t("warrants -> DILUTION_RISK",          c("Company to issue warrants to investors") == "DILUTION_RISK")
t("reverse split -> DILUTION_RISK",     c("ABC announces 1-for-10 reverse split") == "DILUTION_RISK")
t("FDA clearance -> BULLISH",           c("ABC receives FDA clearance for device") == "BULLISH")
t("contract award -> BULLISH",          c("DEF awarded $40M Navy contract") == "BULLISH")
t("filler -> NEUTRAL",                  c("CEO to present at conference") == "NEUTRAL")

print("\ncomposite score")
strong = {"rvol": 0.35, "gapPct": 30, "dollarVolume": 8e6, "hasCatalyst": True,
          "extensionVsVwapPct": 3}
weak   = {"rvol": 0.01, "gapPct": 3,  "dollarVolume": 2e5, "hasCatalyst": False,
          "extensionVsVwapPct": 25}
sc_s, parts_s = core.score_row(strong, "PRE")
sc_w, _       = core.score_row(weak, "PRE")
t("a real runner outscores a dud",      sc_s > sc_w * 2, f"{sc_s} vs {sc_w}")
t("score is bounded 0..1",              0 <= sc_s <= 1 and 0 <= sc_w <= 1)
t("components are returned for audit",  set(parts_s) == {"rvol","gap","liquidity","catalyst","extension"})
chase = dict(strong); chase["extensionVsVwapPct"] = 30
t("chasing 30% above VWAP is penalised", core.score_row(chase, "PRE")[0] < sc_s)
nonews = dict(strong); nonews["hasCatalyst"] = False
t("no catalyst lowers the score",        core.score_row(nonews, "PRE")[0] < sc_s)

print("\nregressions found by the dry run")
d = core.setup_for({"last": 2.98, "vwap": 2.76, "refHigh": 3.02, "recentLow": 2.93})
t("a 40% gapper stops against the BASE, not VWAP", d.get("stopFrom") == "base low", d)
t("...which makes it tradeable instead of STOP_TOO_WIDE", d["state"] in ("COILED","TRIGGERED"), d)
w = core.setup_for({"last": 2.98, "vwap": 2.40, "refHigh": 3.02})
t("with no base low it falls back to VWAP", w.get("stopFrom") == "VWAP", w)
t("rejection states still carry stopPct for the renderer",
  "stopPct" in core.setup_for({"last": 5.2, "vwap": 4.2, "refHigh": 5.15}), "missing stopPct")

dilution = {"rvol": 0.9, "gapPct": 55, "dollarVolume": 4e7, "newsFlag": "DILUTION_RISK",
            "hasCatalyst": True, "extensionVsVwapPct": 6}
clean    = dict(dilution); clean["newsFlag"] = "BULLISH"
sc_d = core.score_row(dilution, "PRE")[0]; sc_c = core.score_row(clean, "PRE")[0]
t("an OFFERING scores far below the same setup on good news", sc_d < sc_c * 0.85,
  f"dilution {sc_d} vs bullish {sc_c}")
t("...and below a name with no news at all",
  sc_d < core.score_row({**dilution, "newsFlag": "NONE"}, "PRE")[0])

hot = [core.score_row({"rvol": v, "gapPct": 30, "dollarVolume": 2e7,
                       "newsFlag": "BULLISH", "extensionVsVwapPct": 4}, "PRE")[0]
       for v in (0.3, 0.8, 1.5)]
t("busy names do not all saturate at 1.00", len(set(hot)) == 3 and max(hot) <= 1.0, hot)

print(f"\n{P} passed, {F} failed\n")
sys.exit(1 if F else 0)
