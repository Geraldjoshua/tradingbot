import { useEffect, useState } from "react";
import * as api from "../api";

// Auto-trader control panel: kill switch, toggles for automation + flow, the
// watchlist, and a live action log. Everything here just reads/writes the
// server config (server/autotrader.config.json) — the loop itself runs backend.

export default function AutoTraderView() {
  const [status, setStatus] = useState<any>(null);
  const [cfg, setCfg] = useState<any>(null);
  const [watch, setWatch] = useState("");
  const [probe, setProbe] = useState("");
  const [probeRes, setProbeRes] = useState<any>(null);
  const [disc, setDisc] = useState<any>(null);
  const [discBusy, setDiscBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function refresh() {
    try {
      const s = await api.autoStatus();
      setStatus(s); setCfg(s.config);
      setWatch((s.config.automation.watchlist || []).join(", "));
    } catch (e: any) { setErr(String(e.message || e)); }
  }
  useEffect(() => { refresh(); const t = setInterval(refresh, 15000); return () => clearInterval(t); }, []);

  async function patch(partial: any) {
    setBusy(true); setErr(null);
    try { const c = await api.autoSetConfig(partial); setCfg(c); await refresh(); }
    catch (e: any) { setErr(String(e.message || e)); }
    finally { setBusy(false); }
  }

  async function toggleRun() {
    setBusy(true); setErr(null);
    try { status?.running ? await api.autoStop() : await api.autoStart(); await refresh(); }
    catch (e: any) { setErr(String(e.message || e)); }
    finally { setBusy(false); }
  }

  async function saveWatch() {
    const tickers = watch.split(/[,\s]+/).map((t) => t.trim().toUpperCase()).filter(Boolean);
    await api.autoSetWatchlist(tickers); await refresh();
  }

  async function runDisc() {
    setDiscBusy(true); setDisc(null); setErr(null);
    try { setDisc(await api.runDiscovery()); }
    catch (e: any) { setErr(String(e.message || e)); }
    finally { setDiscBusy(false); }
  }

  async function runProbe() {
    if (!probe) return;
    setProbeRes(null);
    try { setProbeRes(await api.getFlow(probe.toUpperCase())); }
    catch (e: any) { setErr(String(e.message || e)); }
  }

  if (!cfg) return <div className="view"><p>Loading auto-trader…</p>{err && <p className="err">{err}</p>}</div>;

  const a = cfg.automation, f = cfg.flow;
  const d = cfg.discovery || {
    enabled: false, shadowMode: false, sources: { optionstrat: true, unusualwhales: false },
    everyMinutes: 30, maxScan: 8, minPremium: 250000, minScore: 0.3,
  };
  const sd = cfg.sides || { long: true, short: false };
  const sh = cfg.shares || {};
  const running = status?.running;

  return (
    <div className="view">
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
        <button className="tab" onClick={toggleRun} disabled={busy}
          style={{ background: running ? "#b3261e" : "#1b7f3b", color: "#fff", fontWeight: 700 }}>
          {running ? "■ STOP auto-trader" : "▶ START auto-trader"}
        </button>
        <span className={`badge ${running ? "confirmed" : ""}`}>
          {running ? "RUNNING" : "stopped"}
        </span>
        <span className="sub">
          market {status?.marketOpen ? "OPEN" : "closed"} · {status?.openPositions ?? 0} open ·
          {" "}{status?.dailyEntries ?? 0}/{a.maxDailyEntries} entries today
        </span>
      </div>
      <p className="sub" style={{ marginTop: 0 }}>
        Paper only. MANAGE (auto take-profit + auto-stop) always runs. ENTER runs only in
        <b> full</b> mode, during market hours, for watchlist tickers whose price trigger and flow line up.
      </p>
      {err && <p className="err">{err}</p>}

      {/* Data reset after a restart — say so loudly, it's otherwise invisible */}
      {status?.dataHealth?.needsUpload && (
        <div className="card" style={{ marginBottom: 12, borderLeft: "4px solid #b3261e", background: "#fff4f4" }}>
          <b style={{ color: "#b3261e" }}>⚠ Flow data missing — re-upload needed</b>
          <div className="sub">{status.dataHealth.message}</div>
        </div>
      )}

      {/* Flow freshness — a missed upload is silent otherwise */}
      {status?.flowCache && (
        <div className="card" style={{
          marginBottom: 12,
          borderLeft: `4px solid ${status.flowCache.stale ? "#b3261e" : "#1b7f3b"}`,
        }}>
          {status.flowCache.stale ? (
            <b style={{ color: "#b3261e" }}>
              ⚠ Flow is stale — {status.flowCache.note}.{" "}
              {status.flowCache.action === "block"
                ? "New entries are BLOCKED until you upload."
                : "Trading continues normally — this is a warning only."}
            </b>
          ) : (
            <span>
              ✓ Flow fresh — {status.flowCache.ageHours}h old
              {status.flowCache.generated ? ` (${status.flowCache.generated})` : ""},
              limit {status.flowCache.maxAgeDays}d
            </span>
          )}
          <div className="sub">
            observing {status.observing ?? 0} · ready {(status.ready || []).join(", ") || "none"}
          </div>
        </div>
      )}

      <div className="cols" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        {/* Automation */}
        <div className="card">
          <h3>Automation</h3>
          <label className="row">Mode&nbsp;
            <select value={a.mode} disabled={busy}
              onChange={(e) => patch({ automation: { mode: e.target.value } })}>
              <option value="full">full (enter + exit)</option>
              <option value="exit-only">exit-only (manage only)</option>
            </select>
          </label>
          <label className="row"><input type="checkbox" checked={a.strategies.voldesk}
            onChange={(e) => patch({ automation: { strategies: { voldesk: e.target.checked } } })} /> Vol Desk</label>
          <label className="row"><input type="checkbox" checked={a.strategies.gapgo}
            onChange={(e) => patch({ automation: { strategies: { gapgo: e.target.checked } } })} /> Gap-and-Go (not wired yet)</label>
          <label className="row"><input type="checkbox" checked={a.marketHoursOnly}
            onChange={(e) => patch({ automation: { marketHoursOnly: e.target.checked } })} /> Market hours only</label>
          <label className="row">T1 action&nbsp;
            <select value={a.t1Action} onChange={(e) => patch({ automation: { t1Action: e.target.value } })}>
              <option value="take-profit">take profit at T1</option>
              <option value="lock-and-ride">lock breakeven, ride to T2</option>
            </select>
          </label>
          <div className="row">Poll&nbsp;<input type="number" value={a.pollSeconds} style={{ width: 60 }}
            onChange={(e) => patch({ automation: { pollSeconds: +e.target.value } })} />s ·
            max&nbsp;<input type="number" value={a.maxConcurrent} style={{ width: 44 }}
            onChange={(e) => patch({ automation: { maxConcurrent: +e.target.value } })} /> open ·
            <input type="number" value={a.maxDailyEntries} style={{ width: 44 }}
            onChange={(e) => patch({ automation: { maxDailyEntries: +e.target.value } })} />/day
          </div>
          <div className="row">Base premium $<input type="number" value={cfg.risk.basePremium} style={{ width: 70 }}
            onChange={(e) => patch({ risk: { basePremium: +e.target.value } })} /></div>
        </div>

        {/* Flow */}
        <div className="card">
          <h3>Flow conviction</h3>
          <label className="row"><input type="checkbox" checked={f.enabled}
            onChange={(e) => patch({ flow: { enabled: e.target.checked } })} /> Use flow</label>
          <label className="row">Effect&nbsp;
            <select value={f.mode} disabled={!f.enabled}
              onChange={(e) => patch({ flow: { mode: e.target.value } })}>
              <option value="size">size (agree=full, disagree=tiny)</option>
              <option value="gate">hard gate (only if flow agrees)</option>
              <option value="display">display only</option>
            </select>
          </label>
          <label className="row"><input type="checkbox" checked={f.sources.optionstrat}
            onChange={(e) => patch({ flow: { sources: { optionstrat: e.target.checked } } })} /> OptionStrat</label>
          <label className="row"><input type="checkbox" checked={f.sources.unusualwhales}
            onChange={(e) => patch({ flow: { sources: { unusualwhales: e.target.checked } } })} /> Unusual Whales (needs UW_API_KEY)</label>
          <div className="row">Size × — agree
            <input type="number" step="0.05" value={f.sizing.agree} style={{ width: 54 }}
              onChange={(e) => patch({ flow: { sizing: { agree: +e.target.value } } })} /> · neutral
            <input type="number" step="0.05" value={f.sizing.neutral} style={{ width: 54 }}
              onChange={(e) => patch({ flow: { sizing: { neutral: +e.target.value } } })} /> · disagree
            <input type="number" step="0.05" value={f.sizing.disagree} style={{ width: 54 }}
              onChange={(e) => patch({ flow: { sizing: { disagree: +e.target.value } } })} />
          </div>
          <div className="row">Min score&nbsp;<input type="number" step="0.05" value={f.minScore} style={{ width: 54 }}
            onChange={(e) => patch({ flow: { minScore: +e.target.value } })} /></div>
          <div className="row">
            Stale after <input type="number" step="1" value={f.maxAgeDays ?? 3} style={{ width: 48 }}
              onChange={(e) => patch({ flow: { maxAgeDays: +e.target.value } })} /> days →&nbsp;
            <select value={f.staleAction || "warn"}
              onChange={(e) => patch({ flow: { staleAction: e.target.value } })}>
              <option value="warn">warn only (keep trading)</option>
              <option value="block">block new entries</option>
              <option value="off">off (ignore age)</option>
            </select>
          </div>
        </div>
      </div>

      {/* Direction + instrument */}
      <div className="card" style={{ marginTop: 16 }}>
        <h3>Direction &amp; instrument</h3>
        <label className="row"><input type="checkbox" checked={sd.long !== false}
          onChange={(e) => patch({ sides: { long: e.target.checked } })} /> Longs — buy <b>calls</b> on bullish flow</label>
        <label className="row"><input type="checkbox" checked={sd.short === true}
          onChange={(e) => patch({ sides: { short: e.target.checked } })} /> Shorts — buy <b>puts</b> on bearish flow</label>
        <p className="sub" style={{ marginTop: 0 }}>
          Shorts use a <i>mirrored</i> playbook: trigger = 5-min close <b>below</b> the put wall,
          stop = gamma-flip reclaim, target = put-OI strike (COTMP) or a measured move.
          Vol Desk's CONFIRMED grade is long-only, so shorts are gated on their own R/R instead —
          far less forward-tested than the long side. Off by default for that reason.
        </p>
        <label className="row"><input type="checkbox" checked={sh.enabled !== false}
          onChange={(e) => patch({ shares: { enabled: e.target.checked } })} /> Share fallback — trade stock when no option clears R/R</label>
        <label className="row"><input type="checkbox" checked={sh.allowShort !== false}
          onChange={(e) => patch({ shares: { allowShort: e.target.checked } })} /> …including short stock (needs easy-to-borrow)</label>
        <div className="row">
          max notional <input type="number" step="0.05" value={sh.maxNotionalPct ?? 0.1} style={{ width: 60 }}
            onChange={(e) => patch({ shares: { maxNotionalPct: +e.target.value } })} /> of buying power
        </div>
        <p className="sub" style={{ marginTop: 0 }}>
          Shares are sized by risk: <code>shares = riskBudget / |entry − stop|</code>, so a stop-out
          costs about the same as the option premium budget would have.
        </p>
      </div>

      {/* Discovery */}
      <div className="card" style={{ marginTop: 16 }}>
        <h3>Discovery — let flow find the names</h3>
        <p className="sub" style={{ marginTop: 0 }}>
          Ranks tickers by bullish flow, then runs a real Vol Desk scan on each and keeps only
          the ones your playbook grades <b>CONFIRMED</b>. Flow proposes, Vol Desk disposes.
        </p>
        <label className="row"><input type="checkbox" checked={d.enabled}
          onChange={(e) => patch({ discovery: { enabled: e.target.checked } })} /> Auto-discover new tickers</label>
        <label className="row"><input type="checkbox" checked={d.shadowMode}
          onChange={(e) => patch({ discovery: { shadowMode: e.target.checked } })} /> Shadow mode (log picks, don't buy)</label>
        <label className="row"><input type="checkbox" checked={d.sources.optionstrat}
          onChange={(e) => patch({ discovery: { sources: { optionstrat: e.target.checked } } })} /> from OptionStrat masters (local only)</label>
        <label className="row"><input type="checkbox" checked={d.sources.unusualwhales}
          onChange={(e) => patch({ discovery: { sources: { unusualwhales: e.target.checked } } })} /> from Unusual Whales (works in cloud)</label>
        <div className="row">
          every <input type="number" value={d.everyMinutes} style={{ width: 54 }}
            onChange={(e) => patch({ discovery: { everyMinutes: +e.target.value } })} />min ·
          scan top <input type="number" value={d.maxScan} style={{ width: 44 }}
            onChange={(e) => patch({ discovery: { maxScan: +e.target.value } })} /> ·
          min premium $<input type="number" step="50000" value={d.minPremium} style={{ width: 90 }}
            onChange={(e) => patch({ discovery: { minPremium: +e.target.value } })} /> ·
          min skew <input type="number" step="0.05" value={d.minScore} style={{ width: 54 }}
            onChange={(e) => patch({ discovery: { minScore: +e.target.value } })} />
        </div>
        <div className="row">
          Size-normalize by&nbsp;
          <select value={d.normalize || "marketcap"}
            onChange={(e) => patch({ discovery: { normalize: e.target.value } })}>
            <option value="marketcap">market cap (premium as bps of company)</option>
            <option value="dollarvol">avg daily dollar volume (liquidity)</option>
            <option value="none">none — raw premium (mega-cap biased)</option>
          </select>
        </div>
        <div className="row">
          min score <input type="number" step="0.25" value={d.minTierScore ?? 1.0} style={{ width: 54 }}
            onChange={(e) => patch({ discovery: { minTierScore: +e.target.value } })} />×
          &nbsp;· clamp at <input type="number" value={d.maxTierScore ?? 20} style={{ width: 54 }}
            onChange={(e) => patch({ discovery: { maxTierScore: +e.target.value } })} />×
        </div>

        {/* Per-tier bars */}
        {(d.normalize || "marketcap") === "marketcap" && (
          <>
            <p className="sub" style={{ marginBottom: 4 }}>
              Each name is scored against what's normal <b>for its own size class</b>.
              <code> score = (premium/mktcap in bps) ÷ ref bps</code> — 1.0× means typical for that
              tier, 3.0× means three times normal. Scores compare fairly across tiers, so raw dollars
              don't hand it to mega-caps and raw bps don't hand it to small-caps.
            </p>
            <table className="tbl">
              <thead><tr><th>tier</th><th>market cap</th><th>on</th><th>ref bps</th><th>min premium</th></tr></thead>
              <tbody>
                {[
                  { k: "micro", label: "Micro", range: "< $300M" },
                  { k: "small", label: "Small", range: "$300M – $2B" },
                  { k: "mid", label: "Mid", range: "$2B – $10B" },
                  { k: "large", label: "Large", range: "$10B – $200B" },
                  { k: "mega", label: "Mega", range: "> $200B" },
                ].map(({ k, label, range }) => {
                  const t = (d.tiers || {})[k] || {};
                  return (
                    <tr key={k}>
                      <td><b>{label}</b></td>
                      <td className="sub">{range}</td>
                      <td><input type="checkbox" checked={t.enabled !== false}
                        onChange={(e) => patch({ discovery: { tiers: { [k]: { enabled: e.target.checked } } } })} /></td>
                      <td><input type="number" step="0.1" value={t.refBps ?? 1} style={{ width: 64 }}
                        onChange={(e) => patch({ discovery: { tiers: { [k]: { refBps: +e.target.value } } } })} /></td>
                      <td>$<input type="number" step="50000" value={t.minPremium ?? 0} style={{ width: 100 }}
                        onChange={(e) => patch({ discovery: { tiers: { [k]: { minPremium: +e.target.value } } } })} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="sub">
              Micro-caps are off by default (a $300k print on a $50M shell scores huge but is
              usually illiquid noise). The ref-bps values are seeded estimates, not fitted to data —
              if every hit comes from one tier, raise that tier's ref bps.
            </p>
          </>
        )}
        <div className="row">
          <button onClick={runDisc} disabled={discBusy}>
            {discBusy ? "Scanning… (Vol Desk scans take a while)" : "Run discovery now"}
          </button>
        </div>
        {disc && (
          <div style={{ marginTop: 8 }}>
            <p className="sub">
              sources: {(disc.sources || []).join(" + ") || "none"} · considered {disc.considered ?? 0} ·
              scanned {disc.scanned ?? 0} · qualified {(disc.qualified || []).length}
              {disc.note ? ` · ${disc.note}` : ""}
            </p>
            {!!(disc.qualified || []).length && (
              <table className="tbl">
                <thead><tr><th>ticker</th><th>tier</th><th>score</th><th>tag</th><th>grade</th><th>net premium</th><th>bps</th><th>mkt cap</th><th>skew</th><th>src</th></tr></thead>
                <tbody>
                  {disc.qualified.map((q: any) => (
                    <tr key={q.ticker} className="confirmed">
                      <td><b>{q.ticker}</b></td>
                      <td>{q.tierLabel || "—"}</td>
                      <td><b>{q.tierScore != null ? `${q.tierScore.toFixed(2)}×` : "—"}</b></td>
                      <td>{q.tag}</td><td>{q.grade}</td>
                      <td>${(q.netPremium / 1000).toFixed(0)}k</td>
                      <td>{q.relBps != null ? q.relBps.toFixed(2) : "—"}</td>
                      <td>{q.marketCap ? `$${(q.marketCap / 1e9).toFixed(1)}B`
                        : q.avgDollarVol ? `$${(q.avgDollarVol / 1e6).toFixed(0)}M/d` : "—"}</td>
                      <td>{(q.flowScore * 100).toFixed(0)}%</td>
                      <td>{q.flowSource}{q.inKnows ? " ·knows" : ""}{q.inUnusual ? " ·unusual" : ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {!!(disc.rejected || []).length && (
              <p className="sub">rejected by Vol Desk: {disc.rejected.map((r: any) => `${r.ticker}(${r.tag})`).join(", ")}</p>
            )}
          </div>
        )}
      </div>

      {/* Watchlist */}
      <div className="card" style={{ marginTop: 16 }}>
        <h3>Watchlist (always-checked, in addition to discovery)</h3>
        <div className="row">
          <input value={watch} onChange={(e) => setWatch(e.target.value)} style={{ width: 360 }}
            placeholder="TSLA, NVDA, AAPL" />
          <button onClick={saveWatch} disabled={busy}>Save</button>
          <span className="sub">Each must have a fresh Vol Desk snapshot; the loop checks trigger + flow.</span>
        </div>
      </div>

      {/* Flow probe */}
      <div className="card" style={{ marginTop: 16 }}>
        <h3>Check flow for a ticker</h3>
        <div className="row">
          <input value={probe} onChange={(e) => setProbe(e.target.value)} placeholder="TSLA" style={{ width: 100 }} />
          <button onClick={runProbe}>Check</button>
        </div>
        {probeRes && (
          <pre style={{ fontSize: 12, whiteSpace: "pre-wrap" }}>
            {`${probeRes.conviction.ticker}: flow ${probeRes.conviction.direction} `
              + `(score ${probeRes.conviction.combinedScore}) → stance ${probeRes.decision.stance}, `
              + `size ×${probeRes.decision.sizeMultiplier}${probeRes.decision.block ? " — BLOCKED" : ""}`}
          </pre>
        )}
      </div>

      {/* Action log */}
      <div className="card" style={{ marginTop: 16 }}>
        <h3>Action log</h3>
        <table className="tbl">
          <thead><tr><th>time</th><th>level</th><th>event</th><th>detail</th></tr></thead>
          <tbody>
            {(status?.log || []).map((r: any, i: number) => (
              <tr key={i} className={r.level === "trade" ? "confirmed" : r.level === "error" ? "blocked" : ""}>
                <td>{new Date(r.ts).toLocaleTimeString()}</td>
                <td>{r.level}</td>
                <td>{r.event}</td>
                <td style={{ fontSize: 11 }}>
                  {Object.entries(r).filter(([k]) => !["ts", "level", "event"].includes(k))
                    .map(([k, v]) => `${k}=${v}`).join(" ")}
                </td>
              </tr>
            ))}
            {!(status?.log || []).length && <tr><td colSpan={4} className="sub">no actions yet</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
