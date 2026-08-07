import "dotenv/config";
import express from "express";
import cors from "cors";
import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import * as alpaca from "./alpaca.js";
import * as scanner from "./scanner.js";
import * as news from "./news.js";
import { runBacktest, computeStats } from "./backtest.js";
import { optionOverlay } from "./options.js";
import * as vdTrades from "./voldesk_trades.js";
import * as flow from "./flow.js";
import * as autotrader from "./autotrader.js";
import * as discovery from "./discovery.js";
import * as housekeeping from "./housekeeping.js";
import * as observe from "./observe.js";
import * as diagnostics from "./diagnostics.js";
import * as history from "./history.js";
import { startKeepAlive, notePing, pingStatus } from "./keepalive.js";
import * as localMode from "./local_mode.js";
import * as reconcileMod from "./reconcile.js";
import { pythonPath } from "./pythonPath.js";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Cross-platform (Windows venv lives in Scripts\, not bin/) — see pythonPath.js
const PY = pythonPath();

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
      } catch (parseErr) {
        // A script can exit 0, print a complete document, and still fail here —
        // Python writes NaN/Infinity as bare literals that JSON.parse rejects.
        // Showing only the first 400 chars hid that completely: the head looked
        // like perfectly good JSON and the offending token was 900 chars in.
        // Name the actual reason, and show the tail as well as the head.
        const bare = /(^|[[,:\s])(NaN|-?Infinity)([,}\]\s]|$)/.exec(out);
        const detail = err ? `stderr: ${err.slice(0, 300)}`
          : bare ? `stdout contains bare \`${bare[2]}\` at char ${bare.index}, which is valid Python `
                   + `but NOT valid JSON — the script ran fine, the output just can't be parsed`
          : `JSON.parse: ${parseErr.message}\n  head: ${out.slice(0, 200)}\n  tail: ${out.slice(-200)}`;
        reject(new Error(`${script} failed (code ${code}): ${detail}`));
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

app.get("/api/health", (req, res) => {
  // The self-ping sets x-keepalive:1; anything else hitting this is external
  // (the GitHub Action, cron-job.org, or you in a browser) — and only EXTERNAL
  // traffic actually prevents Render's idle spin-down.
  const selfPing = req.get("x-keepalive") === "1";
  try { notePing({ external: !selfPing }); } catch {}
  res.json({
    ok: true, keys: alpaca.keysPresent(), feed: alpaca.config.FEED,
    keepAlive: pingStatus(),
  });
});

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

// ---- Live scanner --------------------------------------------------------
// Now session-aware (premarket / regular / post-market) and sourced from the
// whole tradable universe rather than a most-actives leaderboard. See
// server/scanner.js for why both of those were blocking small-cap scanning.
//
// The legacy gapMin/gapMax params still work: they were expressed as fractions
// (0.01 = 1%), so they are converted rather than reinterpreted. Old callers keep
// working, they just no longer get a mega-cap-only list.
app.get("/api/scan", async (req, res) => {
  try {
    const q = req.query;
    const legacyGapMin = q.gapMin != null ? parseFloat(q.gapMin) * 100 : null;
    const out = await scanner.scan({
      minPrice: q.minPrice != null ? parseFloat(q.minPrice) : 1,
      maxPrice: q.maxPrice != null ? parseFloat(q.maxPrice) : 20,
      minGapPct: q.minGapPct != null ? parseFloat(q.minGapPct)
        : (legacyGapMin != null ? legacyGapMin : 5),
      minDollarVolume: q.minDollarVolume != null ? parseFloat(q.minDollarVolume) : 250000,
      top: q.top != null ? parseInt(q.top, 10) : 40,
      withNews: q.news !== "0",
      universeMode: q.universe === "actives" ? "actives" : "all",
    });
    // `qualifies` is kept so the existing UI table keeps rendering; everything
    // that reaches this point has already passed the filters.
    out.rows = out.rows.map((r) => ({ ...r, qualifies: true, gapOpen: r.gapPct, gapNow: r.gapPct }));
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ---- News (free, Benzinga via Alpaca) -------------------------------------
app.get("/api/news", async (req, res) => {
  try {
    const symbols = String(req.query.symbols || "").split(",")
      .map((x) => x.trim().toUpperCase()).filter(Boolean);
    const hours = parseInt(req.query.hours, 10) || 24;
    if (!news.newsEnabled()) {
      return res.json({ enabled: false, items: [],
        note: "Alpaca keys not set — the news API needs the same credentials as market data." });
    }
    const items = await news.fetchNews({ symbols, hours, limit: 50 });
    res.json({ enabled: true, hours, symbols, count: items.length, items });
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

  const script = path.join(PROJECT_ROOT, "gex", "gex.py");
  const child = spawn(PY, [script, symbol, maxExp, maxDte]);
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
    // db_change requirement: an explicit requireDb in the body wins (the Vol Desk
    // tab's dropdown sends one), otherwise fall back to the configured setting.
    // It used to hardcode "1" when the body omitted it, so a manual re-scan
    // silently re-applied db_change as a hard filter even after the user had
    // turned discovery.requireDeltaBalance off — the toggle appeared not to work.
    const requireDb = typeof req.body.requireDb === "boolean"
      ? (req.body.requireDb ? "1" : "0")
      : (flow.loadConfig().discovery?.requireDeltaBalance === false ? "0" : "1");
    if (!tickers.length) return res.status(400).json({ error: "no tickers" });
    const dataDir = path.join(PROJECT_ROOT, "data", "voldesk");

    // Yahoo rate-limits hard. Each ticker costs ~6 requests, so 4 concurrent
    // workers with no pacing produced a burst that came back as
    // "YFRateLimitError: Too Many Requests" on most of the batch. Two workers
    // plus a small stagger keeps the request rate under Yahoo's threshold; the
    // scan takes longer but actually returns data.
    const conc = Math.max(1, parseInt(process.env.VOLDESK_CONCURRENCY || "2", 10));
    const staggerMs = Math.max(0, parseInt(process.env.VOLDESK_STAGGER_MS || "400", 10));
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const results = new Array(tickers.length);
    let idx = 0;
    async function worker(slot) {
      await sleep(slot * staggerMs);                      // don't all start at once
      while (idx < tickers.length) {
        const i = idx++;
        try { results[i] = await runPy("gex/voldesk.py", [tickers[i], dataDir, maxDte, requireDb]); }
        catch (e) { results[i] = { ticker: tickers[i], error: String(e.message || e) }; }
        if (idx < tickers.length) await sleep(staggerMs);
      }
    }
    await Promise.all(Array.from({ length: Math.min(conc, tickers.length) }, (_, k) => worker(k)));

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

// ---- Trade history --------------------------------------------------------
// Every executed trade on the account (not just the bot's), FIFO-matched into
// round trips with realized P&L, plus the still-open lots and the entries that
// never filled. See history.js for why the broker ledger is the spine.
app.get("/api/history", async (req, res) => {
  try {
    res.json(await history.tradeHistory({
      days: Math.min(3650, Math.max(1, parseInt(req.query.days) || 365)),
    }));
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
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

// ---- Reconcile with the broker (also runs automatically on boot) ----------
app.get("/api/reconcile", async (req, res) => {
  try { res.json(await reconcileMod.reconcile({ apply: req.query.dry !== "1" })); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// ---- Local mode status / manual ingest ------------------------------------
app.get("/api/local", (_req, res) => {
  try {
    res.json(process.env.LOCAL_MODE === "1"
      ? localMode.localStatus()
      : { enabled: false, note: "not running in local mode (started via npm start?)" });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
app.post("/api/local/rebuild", async (_req, res) => {
  try {
    if (process.env.LOCAL_MODE !== "1") return res.status(400).json({ error: "not in local mode" });
    res.json(await localMode.triggerRebuild());
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
app.post("/api/local/ingest", (_req, res) => {
  try {
    if (process.env.LOCAL_MODE !== "1") return res.status(400).json({ error: "not in local mode" });
    res.json(localMode.triggerIngest());
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

    // 2. delete the bulky uploads — the cache is all we need from here on.
    //
    // CRITICAL EXCEPTION: in LOCAL MODE this same folder is the scraper's working
    // directory, and flow_master.xlsx is its ACCUMULATED history that the master
    // builder appends to every day. Deleting it would silently destroy weeks of
    // captured flow. So locally we never delete — only a cloud upload (where the
    // workbook really is just a transport artifact) gets cleaned up.
    const isLocal = process.env.LOCAL_MODE === "1";
    const deleted = [];
    if (!keep && !isLocal) {
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
      ok: true, dir, localMode: isLocal,
      filesProcessed: before,
      filesDeleted: deleted,
      ...(isLocal ? { keptReason: "local mode — masters are the scraper's accumulated history, never deleted" } : {}),
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
  // LOCAL MODE: also run the scraper + auto-ingest in this process (npm start).
  if (process.env.LOCAL_MODE === "1") {
    try { localMode.startLocalMode(); } catch (e) { console.error("[local] failed:", e.message); }
    console.log(`\n  ▶  Open  http://localhost:${PORT}\n`);
  }
});
