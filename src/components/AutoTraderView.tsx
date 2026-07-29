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

  async function runProbe() {
    if (!probe) return;
    setProbeRes(null);
    try { setProbeRes(await api.getFlow(probe.toUpperCase())); }
    catch (e: any) { setErr(String(e.message || e)); }
  }

  if (!cfg) return <div className="view"><p>Loading auto-trader…</p>{err && <p className="err">{err}</p>}</div>;

  const a = cfg.automation, f = cfg.flow;
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
        </div>
      </div>

      {/* Watchlist */}
      <div className="card" style={{ marginTop: 16 }}>
        <h3>Watchlist (auto-entry candidates)</h3>
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
