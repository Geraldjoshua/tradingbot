import { useEffect, useState } from "react";
import { getHistory } from "../api";
import LineChart from "./LineChart";
import type { CalendarPeriod, HistoryResponse, HistoryTrade } from "../types";

const money = (n: number | null | undefined, dp = 0) =>
  n == null ? "—" : `${n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;
const sign = (n: number | null | undefined) => (n == null ? "" : n >= 0 ? "pos" : "neg");

const CLOSED_BY_LABEL: Record<string, string> = {
  fill: "sold", expired: "expired worthless", assigned: "assigned",
  exercised: "exercised", store: "bot record",
};

function contractLabel(t: HistoryTrade) {
  if (t.contract) {
    return `${t.contract.strike}${t.contract.type === "call" ? "c" : "p"} ${t.contract.expiry.slice(2)}`;
  }
  return t.assetClass === "equity" ? `${t.qty} sh` : t.symbol;
}

// One row + an expandable detail drawer holding the context the table can't fit:
// the thesis it was taken on, and the order ids to trace it at the broker.
function TradeRow({ t }: { t: HistoryTrade }) {
  const [open, setOpen] = useState(false);
  const pnlClass = sign(t.pnl);
  return (
    <>
      <tr onClick={() => setOpen(!open)} style={{ cursor: "pointer" }}>
        <td style={{ color: "var(--muted)" }}>{t.open ? t.entryDate : t.exitDate}</td>
        <td>
          {t.ticker}{" "}
          {t.strategy === "manual" && (
            <span className="badge" style={{ background: "rgba(255,255,255,.06)", color: "var(--muted)" }}>manual</span>
          )}
        </td>
        <td style={{ textAlign: "right" }}>{contractLabel(t)}</td>
        <td><span className={`badge ${t.side}`}>{t.side}</span></td>
        <td>{t.qty}</td>
        <td>{t.entryPrice ?? "—"}</td>
        <td>{t.open ? (t.currentPrice ?? "—") : (t.exitPrice ?? "—")}</td>
        <td>{money(t.cost)}</td>
        <td className={pnlClass} style={{ fontWeight: 700 }}>{money(t.pnl)}</td>
        <td className={pnlClass}>{t.pnlPct == null ? "—" : `${t.pnlPct > 0 ? "+" : ""}${t.pnlPct}%`}</td>
        <td>{t.holdDays == null ? "—" : `${t.holdDays}d`}</td>
        <td style={{ color: "var(--muted)" }}>
          {t.open ? "open" : CLOSED_BY_LABEL[t.closedBy || ""] || t.closedBy}
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={12} style={{ background: "var(--panel2)", textAlign: "left", padding: "10px 12px" }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 10 }}>
              <div><div className="k">Contract</div><div>{t.symbol}</div></div>
              <div><div className="k">Entry</div><div>{t.entryDate} @ {t.entryPrice ?? "—"}</div></div>
              <div><div className="k">{t.open ? "Marked at" : "Exit"}</div>
                <div>{t.open ? (t.currentPrice ?? "—") : `${t.exitDate} @ ${t.exitPrice ?? "—"}`}</div></div>
              {t.levels && (
                <div><div className="k">Thesis levels</div>
                  <div>trig {t.levels.trigger ?? "—"} · stop {t.levels.stop ?? "—"} · T1 {t.levels.t1 ?? "—"} · T2 {t.levels.t2 ?? "—"}</div></div>
              )}
              {t.entrySpot != null && <div><div className="k">Spot at entry</div><div>{t.entrySpot}</div></div>}
              {t.triggeredBy && <div><div className="k">Triggered by</div><div>{t.triggeredBy}</div></div>}
              {t.flowStance && <div><div className="k">Flow at entry</div><div>{t.flowStance}</div></div>}
              <div><div className="k">Source</div>
                <div>{t.origin === "broker" ? "broker ledger" : "bot record"}{t.tracked ? " · tracked" : " · untracked by the bot"}</div></div>
              {t.entryOrderId && <div><div className="k">Entry order</div><div style={{ fontSize: 11 }}>{t.entryOrderId}</div></div>}
              {t.exitOrderId && <div><div className="k">Exit order</div><div style={{ fontSize: 11 }}>{t.exitOrderId}</div></div>}
            </div>
            {t.exitReason && <p className="hint" style={{ margin: "8px 0 0" }}><b>Why it closed:</b> {t.exitReason}</p>}
            {t.pnlIsEstimate && (
              <p className="hint" style={{ margin: "6px 0 0", color: "#e0b341" }}>
                ⚠ P&amp;L is an estimate — one leg's real fill price was never confirmed.
              </p>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

function TradeTable({ trades }: { trades: HistoryTrade[] }) {
  return (
    <div className="tablewrap" style={{ maxHeight: 460 }}>
      <table>
        <thead>
          <tr>
            <th>Date</th><th>Ticker</th><th>Contract</th><th>Side</th><th>Qty</th>
            <th>In</th><th>Out</th><th>Cost</th><th>P/L</th><th>%</th><th>Held</th><th>Closed</th>
          </tr>
        </thead>
        <tbody>{trades.map((t) => <TradeRow key={t.id} t={t} />)}</tbody>
      </table>
    </div>
  );
}

// A day/week/month row. Expanding it answers the two questions separately:
// what was TAKEN in the period, and what the period's exits actually BANKED.
function PeriodRow({ p, trades, granularity }: { p: CalendarPeriod; trades: HistoryTrade[]; granularity: string }) {
  const [open, setOpen] = useState(false);
  const byId = new Map(trades.map((t) => [t.id, t]));
  const opened = p.openedIds.map((id) => byId.get(id)).filter(Boolean) as HistoryTrade[];
  const closed = p.closedIds.map((id) => byId.get(id)).filter(Boolean) as HistoryTrade[];
  return (
    <>
      <tr onClick={() => setOpen(!open)} style={{ cursor: "pointer" }}>
        <td>{p.label}</td>
        <td>{p.opened || "—"}</td>
        <td>{p.stillOpen || "—"}</td>
        <td>{p.closed || "—"}</td>
        <td>{p.winRate == null ? "—" : `${p.winRate}%`}</td>
        <td className={p.closed ? sign(p.realizedPnl) : ""} style={{ fontWeight: 700 }}>
          {p.closed ? money(p.realizedPnl) : "—"}
        </td>
        <td className={sign(p.cumulativePnl)}>{money(p.cumulativePnl)}</td>
        <td>{money(p.openedCost)}</td>
        <td style={{ textAlign: "left", color: "var(--muted)" }}>{p.tickers.join(" ")}</td>
      </tr>
      {open && (
        <tr>
          <td colSpan={9} style={{ background: "var(--panel2)", textAlign: "left", padding: "10px 12px" }}>
            <div className="k" style={{ marginBottom: 4 }}>
              TAKEN {granularity === "day" ? "THIS DAY" : granularity === "week" ? "THIS WEEK" : "THIS MONTH"} ({opened.length})
            </div>
            {opened.length === 0 ? <p className="hint" style={{ margin: 0 }}>No new positions.</p> : (
              <table><tbody>
                {opened.map((t) => (
                  <tr key={`o-${t.id}`}>
                    <td>{t.ticker}</td>
                    <td style={{ textAlign: "right" }}>{contractLabel(t)}</td>
                    <td>{t.qty} @ {t.entryPrice}</td>
                    <td>{money(t.cost)}</td>
                    <td style={{ color: "var(--muted)", textAlign: "left" }}>
                      {t.open ? "still open" : `closed ${t.exitDate} · ${t.pnl != null && t.pnl >= 0 ? "+" : ""}${money(t.pnl)}`}
                    </td>
                  </tr>
                ))}
              </tbody></table>
            )}
            <div className="k" style={{ margin: "12px 0 4px" }}>
              BANKED — closed in this period ({closed.length})
            </div>
            {closed.length === 0 ? (
              <p className="hint" style={{ margin: 0 }}>Nothing closed, so this period realized nothing.</p>
            ) : (
              <table><tbody>
                {closed.map((t) => (
                  <tr key={`c-${t.id}`}>
                    <td>{t.ticker}</td>
                    <td style={{ textAlign: "right" }}>{contractLabel(t)}</td>
                    <td>{t.entryPrice} → {t.exitPrice}</td>
                    <td className={sign(t.pnl)} style={{ fontWeight: 700 }}>{money(t.pnl)}</td>
                    <td className={sign(t.pnl)}>{t.pnlPct == null ? "" : `${t.pnlPct > 0 ? "+" : ""}${t.pnlPct}%`}</td>
                    <td style={{ color: "var(--muted)", textAlign: "left" }}>
                      held {t.holdDays}d · {t.exitReason || CLOSED_BY_LABEL[t.closedBy || ""] || ""}
                    </td>
                  </tr>
                ))}
              </tbody></table>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

export default function HistoryView() {
  const [days, setDays] = useState(365);
  const [data, setData] = useState<HistoryResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [showUnfilled, setShowUnfilled] = useState(false);
  const [grain, setGrain] = useState<"day" | "week" | "month">("day");

  async function load() {
    setBusy(true); setErr("");
    try { setData(await getHistory(days)); }
    catch (e: any) { setErr(e.message || String(e)); }
    finally { setBusy(false); }
  }
  useEffect(() => { load(); }, [days]);

  const s = data?.summary;
  const netRealized = s ? s.realizedPnl : 0;
  const periods = data ? (grain === "day" ? data.byDay : grain === "week" ? data.byWeek : data.byMonth) : [];
  const allTrades = data ? [...data.trades, ...data.openTrades] : [];

  return (
    <div>
      <div className="panel">
        <div className="row">
          <div className="field">
            <label>Lookback</label>
            <select value={days} onChange={(e) => setDays(+e.target.value)}>
              <option value={30}>30 days</option>
              <option value={90}>90 days</option>
              <option value={180}>6 months</option>
              <option value={365}>1 year</option>
              <option value={1825}>everything</option>
            </select>
          </div>
          <button className="primary" onClick={load} disabled={busy}>{busy ? "Loading…" : "Refresh"}</button>
        </div>
        <p className="hint" style={{ marginTop: 10 }}>
          Your whole Alpaca account — every trade that actually executed, read from the broker's activity ledger
          rather than the bot's own notes, so trades placed by hand or before the bot existed are included too.
          Fills are FIFO-matched into round trips and P&amp;L comes from real fill prices. Click any row for the
          thesis behind it.
        </p>
      </div>

      {err && <div className="err">Error: {err}</div>}
      {data?.errors?.map((e) => <div key={e} className="err">⚠ {e}</div>)}

      {data && s && (
        <>
          <div className="panel">
            <div className="stats-grid">
              <div className="stat"><div className="k">Realized P/L</div>
                <div className={`v ${sign(netRealized)}`}>{money(netRealized)}</div></div>
              <div className="stat"><div className="k">Open P/L</div>
                <div className={`v ${sign(data.unrealizedPnl)}`}>{money(data.unrealizedPnl)}</div></div>
              <div className="stat"><div className="k">Round trips</div><div className="v">{s.n}</div></div>
              <div className="stat"><div className="k">Win rate</div>
                <div className="v">{s.winRate == null ? "—" : `${s.winRate}%`}</div>
                <div className="k">{s.wins}W / {s.losses}L</div></div>
              <div className="stat"><div className="k">Profit factor</div>
                <div className="v">{s.profitFactor ?? "—"}</div></div>
              <div className="stat"><div className="k">Avg win</div>
                <div className="v pos">{money(s.avgWin)}</div></div>
              <div className="stat"><div className="k">Avg loss</div>
                <div className="v neg">{money(s.avgLoss)}</div></div>
              <div className="stat"><div className="k">Per trade</div>
                <div className={`v ${sign(s.expectancy)}`}>{money(s.expectancy)}</div></div>
              <div className="stat"><div className="k">Capital deployed</div>
                <div className="v">{money(s.totalCost + data.openCost)}</div></div>
              <div className="stat"><div className="k">Fees (window)</div>
                <div className="v">{money(data.fees, 2)}</div></div>
            </div>
            <p className="hint" style={{ marginTop: 10 }}>
              {s.n > 0 && s.best && s.worst && (
                <>Best <b className="pos">{s.best.ticker} {money(s.best.pnl)}</b> · worst{" "}
                  <b className="neg">{s.worst.ticker} {money(s.worst.pnl)}</b> · avg hold {s.avgHoldDays}d · </>
              )}
              {data.counts.fills} fills since {data.since.slice(0, 10)}
              {data.source === "orders" && " · rebuilt from closed orders (activity ledger unavailable)"}
              . Fees are the window total — Alpaca's fee rows carry no symbol, so they aren't split per trade.
            </p>
          </div>

          {data.equityCurve.length > 1 && (
            <div className="panel">
              <div className="spread" style={{ marginBottom: 8 }}>
                <strong>Cumulative realized P/L</strong>
                <span className="hint">closed trades only, in exit order</span>
              </div>
              <LineChart height={240}
                lines={[{ color: netRealized >= 0 ? "#26a69a" : "#ef5350", data: data.equityCurve }]} />
            </div>
          )}

          <div className="panel">
            <div className="spread" style={{ marginBottom: 12 }}>
              <strong>Daily / weekly breakdown</strong>
              <div style={{ display: "flex", gap: 6 }}>
                {(["day", "week", "month"] as const).map((g) => (
                  <button key={g} className={g === grain ? "primary" : "ghost"}
                    style={g === grain ? { padding: "5px 12px", fontSize: 12 } : undefined}
                    onClick={() => setGrain(g)}>
                    {g === "day" ? "Daily" : g === "week" ? "Weekly" : "Monthly"}
                  </button>
                ))}
              </div>
            </div>
            {periods.length === 0 ? (
              <p className="hint">No activity in this window.</p>
            ) : (
              <>
                <div className="tablewrap" style={{ maxHeight: 420 }}>
                  <table>
                    <thead>
                      <tr>
                        <th>{grain === "day" ? "Day" : grain === "week" ? "Week (Mon–Fri)" : "Month"}</th>
                        <th>Taken</th><th>Still open</th><th>Closed</th><th>Win rate</th>
                        <th>Realized P/L</th><th>Cumulative</th><th>Deployed</th><th>Tickers</th>
                      </tr>
                    </thead>
                    <tbody>
                      {periods.map((p) => (
                        <PeriodRow key={p.key} p={p} trades={allTrades} granularity={grain} />
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="hint" style={{ marginTop: 8 }}>
                  Click a row to see exactly what was taken and what was banked. <b>Taken</b> counts positions
                  <i> opened</i> in the period; <b>Realized P/L</b> is what the period's <i>exits</i> made — a trade
                  opened Monday and sold Friday shows up in Monday's activity and Friday's P&amp;L. Open positions
                  contribute no realized P/L until they're closed.
                </p>
              </>
            )}
          </div>

          <div className="panel">
            <div className="spread" style={{ marginBottom: 12 }}>
              <strong>Closed trades ({data.trades.length})</strong>
              <span className="hint">newest first</span>
            </div>
            {data.trades.length === 0 ? (
              <p className="hint">
                Nothing has closed in this window yet — every fill on the account is still open below.
                Realized P/L appears here as soon as a position is sold, expires, or is assigned.
              </p>
            ) : <TradeTable trades={data.trades} />}
          </div>

          {data.openTrades.length > 0 && (
            <div className="panel">
              <div className="spread" style={{ marginBottom: 12 }}>
                <strong>Still open ({data.openTrades.length})</strong>
                <span className="hint">marked at the broker's current price — not realized</span>
              </div>
              <TradeTable trades={data.openTrades} />
            </div>
          )}

          {data.bySymbol.length > 0 && (
            <div className="panel">
              <div className="spread" style={{ marginBottom: 12 }}><strong>By ticker</strong></div>
              <div className="tablewrap" style={{ maxHeight: 260 }}>
                <table>
                  <thead><tr><th>Ticker</th><th>Trades</th><th>Wins</th><th>Win rate</th><th>Realized P/L</th></tr></thead>
                  <tbody>
                    {data.bySymbol.map((g) => (
                      <tr key={g.key}>
                        <td>{g.key}</td><td>{g.n}</td><td>{g.wins}</td><td>{g.winRate}%</td>
                        <td className={sign(g.pnl)} style={{ fontWeight: 700 }}>{money(g.pnl)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {data.unfilled.length > 0 && (
            <div className="panel">
              <div className="spread" style={{ marginBottom: showUnfilled ? 12 : 0 }}>
                <strong>Entries that never filled ({data.unfilled.length})</strong>
                <button className="ghost" onClick={() => setShowUnfilled(!showUnfilled)}>
                  {showUnfilled ? "Hide" : "Show"}
                </button>
              </div>
              {showUnfilled && (
                <>
                  <div className="tablewrap" style={{ maxHeight: 260 }}>
                    <table>
                      <thead><tr><th>Date</th><th>Ticker</th><th>Contract</th><th>Qty</th><th>Quoted</th><th>What happened</th></tr></thead>
                      <tbody>
                        {data.unfilled.map((u) => (
                          <tr key={u.id}>
                            <td style={{ color: "var(--muted)" }}>{u.date}</td>
                            <td>{u.ticker}</td>
                            <td style={{ fontSize: 11 }}>{u.symbol}</td>
                            <td>{u.contracts ?? "—"}</td>
                            <td>{u.quotedPrice ?? "—"}</td>
                            <td style={{ textAlign: "left", color: "var(--muted)" }}>{u.reason}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <p className="hint" style={{ marginTop: 8 }}>
                    No money changed hands on these, so they carry no P/L — but a run of them means the strategy
                    never got on, which is a different problem from the strategy losing.
                  </p>
                </>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
