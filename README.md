# Trading lab — backtest, GEX & paper trading

A local React + Node app for researching a few equity/vol strategies and forward-testing
them on an Alpaca **paper** account. Four tabs, each a self-contained tool:

- **Backtest (Faber)** — the Meb Faber monthly-SMA timing model (long/flat tactical asset
  allocation). Run any symbol with a chosen SMA length + start year; see the price/SMA line
  with buy/sell markers, an equity curve vs. buy-and-hold, the round-trip trades, and stats
  (CAGR, max drawdown, annualized vol, Sharpe, % time in market).
- **Paper trading** — the **Gap-and-Go Opening Range Breakout** strategy live on paper:
  view your account, run the scanner for today's 1–2.5% gappers, place/cancel bracket orders,
  and an **options ticket** (find near-ATM call/put contracts, buy to open).
- **GEX** — dealer gamma exposure from free Yahoo option chains (yfinance): gamma-flip level,
  call/put walls, regime, and a per-strike GEX chart. (Alpaca supplies no greeks/OI on this
  account, so OI+IV come from Yahoo and gamma is computed via Black-Scholes.)
- **Vol Desk** — a GEX-driven vol setup engine. Scan a basket of tickers; each is graded and
  tagged **CONFIRMED / PENDING / BLOCKED** against five entry filters, with GEX levels
  (gamma flip, put/call walls) and a delta-balance read. Daily snapshots persist per ticker
  so the setup can be tracked forward over time. Phase 2 adds one-click paper entry (sizes an
  ATM call to a premium budget) and position management against a Stop 1–4 / T1 framework.

## The strategies

**Faber timing model** — on monthly data: long the asset when the monthly close is above its
N-month SMA (default 10), move to cash when below. Decision at month-end, held through the next
month. Long/flat only.

**Gap-and-Go ORB** — each trading day, per symbol:
1. **Gap filter** — `gap = (today open − prior close) / prior close`. Only trade if `gapMin ≤ |gap| ≤ gapMax` (default 1%–2.5%).
2. **Direction** — gap up → long; gap down → short.
3. **Opening range** — the first 15-min bar (09:30–09:45 ET). Entry on break of that range.
4. **Stop** = other side of the range. **Target** = entry ± `rTarget × range` (default 2R).
5. **Time stop** — exit at 15:45 if neither hit. Sizing: 1R (a full stop-out) = `riskPerTrade` dollars.

**Vol Desk** — a raw-GEX *approximation* of a vol-desk playbook: the gamma-flip reclaim is the
long trigger, the put wall is the structural stop, the call wall / call-OI-weighted strike are
targets, and a call-vs-put gamma "delta balance" gates conviction. Grading uses 11 boolean
structural proxies — **not** any vendor's actual rules.

> ⚠ These edges are **unproven**. The ORB was validated on a tiny sample (~29 trades, one regime,
> no slippage). Vol Desk uses free-data approximations, not a real vendor feed. Use this to
> forward-test on paper, not to size up real capital. Small N lies.

## Setup

```bash
cd gapgo-backtest
npm install
cp .env.example .env      # then paste your Alpaca PAPER key + secret into .env

# GEX + Vol Desk tabs — Python + yfinance (one-time):
python3 -m venv .venv
.venv/bin/pip install -r gex/requirements.txt

npm run dev               # starts backend (:3001) + frontend (:5173)
```

The backend auto-detects `.venv/bin/python` for the Python scripts (falls back to `python3`).

Open http://localhost:5173.

- Backend proxies Alpaca so your keys never reach the browser.
- Data feed is set by `ALPACA_FEED` in `.env` (`sip` if you have a data subscription, else `iex`).
- Paper base is `paper-api.alpaca.markets` — this app never points at the live endpoint.

## Files

```
server/
  index.js           Express API (backtest, faber, scan, gex, voldesk, account, orders)
  alpaca.js          Alpaca REST client (data + paper trading)
  backtest.js        Gap-and-Go ORB strategy engine (powers the scanner)
  options.js         option-contract selection (near-ATM call/put lookup)
  voldesk_trades.js  Vol Desk paper entry + position management
gex/
  gex.py             dealer GEX from Yahoo chains (Black-Scholes gamma)
  voldesk.py         Vol Desk scan/grade engine + daily snapshot persistence
models/
  faber.py           Faber monthly-SMA timing backtest
src/
  App.tsx, components/  React UI (charts use lightweight-charts)
data/
  voldesk/             per-ticker daily snapshots (gitignored)
  voldesk_trades.json  open/closed paper positions (gitignored)
```
