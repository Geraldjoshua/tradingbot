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
import * as discovery from "./discovery.js";
import * as housekeeping from "./housekeeping.js";
import * as observe from "./observe.js";
import * as diagnostics from "./diagnostics.js";
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
// Limit raised from the 100kb default: the scraper POSTs flow_cache.json to
// /api/flow-cache, which is a few hundred KB for a few thousand tickers (and
// grows with coverage). The global parser runs before any route-level one, so
// the limit has to be set here or large pushes 413 before reaching the route.
app.use(express.json({ limit: process.env.JSON_LIMIT || "32mb" }));

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

// ---- Diagnostics: why is discovery finding nothing? -----------------------
app.get("/api/diagnostics", async (req, res) => {
  try { res.json(await diagnostics.run({ probe: String(req.query.probe || "SPY").toUpperCase() })); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// ---- Discovery: what would flow surface right now? ------------------------
// Runs the full harvest -> filter -> Vol Desk validation pipeline on demand.
// Safe to call any time: it never places orders, it only scans and ranks.
app.get("/api/discovery", async (_req, res) => {
  try {
    const cfg = flow.loadConfig();
    const openTickers = new Set(vdTrades.listAll().filter((p) => p.status === "OPEN").map((p) => p.ticker));
    res.json(await discovery.discover(cfg, { openTickers, cooldown: {} }));
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// ---- Nightly flow upload (xlsx/csv from your Windows scraper) --------------
// You upload the masters + day-CSVs; we distill them into flow_cache.json and
// then DELETE the uploads. Nothing bulky is ever retained: the workbooks are a
// transport format, the cache is the only thing we keep (a few hundred KB).
//
// Raw-body upload (one file per request) instead of multipart so we don't add a
// dependency. The browser panel loops over your selected files.
function flowDir() {
  return flow.loadConfig().flow.optionstratDir || process.env.OPTIONSTRAT_DIR || PROJECT_ROOT;
}
const UPLOAD_OK = /^[\w.\-]+\.(xlsx|csv)$/i;

app.post("/api/flow-upload",
  express.raw({ type: "*/*", limit: process.env.UPLOAD_LIMIT || "128mb" }),
  (req, res) => {
    try {
      const name = String(req.query.filename || "");
      if (!UPLOAD_OK.test(name) || name.includes("..") || name.includes("/")) {
        return res.status(400).json({ error: "filename must be a plain *.xlsx or *.csv" });
      }
      if (!req.body || !req.body.length) return res.status(400).json({ error: "empty body" });
      const dir = flowDir();
      fs.mkdirSync(dir, { recursive: true });
      const dest = path.join(dir, name);
      fs.writeFileSync(dest, req.body);
      console.log(`[flow-upload] ${name} (${(req.body.length / 1048576).toFixed(2)} MB)`);
      res.json({ ok: true, filename: name, sizeMB: +(req.body.length / 1048576).toFixed(2) });
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

// Distill -> discover -> seed the observe list -> DELETE the source files.
app.post("/api/flow-ingest", async (req, res) => {
  try {
    const dir = flowDir();
    const keep = req.body?.keepFiles === true;   // debug escape hatch
    const before = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /\.(xlsx|csv)$/i.test(f)) : [];
    if (!before.length) return res.status(400).json({ error: `no .xlsx/.csv found in ${dir} — upload first` });

    // 1. masters/CSVs -> flow_cache.json (the expensive parse, done once)
    const built = await runPy("flow/build_flow_cache.py", [dir]).catch(() => null);

    let cacheInfo = null;
    const cachePath = path.join(dir, "flow_cache.json");
    if (fs.existsSync(cachePath)) {
      const blob = JSON.parse(fs.readFileSync(cachePath));
      cacheInfo = { tickers: Object.keys(blob.tickers || {}).length, generated: blob.generated || null };
    }

    // 2. delete the bulky uploads — the cache is all we need from here on
    const deleted = [];
    if (!keep) {
      for (const f of before) {
        try { fs.unlinkSync(path.join(dir, f)); deleted.push(f); } catch {}
      }
    }

    // 3. rank the book and seed the observe list
    const cfg = flow.loadConfig();
    const openTickers = new Set(vdTrades.listAll().filter((p) => p.status === "OPEN").map((p) => p.ticker));
    const disc = await discovery.discover(cfg, { openTickers, cooldown: {} });
    // Seed from `watch` (CONFIRMED + PENDING), not `qualified` (CONFIRMED only).
    // PENDING names are precisely the ones worth observing — they're close but
    // haven't reclaimed pTrans yet, so they may firm up tomorrow.
    const seeded = observe.seed(disc.watch || disc.qualified || [], cfg);

    res.json({
      ok: true, dir,
      filesProcessed: before, filesDeleted: deleted,
      cache: cacheInfo, buildOutput: built || null,
      discovery: {
        sources: disc.sources || [], considered: disc.considered ?? 0,
        scanned: disc.scanned ?? 0,
        qualified: (disc.qualified || []).length,
        watch: (disc.watch || []).length,
        tagCounts: disc.tagCounts || {},
        note: disc.note || null,
      },
      observe: seeded,
    });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// What's sitting in the flow dir right now (so you can see uploads landed).
app.get("/api/flow-upload", (_req, res) => {
  try {
    const dir = flowDir();
    if (!fs.existsSync(dir)) return res.json({ dir, files: [] });
    const files = fs.readdirSync(dir).filter((f) => /\.(xlsx|csv|json)$/i.test(f)).map((f) => {
      const st = fs.statSync(path.join(dir, f));
      return { name: f, sizeMB: +(st.size / 1048576).toFixed(2), modified: st.mtime.toISOString() };
    });
    res.json({ dir, files });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// ---- Observe list ---------------------------------------------------------
app.get("/api/observe", (_req, res) => {
  try { res.json({ all: observe.list(), active: observe.activeList(), ready: observe.readyTickers() }); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
app.post("/api/observe/assess", async (req, res) => {
  try { res.json(await observe.assessAll(flow.loadConfig(), { force: req.body?.force === true })); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
app.post("/api/observe/drop", (req, res) => {
  try { res.json(observe.drop(String(req.body?.ticker || "").toUpperCase(), req.body?.reason || "manual") || { error: "not found" }); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// ---- Flow-cache ingest (push from the scraper) -----------------------------
// Render disks attach to exactly ONE service, so a separate scraper worker can't
// write files this service reads. Instead the scraper PUSHES its distilled
// flow_cache.json here and we write it to OPTIONSTRAT_DIR. This also lets the
// scraper run anywhere (your box, a VPS, a Render worker) and keep the deployed
// bot fed automatically.
//
// Guarded by FLOW_PUSH_TOKEN. If that env var isn't set the route is disabled,
// so nobody can inject flow data into your bot by default.
app.post("/api/flow-cache", (req, res) => {
  try {
    const token = process.env.FLOW_PUSH_TOKEN;
    if (!token) return res.status(503).json({ error: "flow push disabled (FLOW_PUSH_TOKEN not set)" });
    const given = req.get("x-flow-token") || req.query.token;
    if (given !== token) return res.status(401).json({ error: "bad token" });

    const blob = req.body;
    if (!blob || typeof blob !== "object" || !blob.tickers || typeof blob.tickers !== "object") {
      return res.status(400).json({ error: "expected a flow_cache.json body with a .tickers object" });
    }
    const dir = flow.loadConfig().flow.optionstratDir || process.env.OPTIONSTRAT_DIR || PROJECT_ROOT;
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, "flow_cache.json");
    fs.writeFileSync(dest, JSON.stringify(blob));
    const n = Object.keys(blob.tickers).length;
    console.log(`[flow-cache] received ${n} tickers -> ${dest}`);
    res.json({ ok: true, tickers: n, generated: blob.generated || null, path: dest });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// What flow data does the server currently hold?
app.get("/api/flow-cache", (_req, res) => {
  try {
    const dir = flow.loadConfig().flow.optionstratDir || process.env.OPTIONSTRAT_DIR || PROJECT_ROOT;
    const p = path.join(dir, "flow_cache.json");
    if (!fs.existsSync(p)) return res.json({ present: false, dir });
    const st = fs.statSync(p);
    const blob = JSON.parse(fs.readFileSync(p));
    res.json({
      present: true, dir, sizeKB: +(st.size / 1024).toFixed(1),
      tickers: Object.keys(blob.tickers || {}).length,
      generated: blob.generated || null,
      ageMinutes: blob.generated ? Math.round((Date.now() - Date.parse(blob.generated)) / 60000) : null,
    });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// ---- Storage usage / manual sweep -----------------------------------------
app.get("/api/storage", (req, res) => {
  try {
    if (req.query.sweep === "1") return res.json(housekeeping.sweep(flow.loadConfig()));
    res.json({ usage: housekeeping.usage(), retention: housekeeping.RETENTION_DEFAULTS });
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
