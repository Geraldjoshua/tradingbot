#!/usr/bin/env python3
"""Small-cap momentum scanner — premarket, regular hours and post-market.

    python3 scanner/momentum_scanner.py                  # continuous, 60s
    python3 scanner/momentum_scanner.py --once           # one pass and exit
    python3 scanner/momentum_scanner.py --min-price 1 --max-price 20 --min-gap 5
    python3 scanner/momentum_scanner.py --json-out data/scan.json --interval 30

Needs ALPACA_API_KEY / ALPACA_SECRET_KEY in the environment or in .env at the
project root. Nothing else — stdlib only, no pip install.

HOW IT DIFFERS FROM THE EXISTING /api/scan
The old scanner asked Alpaca for its 40 most-active symbols and kept the ones
that gapped 1-2.5%. Both halves of that are wrong for this job:

  * "Most actives" is a raw-volume leaderboard, so it returns mega-caps every
    day. A small cap cannot appear on it by definition — that is what makes it a
    small cap. You have to start from the whole tradable universe and filter DOWN.
  * A 1-2.5% gap band is the Gap-and-Go ORB filter from backtest.js, and it is
    correct there. The names you are describing gap 20-100%; the band excludes
    every one of them.

So this starts from ~11,000 tradable US equities, and ranks on RELATIVE VOLUME
rather than gap size — because gap tells you something happened overnight, and
RVOL tells you whether anyone actually turned up to trade it, which is what
decides whether it runs or fades in the first ten minutes.

TWO-STAGE SCAN, so a 60-second loop is affordable:
  Stage 1 (every --refresh-min): sweep the full universe on snapshots, apply the
          cheap filters (price, gap, dollar volume), keep a hot list.
  Stage 2 (every loop): pull extended-hours minute bars for the hot list only and
          compute VWAP, premarket high, RVOL and the setup levels.

WHAT THIS IS NOT
It is not connected to the Vol Desk options bot and it does not place orders. The
GEX system is a multi-day swing thesis on dealer positioning; this is intraday
momentum on retail-driven small caps. They are different edges with different
holding periods and they should not share capital or a risk budget. Read the
output, decide yourself, size it separately.
"""

import argparse
import json
import os
import sys
import time
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import alpaca_client as ac
import core

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UNIVERSE_CACHE = os.path.join(ROOT, "data", "scanner_universe.json")


# ---- .env loading (no python-dotenv dependency) ----------------------------
def load_dotenv(path=None):
    path = path or os.path.join(ROOT, ".env")
    if not os.path.exists(path):
        return
    for line in open(path):
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


# ---- Universe --------------------------------------------------------------
def load_universe(max_age_hours=20, exclude_otc=True):
    """Tradable US equities, cached to disk for a day.

    Cached because it is ~11k rows that change slowly, and re-pulling it every
    60-second loop would be the single most expensive thing the scanner does for
    the least benefit.
    """
    try:
        blob = json.load(open(UNIVERSE_CACHE))
        age = (time.time() - blob.get("ts", 0)) / 3600
        if age < max_age_hours and blob.get("symbols"):
            return blob["symbols"]
    except Exception:
        pass

    rows = ac.assets()
    syms = []
    for a in rows:
        sym = a.get("symbol", "")
        # Skip warrants/units/rights (5-char suffixes) — they gap violently on
        # nothing, quote terribly, and are not what you mean by a runner.
        if not sym or not sym.isalpha() or len(sym) > 4:
            continue
        if exclude_otc and a.get("exchange") == "OTC":
            continue
        syms.append(sym)
    syms = sorted(set(syms))
    try:
        os.makedirs(os.path.dirname(UNIVERSE_CACHE), exist_ok=True)
        json.dump({"ts": time.time(), "symbols": syms}, open(UNIVERSE_CACHE, "w"))
    except Exception:
        pass
    return syms


# ---- Stage 1: cheap full-universe sweep ------------------------------------
def sweep(symbols, args, session):
    """Snapshot the whole universe and keep the plausible names.

    Uses only what a snapshot gives us — previous close, today's daily bar,
    latest trade — so it is one cheap pass over ~11k names rather than a bar
    fetch per symbol.
    """
    snaps = ac.snapshots(symbols)
    hot = []
    for sym, s in snaps.items():
        if not s:
            continue
        prev = s.get("prevDailyBar") or {}
        day = s.get("dailyBar") or {}
        trade = s.get("latestTrade") or {}
        prev_close = prev.get("c")
        last = trade.get("p") or day.get("c")
        if not prev_close or not last or prev_close <= 0:
            continue

        # Premarket, `dailyBar` is either absent or still yesterday's — which is
        # precisely why the old open-based gap could not work before 09:30. Gap
        # from LAST TRADE against the prior close is defined in every session.
        gap_pct = (last - prev_close) / prev_close * 100.0
        if not (args.min_price <= last <= args.max_price):
            continue
        if abs(gap_pct) < args.min_gap:
            continue

        vol = float(day.get("v") or 0)
        dollar_vol = vol * last
        hot.append({
            "symbol": sym, "last": float(last), "prevClose": float(prev_close),
            "gapPct": round(gap_pct, 2), "sessionVolume": vol,
            "dollarVolume": dollar_vol,
        })

    hot.sort(key=lambda r: (-abs(r["gapPct"]), -r["dollarVolume"]))
    return hot[:args.hot_list]


# ---- Stage 2: detail pass on the hot list ----------------------------------
def enrich(hot, args, session, now_et):
    if not hot:
        return []
    syms = [r["symbol"] for r in hot]

    start = core.session_start_iso(now_et, session)
    intraday = ac.bars_multi(syms, "1Min", start)

    daily_start = (now_et - timedelta(days=60)).strftime("%Y-%m-%d")
    daily = ac.bars_multi(syms, "1Day", daily_start)

    out = []
    for r in hot:
        sym = r["symbol"]
        bars = intraday.get(sym) or []
        pre, rth, post = core.split_bars(bars)

        dbars = daily.get(sym) or []
        adv = core.average_daily_volume(dbars, 20)
        r["adv20"] = int(adv) if adv else None
        r["atr14"] = core.atr(dbars, 14)

        pre_s = core.summarize(pre)
        rth_s = core.summarize(rth)
        post_s = core.summarize(post)
        r["premarketHigh"] = pre_s["high"]
        r["premarketVolume"] = pre_s["volume"]

        if session == "PRE":
            live = pre_s
            # Premarket VWAP over premarket prints only — the level premarket
            # traders are actually watching.
            r["vwap"] = pre_s["vwap"]
            r["refHigh"] = pre_s["high"]
            sess_vol = pre_s["volume"]
        elif session == "RTH":
            live = rth_s
            r["vwap"] = core.bar_vwap(rth)
            # The premarket high stays the reference into the open. It is the
            # level the whole first hour trades against; throwing it away at
            # 09:30 discards the structure the setup is built on.
            highs = [h for h in (pre_s["high"], rth_s["high"]) if h is not None]
            r["refHigh"] = max(highs) if highs else None
            sess_vol = rth_s["volume"]
        else:
            live = post_s if post_s["bars"] else rth_s
            r["vwap"] = core.bar_vwap(rth + post)
            highs = [h for h in (pre_s["high"], rth_s["high"], post_s["high"]) if h is not None]
            r["refHigh"] = max(highs) if highs else None
            sess_vol = rth_s["volume"] + post_s["volume"]

        if live.get("last"):
            r["last"] = live["last"]
            r["gapPct"] = round((r["last"] - r["prevClose"]) / r["prevClose"] * 100, 2)
        r["sessionVolume"] = sess_vol
        r["dollarVolume"] = sess_vol * (r.get("last") or 0)
        r["rvol"] = core.relative_volume(sess_vol, adv, session, now_et)

        # The base being broken out of: the low of the last ~20 minutes of
        # prints. This is the stop a momentum trader actually uses; session VWAP
        # on a name up 40% premarket is far too far away to be one.
        recent = (pre + rth + post)[-20:]
        rl = core.summarize(recent).get("low")
        r["recentLow"] = rl

        vw = r.get("vwap")
        r["extensionVsVwapPct"] = (
            round((r["last"] - vw) / vw * 100, 2) if vw and r.get("last") else None)

        if r["dollarVolume"] < args.min_dollar_volume:
            continue
        if args.min_rvol and (r["rvol"] is None or r["rvol"] < args.min_rvol):
            continue
        out.append(r)
    return out


# ---- News ------------------------------------------------------------------
def attach_news(rows, args, hours=24):
    """Headlines from Alpaca's free news feed (Benzinga), one batched call.

    WHY THE CLASSIFICATION MATTERS MORE THAN THE HEADLINE
    On a small cap the *kind* of news decides the trade. A 40% gap on an FDA
    clearance and a 40% gap on a registered direct offering look identical on a
    scanner and are opposite trades: the second one is the company selling stock
    into your buying, and it is the single most common way a premarket runner
    kills people who chased it. So headlines are bucketed, and DILUTION_RISK is
    surfaced loudly rather than being one line in a list you scroll past.
    """
    if args.no_news or not rows:
        return rows
    syms = [r["symbol"] for r in rows[:args.top]]
    start = (datetime.now(timezone.utc) - timedelta(hours=hours)).strftime("%Y-%m-%dT%H:%M:%SZ")
    items = ac.news(symbols=syms, start=start, limit=50)

    by_sym = {}
    for n in items:
        headline = n.get("headline") or n.get("title") or ""
        for s in (n.get("symbols") or []):
            if s in syms:
                by_sym.setdefault(s, []).append({
                    "headline": headline,
                    "at": n.get("created_at") or n.get("updated_at"),
                    "source": n.get("source") or "benzinga",
                    "url": n.get("url"),
                    "kind": core.classify_headline(headline),
                })
    for r in rows:
        items_for = by_sym.get(r["symbol"], [])[:3]
        r["news"] = items_for
        r["hasCatalyst"] = bool(items_for)
        r["newsFlag"] = ("DILUTION_RISK" if any(i["kind"] == "DILUTION_RISK" for i in items_for)
                         else "BULLISH" if any(i["kind"] == "BULLISH" for i in items_for)
                         else "NEUTRAL" if items_for else "NONE")
    return rows


# ---- Rendering -------------------------------------------------------------
def render(rows, session, now_et, args):
    stamp = now_et.strftime("%Y-%m-%d %H:%M:%S ET")
    print("\033[2J\033[H" if not args.no_clear else "", end="")
    print(f"  MOMENTUM SCANNER   {stamp}   session={session}   candidates={len(rows)}")
    print(f"  filters: ${args.min_price:g}-${args.max_price:g}  gap>={args.min_gap:g}%  "
          f"rvol>={args.min_rvol or 0:g}  $vol>=${args.min_dollar_volume:,.0f}")
    print("  " + "-" * 122)
    print(f"  {'SYM':<6}{'LAST':>8}{'GAP%':>8}{'RVOL':>7}{'$VOL':>10}"
          f"{'VWAP':>9}{'vsVWAP':>8}{'REF HI':>9}  {'STATE':<14}{'NEWS':<16}{'SCORE':>6}")
    print("  " + "-" * 122)
    if not rows:
        print("  nothing passed the filters this pass.")
    for r in rows[:args.top]:
        s = r.get("setup", {})
        dv = r.get("dollarVolume") or 0
        dv_s = f"{dv/1e6:.1f}M" if dv >= 1e6 else f"{dv/1e3:.0f}K"
        flag = r.get("newsFlag", "NONE")
        mark = "!!" if flag == "DILUTION_RISK" else "  "
        print(f"  {r['symbol']:<6}{r.get('last') or 0:>8.2f}{r.get('gapPct') or 0:>8.1f}"
              f"{(r.get('rvol') or 0):>7.2f}{dv_s:>10}"
              f"{(r.get('vwap') or 0):>9.2f}{(r.get('extensionVsVwapPct') or 0):>8.1f}"
              f"{(r.get('refHigh') or 0):>9.2f}  {s.get('state','-'):<14}{mark}{flag:<14}"
              f"{r.get('score') or 0:>6.2f}")
    print("  " + "-" * 122)

    for r in rows[:min(args.detail, len(rows))]:
        s = r.get("setup", {})
        print(f"\n  {r['symbol']}  — {s.get('state','?')}: {s.get('reason','')}")
        if s.get("entry") and s.get("target"):
            print(f"      entry {s['entry']}   stop {s['stop']} ({s.get('stopPct','?')}% "
                  f"via {s.get('stopFrom','?')})   target {s['target']} ({s['rMultiple']}R)   "
                  f"risk/share ${s['riskPerShare']}")
            if args.risk_dollars and s.get("riskPerShare", 0) > 0:
                sh = int(args.risk_dollars / s["riskPerShare"])
                print(f"      ${args.risk_dollars:g} risk = {sh} shares "
                      f"(${sh * s['entry']:,.0f} notional)")
        elif s.get("entry"):
            print(f"      would-be entry {s['entry']}, stop {s['stop']} "
                  f"({s.get('stopPct','?')}% via {s.get('stopFrom','?')}) — not tradeable as shown")
        for n in r.get("news", []):
            tag = "!! " if n["kind"] == "DILUTION_RISK" else "   "
            print(f"    {tag}[{n['kind']}] {n['headline'][:96]}")
        if r.get("newsFlag") == "NONE":
            print("       no headline in 24h — a gap with no catalyst is usually not yours")
    print()


# ---- One pass --------------------------------------------------------------
_universe_cache = {"syms": None, "hot": [], "swept_at": 0}


def scan_once(args):
    now_et = core.et_now()
    session = core.session_of(now_et)
    if session == "CLOSED" and not args.force:
        return {"session": session, "rows": [], "note": "market closed — use --force to scan anyway"}

    if _universe_cache["syms"] is None:
        _universe_cache["syms"] = load_universe()

    stale = (time.time() - _universe_cache["swept_at"]) > args.refresh_min * 60
    if stale or not _universe_cache["hot"]:
        _universe_cache["hot"] = sweep(_universe_cache["syms"], args, session)
        _universe_cache["swept_at"] = time.time()

    rows = enrich(list(_universe_cache["hot"]), args, session, now_et)
    rows = attach_news(rows, args)

    for r in rows:
        r["setup"] = core.setup_for(r, r_target=args.r_target,
                                    min_stop_pct=args.min_stop_pct,
                                    max_stop_pct=args.max_stop_pct)
        total, parts = core.score_row(r, session)
        r["score"], r["scoreParts"] = total, parts

    rows.sort(key=lambda r: -r["score"])
    return {"session": session, "asof": now_et.isoformat(),
            "universe": len(_universe_cache["syms"] or []),
            "hotList": len(_universe_cache["hot"]), "rows": rows}


# ---- main ------------------------------------------------------------------
def build_parser():
    p = argparse.ArgumentParser(
        description="Small-cap momentum scanner (premarket / RTH / post-market)")
    p.add_argument("--once", action="store_true", help="single pass, then exit")
    p.add_argument("--interval", type=int, default=60, help="seconds between passes")
    p.add_argument("--refresh-min", type=int, default=10,
                   help="minutes between full-universe sweeps")
    p.add_argument("--min-price", type=float, default=1.0)
    p.add_argument("--max-price", type=float, default=20.0)
    p.add_argument("--min-gap", type=float, default=5.0, help="percent")
    p.add_argument("--min-rvol", type=float, default=0.0)
    p.add_argument("--min-dollar-volume", type=float, default=250000)
    p.add_argument("--hot-list", type=int, default=120, help="names kept from the sweep")
    p.add_argument("--top", type=int, default=20, help="rows printed")
    p.add_argument("--detail", type=int, default=5, help="rows with levels + headlines")
    p.add_argument("--r-target", type=float, default=2.0)
    p.add_argument("--max-stop-pct", type=float, default=8.0,
                   help="widest stop you will accept, percent of entry")
    p.add_argument("--min-stop-pct", type=float, default=1.0,
                   help="tighter than this is inside the noise")
    p.add_argument("--risk-dollars", type=float, default=0,
                   help="if set, prints a share count for that risk")
    p.add_argument("--json-out", default="", help="write each pass to this file")
    p.add_argument("--no-news", action="store_true")
    p.add_argument("--no-clear", action="store_true", help="don't clear the screen")
    p.add_argument("--force", action="store_true", help="scan even when closed")
    return p


def main(argv=None):
    args = build_parser().parse_args(argv)
    load_dotenv()
    if not ac.keys_present():
        print("ERROR: ALPACA_API_KEY / ALPACA_SECRET_KEY not set (env or .env).",
              file=sys.stderr)
        return 2

    print(f"scanner starting — {'single pass' if args.once else f'loop every {args.interval}s'}"
          f"   Ctrl-C to stop")
    while True:
        t0 = time.time()
        try:
            res = scan_once(args)
            render(res["rows"], res["session"], core.et_now(), args)
            if res.get("note"):
                print(f"  {res['note']}")
            if args.json_out:
                os.makedirs(os.path.dirname(os.path.abspath(args.json_out)), exist_ok=True)
                json.dump(res, open(args.json_out, "w"), indent=2, default=str)
        except KeyboardInterrupt:
            print("\nstopped.")
            return 0
        except Exception as e:
            # Never die on one bad pass. A scanner that exits at 09:31 because a
            # single request timed out is worse than one that prints the error
            # and tries again in a minute.
            print(f"  [pass failed] {type(e).__name__}: {e}", file=sys.stderr)

        if args.once:
            return 0
        time.sleep(max(1.0, args.interval - (time.time() - t0)))


if __name__ == "__main__":
    sys.exit(main())
