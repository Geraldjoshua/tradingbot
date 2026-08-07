# Momentum scanner

Standalone. Does not touch the Vol Desk options bot, does not place orders.

```bash
python3 scanner/momentum_scanner.py --once            # one pass
python3 scanner/momentum_scanner.py                   # loop, 60s
python3 scanner/momentum_scanner.py --interval 30 --min-gap 10 --risk-dollars 200
python3 scanner/momentum_scanner.py --json-out data/scan.json --no-clear
python3 scanner/test_core.py                          # 60 tests, no keys needed
```

Needs `ALPACA_API_KEY` / `ALPACA_SECRET_KEY` in the environment or `.env` at the
project root. Stdlib only — no `pip install`.

## Sessions

| Session | ET window | What it ranks on |
|---|---|---|
| PRE | 04:00–09:30 | premarket volume as a share of average daily volume |
| RTH | 09:30–16:00 | pace-adjusted RVOL (1.0 = normal for the time of day) |
| POST | 16:00–20:00 | post-market volume vs ADV |
| CLOSED | — | `--force` to scan anyway |

## Key flags

| Flag | Default | Notes |
|---|---|---|
| `--min-price` / `--max-price` | 1 / 20 | the small-cap momentum band |
| `--min-gap` | 5 (%) | the old scanner's 1–2.5% band was for a different strategy |
| `--min-rvol` | 0 | try 0.05 premarket, 2.0 intraday |
| `--min-dollar-volume` | 250000 | liquidity to get back out |
| `--max-stop-pct` | 8 | widest stop you'll accept |
| `--risk-dollars` | 0 | prints a share count per name |
| `--refresh-min` | 10 | minutes between full-universe sweeps |

## Reading the output

`STATE` is a checklist, not a signal:

- **COILED** — above VWAP, just under the reference high. The one to watch.
- **TRIGGERED** — through the level and holding VWAP.
- **EXTENDED** — more than 3% through it. The break happened without you.
- **BELOW_VWAP** — no long here.
- **STOP_TOO_WIDE** — nothing to stop against inside `--max-stop-pct`.

`NEWS` is the column that saves money. `!! DILUTION_RISK` means a headline
matched offering / warrant / 424B5 / reverse-split language — the company may be
selling stock into your buying. `NONE` on a big gap usually isn't your trade.

## Honest limits

- **No float data.** Alpaca doesn't expose shares outstanding or float, and float
  rotation is the metric this is missing. RVOL is the best free proxy.
- **Premarket volume is 15 minutes delayed.** Free real-time is IEX only — a few
  percent of consolidated volume, and erratic. Delayed consolidated is a better
  ranking input than real-time 2%; prices come from the real-time feed instead.
- **The score weights are judgement, not a fit.** No labelled outcomes exist yet.
  Every component is returned next to the total so you can disagree with it.
- **The volume curve is the standard U-shape, eyeballed.** Fine for ranking names
  against each other at the same moment; not for "this is exactly 3.2x normal".
- **Holidays aren't modelled.** On ~9 days a year it thinks the market is open.
- **Keyword news buckets, not NLP.** Plenty of dilution is worded politely.
