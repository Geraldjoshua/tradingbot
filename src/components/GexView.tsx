import { useState } from "react";
import { getGex } from "../api";
import type { GexResult } from "../types";

function fmtB(n: number) {
  const a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return n.toFixed(0);
}

export default function GexView() {
  const [symbol, setSymbol] = useState("SPY");
  const [maxDte, setMaxDte] = useState(45);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [gex, setGex] = useState<GexResult | null>(null);

  async function run() {
    setBusy(true); setErr("");
    try {
      setGex(await getGex(symbol.toUpperCase(), 4, maxDte));
    } catch (e: any) { setErr(e.message || String(e)); setGex(null); }
    finally { setBusy(false); }
  }

  // window the profile to ±8% around spot for a readable chart
  const windowed = gex
    ? gex.profile.filter((p) => Math.abs(p.strike - gex.spot) <= gex.spot * 0.08)
    : [];
  const maxAbs = Math.max(1, ...windowed.map((p) => Math.abs(p.gex)));

  return (
    <div>
      <div className="panel">
        <div className="row">
          <div className="field"><label>Underlying</label>
            <input value={symbol} onChange={(e) => setSymbol(e.target.value)} /></div>
          <div className="field"><label>Max DTE (days)</label>
            <input type="number" value={maxDte} onChange={(e) => setMaxDte(+e.target.value)} /></div>
          <button className="primary" onClick={run} disabled={busy}>{busy ? "Computing…" : "Compute GEX"}</button>
        </div>
        <p className="hint" style={{ marginTop: 10 }}>
          Open interest + IV pulled from Yahoo (yfinance); gamma computed via Black-Scholes.
          Aggregates the nearest expiries within Max DTE. Dealer convention: long calls, short puts.
        </p>
      </div>

      {err && <div className="err">Error: {err}</div>}

      {gex && (
        <>
          <div className="panel">
            <div className="spread" style={{ marginBottom: 12 }}>
              <strong>{gex.symbol} — dealer gamma exposure</strong>
              <span className="hint">expiries: {gex.expiries.join(", ")}</span>
            </div>
            <div className="stats-grid">
              <div className="stat"><div className="k">Spot</div><div className="v">${gex.spot}</div></div>
              <div className="stat"><div className="k">Gamma flip</div><div className="v">{gex.gammaFlip ?? "—"}</div></div>
              <div className="stat"><div className="k">Regime</div>
                <div className={`v ${gex.regime === "long_gamma" ? "pos" : "neg"}`}>
                  {gex.regime === "long_gamma" ? "Long γ" : gex.regime === "short_gamma" ? "Short γ" : "—"}
                </div></div>
              <div className="stat"><div className="k">Call wall (resist.)</div><div className="v pos">{gex.callWall.strike}</div></div>
              <div className="stat"><div className="k">Put wall (support)</div><div className="v neg">{gex.putWall.strike}</div></div>
              <div className="stat"><div className="k">Total GEX /1%</div>
                <div className={`v ${gex.totalGex >= 0 ? "pos" : "neg"}`}>{fmtB(gex.totalGex)}</div></div>
            </div>
            <p className="hint" style={{ marginTop: 10 }}>
              {gex.regime === "long_gamma"
                ? "Spot above flip → dealers long gamma → moves tend to get dampened (mean-revert)."
                : "Spot below flip → dealers short gamma → moves tend to get amplified (trend/vol up)."}
            </p>
          </div>

          <div className="panel">
            <strong>GEX by strike (±8% of spot)</strong>
            <div style={{ marginTop: 12 }}>
              {windowed.map((p) => {
                const pct = (p.gex / maxAbs) * 50; // half-width %
                const isSpot = Math.abs(p.strike - gex.spot) < gex.spot * 0.0025;
                const isFlip = gex.gammaFlip != null && Math.abs(p.strike - gex.gammaFlip) < gex.spot * 0.0025;
                return (
                  <div key={p.strike} style={{ display: "flex", alignItems: "center", height: 18, fontSize: 11 }}>
                    <div style={{ width: 54, textAlign: "right", paddingRight: 8, color: isSpot ? "var(--accent)" : isFlip ? "#e0b341" : "var(--muted)", fontWeight: isSpot || isFlip ? 700 : 400 }}>
                      {p.strike}{isSpot ? " ◄spot" : isFlip ? " ◄flip" : ""}
                    </div>
                    <div style={{ position: "relative", flex: 1, height: "100%", borderLeft: "1px solid var(--border)" }}>
                      <div style={{ position: "absolute", left: "50%", top: 0, bottom: 0, width: 1, background: "var(--border)" }} />
                      <div style={{
                        position: "absolute", top: 3, bottom: 3,
                        left: p.gex >= 0 ? "50%" : `${50 + pct}%`,
                        width: `${Math.abs(pct)}%`,
                        background: p.gex >= 0 ? "var(--green)" : "var(--red)",
                        opacity: 0.8, borderRadius: 2,
                      }} />
                    </div>
                  </div>
                );
              })}
            </div>
            <p className="hint" style={{ marginTop: 10 }}>
              Green = positive GEX (dealers buy dips / sell rips near these strikes → resistance-ish).
              Red = negative GEX (support-ish). Biggest bars are the call/put walls.
            </p>
          </div>
        </>
      )}
    </div>
  );
}
