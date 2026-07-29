import { useState } from "react";
import { getFaber } from "../api";
import type { FaberResult } from "../types";
import LineChart from "./LineChart";
import type { Time, SeriesMarker, UTCTimestamp } from "lightweight-charts";

function Row({ k, s, b, better }: { k: string; s: string; b: string; better?: "strat" | "bh" }) {
  return (
    <tr>
      <td style={{ textAlign: "left", color: "var(--muted)" }}>{k}</td>
      <td className={better === "strat" ? "pos" : ""}>{s}</td>
      <td className={better === "bh" ? "pos" : ""}>{b}</td>
    </tr>
  );
}

export default function FaberView() {
  const [symbol, setSymbol] = useState("SPY");
  const [sma, setSma] = useState(10);
  const [startYear, setStartYear] = useState<number | "">("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [r, setR] = useState<FaberResult | null>(null);

  async function run() {
    setBusy(true); setErr("");
    try {
      const d = await getFaber(symbol.toUpperCase(), sma, startYear === "" ? undefined : Number(startYear));
      if (d.error) { setErr(d.error); setR(null); } else setR(d);
    } catch (e: any) { setErr(e.message || String(e)); setR(null); }
    finally { setBusy(false); }
  }

  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const pct0 = (x: number) => `${(x * 100).toFixed(0)}%`;

  // buy/sell markers from trades
  const markers: SeriesMarker<Time>[] = r
    ? r.trades.flatMap((t) => {
        const m: SeriesMarker<Time>[] = [{
          time: (Date.parse(t.entryDate) / 1000) as UTCTimestamp as unknown as Time,
          position: "belowBar", color: "#26a69a", shape: "arrowUp", text: "BUY",
        }];
        if (t.exitDate !== "OPEN")
          m.push({
            time: (Date.parse(t.exitDate) / 1000) as UTCTimestamp as unknown as Time,
            position: "aboveBar", color: "#ef5350", shape: "arrowDown", text: "SELL",
          });
        return m;
      })
    : [];

  return (
    <div>
      <div className="panel">
        <div className="row">
          <div className="field"><label>Symbol</label>
            <input value={symbol} onChange={(e) => setSymbol(e.target.value)} /></div>
          <div className="field"><label>SMA (months)</label>
            <input type="number" value={sma} onChange={(e) => setSma(+e.target.value)} /></div>
          <div className="field"><label>Start year (optional)</label>
            <input type="number" placeholder="max" value={startYear} onChange={(e) => setStartYear(e.target.value === "" ? "" : +e.target.value)} /></div>
          <button className="primary" onClick={run} disabled={busy}>{busy ? "Running…" : "Run Faber backtest"}</button>
        </div>
        <p className="hint" style={{ marginTop: 10 }}>
          <b>Meb Faber timing model:</b> long when the monthly close is above its {sma}-month SMA, in cash when below.
          Monthly data from Yahoo (decades of history). Long/flat only — compared against buy-and-hold.
        </p>
      </div>

      {err && <div className="err">Error: {err}</div>}

      {r && (
        <>
          <div className="panel">
            <div className="spread" style={{ marginBottom: 12 }}>
              <strong>{r.symbol} · {r.smaMonths}-month timing model</strong>
              <span className="hint">{r.start} → {r.end} · {r.months} months</span>
            </div>
            <table style={{ maxWidth: 460 }}>
              <thead><tr><th style={{ textAlign: "left" }}>Metric</th><th>Faber</th><th>Buy &amp; Hold</th></tr></thead>
              <tbody>
                <Row k="CAGR" s={pct(r.strat.cagr)} b={pct(r.bh.cagr)} better={r.strat.cagr > r.bh.cagr ? "strat" : "bh"} />
                <Row k="Total return" s={pct0(r.strat.totalReturn)} b={pct0(r.bh.totalReturn)} better={r.strat.totalReturn > r.bh.totalReturn ? "strat" : "bh"} />
                <Row k="Max drawdown" s={`-${pct(r.strat.maxDrawdown)}`} b={`-${pct(r.bh.maxDrawdown)}`} better={r.strat.maxDrawdown < r.bh.maxDrawdown ? "strat" : "bh"} />
                <Row k="Volatility (ann.)" s={pct(r.strat.vol)} b={pct(r.bh.vol)} better={r.strat.vol < r.bh.vol ? "strat" : "bh"} />
                <Row k="Sharpe" s={r.strat.sharpe.toFixed(2)} b={r.bh.sharpe.toFixed(2)} better={r.strat.sharpe > r.bh.sharpe ? "strat" : "bh"} />
                <Row k="Time in market" s={pct0(r.strat.timeInMarket)} b="100%" />
                <Row k="Trades / win rate" s={`${r.strat.nTrades} · ${pct0(r.strat.winRate)}`} b="—" />
              </tbody>
            </table>
            <p className="hint" style={{ marginTop: 10 }}>
              The model's edge is usually <b>risk reduction</b> — similar or slightly lower return with a much smaller
              drawdown and higher Sharpe, by sitting in cash during sustained downtrends.
            </p>
          </div>

          <div className="panel">
            <strong>Price vs {r.smaMonths}-mo SMA (BUY / SELL signals)</strong>
            <div style={{ marginTop: 10 }}>
              <LineChart
                lines={[
                  { color: "#4c9aff", data: r.series.map((p) => ({ date: p.date, value: p.close })), lineWidth: 2 },
                  { color: "#e0b341", data: r.series.map((p) => ({ date: p.date, value: p.sma })), lineWidth: 1 },
                ]}
                markers={markers}
                height={340}
              />
            </div>
            <p className="hint" style={{ marginTop: 6 }}>Blue = price · yellow = {r.smaMonths}-mo SMA · ▲ BUY (cross above) · ▼ SELL (cross below → cash)</p>
          </div>

          <div className="panel">
            <strong>Growth of $1 — Faber vs Buy &amp; Hold</strong>
            <div style={{ marginTop: 10 }}>
              <LineChart
                lines={[
                  { color: "#26a69a", data: r.equity.map((p) => ({ date: p.date, value: p.strat })), lineWidth: 2 },
                  { color: "#8a93a0", data: r.equity.map((p) => ({ date: p.date, value: p.bh })), lineWidth: 1 },
                ]}
                height={300}
              />
            </div>
            <p className="hint" style={{ marginTop: 6 }}>Green = Faber timing · gray = buy &amp; hold</p>
          </div>

          <div className="panel">
            <strong>Trades ({r.trades.length})</strong>
            <div className="tablewrap" style={{ marginTop: 10 }}>
              <table>
                <thead><tr><th>Buy date</th><th>Buy px</th><th>Sell date</th><th>Sell px</th><th>Months</th><th>Return</th></tr></thead>
                <tbody>
                  {r.trades.slice().reverse().map((t, i) => (
                    <tr key={i}>
                      <td>{t.entryDate}</td>
                      <td>{t.entryPrice}</td>
                      <td>{t.exitDate}</td>
                      <td>{t.exitPrice}</td>
                      <td>{t.months}</td>
                      <td className={t.ret >= 0 ? "pos" : "neg"}>{t.ret >= 0 ? "+" : ""}{(t.ret * 100).toFixed(1)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
