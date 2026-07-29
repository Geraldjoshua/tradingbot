import { useState } from "react";
import { runBacktest } from "../api";
import type { BacktestResponse } from "../types";
import Chart from "./Chart";
import StatsPanel from "./StatsPanel";

function defaultRange() {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - 60);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return { start: iso(start), end: iso(end) };
}

export default function BacktestView() {
  const dr = defaultRange();
  const [symbols, setSymbols] = useState("NVDA,TSLA,AMD,PLTR,AAL,NU,LCID");
  const [start, setStart] = useState(dr.start);
  const [end, setEnd] = useState(dr.end);
  const [gapMin, setGapMin] = useState(1.0);
  const [gapMax, setGapMax] = useState(2.5);
  const [rTarget, setRTarget] = useState(2);
  const [risk, setRisk] = useState(100);
  const [optionMode, setOptionMode] = useState(false);
  const [dte, setDte] = useState(3);
  const [iv, setIv] = useState(0); // 0 = use realized vol
  const [riskPremium, setRiskPremium] = useState(150);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [resp, setResp] = useState<BacktestResponse | null>(null);
  const [viewSym, setViewSym] = useState("");

  async function run() {
    setBusy(true);
    setErr("");
    try {
      const syms = symbols.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
      const data = await runBacktest({
        symbols: syms,
        start: new Date(start).toISOString(),
        end: new Date(end + "T23:59:59").toISOString(),
        timeframe: "15Min",
        params: {
          gapMin: gapMin / 100,
          gapMax: gapMax / 100,
          rTarget,
          riskPerTrade: risk,
          optionMode,
          dte,
          iv: iv > 0 ? iv / 100 : undefined,
          riskPremium,
        },
      });
      setResp(data);
      setViewSym(syms[0] || "");
    } catch (e: any) {
      setErr(e.message || String(e));
      setResp(null);
    } finally {
      setBusy(false);
    }
  }

  const cur = resp && viewSym ? resp.results[viewSym] : null;

  return (
    <div>
      <div className="panel">
        <div className="row">
          <div className="field" style={{ flex: 1, minWidth: 260 }}>
            <label>Tickers (comma-separated)</label>
            <input value={symbols} onChange={(e) => setSymbols(e.target.value)} />
          </div>
          <div className="field">
            <label>Start</label>
            <input type="date" value={start} onChange={(e) => setStart(e.target.value)} />
          </div>
          <div className="field">
            <label>End</label>
            <input type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
          </div>
        </div>
        <div className="row" style={{ marginTop: 12 }}>
          <div className="field">
            <label>Gap min %</label>
            <input type="number" step="0.1" value={gapMin} onChange={(e) => setGapMin(+e.target.value)} />
          </div>
          <div className="field">
            <label>Gap max %</label>
            <input type="number" step="0.1" value={gapMax} onChange={(e) => setGapMax(+e.target.value)} />
          </div>
          <div className="field">
            <label>Target (R)</label>
            <input type="number" step="0.5" value={rTarget} onChange={(e) => setRTarget(+e.target.value)} />
          </div>
          <div className="field">
            <label>Risk / trade ($)</label>
            <input type="number" step="10" value={risk} onChange={(e) => setRisk(+e.target.value)} />
          </div>
          <div className="field">
            <label>Instrument</label>
            <select value={optionMode ? "options" : "stock"} onChange={(e) => setOptionMode(e.target.value === "options")}>
              <option value="stock">Stock</option>
              <option value="options">Options (modeled)</option>
            </select>
          </div>
          <button className="primary" onClick={run} disabled={busy}>
            {busy ? "Running…" : "Run backtest"}
          </button>
        </div>

        {optionMode && (
          <div className="row" style={{ marginTop: 12 }}>
            <div className="field">
              <label>Days to expiry</label>
              <input type="number" step="1" value={dte} onChange={(e) => setDte(+e.target.value)} />
            </div>
            <div className="field">
              <label>IV % (0 = realized)</label>
              <input type="number" step="1" value={iv} onChange={(e) => setIv(+e.target.value)} />
            </div>
            <div className="field">
              <label>Premium / trade ($)</label>
              <input type="number" step="10" value={riskPremium} onChange={(e) => setRiskPremium(+e.target.value)} />
            </div>
            <p className="hint" style={{ flex: 1, minWidth: 240, alignSelf: "center", margin: 0 }}>
              Buys an ~ATM {`{call on gap-up, put on gap-down}`}, priced with Black-Scholes.
              Modeled estimate — assumes constant IV & mid fills (Alpaca gives no live greeks/OI here).
            </p>
          </div>
        )}

        <p className="hint" style={{ marginTop: 10 }}>
          15-min bars · opening-range breakout · trade in the gap's direction when 1R = ${risk} risk.
          Data feed is set server-side (SIP/IEX).
        </p>
      </div>

      {err && <div className="err">Error: {err}</div>}

      {resp && (
        <>
          <StatsPanel stats={resp.pooled} title="Pooled — all tickers" />

          <div className="panel">
            <div className="spread" style={{ marginBottom: 12 }}>
              <strong>Chart</strong>
              <select value={viewSym} onChange={(e) => setViewSym(e.target.value)}>
                {Object.keys(resp.results).map((s) => (
                  <option key={s} value={s}>
                    {s} ({resp.results[s].trades.length} trades)
                  </option>
                ))}
              </select>
            </div>
            {cur && <Chart bars={cur.bars} trades={cur.trades} />}
            {cur && (
              <div style={{ marginTop: 16 }}>
                <StatsPanel stats={cur.stats} title={`${viewSym} — per-symbol`} />
              </div>
            )}
          </div>

          {cur && cur.option && (
            <div className="panel">
              <div className="spread" style={{ marginBottom: 12 }}>
                <strong>{viewSym} — modeled options overlay</strong>
                <span className="hint">IV used: {(cur.option.ivUsed * 100).toFixed(1)}% · {cur.option.trades.length} legs</span>
              </div>
              <div className="stats-grid">
                <div className="stat"><div className="k">Option win rate</div><div className="v">{(cur.option.stats.winRate * 100).toFixed(1)}%</div></div>
                <div className="stat"><div className="k">Total P/L</div><div className={`v ${cur.option.stats.totalPnl >= 0 ? "pos" : "neg"}`}>${cur.option.stats.totalPnl.toFixed(0)}</div></div>
                <div className="stat"><div className="k">Avg ROI / trade</div><div className={`v ${cur.option.stats.avgRoi >= 0 ? "pos" : "neg"}`}>{(cur.option.stats.avgRoi * 100).toFixed(0)}%</div></div>
                <div className="stat"><div className="k">Return on capital</div><div className={`v ${cur.option.stats.returnOnCapital >= 0 ? "pos" : "neg"}`}>{(cur.option.stats.returnOnCapital * 100).toFixed(0)}%</div></div>
                <div className="stat"><div className="k">Capital deployed</div><div className="v">${cur.option.stats.totalCost.toFixed(0)}</div></div>
                <div className="stat"><div className="k">Wins / Losses</div><div className="v">{cur.option.stats.wins} / {cur.option.stats.losses}</div></div>
              </div>
              <div className="tablewrap" style={{ marginTop: 12 }}>
                <table>
                  <thead>
                    <tr><th>Date</th><th>Type</th><th>Strike</th><th>DTE</th><th>Qty</th><th>Prem in</th><th>Prem out</th><th>Δ</th><th>Cost</th><th>P/L</th><th>ROI</th></tr>
                  </thead>
                  <tbody>
                    {cur.option.trades.map((o, i) => (
                      <tr key={i}>
                        <td>{o.date}</td>
                        <td><span className={`badge ${o.type === "call" ? "long" : "short"}`}>{o.type}</span></td>
                        <td>{o.strike}</td>
                        <td>{o.dte}</td>
                        <td>{o.contracts}</td>
                        <td>{o.premiumIn.toFixed(2)}</td>
                        <td>{o.premiumOut.toFixed(2)}</td>
                        <td>{o.entryDelta.toFixed(2)}</td>
                        <td>${o.cost.toFixed(0)}</td>
                        <td className={o.pnl >= 0 ? "pos" : "neg"}>${o.pnl.toFixed(0)}</td>
                        <td className={o.roi >= 0 ? "pos" : "neg"}>{(o.roi * 100).toFixed(0)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="hint" style={{ marginTop: 8 }}>
                Modeled via Black-Scholes on the underlying's move — not tick-accurate fills. Assumes ATM strike,
                fixed DTE, constant IV, and mid prices. Real options add spread + IV-crush risk.
              </p>
            </div>
          )}

          {cur && (
            <div className="panel">
              <strong>{viewSym} trades</strong>
              <div className="tablewrap" style={{ marginTop: 10 }}>
                <table>
                  <thead>
                    <tr>
                      <th>Date</th><th>Side</th><th>Gap%</th><th>Entry</th>
                      <th>Stop</th><th>Target</th><th>Exit</th><th>Out</th>
                      <th>Shares</th><th>R</th><th>P/L</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cur.trades.map((t, i) => (
                      <tr key={i}>
                        <td>{t.date}</td>
                        <td><span className={`badge ${t.side}`}>{t.side}</span></td>
                        <td>{(t.gap * 100).toFixed(2)}</td>
                        <td>{t.entry.toFixed(2)}</td>
                        <td>{t.stop.toFixed(2)}</td>
                        <td>{t.target.toFixed(2)}</td>
                        <td>{t.exitPrice.toFixed(2)}</td>
                        <td>{t.outcome}</td>
                        <td>{t.shares}</td>
                        <td className={t.r >= 0 ? "pos" : "neg"}>{t.r >= 0 ? "+" : ""}{t.r.toFixed(2)}</td>
                        <td className={t.pnl >= 0 ? "pos" : "neg"}>${t.pnl.toFixed(0)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
