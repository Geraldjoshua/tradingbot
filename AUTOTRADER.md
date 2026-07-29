# Auto-trader + flow conviction — how it works

This adds two things to the Vol Desk engine:

1. **Full automation** — a background loop that *executes* trades: it auto-buys
   entries and auto-closes them (take-profit at T1, hard-stop on any Stop 1–4).
   No clicks.
2. **Flow conviction** — before every buy it asks "does the options flow agree
   with going long here?" using **OptionStrat** (your scraped master workbooks)
   and optionally **Unusual Whales** (live API). Flow either **sizes** the trade,
   **gates** it, or is **display-only** — your choice.

Everything is paper-only (Alpaca paper endpoint) and every behaviour is a toggle
in `server/autotrader.config.json` (or the **Auto-trader** tab).

> ⚠ The underlying edges are still unproven (see the main README). This automates
> a research playbook on paper — not a licence to size real capital.

---

## The loop (`server/autotrader.js`)

Every `pollSeconds` (default 60s) one `tick()` runs. Ticks never overlap.

```
tick()
 ├─ reload config (so UI toggles apply live)
 ├─ if automation.enabled == false → stop
 ├─ MANAGE  (always, both modes)
 │    evaluatePositions()  →  for each OPEN position:
 │      action EXIT   (Stop 1–4) → exitTrade()            [auto-stop]
 │      action T1_HIT           → exitTrade()             [auto take-profit]
 │                                 or lockToBreakeven()   [if t1Action = lock-and-ride]
 └─ ENTER  (mode "full" only, market hours only)
      for each watchlist ticker, subject to caps:
        skip if already open / in cooldown
        conviction = flow.getConviction(ticker)
        decision   = flow.decideForTrade(conviction, "long")
        enterTrade(confirm=true, flowDecision)   → buys, sized by the decision
```

`MANAGE` runs even in `exit-only` mode and even outside market hours (the exit
orders are marketable limits, which Alpaca accepts off-hours). `ENTER` only fires
in `full` mode, during 09:30–16:00 ET on weekdays, and respects the caps.

### Guardrails
- `automation.enabled` — the master kill switch (Start/Stop button).
- `mode` — `full` (enter + exit) or `exit-only` (manage only, never buys).
- `maxConcurrent` — don't exceed N open Vol Desk positions.
- `maxDailyEntries` — cap new buys per day (resets at midnight).
- `entryCooldownMin` — after touching a ticker (entered or rejected) don't
  re-try it for N minutes, so a standing reject isn't re-priced every poll.
- Already-open tickers are never doubled into.
- One tick at a time (`busy` flag); one immediate tick on Start.
- Every action is appended to `data/autotrader_log.json` (last 500), counters to
  `data/autotrader_state.json`.

---

## Flow conviction (`server/flow.js`)

`getConviction(ticker)` blends the enabled sources into one signed number in
`[-1, +1]` (+bullish / −bearish); `direction` is its sign and `combinedScore` its
magnitude.

| Source | File | On/off | Signal |
|---|---|---|---|
| OptionStrat | `flow/optionstrat_flow.py` | `flow.sources.optionstrat` | `bullish_premium − bearish_premium` from the master **Aggregate** sheet (falls back to today's day-CSV). Presence in the *unusual* / *knows* books adds a booster. |
| Unusual Whales | `server/unusualwhales.js` | `flow.sources.unusualwhales` (needs `UW_API_KEY`) | recent flow-alert premium, call-side = bullish, put-side = bearish. Off & silent unless a key is set. |

Blend = premium-weighted (per-source `sourceWeights`) average of each source's
signed score, capped to ±1.

### Turning conviction into a decision — `decideForTrade(conv, cfg, "long")`

Vol Desk always buys **calls**, so the trade is a *long*; flow "agrees" when it's
bullish (score ≥ `minScore`). The **effect mode** decides what that does:

| `flow.mode` | flow agrees (bullish) | flow disagrees (bearish) | no / weak flow |
|---|---|---|---|
| `size` *(default)* | full size ×`sizing.agree` (1.0) | tiny ×`sizing.disagree` (0.25) | reduced ×`sizing.neutral` (0.7) |
| `gate` | full size, trade allowed | **blocked** | **blocked** |
| `display` | full size | full size | full size |

The multiplier scales the **premium budget**: `effectiveBudget =
basePremium × multiplier`, and contracts = `floor(effectiveBudget / (premium×100))`
(min 1). So "against the flow" still lets you take a token position in `size`
mode, whereas `gate` refuses it outright.

This is exactly the behaviour you asked for: *agree → normal size, disagree →
very small (or block under a hard gate), and it's all switchable.*

---

## Where flow plugs into an entry (`server/voldesk_trades.js`)

`enterTrade()` now:
1. computes conviction + decision (or reuses one the loop passes in),
2. shows it in the **PREVIEW** (`flow`, `effectiveBudget`, `flowBlocked`),
3. on `confirm`, **blocks first** if the gate says so (`status: "FLOW_BLOCKED"`),
   then applies the old price-trigger check, then buys the flow-sized quantity,
4. stamps `flowAtEntry` onto the stored position for the record.

Manual entries from the Vol Desk tab get the same treatment; set `ignoreFlow`
to bypass it.

---

## Config reference (`server/autotrader.config.json`)

```jsonc
{
  "automation": {
    "enabled": false,          // master switch (Start/Stop)
    "mode": "full",            // "full" | "exit-only"
    "pollSeconds": 60,
    "strategies": { "voldesk": true, "gapgo": false },  // gapgo not wired yet
    "marketHoursOnly": true,
    "t1Action": "take-profit", // "take-profit" | "lock-and-ride"
    "maxConcurrent": 5,
    "maxDailyEntries": 3,
    "entryCooldownMin": 30,
    "watchlist": []            // tickers the loop may auto-enter
  },
  "flow": {
    "enabled": true,
    "mode": "size",            // "size" | "gate" | "display"
    "sources": { "optionstrat": true, "unusualwhales": false },
    "optionstratDir": "",      // where the master workbooks live ("" = project root / $OPTIONSTRAT_DIR)
    "sizing": { "agree": 1.0, "neutral": 0.7, "disagree": 0.25 },
    "minScore": 0.15,
    "boosts": { "unusual": 0.1, "knows": 0.15 },
    "sourceWeights": { "optionstrat": 1.0, "unusualwhales": 1.0 }
  },
  "risk": { "basePremium": 300 }
}
```

You never have to edit this by hand — the **Auto-trader** tab writes every field.

---

## API

| Method | Route | Purpose |
|---|---|---|
| GET | `/api/flow?ticker=TSLA` | conviction + long decision for a ticker |
| GET | `/api/autotrader/status` | running?, market open?, config, log, counters |
| POST | `/api/autotrader/start` / `/stop` | flip the loop (also sets `enabled`) |
| GET/POST | `/api/autotrader/config` | read / merge-patch the config |
| POST | `/api/autotrader/watchlist` | `{ tickers: [...] }` |

---

## Setup / running

1. Populate OptionStrat data: run your scraper (`strata_flow.py`) + the master
   builder so `flow_master.xlsx` (and unusual/knows) exist. Point
   `flow.optionstratDir` or `OPTIONSTRAT_DIR` at that folder if it isn't the
   project root.
2. `.venv/bin/pip install -r gex/requirements.txt` (now includes `openpyxl` so
   the reader can open the workbooks; without it, it falls back to day-CSVs).
3. (optional) put `UW_API_KEY=...` in `.env` and toggle Unusual Whales on.
4. `npm run dev`, open the **Auto-trader** tab, set a watchlist, pick your modes,
   press **START**.

## Safe first run
- Leave `mode` on **exit-only** first — the bot only *manages* positions you
  opened by hand, so you can watch the auto take-profit / auto-stop behave.
- Then switch to **full** with a 1-ticker watchlist, `flow.mode: "gate"`, and
  `maxDailyEntries: 1` to see a single gated entry before loosening.
