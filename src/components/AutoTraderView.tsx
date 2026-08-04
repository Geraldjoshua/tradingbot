import { useEffect, useState } from "react";
import * as api from "../api";

// Auto-trader control panel: kill switch, toggles for automation + flow, the
// watchlist, and a live action log. Everything here just reads/writes the
// server config (server/autotrader.config.json) — the loop itself runs backend.

export default function AutoTraderView() {
  const [status, setStatus] = useState<any>(null);
  const [cfg, setCfg] = useState<any>(null);
  const [watch, setWatch] = useState("");
  // True once you start editing the watchlist. The status poll runs every 15s and
  // used to overwrite the textbox from the server on every tick — so a list long
  // enough to take >15s to type would be wiped out from under you before saving.
  const [watchDirty, setWatchDirty] = useState(false);
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
      // Never clobber what you're in the middle of typing.
      if (!watchDirty) setWatch((s.config.automation.watchlist || []).join(", "));
    } catch (e: any) { setErr(String(e.message || e)); }
  }
  useEffect(() => { refresh(); const t = setInterval(refresh, 15000); return () => clearInterval(t); }, [watchDirty]);

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
    await api.autoSetWatchlist(tickers);
    setWatchDirty(false);              // saved — polling may sync it again
    await refresh();
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
  const rk = cfg.risk || { basePremium: 300, maxContracts: 10 };
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

      {/* Keep-alive: is the service actually being pinged from outside? A green
          checkmark on GitHub does NOT prove the request reached this server. */}
      {status?.keepAlive && (
        <div className="card" style={{ marginBottom: 12,
          borderLeft: `4px solid ${status.keepAlive.healthy ? "#1b7f3b" : "#c77700"}` }}>
          {status.keepAlive.healthy ? (
            <span>✓ Keep-alive healthy — last external ping {status.keepAlive.minutesSinceExternalPing}m ago
              ({status.keepAlive.externalPings} total), up {status.keepAlive.uptimeMinutes}m</span>
          ) : (
            <>
              <b style={{ color: "#c77700" }}>
                ⚠ Keep-alive: {status.keepAlive.warning || "no external ping recorded yet"}
              </b>
              <div className="sub">
                Render free sleeps after 15 min with no inbound request. Check the repo's Actions tab
                and that the <code>HEALTHCHECK_URL</code> variable points at
                <code> /api/health</code> on this service. Up {status.keepAlive.uptimeMinutes}m,
                {" "}{status.keepAlive.externalPings} external pings seen.
              </div>
            </>
          )}
        </div>
      )}

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
          <label className="row">
            Stops that trigger while closed fire&nbsp;
            <input type="number" min={0} max={60} style={{ width: 44 }}
              value={a.queuedExitDelayMin ?? 5}
              onChange={(e) => patch({ automation: { queuedExitDelayMin: Math.max(0, +e.target.value) } })} />
            &nbsp;min after the open
          </label>
          <p className="sub" style={{ margin: "0 0 4px 0" }}>
            A queued stop crosses the book by design, and the opening auction carries the widest
            spreads of the day — firing at 09:30:05 pays the worst spread available at the moment the
            position is already in trouble. This waits for the book to settle. It does <b>not</b> improve
            the price on a gap: the option is worth what it's worth. It only avoids paying an
            opening-auction spread on top of the gap. Set 0 to fire immediately.
          </p>
          <label className="row">
            <input type="checkbox" checked={cfg.scaleOut?.enabled === true}
              onChange={(e) => patch({ scaleOut: { enabled: e.target.checked } })} />
            Scale out — sell&nbsp;
            <input type="number" min={5} max={95} step="5" style={{ width: 50 }}
              disabled={cfg.scaleOut?.enabled !== true}
              value={Math.round((cfg.scaleOut?.firstPct ?? 0.8) * 100)}
              onChange={(e) => patch({ scaleOut: { firstPct: Math.min(95, Math.max(5, +e.target.value)) / 100 } })} />
            % at T1, run the rest to T2
          </label>
          <label className="row" style={{ marginLeft: 22 }}>
            <input type="checkbox" checked={cfg.scaleOut?.moveStopToBreakeven !== false}
              disabled={cfg.scaleOut?.enabled !== true}
              onChange={(e) => patch({ scaleOut: { moveStopToBreakeven: e.target.checked } })} />
            …and move the stop to breakeven on the remainder
          </label>
          <p className="sub" style={{ margin: "0 0 4px 22px" }}>
            Banks the move that actually happened and leaves a runner for the bigger target.
            <b> Needs at least 2 contracts</b> — 80% of one contract is zero, and a contract can't be
            split, so single-contract positions still close fully at T1. With 3 contracts it sells 2
            and runs 1. Note that "breakeven" is the stop on the <i>underlying</i> at your entry price:
            the option can still be worth less there than you paid, because theta ran while you waited.
          </p>
          <div className="row">Poll&nbsp;<input type="number" value={a.pollSeconds} style={{ width: 60 }}
            onChange={(e) => patch({ automation: { pollSeconds: +e.target.value } })} />s ·
            max&nbsp;<input type="number" value={a.maxConcurrent} style={{ width: 44 }}
            onChange={(e) => patch({ automation: { maxConcurrent: +e.target.value } })} /> open ·
            <input type="number" value={a.maxDailyEntries} style={{ width: 44 }}
            onChange={(e) => patch({ automation: { maxDailyEntries: +e.target.value } })} />/day
          </div>
          <label className="row">Entry trigger&nbsp;
            <select value={a.triggerMode || "open"}
              onChange={(e) => patch({ automation: { triggerMode: e.target.value } })}>
              <option value="open">opening bar only (09:30–09:35)</option>
              <option value="intraday">any 5-min bar that crosses the level</option>
            </select>
            {(a.triggerMode === "intraday") && (
              <>&nbsp;· no new triggers after&nbsp;
                <input type="number" value={Math.floor((a.intradayCutoffMin ?? 840) / 60)} style={{ width: 40 }}
                  onChange={(e) => patch({ automation: { intradayCutoffMin: Math.max(10, +e.target.value) * 60 } })} />:00 ET
              </>
            )}
          </label>
          <p className="sub" style={{ margin: "0 0 4px 0" }}>
            This does <b>not</b> limit trading to the first 5 minutes. The bot can buy at any hour the
            market is open. What this sets is <i>when permission is decided</i>.
            <br /><br />
            <b>Opening bar only:</b> one price reading is taken at 09:35 and used all day. Above the
            level → the name is allowed, and it may be bought at 10am, 1pm or 3pm once everything else
            lines up. Below the level → that name is off the table until tomorrow, even if it climbs
            above at noon.
            <br /><br />
            <b>Any 5-min bar:</b> a name that crosses the level later in the day earns permission then,
            instead of being locked out at 09:35. It must be a real <i>crossing</i> — previous bar below,
            this bar above — not merely "price happens to be above", which would be true on every bar of
            a trending name and would duplicate what the CONFIRMED tag already checks. The cutoff stops
            new permissions being granted late in the session.
          </p>
          <hr style={{ border: 0, borderTop: "1px solid var(--border, #333)", margin: "10px 0 6px" }} />
          <h4 style={{ margin: "4px 0" }}>Sizing</h4>

          {/* (a) respect the budget */}
          <label className="row">
            <input type="checkbox" checked={rk.enforceBudget !== false}
              onChange={(e) => patch({ risk: { enforceBudget: e.target.checked } })} />
            Respect the premium budget&nbsp;
            $<input type="number" step="100" value={rk.basePremium} style={{ width: 90 }}
              onChange={(e) => patch({ risk: { basePremium: +e.target.value } })} /> per trade
          </label>
          <p className="sub" style={{ margin: "0 0 6px 22px" }}>
            On: contracts = budget ÷ (premium × 100). Off: the budget is ignored and size comes
            from the fixed count below. Either way the order is capped by your actual buying power —
            it will never spend money you don't have.
          </p>

          {/* (b) exact contract count */}
          <label className="row">
            <input type="checkbox" checked={rk.fixedContracts?.enabled === true}
              onChange={(e) => patch({ risk: { fixedContracts: { enabled: e.target.checked } } })} />
            Always buy exactly&nbsp;
            <input type="number" min={1} value={rk.fixedContracts?.count ?? 1} style={{ width: 44 }}
              disabled={rk.fixedContracts?.enabled !== true}
              onChange={(e) => patch({ risk: { fixedContracts: { count: +e.target.value } } })} />
            &nbsp;contract(s) per trade
          </label>
          <p className="sub" style={{ margin: "0 0 6px 22px" }}>
            Off: buy as many as the budget fits. Hard ceiling either way:&nbsp;
            <input type="number" value={rk.maxContracts ?? 10} style={{ width: 44 }}
              onChange={(e) => patch({ risk: { maxContracts: +e.target.value } })} /> contracts.
          </p>

          {/* (d) find something cheaper */}
          <label className="row">
            <input type="checkbox" checked={rk.findCheaper !== false}
              onChange={(e) => patch({ risk: { findCheaper: e.target.checked } })} />
            Find a cheaper contract when the best one busts the budget
          </label>
          <p className="sub" style={{ margin: "0 0 6px 22px" }}>
            Re-ranks the chain with your budget as a per-contract price ceiling and takes the best
            contract that <i>fits</i>, instead of the best contract outright. If nothing fits (usually
            true on mega-caps — cheap strikes are far OTM and fail the delta/R-R filters) the ticker is
            skipped and the loop moves on to the next name, which is how it finds a cheaper <i>ticker</i>.
          </p>

          {/* (c) overrun */}
          <label className="row">
            <input type="checkbox" checked={rk.allowBudgetOverrun !== false}
              onChange={(e) => patch({ risk: { allowBudgetOverrun: e.target.checked } })} />
            Last resort: buy 1 contract even if it exceeds the budget
          </label>
          <p className="sub" style={{ margin: "0 0 0 22px" }}>
            A $30 premium contract costs <b>$3,000</b>, so a $300 budget can't afford one. Ticked, it
            buys 1 anyway and logs <code>OVER_BUDGET 10x</code> — that's how three ~$3,000 positions
            were opened on a "$300" budget. Unticked, it skips as <code>TOO_EXPENSIVE</code>. Capped at
            <input type="number" value={rk.overrunTolerance ?? 15} style={{ width: 40 }}
              onChange={(e) => patch({ risk: { overrunTolerance: +e.target.value } })} />× the budget.
          </p>
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
          onChange={(e) => patch({ discovery: { sources: { optionstrat: e.target.checked } } })} />
          <b>from OptionStrat masters</b> — the flow you upload or scrape</label>
        <label className="row"><input type="checkbox" checked={d.sources.unusualwhales}
          onChange={(e) => patch({ discovery: { sources: { unusualwhales: e.target.checked } } })} /> from Unusual Whales (needs UW_API_KEY)</label>
        {d.sources.optionstrat === false && d.sources.unusualwhales === false && (
          <p className="sub" style={{ color: "var(--warn, #d88)", margin: "0 0 6px 22px" }}>
            <b>Both sources are off — discovery cannot find anything.</b> With neither ticked, no source
            is even attempted: you'll see "sources: none · considered 0" no matter how good the uploaded
            book is. Only the watchlist will trade.
          </p>
        )}
        <p className="sub" style={{ margin: "0 0 6px 22px" }}>
          This used to be labelled "local only", which was wrong and worth correcting: the masters work
          wherever they are, and the whole upload flow exists so a cloud deploy can use them. Uploading
          <code> flow_master.xlsx</code> on the Flow tab builds the same cache the local scraper would.
        </p>
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

        <label className="row">GEX data source&nbsp;
          <select value={cfg.data?.provider || "alpaca"}
            onChange={(e) => patch({ data: { provider: e.target.value } })}>
            <option value="alpaca">Alpaca — OI + IV + bars over REST</option>
            <option value="yahoo">Yahoo (yfinance) — fallback</option>
          </select>
        </label>
        <p className="sub" style={{ margin: "0 0 6px 22px" }}>
          Alpaca needs ~<b>3</b> calls per ticker; Yahoo needs ~<b>7</b> and rate-limits at roughly 19
          tickers in a burst — which is the only reason "scan top" sits at 8. Alpaca also returns
          <code> open_interest_date</code>, so you can finally see how stale the OI behind your gamma is;
          Yahoo never tells you. If Alpaca keys are missing or the API errors, it falls back to Yahoo
          automatically rather than aborting the scan — a data outage should degrade a scan, not leave
          the trader with no snapshot. The source used is recorded on every snapshot as
          <code> data_source</code>.
        </p>

        <label className="row">
          <input type="checkbox" checked={(cfg.walls?.minDistancePct ?? 0.015) > 0}
            onChange={(e) => patch({ walls: { minDistancePct: e.target.checked ? 0.015 : 0 } })} />
          A wall must be at least&nbsp;
          <input type="number" step="0.5" style={{ width: 50 }}
            value={+(((cfg.walls?.minDistancePct ?? 0.015) * 100).toFixed(1))}
            disabled={(cfg.walls?.minDistancePct ?? 0.015) <= 0}
            onChange={(e) => patch({ walls: { minDistancePct: Math.max(0, +e.target.value) / 100 } })} />
          % from spot
        </label>
        <p className="sub" style={{ margin: "0 0 6px 22px" }}>
          Per-contract gamma peaks at-the-money, so ranking strikes by gamma alone returns the strike
          <i> next to spot</i> almost every time. That strike becomes T1, your profit target — observed
          live as GOOGL spot 349.99 → target 350.00, AMZN 271.66 → 272.50. A target 0.3% away can never
          satisfy <code>rr&gt;=2</code>, so names were rejected for what looked like a market judgement
          but was an artefact of the selection rule. This requires a wall to stand at a distance;
          if nothing further out qualifies it relaxes rather than failing the scan.
        </p>

        <label className="row">
          <input type="checkbox" checked={cfg.walls?.weightByOi === true}
            onChange={(e) => patch({ walls: { weightByOi: e.target.checked } })} />
          Rank walls by gamma × open interest instead of gamma alone
        </label>
        <p className="sub" style={{ margin: "0 0 6px 22px" }}>
          Lets a large OI cluster further out beat the ATM strike's naturally-high gamma — closer to how
          dealers describe a wall. Off by default: distance is the primary control, and a big
          near-strike OI could still win. Try one change at a time.
        </p>

        <label className="row">
          <input type="checkbox" checked={d.requireDeltaBalance !== false}
            onChange={(e) => patch({ discovery: { requireDeltaBalance: e.target.checked } })} />
          Require the delta-balance jump (<code>db_change</code>) as a hard filter
        </label>
        <p className="sub" style={{ margin: "0 0 6px 22px" }}>
          Demands the call share of dealer gamma rise <b>0.50</b> in one session (0.30 on a perfect
          11/11) — a violent repositioning, so it blocks most names most days. It also fails
          automatically as <code>no_prior</code> when yesterday's snapshot is missing, which is every
          restart on a host that wipes <code>data/</code>. Unticked, db_change still appears in the log
          but doesn't block; grade ≥9, cushion, no-spike-crash and R/R ≥2 still apply.
        </p>

        <h4 style={{ margin: "14px 0 4px" }}>Setup quality</h4>

        <label className="row">
          Minimum R/R&nbsp;
          <input type="number" step="0.25" min="0" style={{ width: 60 }}
            value={cfg.setup?.minRR ?? 2}
            onChange={(e) => patch({ setup: { minRR: Math.max(0, +e.target.value) } })} />
          &nbsp;: 1
        </label>
        <p className="sub" style={{ margin: "0 0 6px 22px" }}>
          Reward is <code>T1 − pTrans</code>, risk is <code>pTrans − nTrans</code> — both measured from
          the <b>trigger</b>, not from wherever price happens to be. Raise it for fewer, better setups;
          lower it to see more. Set <b>0</b> to disable the filter entirely. Changing this does not
          change what the trade is worth — only which ones qualify — so if lowering it is what makes
          names appear, those names were always the marginal ones.
        </p>

        <label className="row">
          <input type="checkbox" checked={(cfg.setup?.maxExtensionPct ?? 3) > 0}
            onChange={(e) => patch({ setup: { maxExtensionPct: e.target.checked ? 3 : 0 } })} />
          Reject names already more than&nbsp;
          <input type="number" step="0.5" min="0" style={{ width: 55 }}
            value={cfg.setup?.maxExtensionPct ?? 3}
            disabled={(cfg.setup?.maxExtensionPct ?? 3) <= 0}
            onChange={(e) => patch({ setup: { maxExtensionPct: Math.max(0, +e.target.value) } })} />
          % past pTrans
        </label>
        <p className="sub" style={{ margin: "0 0 6px 22px" }}>
          The single biggest difference from the reference system: it enters names that have{" "}
          <i>just</i> crossed pTrans, while we were entering ones 8–25% past it. Reward measured from
          pTrans averaged <b>15.2%</b>; from where we actually entered, <b>5.0%</b> — and 5% doesn't
          cover an option's spread and theta. This is the freshness gate. Blocked names now report{" "}
          <code>ext&lt;=3%</code>, so an extended name says so instead of failing a mangled R/R test.
        </p>

        <label className="row">
          Require&nbsp;
          <input type="number" step="1" min="0" max="3" style={{ width: 45 }}
            value={cfg.setup?.minRegimeGates ?? 2}
            onChange={(e) => patch({ setup: { minRegimeGates: Math.max(0, Math.min(3, Math.round(+e.target.value))) } })} />
          &nbsp;of 3 regime gates
        </label>
        <p className="sub" style={{ margin: "0 0 6px 22px" }}>
          Basket (SPY/QQQ up 0.5%), VIX falling, and bull:bear 3:1 across the universe. <b>The third is
          not computed yet</b> — it needs a 700-name sweep we don't run — so in practice a setting of 2
          means <i>both</i> remaining gates, which is stricter than the reference system's "2 of 3".
          Use 1 if that proves too tight. Set 0 to compute-and-ignore, which is what the system did
          before today. If the regime feed can't be read at all the filter reports{" "}
          <code>regime UNREADABLE</code> and passes rather than blocking — a Yahoo outage shouldn't
          masquerade as a market call.
        </p>

        <label className="row">
          <input type="checkbox" checked={d.tierFloors !== false}
            onChange={(e) => patch({ discovery: { tierFloors: e.target.checked } })} />
          Let smaller companies in — use each tier's own min premium
        </label>
        <p className="sub" style={{ margin: "0 0 6px 22px" }}>
          <b>On:</b> the gate above drops to the lowest floor among enabled tiers, and each tier's own
          "min premium" below does the filtering. <b>Off:</b> that single gate applies to every name
          regardless of size — which meant the smaller tiers' floors could never be reached, so those
          companies were excluded no matter how you set the table.
        </p>

        <label className="row">
          <input type="checkbox" checked={d.affordability?.enabled === true}
            onChange={(e) => patch({ discovery: { affordability: { enabled: e.target.checked } } })} />
          Prefer tickers whose contracts fit the budget
        </label>
        <p className="sub" style={{ margin: "0 0 6px 22px" }}>
          Only the top <b>{d.maxScan}</b> names get scanned each cycle. If those slots all go to $400
          stocks they're scanned, sized, and skipped as <code>TOO_EXPENSIVE</code> while the affordable
          names never got looked at. This moves cheaper names up the ranking (est. contract cost ≈ spot
          × 8, against your ${cfg.risk?.basePremium ?? 300} budget). A <i>preference</i>, not a filter —
          a mega-cap with exceptional flow still outranks a cheap name with mediocre flow.
        </p>
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
            {/* What actually got scanned, and why each one didn't make it.
                The old build printed only "rejected by Vol Desk: NVDA(BLOCKED), …",
                which tells you nothing on a 0-qualified day — and 0 qualified is
                the NORMAL outcome most days, so that's exactly when you need detail. */}
            {!!(disc.watch || []).length && (
              <>
                <p className="sub" style={{ marginBottom: 4 }}>
                  <b>Scanned {disc.scanned} of {disc.considered} candidates.</b>{" "}
                  {disc.tagCounts && Object.entries(disc.tagCounts)
                    .map(([t, n]: any) => `${n} ${t}`).join(" · ")}
                  {" — "}these are on the observe list and get re-checked daily.
                </p>
                <table className="tbl">
                  <thead><tr>
                    <th>ticker</th><th>side</th><th>tag</th><th>grade</th><th>R/R</th>
                    <th>tier</th><th>score</th><th>net premium</th><th>what's blocking it</th>
                  </tr></thead>
                  <tbody>
                    {disc.watch.map((w: any) => (
                      <tr key={`${w.ticker}-${w.side}`} className={w.tag === "CONFIRMED" ? "confirmed" : undefined}>
                        <td><b>{w.ticker}</b></td>
                        <td>{w.side === "short" ? "put" : "call"}</td>
                        <td>{w.tag}</td>
                        <td>{w.grade != null ? `${w.grade}/11` : "—"}</td>
                        <td>{w.rr != null ? Number(w.rr).toFixed(2) : "—"}</td>
                        <td>{w.tierLabel || "—"}</td>
                        <td>{w.tierScore != null ? `${w.tierScore.toFixed(2)}×` : "—"}</td>
                        <td>${(Math.abs(w.netPremium) / 1000).toFixed(0)}k</td>
                        <td className="sub">{(w.blockers || []).join(", ") || "nothing — tradeable"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
            {!!(disc.rejected || []).length && (
              <p className="sub" style={{ marginTop: 6 }}>
                scanned but not even watchable:{" "}
                {disc.rejected
                  .filter((r: any) => !(disc.watch || []).find((w: any) => w.ticker === r.ticker))
                  .map((r: any) => `${r.ticker} (${r.tag}${r.grade != null ? ` ${r.grade}/11` : ""})`)
                  .join(", ") || "none"}
              </p>
            )}
            {!(disc.watch || []).length && !!disc.scanned && (
              <p className="sub">
                All {disc.scanned} scanned names came back BLOCKED — none reached CONFIRMED or PENDING,
                so nothing was added to the observe list. That is a normal outcome: a name only becomes
                watchable once its structure lines up.
              </p>
            )}
          </div>
        )}
      </div>

      {/* Watchlist */}
      <div className="card" style={{ marginTop: 16 }}>
        <h3>Watchlist (always-checked, in addition to discovery)</h3>
        <div className="row">
          <input value={watch}
            onChange={(e) => { setWatch(e.target.value); setWatchDirty(true); }}
            style={{ width: 360 }} placeholder="TSLA, NVDA, AAPL  (no limit)" />
          <button onClick={saveWatch} disabled={busy}>
            {watchDirty ? "Save *" : "Save"}
          </button>
          <span className="sub">Scanned automatically if no snapshot exists.</span>
        </div>
        <p className="sub" style={{ marginTop: 6 }}>
          Watchlist names are held to the <b>same standard as discovered ones</b>: the setup must be
          graded <b>CONFIRMED</b> by Vol Desk, then flow and the intraday trigger must agree.
          Adding a ticker here says "always check this one" — not "buy this one".
          Skips appear in the log as <code>NOT_CONFIRMED</code> with the failing filters.
        </p>
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
