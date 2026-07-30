// Pipeline diagnostics — "why did discovery find nothing?"
//
// Discovery is a funnel with several stages, each of which can silently drop
// everything. When the result is "12 considered, 0 qualified" the useful question
// isn't *whether* it failed but *where*. This walks the funnel in order and
// reports the first stage that breaks, with the real error attached.
//
// The stage most likely to fail on a cloud host is YAHOO. Both market-cap
// normalization (flow/marketcap.py) and every Vol Desk GEX scan (gex/voldesk.py)
// call yfinance, and Yahoo rate-limits/blocks datacenter IPs far more
// aggressively than home connections. If Yahoo is unreachable from your dyno,
// discovery will return 0 forever and no amount of waiting fixes it.
//
// GET /api/diagnostics

import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import * as alpaca from "./alpaca.js";
import * as flow from "./flow.js";
import * as discovery from "./discovery.js";
import * as observe from "./observe.js";
import { pythonPath } from "./pythonPath.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Cross-platform (Windows venv lives in Scripts\, not bin/) — see pythonPath.js
const PY = pythonPath();

function runPy(args, timeoutMs = 60000) {
  return new Promise((resolve) => {
    const child = spawn(PY, args);
    let out = "", err = "";
    const t = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => { clearTimeout(t); resolve({ ok: false, error: e.message }); });
    child.on("close", (code) => {
      clearTimeout(t);
      resolve({ ok: code === 0, code, stdout: out.slice(0, 800), stderr: err.slice(0, 800) });
    });
  });
}

const step = (name, ok, detail, hint) => ({ name, ok, detail, ...(hint && !ok ? { hint } : {}) });

export async function run({ probe = "SPY" } = {}) {
  const cfg = flow.loadConfig();
  const steps = [];

  // 1. Alpaca credentials + reachability
  try {
    const acct = await alpaca.getAccount();
    steps.push(step("alpaca", true,
      `account ${acct.status}, buying power $${Math.round(parseFloat(acct.buying_power) || 0).toLocaleString()}`));
  } catch (e) {
    steps.push(step("alpaca", false, String(e.message || e),
      "Check ALPACA_API_KEY / ALPACA_SECRET_KEY env vars on the service."));
  }

  // 2. Flow cache — is there anything to discover FROM?
  const cs = flow.cacheStatus(cfg);
  steps.push(step("flow-cache", cs.present,
    cs.present ? `${cs.ageHours}h old${cs.stale ? " (STALE)" : ""}` : cs.note,
    "Upload flow on the Flow upload tab (or push flow_cache.json)."));

  let cacheTickers = 0;
  if (cs.present) {
    try {
      const dir = cfg.flow.optionstratDir || process.env.OPTIONSTRAT_DIR || ROOT;
      const blob = JSON.parse(fs.readFileSync(path.join(dir, "flow_cache.json")));
      cacheTickers = Object.keys(blob.tickers || {}).length;
      steps.push(step("flow-cache-contents", cacheTickers > 0, `${cacheTickers} tickers`,
        "The cache parsed but is empty — check the Aggregate sheet in your master workbook."));
    } catch (e) {
      steps.push(step("flow-cache-contents", false, String(e.message || e)));
    }
  }

  // 3. yfinance importable at all?
  const yf = await runPy(["-c", "import yfinance,sys; print(yfinance.__version__)"], 30000);
  steps.push(step("yfinance-installed", yf.ok, yf.ok ? `v${(yf.stdout || "").trim()}` : (yf.stderr || yf.error || "import failed"),
    "Rebuild the image — gex/requirements.txt should install yfinance."));

  // 4. Can we actually REACH Yahoo from this host? (the usual cloud failure)
  const cap = await runPy([path.join(ROOT, "flow", "marketcap.py"), probe, "--cache", path.join(ROOT, "data")], 60000);
  let capOk = false, capDetail = cap.stderr || cap.error || "no output";
  try {
    const j = JSON.parse(cap.stdout || "{}");
    const v = j[probe.toUpperCase()];
    capOk = typeof v === "number" && v > 0;
    capDetail = capOk ? `${probe} market cap $${(v / 1e9).toFixed(1)}B` : `returned ${JSON.stringify(j).slice(0, 200)}`;
  } catch {}
  steps.push(step("yahoo-marketcap", capOk, capDetail,
    "Yahoo is likely blocking this host's IP. Options: set discovery.normalize to \"dollarvol\" " +
    "(uses Alpaca bars, no Yahoo), or set discovery.keepUnsized=true, or run the app somewhere with a residential IP."));

  // 5. Can a Vol Desk GEX scan complete? (also Yahoo, and it's the gate that
  //    turns a flow candidate into a tradeable name)
  const scan = await runPy([path.join(ROOT, "gex", "voldesk.py"), probe,
    path.join(ROOT, "data", "voldesk"), "45", "1"], 120000);
  let scanOk = false, scanDetail = scan.stderr || scan.error || "no output";
  try {
    const j = JSON.parse(scan.stdout || "{}");
    scanOk = !j.error && !!j.tag;
    scanDetail = scanOk
      ? `${probe}: tag ${j.tag}, grade ${j.grade}, nTrans ${j.levels?.nTrans}, T1 ${j.levels?.plusGEX_T1}`
      : (j.error || JSON.stringify(j).slice(0, 200));
  } catch {}
  steps.push(step("voldesk-scan", scanOk, scanDetail,
    "Without this, nothing can ever qualify — every candidate needs a successful scan."));

  // 6. Run the real funnel and report where the numbers collapse
  let funnel = null;
  try {
    const openTickers = new Set();
    const res = await discovery.discover(cfg, { openTickers, cooldown: {} });
    funnel = {
      sources: res.sources || [],
      considered: res.considered ?? 0,
      afterSizeFilters: res.scanned != null ? "see scanned" : null,
      scanned: res.scanned ?? 0,
      qualified: (res.qualified || []).length,
      rejected: res.rejected || [],
      note: res.note || null,
    };
  } catch (e) {
    funnel = { error: String(e.message || e) };
  }

  // Where did it break?
  let verdict, explain;
  const firstFail = steps.find((s) => !s.ok);
  if (firstFail) {
    verdict = `blocked at: ${firstFail.name}`;
    explain = firstFail.hint || firstFail.detail;
  } else if (funnel?.considered === 0) {
    verdict = "no flow candidates";
    explain = "The uploaded book produced no names above minPremium / minScore. Lower those, or upload a busier session.";
  } else if (funnel?.scanned === 0) {
    verdict = "all candidates dropped before scanning";
    explain = "Size/tier filters removed everything. Usually the market-cap lookup returned nothing (see yahoo-marketcap), " +
      "or minTierScore is too high. Try discovery.normalize=\"dollarvol\", or keepUnsized=true, or lower minTierScore.";
  } else if (funnel?.qualified === 0) {
    verdict = "scanned, but nothing graded CONFIRMED";
    explain = "This is the NORMAL outcome most days — CONFIRMED needs spot to have reclaimed pTrans with the filters passing. " +
      "Names stay unqualified until structure lines up. Check `rejected` for the tags they got.";
  } else {
    verdict = "healthy";
    explain = `${funnel.qualified} name(s) qualified.`;
  }

  return {
    verdict, explain,
    steps, funnel,
    observing: observe.activeList().length,
    ready: observe.readyTickers(),
    config: {
      normalize: cfg.discovery?.normalize,
      minTierScore: cfg.discovery?.minTierScore,
      keepUnsized: cfg.discovery?.keepUnsized,
      minPremium: cfg.discovery?.minPremium,
      minScore: cfg.discovery?.minScore,
      acceptTags: cfg.discovery?.acceptTags,
      sides: cfg.sides,
    },
  };
}
