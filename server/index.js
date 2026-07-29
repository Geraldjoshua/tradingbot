import "dotenv/config";
import express from "express";
import cors from "cors";
import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import * as alpaca from "./alpaca.js";
import { runBacktest, computeStats } from "./backtest.js";
import { optionOverlay } from "./options.js";
import * as vdTrades from "./voldesk_trades.js";
import * as flow from "./flow.js";
import * as autotrader from "./autotrader.js";
import { startKeepAlive } from "./keepalive.js";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PY = fs.existsSync(path.join(PROJECT_ROOT, ".venv/bin/python"))
  ? path.join(PROJECT_ROOT, ".venv/bin/python")
  : "python3";

// Run a python script, resolve parsed-JSON stdout (or reject with stderr).
function runPy(script, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(PY, [path.join(PROJECT_ROOT, script), ...args]);
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => reject(new Error(`spawn failed: ${e.message}`)));
    child.on("close", (code) => {
      try {
        resolve(JSON.parse(out));
      } catch {
        reject(new Error(`${script} failed (code ${code}): ${(err || out).slice(0, 400)}`));
      }
    });
  });
}

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;

app.get("/api/health", (_req, res) =>
  res.json({ ok: true, keys: alpaca.keysPresent(), feed: alpaca.config.FEED })
);

// ---- Backtest -------------------------------------------------------------
app.post("/api/backtest", async (req, res) => {
  try {
    const { symbols = [], start, end, timeframe = "15Min", params = {} } = req.body;
    if (!symbols.length) return res.status(400).json({ error: "no symbols" });

    const results = {};
    let pooledTrades = [];
    for (const sym of symbols) {
      const bars = await alpaca.getBars(sym, timeframe, start, end);
      const bt = runBacktest(bars, params);
      // daily bars (for realized-vol) come from resampling: use the same bars,
      // grabbing one close per session is enough — but a dedicated daily pull is cleaner.
      let option = null;
      if (params.optionMode) {
        const daily = await alpaca.getBars(sym, "1Day", start, end);
        option = optionOverlay(bt.trades, daily, {
          dte: params.dte,
          iv: params.iv,
          riskPremium: params.riskPremium,
        });
      }
      results[sym] = { bars, ...bt, option };
      pooledTrades = pooledTrades.concat(bt.trades);
    }
    // sort pooled trades by date so the pooled equity curve is chronological
    pooledTrades.sort((a, b) => (a.date < b.date ? -1 : 1));
    res.json({
      results,
      pooled: computeStats(pooledTrades, params.riskPerTrade || 100),
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ---- Live scanner (today's qualifying gappers) ----------------------------
app.get("/api/scan", async (req, res) => {
  try {
    const gapMin = parseFloat(req.query.gapMin) || 0.01;
    const gapMax = parseFloat(req.query.gapMax) || 0.025;
    const symbols = await alpaca.getMostActives(40);
    const snaps = await alpaca.getSnapshots(symbols);
    const rows = [];
    for (const sym of symbols) {
      const s = snaps[sym];
      if (!s || !s.prevDailyBar || !s.dailyBar) continue;
      const prevClose = s.prevDailyBar.c;
      const open = s.dailyBar.o;
      const last = s.latestTrade ? s.latestTrade.p : s.dailyBar.c;
      const gapOpen = (open - prevClose) / prevClose;
      const gapNow = (last - prevClose) / prevClose;
      rows.push({
        symbol: sym,
        prevClose,
        open,
        last,
        gapOpen: +(gapOpen * 100).toFixed(2),
        gapNow: +(gapNow * 100).toFixed(2),
        volume: s.dailyBar.v,
        qualifies:
          Math.abs(gapOpen) >= gapMin && Math.abs(gapOpen) <= gapMax,
        side: gapOpen > 0 ? "long" : "short",
      });
    }
    rows.sort((a, b) => Number(b.qualifies) - Number(a.qualifies) || Math.abs(b.gapOpen) - Math.abs(a.gapOpen));
    res.json({ rows });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ---- Options: pick a near-ATM contract for a symbol/direction -------------
app.get("/api/option-select", async (req, res) => {
  try {
    const symbol = String(req.query.symbol || "").toUpperCase();
    const side = req.query.side === "put" ? "put" : "call"; // gap-up->call, gap-down->put
    if (!symbol) return res.status(400).json({ error: "symbol required" });

    // delayed_sip avoids the "recent SIP data" block; a ~15-min-old spot is
    // perfectly fine for choosing an ATM strike.
    const spot = await alpaca.getLatestTrade(symbol, "delayed_sip");
    if (!spot) return res.status(404).json({ error: "no spot price" });

    // nearest expiry from today out to ~2 weeks
    const today = new Date();
    const twoWk = new Date(Date.now() + 14 * 864e5);
    const iso = (d) => d.toISOString().slice(0, 10);
    const band = spot * 0.06;
    const contracts = await alpaca.getOptionContracts({
      underlying: symbol,
      type: side,
      expGte: iso(today),
      expLte: iso(twoWk),
      strikeGte: spot - band,
      strikeLte: spot + band,
      limit: 200,
    });
    if (!contracts.length) return res.json({ spot, side, expiries: [], candidates: [] });

    // group by expiry, keep the nearest expiry
    const expiries = [...new Set(contracts.map((c) => c.expiration_date))].sort();
    const nearest = expiries[0];
    const forExp = contracts
      .filter((c) => c.expiration_date === nearest)
      .sort((a, b) => Math.abs(+a.strike_price - spot) - Math.abs(+b.strike_price - spot))
      .slice(0, 8);

    const quotes = await alpaca.getOptionQuotes(forExp.map((c) => c.symbol));
    const candidates = forExp
      .map((c) => {
        const q = quotes[c.symbol]?.latestQuote;
        return {
          symbol: c.symbol,
          strike: +c.strike_price,
          expiry: c.expiration_date,
          bid: q?.bp ?? null,
          ask: q?.ap ?? null,
          mid: q ? +(((q.bp + q.ap) / 2) || 0).toFixed(2) : null,
          distFromSpot: +(Math.abs(+c.strike_price - spot)).toFixed(2),
        };
      })
      .sort((a, b) => a.distFromSpot - b.distFromSpot);

    res.json({ spot: +spot.toFixed(2), side, expiries, nearest, candidates });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ---- Meb Faber timing model backtest (monthly, N-month SMA) ---------------
app.get("/api/faber", async (req, res) => {
  try {
    const symbol = String(req.query.symbol || "SPY").toUpperCase();
    const sma = String(parseInt(req.query.sma) || 10);
    const args = [symbol, sma];
    if (req.query.startYear) args.push(String(parseInt(req.query.startYear)));
    res.json(await runPy("models/faber.py", args));
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ---- GEX (dealer gamma exposure from free Yahoo chains via yfinance) -------
app.get("/api/gex", (req, res) => {
  const symbol = String(req.query.symbol || "").toUpperCase();
  if (!symbol) return res.status(400).json({ error: "symbol required" });
  const maxExp = String(parseInt(req.query.maxExpiries) || 4);
  const maxDte = String(parseInt(req.query.maxDte) || 45);

  const venvPy = path.join(PROJECT_ROOT, ".venv/bin/python");
  const py = fs.existsSync(venvPy) ? venvPy : "python3";
  const script = path.join(PROJECT_ROOT, "gex", "gex.py");

  const child = spawn(py, [script, symbol, maxExp, maxDte]);
  let out = "", errout = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (errout += d));
  child.on("error", (e) => res.status(500).json({ error: `spawn failed: ${e.message}` }));
  child.on("close", (code) => {
    try {
      res.json(JSON.parse(out));
    } catch {
      res.status(500).json({ error: `gex failed (code ${code}): ${(errout || out).slice(0, 400)}` });
    }
  });
});

// ---- Vol Desk forward-test scan (GEX levels + grade + tag per ticker) ------
app.post("/api/voldesk", async (req, res) => {
  try {
    const tickers = (req.body.tickers || []).map((t) => String(t).toUpperCase()).filter(Boolean);
    const maxDte = String(parseInt(req.body.maxDte) || 45);
    const requireDb = req.body.requireDb === false ? "0" : "1";
    if (!tickers.length) return res.status(400).json({ error: "no tickers" });
    const dataDir = path.join(PROJECT_ROOT, "data", "voldesk");

    // Scan up to 4 tickers at once (gentle on Yahoo) instead of one-at-a-time.
    const results = new Array(tickers.length);
    let idx = 0;
    async function worker() {
      while (idx < tickers.length) {
        const i = idx++;
        try { results[i] = await runPy("gex/voldesk.py", [tickers[i], dataDir, maxDte, requireDb]); }
        catch (e) { results[i] = { ticker: tickers[i], error: String(e.message || e) }; }
      }
    }
    await Promise.all(Array.from({ length: Math.min(4, tickers.length) }, worker));

    // Rank: CONFIRMED first, then PENDING, then BLOCKED/error — and WITHIN each
    // group by a setup-quality score so the strongest setups are at the very top.
    const order = { CONFIRMED: 0, PENDING: 1, BLOCKED: 2 };
    const fails = (r) => (r.error ? 99 : (r.filter_reasons?.length || 0)); // fewer blockers = closer to tradeable
    const qscore = (r) => r.error ? -1
      : (r.grade || 0) * 3
      + Math.min(r.rr || 0, 12)
      + ((r.db_change || 0) > 0 ? r.db_change * 5 : 0)
      + (r.minervini || 0)
      + Math.min(r.cushion_pct || 0, 15) / 3;
    results.sort((a, b) =>
      (order[a.tag] ?? 3) - (order[b.tag] ?? 3) ||   // CONFIRMED, then PENDING, then BLOCKED
      fails(a) - fails(b) ||                          // fewest failing filters first
      qscore(b) - qscore(a));                         // then best setup quality
    res.json({ results });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Snapshot history for one ticker (chronological) — for db_change / progress.
app.get("/api/voldesk/history", (req, res) => {
  try {
    const t = String(req.query.ticker || "").toUpperCase();
    const dir = path.join(PROJECT_ROOT, "data", "voldesk", t);
    if (!t || !fs.existsSync(dir)) return res.json({ ticker: t, snapshots: [] });
    const snaps = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f))));
    res.json({ ticker: t, snapshots: snaps });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ---- Vol Desk Phase 2: entry + position management ------------------------
app.post("/api/voldesk/enter", async (req, res) => {
  try {
    res.json(await vdTrades.enterTrade({
      ticker: req.body.ticker,
      riskPremium: req.body.riskPremium || 300,
      force: !!req.body.force,
      confirm: !!req.body.confirm,
      dteTarget: req.body.dteTarget || 45,
      moneyness: req.body.moneyness || "ITM",
    }));
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

app.get("/api/voldesk/positions", async (_req, res) => {
  try { res.json({ positions: await vdTrades.evaluatePositions() }); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

app.post("/api/voldesk/exit", async (req, res) => {
  try { res.json(await vdTrades.exitTrade({ id: req.body.id, reason: req.body.reason })); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

app.post("/api/voldesk/lock", (req, res) => {
  try { res.json(vdTrades.lockToBreakeven({ id: req.body.id })); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// ---- Flow conviction ------------------------------------------------------
// Blended OptionStrat + Unusual Whales verdict for a ticker, plus the long-trade
// decision (size multiplier / gate) under the current config.
app.get("/api/flow", async (req, res) => {
  try {
    const ticker = String(req.query.ticker || "").toUpperCase();
    if (!ticker) return res.status(400).json({ error: "ticker required" });
    const cfg = flow.loadConfig();
    const conviction = await flow.getConviction(ticker, cfg);
    const decision = flow.decideForTrade(conviction, cfg, req.query.side === "short" ? "short" : "long");
    res.json({ conviction, decision });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// ---- Auto-trader control --------------------------------------------------
app.get("/api/autotrader/status", (_req, res) => {
  try { res.json(autotrader.status()); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
app.post("/api/autotrader/start", (_req, res) => {
  try { res.json(autotrader.start()); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
app.post("/api/autotrader/stop", (_req, res) => {
  try { res.json(autotrader.stop()); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
app.get("/api/autotrader/config", (_req, res) => {
  try { res.json(flow.loadConfig()); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
// Merge a partial config (any subset of automation/flow/risk) — powers the toggles.
app.post("/api/autotrader/config", (req, res) => {
  try { res.json(flow.saveConfig(req.body || {})); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
app.post("/api/autotrader/watchlist", (req, res) => {
  try {
    const tickers = (req.body.tickers || []).map((t) => String(t).toUpperCase()).filter(Boolean);
    res.json(flow.saveConfig({ automation: { watchlist: tickers } }));
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// ---- Paper trading --------------------------------------------------------
app.get("/api/account", async (_req, res) => {
  try { res.json(await alpaca.getAccount()); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
app.get("/api/positions", async (_req, res) => {
  try { res.json(await alpaca.getPositions()); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
app.get("/api/orders", async (req, res) => {
  try { res.json(await alpaca.getOrders(req.query.status || "open")); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
app.post("/api/orders", async (req, res) => {
  try { res.json(await alpaca.placeOrder(req.body)); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
app.delete("/api/orders/:id", async (req, res) => {
  try { res.json(await alpaca.cancelOrder(req.params.id)); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
app.delete("/api/positions/:symbol", async (req, res) => {
  try { res.json(await alpaca.closePosition(req.params.symbol)); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// ---- Serve the built frontend (production / Render) -----------------------
// In dev, Vite serves the UI and proxies /api here. In production there's no
// Vite, so Express serves the built dist/ and falls back to index.html for the
// SPA. API routes above always win because this is registered last.
const DIST = path.join(PROJECT_ROOT, "dist");
if (fs.existsSync(DIST)) {
  app.use(express.static(DIST));
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api")) return next();
    res.sendFile(path.join(DIST, "index.html"));
  });
  console.log(`[gapgo] serving frontend from ${DIST}`);
}

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[gapgo] backend on http://0.0.0.0:${PORT}  (feed=${alpaca.config.FEED}, keys=${alpaca.keysPresent()})`);
  // Resume the auto-trader loop if it was left enabled in the config.
  try { autotrader.boot(); } catch (e) { console.error("[autotrader] boot failed:", e.message); }
  // Free-plan anti-idle self-ping (helper only; see keepalive.js).
  try { startKeepAlive(); } catch (e) { console.error("[keepalive] failed:", e.message); }
});
