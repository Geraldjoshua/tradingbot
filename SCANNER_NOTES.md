# Scanner — how the old one worked, why it couldn't do what you want, what replaced it

---

## 1. How today's scanner works

`GET /api/scan` in `server/index.js`, ~30 lines:

```
getMostActives(40)  →  getSnapshots  →  gap = (dailyBar.open − prevDailyBar.close) / prevClose
                                        qualifies = 1% ≤ |gap| ≤ 2.5%
```

That's it. No volume analysis, no VWAP, no news, no session logic. The 1–2.5% band
comes from `backtest.js` — the Gap-and-Go opening-range strategy, where the thesis is
that small gaps continue and large ones are exhaustion. **For that strategy on liquid
names, the band is correct.** It's just the wrong instrument for what you're asking.

### Why it can't scan premarket

`dailyBar.open` doesn't exist before 09:30 — there is no open yet. So premarket the gap
is either undefined or computed from yesterday's bar wearing today's date. It didn't
fail loudly; it returned nothing useful, which is worse.

### Why it can't find small caps — the deeper problem

`getMostActives` is a **raw-volume leaderboard**. It returns AAPL, TSLA, NVDA, SPY every
single day. A small cap cannot appear on a raw-volume leaderboard — *not appearing on one
is what makes it a small cap.*

No amount of tuning the gap band fixes this. You have to start from the whole market and
filter **down**, not take a leaderboard and filter **up**. That inversion is the actual fix.

---

## 2. What I built

### `scanner/momentum_scanner.py` — standalone, `main()`, continuous

```bash
python3 scanner/momentum_scanner.py --once
python3 scanner/momentum_scanner.py --interval 30 --min-gap 10 --risk-dollars 200
python3 scanner/test_core.py          # 60 tests, no API key needed
```

Stdlib only — no pip install, no pandas. Same reasoning as `gex/dataprovider.py`.

**Two-stage, so a 60-second loop is affordable:**

- *Stage 1* (every 10 min): sweep ~11,000 tradable equities via chunked snapshots, apply
  cheap filters (price, gap, dollar volume), keep ~120 names.
- *Stage 2* (every loop): extended-hours minute bars for the hot list only → VWAP,
  premarket high, RVOL, setup levels.

**It ranks on RVOL, not gap size.** Gap tells you something happened overnight; RVOL tells
you whether anyone actually turned up to trade it — which is what decides whether it runs
or fades in the first ten minutes. Weights: RVOL 0.40, gap 0.20, liquidity 0.15,
catalyst 0.15, extension 0.10.

**Sessions:** PRE 04:00–09:30, RTH 09:30–16:00, POST 16:00–20:00. Gap is measured from
**last trade vs prior close**, which is defined in every session.

### The feed decision, which matters more premarket than intraday

Your free plan gives two views of the same tape: real-time **IEX** (a low single-digit
share of consolidated volume) and 15-minute-delayed **consolidated SIP**.

Intraday that's cosmetic. Premarket it isn't — premarket volume *is* the signal, and IEX
sees a small, erratic slice of it, so ranking on IEX volume partly ranks by which venue
happened to print. So the scanner deliberately splits: **delayed consolidated for volume
and RVOL** (15 min stale is fine — the question is "is this name active"), **real-time IEX
for last price** (stale prices are dangerous; stale volume isn't).

### On "tell me to get in"

It gives you a **checklist with levels, not a signal** — and that's deliberate. A scanner
can't see the tape, the halt, the offer sitting on the level, or that the catalyst is a
dilutive offering. Every field is something you could verify yourself in five seconds.

- **COILED** — above VWAP, just under the reference high. The one to watch.
- **TRIGGERED** — through the level, holding VWAP.
- **EXTENDED** — >3% through. The break happened without you. (Same lesson as the options
  bot's anti-chase gate.)
- **BELOW_VWAP** — no long here.
- **STOP_TOO_WIDE** — nothing to stop against inside your cap.

### Three bugs the dry run caught

I ran the full pipeline against a synthetic tape before shipping it. It found:

1. **A dilution headline was *raising* the score.** Catalyst was scored as "has news" = 1.0,
   so a $25M registered direct offering ranked as a positive — the scanner was rewarding
   the most reliable way a premarket runner takes money off people who chased it. Catalyst
   is now signed: BULLISH 1.0, NEUTRAL 0.5, NONE 0.3, **DILUTION_RISK 0.05**.
2. **Scores saturated at 1.00.** Every name in play maxed out, so the composite stopped
   discriminating exactly on the busiest mornings. Upper bounds widened.
3. **VWAP as the stop didn't work on the target names.** A small cap up 40% premarket has
   VWAP dragged far below price by the whole ramp, so stops came out 8–15% wide and nearly
   every real candidate returned STOP_TOO_WIDE. Now VWAP is the *trend filter* and the
   **base low** (last ~20 minutes) is the stop — which is what momentum traders actually use.

---

## 3. News — you already had it, free

**Alpaca's News API is included on your existing plan.** Benzinga-sourced, ~130 articles/day,
history to 2015, 200 requests/minute on the free tier. Same keys as your market data. No
scraping, no second vendor, no ToS problem.

`server/news.js` + `GET /api/news?symbols=X,Y&hours=24`, and it's wired into both scanners.

### The part that matters more than the headline

For a small cap, *which kind* of news it is decides the trade. A 40% gap on an FDA
clearance and a 40% gap on a registered direct offering are **indistinguishable on a price
scanner and are opposite trades** — in the second, the company is selling stock into your
buying.

So headlines are bucketed on offering / pricing / 424B5 / shelf / warrant / convertible /
reverse-split language and flagged `!! DILUTION_RISK` in the output. These are keyword
buckets, not NLP — meant to make you *look*, not to decide for you. Plenty of dilution is
worded politely.

`NONE` on a big gap is also information: a gap with no catalyst usually isn't your trade.

### Also worth adding later (free)

**SEC EDGAR RSS.** For small caps the 8-K and 424B5 hit EDGAR before the Benzinga headline
does, and that's the filing that kills a runner. Free, no key, no rate limit worth worrying
about. It's the natural next addition.

---

## 4. What's still missing, honestly

- **Float.** Alpaca doesn't expose shares outstanding or float, and float rotation is the
  single metric this is missing. RVOL is the best free proxy. Real float data means a paid
  vendor.
- **Halt status.** Not in the free feed. A halted name will just look frozen.
- **The score weights are judgement, not a fit.** You have no labelled outcomes yet, so
  there's nothing to fit to. Every component is returned next to the total so you can
  disagree with it. Treat it as a sort order for your own eyes, not an edge.
- **Holidays aren't modelled** — on ~9 days a year it thinks the market is open. Same
  limitation as the options bot.

## 5. Keep these two systems apart

The Vol Desk bot is a multi-day swing thesis on dealer positioning. This is intraday
momentum on retail-driven small caps. Different edges, different holding periods,
different failure modes.

They should not share capital, a risk budget, or a daily loss limit — and the scanner
deliberately has no connection to the trading loop and places no orders. If you later want
it to, that should be a separate budget with its own circuit breaker, not an extension of
`risk.basePremium`.
