# Running locally — one command, fully hands-off

Locally everything shares one filesystem, so the three-part cloud dance (scrape →
upload → ingest) collapses into a single process:

```
npm start
  ├── Express + built UI ................ http://localhost:3001
  ├── auto-trader loop .................. entries, exits, daily re-assessment
  └── local mode
        ├── scraper supervisor .......... flow/scraper_service.py as a child:
        │     scrapes 09:25–16:40 ET, restarts if it dies, and after the close
        │     builds masters → flow_cache.json in place
        └── cache watcher ............... sees flow_cache.json change →
              runs discovery → seeds the observe list automatically
```

**No uploading. No push token. No keep-alive** (nothing to keep awake).

## Where do my Alpaca keys go?

A file called **`.env`** in the project root (same folder as `package.json`).
`npm run setup` creates it from `.env.example`; open it in any text editor and fill:

```
ALPACA_API_KEY=PKXXXXXXXXXXXXXXXXXXXX
ALPACA_SECRET_KEY=your-secret-here
ALPACA_PAPER_BASE=https://paper-api.alpaca.markets
ALPACA_FEED=iex
```

`.env` is git-ignored, so your keys never leave the machine. The **Key** from
Alpaca goes in `ALPACA_API_KEY` (paper keys start with `PK`), the **Secret Key** in
`ALPACA_SECRET_KEY`. Restart `npm start` after editing. Verify at
<http://localhost:3001/api/health> — `"keys": true` means they loaded.

## First-time setup

```bash
npm install
npm run setup          # creates .venv, installs yfinance/openpyxl/playwright + Chromium
```

Then put your Alpaca **paper** keys in `.env` (setup copies `.env.example` for you):

```
ALPACA_API_KEY=PK...
ALPACA_SECRET_KEY=...
```

`npm run setup` is cross-platform and idempotent — re-run it any time.

## Daily use

```bash
npm start
```

Open <http://localhost:3001>. That's the whole routine. Leave the terminal open;
`Ctrl+C` stops the trader and the scraper together.

| Script | What it does |
|---|---|
| `npm start` | Build the UI, then run server + scraper + trader |
| `npm run start:fast` | Same, skipping the UI rebuild (quicker restarts) |
| `npm run start:noscraper` | Local, but don't launch the scraper |
| `npm run dev` | Hot-reload development (Vite on 5173, API on 3001) |
| `npm run server` | Plain server only — no scraper, no auto-ingest (cloud mode) |

## What happens across a day

| Time (ET) | Action |
|---|---|
| 09:25 | Scraper starts, opens the OptionStrat live feed |
| 09:30–16:00 | Trader runs: trigger checks, entries, exits every 60s. Discovery re-ranks every 30 min |
| every ~2 min | `[heartbeat HH:MM:SS] rows captured: live=N` so you can see it's alive |
| on each capture | `[live] +N rows (session N) \| NVDA, TSLA, …` — the tickers as they land |
| every 15 min | Scraper rebuilds masters + `flow_cache.json`; the watcher auto-ingests and reseeds the observe list |
| 16:40 | Scraper stops (it keeps running past the 16:00 close because OptionStrat keeps printing late flow, and those rows belong in tomorrow's book) and does the **end-of-day roll-up**: today's CSV rows are folded into `flow_master.xlsx`, the cache is rebuilt, and auto-ingest reseeds the observe list. Printed as a boxed `BUILD` block with before/after file sizes |
| you shut it down | Nothing runs. Any position you're in lives at Alpaca; the bot is simply blind until the next start |

The observe list re-vets itself once a day and drops names that decay. You add
nothing.

## Overnight downtime, and how the next start recovers

The server is off overnight, so **the bot cannot manage anything while it's down** —
no stop will fire between shutdown and your next `npm start`. That's the accepted
trade-off of self-hosting, and it's why the wake lock exists for the hours you *are*
running.

What it does do is **reconcile with Alpaca on every boot**, because the broker kept
living while we didn't. Alpaca is treated as the source of truth for *what we hold*;
the local store is the source of truth for *why* (levels, targets, flow context).
Four drift cases are handled:

| Situation | What happens |
|---|---|
| Store says OPEN, Alpaca still holds it | Kept. If the entry filled overnight at a different price, the real fill is written in (estimate → actual) |
| Store says OPEN, Alpaca holds nothing, entry had filled | Marked **CLOSED** — expired, assigned, or closed outside the bot. Stops the loop chasing a phantom |
| Entry order expired/canceled unfilled | Marked **CANCELED** — we're not actually in the trade |
| Entry order still working | Left alone; the loop picks up the fill |
| Alpaca holds something the store doesn't know | Flagged **UNTRACKED** in the log, *not* auto-adopted — nothing is managing its stop, and inventing entry levels for an unplanned position would be worse than telling you to look |

You'll see it in the console at startup:

```
[autotrader info] reconciled-with-broker {"summary":"4 open checked, 1 phantom closed, 3 entry resolved"}
```

Re-run any time at `/api/reconcile`, or `/api/reconcile?dry=1` to preview without
changing anything.

## Every restart re-reads the masters

You shut it down each evening, so each morning is a cold start. On **every boot**
local mode rebuilds `flow_cache.json` directly from `flow_master.xlsx` (plus
unusual/knows if present) and then ingests — so the observe list is repopulated
from your full accumulated history without waiting for the first scrape, and it
doesn't matter whether yesterday's cache is still around.

`flow_master.xlsx` is the durable record and is **never deleted locally**. (The
cloud upload path deletes uploads after parsing, since there the workbook is just a
transport file — that deletion is explicitly disabled in local mode.)

## The Flow tab in local mode

You don't *need* to upload anything — the scraper writes the workbooks itself, into
the folder the bot already reads. So the tab leads with status: scraper running /
idle, the workbooks on disk with sizes and timestamps, when the last auto-ingest
ran, and whether the wake lock is held. Buttons: **Re-read masters now**,
**Re-assess observe list**, **Why nothing found?**

**Import is still there** as a normal section, because flow can legitimately come
from somewhere else — another machine, an export, a manual pull. Imported files land
in the flow folder and are ingested immediately, and **nothing is deleted** in local
mode. One caveat: a file with the same name as an existing master *replaces* it, so
back up `flow_master.xlsx` first if you mean to merge rather than overwrite.

## Where things live

```
data/flow/            flow_YYYY-MM-DD.csv, flow_*_master.xlsx, flow_cache.json
data/flow/optionstrat_profile/   scraper's browser profile
data/voldesk/<TICKER>/   daily GEX snapshots (auto-pruned, 30 days)
data/observe_list.json   the watch list
data/voldesk_trades.json positions + history
data/autotrader_log.json last 500 actions
```

Nothing is ephemeral here — unlike the free cloud tier, your observe list and
history survive restarts. Housekeeping still prunes old snapshots daily.

## Flow sources

- **OptionStrat — ON.** The scraper feeds it locally, which is the whole point of
  running here: your residential IP is far less likely to be blocked than a
  datacenter one.
- **Unusual Whales — wired but OFF.** Set `UW_API_KEY` in `.env` and toggle it on
  in the Auto-trader tab if you ever subscribe (~$50/mo). It needs no browser.

## Tunables (env or `.env`)

```
SCRAPER_FEEDS=live        # or live,unusual,knows for the ranking boosts (more RAM)
# (headless is always on and not overridable — a visible window steals focus and
#  gets closed by accident, killing the feed)
MARKET_HOURS_ONLY=true    # false to scrape around the clock
BUILD_EVERY_MIN=15        # rebuild/ingest cadence
LOCAL_SCRAPER=off         # run local mode without the scraper
PORT=3001
```

## Troubleshooting

**Scraper won't start / "spawn failed"** — Playwright or Chromium missing. Re-run
`npm run setup`. To verify: `.venv/bin/python -m playwright install chromium`
(Windows: `.venv\Scripts\python -m playwright install chromium`).

**Scraper log shows `rows visible: 0`** — OptionStrat served a blank page to the
headless browser. It runs headless always (by design), so the levers are the
fingerprint hardening already in `flow/strata_flow.py`, plus:
delete `data/flow/optionstrat_profile/` to start with a clean browser profile, and
confirm the site loads normally in your own browser. From a residential IP this is
uncommon; it was mainly a datacenter problem.

**Python errors on Windows** — check `http://localhost:3001/api/diagnostics`. It
reports the resolved interpreter and whether the venv was found. Windows keeps its
venv Python in `.venv\Scripts\`, not `.venv/bin/`, which older versions of this
project got wrong.

**Nothing in the observe list** — click **"Why nothing found?"** on the Flow
upload tab. It walks the funnel (Alpaca → flow cache → yfinance → Yahoo reachable
→ Vol Desk scan) and names the failing stage. Note `0 qualified` on a given day is
normal; the list should still fill with PENDING names.

## Sleep — the one real downside, and what we do about it

**A sleeping machine cannot wake itself.** Once the OS suspends, our timers are
frozen and a stop-loss will not fire. There is no software trick around this from
inside the process, so we PREVENT sleep instead of trying to recover from it.

`npm start` automatically holds an OS wake lock for as long as it runs:

| Platform | Mechanism |
|---|---|
| Windows | `SetThreadExecutionState(ES_CONTINUOUS \| ES_SYSTEM_REQUIRED)` via PowerShell |
| macOS | `caffeinate -s` |
| Linux | `systemd-inhibit --what=sleep:idle` |

You'll see `[wakelock] holding — system sleep prevented via …` at startup, and it's
released cleanly on Ctrl+C. Check it any time at `/api/local`. Disable with
`WAKELOCK=off`.

**The display can still sleep** — we only block *system* sleep, so the screen going
dark is fine and expected.

**Closing the lid is still a suspend** on most setups, and the wake lock does not
override it. If you want lid-closed operation:

- **Windows:** Control Panel → Power Options → *Choose what closing the lid does*
  → set to **Do nothing** (on AC at minimum).
- **macOS:** lid-closed requires external power + display, or a tool like Amphetamine.
  Otherwise leave the lid open with the screen off.

**Belt and braces:** keep the laptop on AC, disable sleep in OS settings too, and
if the machine does suspend, the loop resumes on wake and re-evaluates every
position on its next tick (60s) — it just can't act during the gap.

**Windows can also wake on a schedule** (Task Scheduler → your task → Conditions →
*Wake the computer to run this task*) if you'd rather let it sleep overnight and
wake before the open. That's optional; the wake lock alone is simpler.
