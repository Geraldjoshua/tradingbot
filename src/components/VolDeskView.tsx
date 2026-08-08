import { useEffect, useState } from "react";
import { runVolDesk, voldeskEnter, voldeskPositions, voldeskExit, voldeskLock } from "../api";
import type { VolDeskSnapshot, VolDeskPosition } from "../types";

const ACTION_COLOR: Record<string, string> = {
  HOLD: "var(--green)", T1_HIT: "var(--accent)", WATCH: "#e0b341", EXIT: "var(--red)",
  // T1_INFO: target reached on a protect-mode position, deliberately not sold.
  T1_INFO: "var(--accent)", T2_HIT: "var(--accent)",
};

// A share position has no strike and no expiry. Reading them unguarded is what
// blanked this tab: `p.expiry.slice(5)` on a shares row throws, and with no error
// boundary React unmounted the whole page.
function describeInstrument(p: VolDeskPosition): string {
  if (p.instrument === "shares") return `${p.shares ?? "?"} sh`;
  const strike = p.strike != null ? `${p.strike}${p.optionType === "put" ? "p" : "c"}` : "?";
  const exp = p.expiry ? ` ${p.expiry.slice(5)}` : "";
  return `${strike}${exp}`;
}

function positionQty(p: VolDeskPosition): number | string {
  return p.instrument === "shares" ? (p.shares ?? "—") : (p.contracts ?? "—");
}

function entryOf(p: VolDeskPosition): number | string {
  const v = p.instrument === "shares" ? p.entryPrice : p.entryPremium;
  return v ?? "—";
}

const TAG_COLOR: Record<string, string> = {
  CONFIRMED: "var(--green)",
  PENDING: "#e0b341",
  BLOCKED: "var(--red)",
};

function Tag({ t }: { t: string }) {
  return (
    <span className="badge" style={{ background: "rgba(255,255,255,.06)", color: TAG_COLOR[t] || "var(--muted)", fontWeight: 700 }}>
      {t}
    </span>
  );
}

export default function VolDeskView() {
  const [tickers, setTickers] = useState(
    "NVDA,AAPL,MSFT,AMD,TSLA,META,AMZN,GOOGL,NFLX,AVGO,PLTR,COIN,MU,INTC,SOFI,UBER,DIS,BA,SHOP,MARA,F,AAL,NIO,CCL"
  );
  const [maxDte, setMaxDte] = useState(45);
  const [hideBlocked, setHideBlocked] = useState(false);
  const [requireDb, setRequireDb] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [rows, setRows] = useState<VolDeskSnapshot[]>([]);
  const [sel, setSel] = useState<VolDeskSnapshot | null>(null);

  // Phase 2: entry + positions
  const [riskPremium, setRiskPremium] = useState(1500);
  const [force, setForce] = useState(false);
  const [dteTarget, setDteTarget] = useState(45);
  const [moneyness, setMoneyness] = useState("ITM");
  const [entryMsg, setEntryMsg] = useState("");
  const [preview, setPreview] = useState<any>(null);
  const [positions, setPositions] = useState<VolDeskPosition[]>([]);
  const [posBusy, setPosBusy] = useState(false);

  async function loadPositions() {
    setPosBusy(true);
    try { setPositions((await voldeskPositions()).positions); }
    catch (e: any) { setErr(e.message || String(e)); }
    finally { setPosBusy(false); }
  }
  useEffect(() => { loadPositions(); }, []);

  // Step 1: preview the exact contract (places nothing)
  async function enter(ticker: string) {
    setEntryMsg(""); setErr(""); setPreview(null);
    try {
      const r = await voldeskEnter(ticker, riskPremium, force, false, dteTarget, moneyness);
      if (r.status === "PREVIEW") setPreview(r);
      else setEntryMsg(`Could not preview — ${r.note || r.status}`);
    } catch (e: any) { setErr(e.message || String(e)); }
  }
  // Step 2: user confirmed — actually place the order
  async function confirmBuy(ticker: string) {
    setErr("");
    try {
      const r = await voldeskEnter(ticker, riskPremium, force, true, dteTarget, moneyness);
      if (r.status === "ENTERED") {
        setEntryMsg(`ENTERED ${r.position.contracts}x ${r.position.optionSymbol} @ ~$${r.position.entryPremium} (order ${r.order.id?.slice(0, 8)})`);
        setPreview(null);
        loadPositions();
      } else {
        setEntryMsg(`Not entered — ${r.note || r.status}`);
        setPreview(null);
      }
    } catch (e: any) { setErr(e.message || String(e)); }
  }
  async function doExit(id: string, reason: string) {
    setErr("");
    try { await voldeskExit(id, reason); loadPositions(); }
    catch (e: any) { setErr(e.message || String(e)); }
  }
  async function doLock(id: string) {
    setErr("");
    try { await voldeskLock(id); loadPositions(); }
    catch (e: any) { setErr(e.message || String(e)); }
  }

  async function run() {
    setBusy(true); setErr("");
    try {
      const syms = tickers.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
      const r = await runVolDesk(syms, maxDte, requireDb);
      setRows(r.results);
      setSel(r.results[0] || null);
    } catch (e: any) { setErr(e.message || String(e)); }
    finally { setBusy(false); }
  }

  return (
    <div>
      <div className="panel">
        <div className="row">
          <div className="field" style={{ flex: 1, minWidth: 280 }}>
            <label>Tickers (comma-separated)</label>
            <input value={tickers} onChange={(e) => setTickers(e.target.value)} />
          </div>
          <div className="field">
            <label>Max DTE (days)</label>
            <input type="number" value={maxDte} onChange={(e) => setMaxDte(+e.target.value)} />
          </div>
          <div className="field">
            <label>db_change filter</label>
            <select value={requireDb ? "req" : "opt"} onChange={(e) => setRequireDb(e.target.value === "req")}>
              <option value="req">required (faithful)</option>
              <option value="opt">structure-only</option>
            </select>
          </div>
          <button className="primary" onClick={run} disabled={busy}>{busy ? "Scanning…" : "Run evening scan"}</button>
        </div>
        {!requireDb && (
          <div className="err" style={{ marginTop: 10 }}>
            ⚠ <b>Structure-only mode</b> — db_change is turned OFF as a filter. Setups qualify on the other four
            real filters (grade, cushion, spike-crash, R/R), but you're missing the day-over-day dealer-positioning
            signal the strategy calls its core edge. Weaker than the full system — use it to get moving before you
            have 2 days of data, not as the real thing.
          </div>
        )}
        <p className="hint" style={{ marginTop: 10 }}>
          Forward-test scan. Computes GEX levels (Yahoo OI + our Black-Scholes gamma), grades the setup,
          applies the five filters, and tags CONFIRMED / PENDING / BLOCKED. A daily snapshot is saved per ticker
          so <b>db_change</b> (delta-balance vs prior session) goes live from the 2nd day you run it.
          Levels (pTrans/nTrans/grade/db) are raw-GEX approximations, not the proprietary Vol Desk feed.
        </p>
      </div>

      {err && <div className="err">Error: {err}</div>}

      <div className="panel">
        <div className="spread" style={{ marginBottom: 12 }}>
          <strong>Open Vol Desk positions</strong>
          <button className="ghost" onClick={loadPositions} disabled={posBusy}>{posBusy ? "…" : "Refresh"}</button>
        </div>
        {positions.length === 0 ? (
          <p className="hint">No open positions. Enter one from a CONFIRMED setup below.</p>
        ) : (
          <>
            <div className="tablewrap">
              <table>
                <thead>
                  <tr>
                    <th>Ticker</th><th>Position</th><th>Qty</th><th>Entry</th><th>Now</th>
                    <th>P/L</th><th>Spot</th><th>Prog→T1</th><th>Stop</th><th>Days/DTE</th><th>Action</th><th></th>
                  </tr>
                </thead>
                <tbody>
                  {positions.map((p) => (
                    <tr key={p.id} style={{ background: p.urgent ? "rgba(239,83,80,.08)" : undefined }}>
                      <td>
                        {p.ticker}
                        {p.instrument === "shares" && (
                          <span className="badge" style={{ marginLeft: 4, fontSize: 10 }}>SHARES</span>
                        )}
                        {p.adopted && (
                          <span className="badge" style={{ marginLeft: 4, fontSize: 10, color: "#e0b341" }}
                            title="found at the broker and adopted — levels re-derived from a fresh scan">
                            ADOPTED
                          </span>
                        )}
                        {p.manageMode === "protect" && (
                          <span className="badge" style={{ marginLeft: 4, fontSize: 10, color: "var(--muted)" }}
                            title="protect mode: stops only. No time stop, no auto-take-profit.">
                            PROTECT
                          </span>
                        )}
                      </td>
                      <td>{describeInstrument(p)}</td>
                      <td>{positionQty(p)}</td>
                      <td>{entryOf(p)}</td>
                      <td>{p.optMid ?? "—"}</td>
                      <td className={(p.optPnl ?? 0) >= 0 ? "pos" : "neg"}
                          title={p.pnlSource === "broker"
                            ? `Alpaca unrealized_pl${p.pnlGap ? ` · our mid-based estimate said $${p.pnlEstimate} (${p.pnlGap > 0 ? "+" : ""}${p.pnlGap} off)` : ""}`
                            : "our own estimate — the broker had no row for this symbol"}>
                        {p.optPnl == null ? "—" : `$${p.optPnl}`}
                        {/* A large gap means the bid/ask is wide enough that the mid
                            is not a price you could get. Worth seeing before you
                            decide whether a winner is really a winner. */}
                        {p.pnlGap != null && Math.abs(p.pnlGap) >= 100 && (
                          <span style={{ color: "#e0b341", fontSize: 10 }} title={
                            `Our mid-based estimate was $${p.pnlEstimate}, $${Math.abs(p.pnlGap)} `
                            + `${p.pnlGap > 0 ? "higher" : "lower"} than the broker. Wide spread — `
                            + `the mid is not a fill.`}> ⚠</span>
                        )}
                        {p.pnlSource === "estimate" && (
                          <span style={{ color: "var(--muted)", fontSize: 10 }}
                            title="estimate: the broker has no position row for this symbol"> ~</span>
                        )}
                      </td>
                      <td title={p.spotFeed === "broker" ? "broker mark"
                        : p.spotFeed === "iex" ? "real-time (IEX)"
                        : p.spotFeed === "delayed_sip" ? "15-MIN DELAYED — stops are evaluated on this"
                        : undefined}>
                        {p.currentSpot ?? "—"}
                        {p.spotFeed === "delayed_sip" && (
                          <span style={{ color: "#e0b341", fontSize: 10 }} title="15-minute delayed feed"> ⏱</span>
                        )}
                      </td>
                      <td>{p.progressPct}%</td>
                      <td title={p.stopRatchet ? `ratcheted to ${p.stopRatchet.movedTo} on ${p.stopRatchet.on}` : undefined}>
                        {p.effectiveStop ?? p.stopLevel ?? "—"}
                        {p.lockedToBreakeven && <span style={{ color: "var(--green)" }} title="stop moved to entry or better"> ●</span>}
                      </td>
                      <td>{p.daysHeld}{p.dteLeft != null ? ` / ${p.dteLeft}d` : ""}</td>
                      <td style={{ color: ACTION_COLOR[p.action], fontWeight: 700 }}>{(p.action || "—").replace(/_/g, " ")}</td>
                      <td style={{ whiteSpace: "nowrap" }}>
                        {p.action === "T1_HIT" && <button className="ghost" onClick={() => doLock(p.id)}>Lock</button>}{" "}
                        <button className="ghost danger" onClick={() => doExit(p.id, p.reason)}>Exit</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {(() => {
              const gaps = positions.filter((p) => p.pnlGap != null && Math.abs(p.pnlGap!) >= 100);
              const total = positions.reduce((a, p) => a + (p.optPnl ?? 0), 0);
              return (
                <p className="hint" style={{ marginTop: 6 }}>
                  Total unrealized <b className={total >= 0 ? "pos" : "neg"}>${total.toFixed(0)}</b>
                  {" — from Alpaca's own numbers, so this matches the Paper trading tab."}
                  {gaps.length > 0 && (
                    <> {" "}⚠ {gaps.length} position{gaps.length > 1 ? "s" : ""} where our mid-based
                    estimate differs by over $100 ({gaps.map((g) => g.ticker).join(", ")}) — wide
                    spreads, so the mid is not a price you could get out at.</>
                  )}
                </p>
              );
            })()}
            <div style={{ marginTop: 8 }}>
              {positions.map((p) => (
                <p key={p.id} className="hint" style={{ margin: "2px 0" }}>
                  <b style={{ color: ACTION_COLOR[p.action] || "var(--muted)" }}>
                    {p.ticker} {(p.action || "—").replace(/_/g, " ")}
                  </b> — {p.reason}
                </p>
              ))}
            </div>
          </>
        )}
      </div>

      {rows.length > 0 && (() => {
        const counts = rows.reduce((a: Record<string, number>, r) => {
          const k = r.error ? "ERROR" : r.tag; a[k] = (a[k] || 0) + 1; return a;
        }, {});
        const displayed = hideBlocked ? rows.filter((r) => r.tag === "CONFIRMED" || r.tag === "PENDING") : rows;
        return (
        <div className="panel">
          <div className="spread" style={{ marginBottom: 8 }}>
            <strong>Setups &nbsp;
              <span style={{ color: "var(--green)" }}>{counts.CONFIRMED || 0} confirmed</span> ·{" "}
              <span style={{ color: "#e0b341" }}>{counts.PENDING || 0} pending</span> ·{" "}
              <span style={{ color: "var(--muted)" }}>{counts.BLOCKED || 0} blocked{counts.ERROR ? ` · ${counts.ERROR} err` : ""}</span>
            </strong>
            <label style={{ fontSize: 12, color: "var(--muted)", display: "flex", gap: 6, alignItems: "center", cursor: "pointer" }}>
              <input type="checkbox" checked={hideBlocked} onChange={(e) => setHideBlocked(e.target.checked)} style={{ minWidth: 0 }} />
              show confirmed/pending only
            </label>
          </div>
          {displayed.length === 0 && <p className="hint">No confirmed/pending setups. Uncheck the filter to see blocked names, or run again tomorrow so db_change activates.</p>}
          <div className="tablewrap" style={{ marginTop: 4 }}>
            <table>
              <thead>
                <tr>
                  <th>#</th><th>Ticker</th><th>Tag</th><th>Spot</th><th>pTrans</th><th>nTrans</th>
                  <th>+GEX/T1</th><th>Grade</th><th>R/R</th><th title="R/R measured from spot — the price you would actually fill at, rather than from pTrans">R/R fill</th><th>Ext%</th><th>Cush%</th><th>db→Δ</th><th>Mnv</th><th>Why blocked</th>
                </tr>
              </thead>
              <tbody>
                {displayed.map((r, i) => (
                  <tr key={r.ticker} onClick={() => setSel(r)} style={{ cursor: "pointer", background: sel?.ticker === r.ticker ? "var(--panel2)" : undefined }}>
                    <td style={{ color: "var(--muted)" }}>{i + 1}</td>
                    <td>{r.ticker}</td>
                    <td>{r.error ? <span className="neg">ERR</span> : <Tag t={r.tag} />}</td>
                    <td>{r.spot}</td>
                    <td>{r.levels?.pTrans}</td>
                    <td>{r.levels?.nTrans}</td>
                    <td>{r.levels?.plusGEX_T1}</td>
                    <td>{r.grade}/11{r.deep ? " D" : ""}</td>
                    <td>{r.rr}</td>
                    {/* Red once the fill ratio drops under 2: at that point the
                        trade you'd get is not the trade the row is advertising,
                        and on an option the gap is where the expectancy goes. */}
                    <td style={{ color: r.rr_at_fill == null ? undefined
                      : r.rr_at_fill < 2 ? "var(--red)" : "var(--green)" }}>
                      {r.rr_at_fill ?? "—"}
                    </td>
                    <td style={{ color: (r.extension_pct ?? 0) > 3 ? "var(--red)" : undefined }}>
                      {r.extension_pct ?? "—"}
                    </td>
                    <td>{r.cushion_pct}</td>
                    <td>{r.db?.toFixed(2)}{r.db_change != null ? ` (${r.db_change >= 0 ? "+" : ""}${r.db_change.toFixed(2)})` : " (—)"}</td>
                    <td>{r.minervini}/8</td>
                    <td style={{ textAlign: "left", color: "var(--muted)" }}>{r.error ? r.error.slice(0, 40) : r.filter_reasons?.join(", ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        );
      })()}

      {sel && !sel.error && (
        <div className="panel">
          <div className="spread" style={{ marginBottom: 12 }}>
            <strong>{sel.ticker} detail</strong>
            <span className="hint">{sel.date} · spot ${sel.spot}</span>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
            <div>
              <div className="k" style={{ marginBottom: 6 }}>LEVEL LADDER</div>
              {[
                ["T2 (COTMC)", sel.levels.T2],
                ["+GEX / T1 (target)", sel.levels.plusGEX_T1],
                ["spot", sel.spot],
                ["pTrans (entry)", sel.levels.pTrans],
                ["zeroGEX (flip)", sel.levels.zeroGEX],
                ["nTrans (stop)", sel.levels.nTrans],
                ["COTMP", sel.levels.COTMP],
              ].map(([label, v]) => (
                <div key={label as string} style={{ display: "flex", justifyContent: "space-between", padding: "3px 0", borderBottom: "1px solid var(--border)", color: label === "spot" ? "var(--accent)" : undefined, fontWeight: label === "spot" ? 700 : 400 }}>
                  <span>{label}</span><span>{v as number}</span>
                </div>
              ))}
            </div>

            <div>
              <div className="k" style={{ marginBottom: 6 }}>FIVE FILTERS</div>
              {Object.entries(sel.filters).map(([k, v]) => (
                <div key={k} style={{ display: "flex", justifyContent: "space-between", padding: "3px 0" }}>
                  <span>{k}</span><span className={v ? "pos" : "neg"}>{v ? "PASS" : "FAIL"}</span>
                </div>
              ))}
              <div className="k" style={{ margin: "12px 0 6px" }}>REGIME GATES ({sel.regime.gates_passed}/3)</div>
              <div style={{ display: "flex", justifyContent: "space-between" }}><span>basket (SPY {sel.regime.spy_chg}% / QQQ {sel.regime.qqq_chg}%)</span><span className={sel.regime.basket_gate ? "pos" : "neg"}>{sel.regime.basket_gate ? "PASS" : "FAIL"}</span></div>
              <div style={{ display: "flex", justifyContent: "space-between" }}><span>VIX ({sel.regime.vix_chg ?? "—"}%)</span><span className={sel.regime.vix_gate ? "pos" : "neg"}>{sel.regime.vix_gate ? "PASS" : "FAIL"}</span></div>
              {/* Which VIX you actually got. The proxy is a different number
                  from the index, so a reading that silently swapped sources
                  would be misleading rather than merely approximate. */}
              {sel.regime.vix_source && sel.regime.vix_source !== "yahoo ^VIX" && (
                <div className="hint" style={{ margin: "2px 0 0 0", fontSize: 11 }}>
                  ⚠ {sel.regime.vix_source}
                  {String(sel.regime.vix_source).startsWith("VIXY") &&
                    " — a VIX futures ETF, so this % includes roll decay and is not the index's move. Direction is what the gate tests."}
                </div>
              )}
              {sel.regime.regime_source && sel.regime.regime_source !== "alpaca" && (
                <div className="hint" style={{ margin: "2px 0 0 0", fontSize: 11 }}>
                  ⚠ basket from {sel.regime.regime_source}
                </div>
              )}
              <div style={{ display: "flex", justifyContent: "space-between" }}><span>bull:bear (700 names)</span><span className="hint">n/a</span></div>
            </div>
          </div>

          <div className="k" style={{ margin: "14px 0 6px" }}>GRADE RULES ({sel.grade}/11)</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {Object.entries(sel.grade_rules).map(([k, v]) => (
              <span key={k} className="badge" style={{ background: "rgba(255,255,255,.05)", color: v ? "var(--green)" : "var(--red)" }}>
                {v ? "✓" : "✕"} {k}
              </span>
            ))}
          </div>

          <div style={{ marginTop: 16, padding: 12, background: "var(--panel2)", borderRadius: 8 }}>
            <div className="spread" style={{ marginBottom: 8 }}>
              <strong>Take this trade (paper)</strong>
              <Tag t={sel.tag} />
            </div>
            <div className="row">
              <div className="field"><label>Premium budget ($)</label>
                <input type="number" value={riskPremium} onChange={(e) => setRiskPremium(+e.target.value)} /></div>
              <div className="field"><label>DTE target</label>
                <input type="number" value={dteTarget} onChange={(e) => setDteTarget(+e.target.value)} /></div>
              <div className="field"><label>Moneyness</label>
                <select value={moneyness} onChange={(e) => setMoneyness(e.target.value)}>
                  <option value="ITM">ITM (in the money)</option>
                  <option value="ATM">ATM (at the money)</option>
                  <option value="OTM">OTM (out of the money)</option>
                </select></div>
              <div className="field"><label>Force (ignore trigger)</label>
                <select value={force ? "y" : "n"} onChange={(e) => setForce(e.target.value === "y")}>
                  <option value="n">no</option><option value="y">yes</option>
                </select></div>
              <button className="primary" onClick={() => enter(sel.ticker)}>Preview {sel.ticker} call</button>
            </div>
            <p className="hint" style={{ marginTop: 8 }}>
              Picks a ~{dteTarget}-DTE {moneyness} call and shows it below. Nothing is bought until you click <b>Confirm buy</b>.
              {sel.tag !== "CONFIRMED" && " ⚠ Not CONFIRMED — only place with Force, for testing."}
            </p>

            {preview && preview.ticker === sel.ticker && (
              <div style={{ marginTop: 12, padding: 12, border: "1px solid var(--border)", borderRadius: 8, background: "var(--panel)" }}>
                <div className="k" style={{ marginBottom: 8 }}>ORDER PREVIEW — review before buying</div>
                <div className="stats-grid">
                  <div className="stat"><div className="k">Contract</div><div className="v" style={{ fontSize: 14 }}>{preview.contract.strike} Call · {preview.contract.moneyness}</div></div>
                  <div className="stat"><div className="k">Expiry</div><div className="v" style={{ fontSize: 14 }}>{preview.contract.expiry} ({preview.contract.dte}d)</div></div>
                  <div className="stat"><div className="k">Premium (mid)</div><div className="v">${preview.premium?.toFixed(2)}</div></div>
                  <div className="stat"><div className="k">Bid / Ask</div><div className="v" style={{ fontSize: 14 }}>{preview.contract.bid ?? "—"} / {preview.contract.ask ?? "—"}</div></div>
                  <div className="stat"><div className="k">Contracts</div><div className="v">{preview.contracts}</div></div>
                  <div className="stat"><div className="k">Total cost (max loss)</div><div className={`v ${preview.overBudget ? "neg" : ""}`}>${preview.cost?.toFixed(0)}</div></div>
                </div>
                {preview.overBudget && (
                  <div className="err" style={{ marginTop: 10 }}>
                    ⚠ One contract costs ${(preview.premium * 100).toFixed(0)} — more than your ${preview.budget} budget.
                    Buying the minimum 1 contract will cost <b>${preview.cost.toFixed(0)}</b>. Raise the budget, pick a different name, or confirm to spend ${preview.cost.toFixed(0)}.
                  </div>
                )}
                <p className="hint" style={{ marginTop: 8 }}>{preview.triggerNote}</p>
                <div className="row" style={{ marginTop: 8 }}>
                  <button className="primary" onClick={() => confirmBuy(sel.ticker)}>Confirm buy · ${preview.cost.toFixed(0)}</button>
                  <button className="ghost" onClick={() => setPreview(null)}>Cancel</button>
                </div>
              </div>
            )}
            {entryMsg && <div className="hint" style={{ marginTop: 6, color: "var(--text)" }}>{entryMsg}</div>}
          </div>

          <p className="hint" style={{ marginTop: 12 }}>
            db = call-gamma / (call+put gamma) in [0,1]; db_change needs a prior day's snapshot ({sel.db_status}).
            Grade rules and the pTrans/nTrans mapping are our raw-GEX proxies — tune them to match your real Vol Desk feed.
          </p>
        </div>
      )}
    </div>
  );
}
