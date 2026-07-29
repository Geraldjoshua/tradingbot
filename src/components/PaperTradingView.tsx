import { useEffect, useState } from "react";
import {
  getAccount, getPositions, getOrders, scan,
  placeOrder, cancelOrder, closePosition, optionSelect,
} from "../api";
import type { OptionCandidate } from "../types";

export default function PaperTradingView() {
  const [account, setAccount] = useState<any>(null);
  const [positions, setPositions] = useState<any[]>([]);
  const [orders, setOrders] = useState<any[]>([]);
  const [scanRows, setScanRows] = useState<any[]>([]);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  // order form
  const [symbol, setSymbol] = useState("");
  const [qty, setQty] = useState(10);
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [bracket, setBracket] = useState(true);
  const [stop, setStop] = useState<number | "">("");
  const [target, setTarget] = useState<number | "">("");

  // options ticket
  const [optSym, setOptSym] = useState("");
  const [optSide, setOptSide] = useState<"call" | "put">("call");
  const [optSpot, setOptSpot] = useState<number | null>(null);
  const [optCands, setOptCands] = useState<OptionCandidate[]>([]);
  const [optPick, setOptPick] = useState<string>("");
  const [optQty, setOptQty] = useState(1);
  const [optBusy, setOptBusy] = useState(false);

  async function refresh() {
    setErr("");
    try {
      const [a, p, o] = await Promise.all([getAccount(), getPositions(), getOrders("open")]);
      setAccount(a); setPositions(p); setOrders(o);
    } catch (e: any) { setErr(e.message || String(e)); }
  }
  useEffect(() => { refresh(); }, []);

  async function doScan() {
    setErr(""); setBusy(true);
    try { const r = await scan(0.01, 0.025); setScanRows(r.rows); }
    catch (e: any) { setErr(e.message || String(e)); }
    finally { setBusy(false); }
  }

  async function submit() {
    setErr(""); setMsg(""); setBusy(true);
    try {
      const body: any = {
        symbol: symbol.toUpperCase(),
        qty,
        side,
        type: "market",
        time_in_force: "day",
      };
      if (bracket && stop !== "" && target !== "") {
        body.order_class = "bracket";
        body.stop_loss = { stop_price: Number(stop) };
        body.take_profit = { limit_price: Number(target) };
      }
      const o = await placeOrder(body);
      setMsg(`Order ${o.id?.slice(0, 8)} submitted: ${o.side} ${o.qty} ${o.symbol} (${o.status})`);
      await refresh();
    } catch (e: any) { setErr(e.message || String(e)); }
    finally { setBusy(false); }
  }

  function prefill(r: any) {
    setSymbol(r.symbol);
    setSide(r.side === "long" ? "buy" : "sell");
    // also stage the options ticket in the gap's direction
    setOptSym(r.symbol);
    setOptSide(r.side === "long" ? "call" : "put");
  }

  async function loadContracts() {
    setErr(""); setOptBusy(true); setOptCands([]); setOptPick("");
    try {
      const r = await optionSelect(optSym.toUpperCase(), optSide);
      setOptSpot(r.spot);
      setOptCands(r.candidates);
      if (r.candidates[0]) setOptPick(r.candidates[0].symbol);
    } catch (e: any) { setErr(e.message || String(e)); }
    finally { setOptBusy(false); }
  }

  async function buyOption() {
    setErr(""); setMsg(""); setOptBusy(true);
    try {
      const o = await placeOrder({
        symbol: optPick, // OCC option symbol
        qty: optQty,
        side: "buy",
        type: "market",
        time_in_force: "day",
      });
      setMsg(`Option order ${o.id?.slice(0, 8)}: buy ${o.qty} ${o.symbol} (${o.status})`);
      await refresh();
    } catch (e: any) { setErr(e.message || String(e)); }
    finally { setOptBusy(false); }
  }

  const num = (v: any) => (v == null ? "-" : Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 }));

  return (
    <div>
      {err && <div className="err">Error: {err}</div>}
      {msg && <div className="panel" style={{ borderColor: "var(--green)" }}>{msg}</div>}

      {account && (
        <div className="panel">
          <div className="spread" style={{ marginBottom: 12 }}>
            <strong>Paper account · {account.account_number}</strong>
            <button className="ghost" onClick={refresh}>Refresh</button>
          </div>
          <div className="stats-grid">
            <div className="stat"><div className="k">Equity</div><div className="v">${num(account.equity)}</div></div>
            <div className="stat"><div className="k">Cash</div><div className="v">${num(account.cash)}</div></div>
            <div className="stat"><div className="k">Buying power</div><div className="v">${num(account.buying_power)}</div></div>
            <div className="stat"><div className="k">Positions</div><div className="v">{positions.length}</div></div>
            <div className="stat"><div className="k">Open orders</div><div className="v">{orders.length}</div></div>
            <div className="stat"><div className="k">PDT</div><div className="v">{account.pattern_day_trader ? "Yes" : "No"}</div></div>
          </div>
        </div>
      )}

      <div className="panel">
        <div className="spread" style={{ marginBottom: 12 }}>
          <strong>Today's scanner (gap 1–2.5% movers)</strong>
          <button className="primary" onClick={doScan} disabled={busy}>{busy ? "Scanning…" : "Scan now"}</button>
        </div>
        {scanRows.length > 0 && (
          <div className="tablewrap">
            <table>
              <thead>
                <tr><th>Symbol</th><th>Prev close</th><th>Open</th><th>Last</th><th>Gap@open%</th><th>Gap now%</th><th>Side</th><th>Qualifies</th><th></th></tr>
              </thead>
              <tbody>
                {scanRows.map((r) => (
                  <tr key={r.symbol} style={{ opacity: r.qualifies ? 1 : 0.5 }}>
                    <td>{r.symbol}</td>
                    <td>{num(r.prevClose)}</td>
                    <td>{num(r.open)}</td>
                    <td>{num(r.last)}</td>
                    <td>{r.gapOpen}</td>
                    <td>{r.gapNow}</td>
                    <td><span className={`badge ${r.side}`}>{r.side}</span></td>
                    <td>{r.qualifies ? "✓" : "—"}</td>
                    <td><button className="ghost" onClick={() => prefill(r)}>Use</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="hint" style={{ marginTop: 8 }}>
          Runs the picker on today's most-active names. During market hours use the ORB rules: wait for
          the 9:30–9:45 range, then enter on the breakout with a bracket (stop = other side of range, target = 2× range).
        </p>
      </div>

      <div className="panel">
        <strong>Place paper order</strong>
        <div className="row" style={{ marginTop: 12 }}>
          <div className="field"><label>Symbol</label>
            <input value={symbol} onChange={(e) => setSymbol(e.target.value)} /></div>
          <div className="field"><label>Qty</label>
            <input type="number" value={qty} onChange={(e) => setQty(+e.target.value)} /></div>
          <div className="field"><label>Side</label>
            <select value={side} onChange={(e) => setSide(e.target.value as any)}>
              <option value="buy">buy</option><option value="sell">sell</option>
            </select></div>
          <div className="field"><label>Bracket</label>
            <select value={bracket ? "y" : "n"} onChange={(e) => setBracket(e.target.value === "y")}>
              <option value="y">yes</option><option value="n">no</option>
            </select></div>
          {bracket && <>
            <div className="field"><label>Stop price</label>
              <input type="number" step="0.01" value={stop} onChange={(e) => setStop(e.target.value === "" ? "" : +e.target.value)} /></div>
            <div className="field"><label>Target price</label>
              <input type="number" step="0.01" value={target} onChange={(e) => setTarget(e.target.value === "" ? "" : +e.target.value)} /></div>
          </>}
          <button className="primary" onClick={submit} disabled={busy || !symbol}>Submit</button>
        </div>
        <p className="hint" style={{ marginTop: 8 }}>Paper account only. Market entry; bracket adds an OCO stop + target.</p>
      </div>

      <div className="panel">
        <strong>Options ticket (long call / put)</strong>
        <div className="row" style={{ marginTop: 12 }}>
          <div className="field"><label>Underlying</label>
            <input value={optSym} onChange={(e) => setOptSym(e.target.value)} /></div>
          <div className="field"><label>Direction</label>
            <select value={optSide} onChange={(e) => setOptSide(e.target.value as any)}>
              <option value="call">call (gap up)</option>
              <option value="put">put (gap down)</option>
            </select></div>
          <button className="ghost" onClick={loadContracts} disabled={optBusy || !optSym}>
            {optBusy ? "…" : "Find contracts"}
          </button>
          {optSpot != null && <span className="hint" style={{ alignSelf: "center" }}>spot ≈ ${optSpot}</span>}
        </div>

        {optCands.length > 0 && (
          <div className="row" style={{ marginTop: 12 }}>
            <div className="field" style={{ minWidth: 320 }}><label>Contract (nearest expiry, sorted by ATM)</label>
              <select value={optPick} onChange={(e) => setOptPick(e.target.value)}>
                {optCands.map((c) => (
                  <option key={c.symbol} value={c.symbol}>
                    {c.strike} {c.expiry} — bid {c.bid ?? "—"} / ask {c.ask ?? "—"}
                  </option>
                ))}
              </select></div>
            <div className="field"><label>Contracts</label>
              <input type="number" min={1} value={optQty} onChange={(e) => setOptQty(+e.target.value)} /></div>
            <button className="primary" onClick={buyOption} disabled={optBusy || !optPick}>Buy to open</button>
          </div>
        )}
        <p className="hint" style={{ marginTop: 8 }}>
          Long options only (L3). Market buy — exits are separate orders (no native bracket on options).
          Follow the ORB rules: exit the option when the underlying hits its stop or 2R target.
        </p>
      </div>

      {positions.length > 0 && (
        <div className="panel">
          <strong>Open positions</strong>
          <div className="tablewrap" style={{ marginTop: 10 }}>
            <table>
              <thead><tr><th>Symbol</th><th>Qty</th><th>Avg entry</th><th>Current</th><th>Mkt value</th><th>Unrealized P/L</th><th></th></tr></thead>
              <tbody>
                {positions.map((p) => (
                  <tr key={p.symbol}>
                    <td>{p.symbol}</td>
                    <td>{p.qty}</td>
                    <td>{num(p.avg_entry_price)}</td>
                    <td>{num(p.current_price)}</td>
                    <td>${num(p.market_value)}</td>
                    <td className={Number(p.unrealized_pl) >= 0 ? "pos" : "neg"}>${num(p.unrealized_pl)}</td>
                    <td><button className="ghost danger" onClick={async () => { await closePosition(p.symbol); refresh(); }}>Close</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {orders.length > 0 && (
        <div className="panel">
          <strong>Open orders</strong>
          <div className="tablewrap" style={{ marginTop: 10 }}>
            <table>
              <thead><tr><th>Symbol</th><th>Side</th><th>Qty</th><th>Type</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {orders.map((o) => (
                  <tr key={o.id}>
                    <td>{o.symbol}</td>
                    <td>{o.side}</td>
                    <td>{o.qty}</td>
                    <td>{o.type}{o.order_class && o.order_class !== "simple" ? ` (${o.order_class})` : ""}</td>
                    <td>{o.status}</td>
                    <td><button className="ghost danger" onClick={async () => { await cancelOrder(o.id); refresh(); }}>Cancel</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
