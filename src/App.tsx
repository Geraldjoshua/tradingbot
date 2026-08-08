import { useState } from "react";
import ErrorBoundary from "./components/ErrorBoundary";
import FaberView from "./components/FaberView";
import PaperTradingView from "./components/PaperTradingView";
import GexView from "./components/GexView";
import VolDeskView from "./components/VolDeskView";
import AutoTraderView from "./components/AutoTraderView";
import FlowUploadView from "./components/FlowUploadView";
import HistoryView from "./components/HistoryView";

type Tab = "backtest" | "paper" | "gex" | "voldesk" | "auto" | "flow" | "history";

export default function App() {
  const [tab, setTab] = useState<Tab>("backtest");
  return (
    <div className="app">
      <h1>Gap-and-Go ORB</h1>
      <p className="sub">Opening-range breakout on gapping movers · backtest, options & paper trading (Alpaca) · GEX (Yahoo)</p>
      <div className="tabs">
        <button className={`tab ${tab === "backtest" ? "active" : ""}`} onClick={() => setTab("backtest")}>Backtest (Faber)</button>
        <button className={`tab ${tab === "paper" ? "active" : ""}`} onClick={() => setTab("paper")}>Paper trading</button>
        <button className={`tab ${tab === "gex" ? "active" : ""}`} onClick={() => setTab("gex")}>GEX</button>
        <button className={`tab ${tab === "voldesk" ? "active" : ""}`} onClick={() => setTab("voldesk")}>Vol Desk</button>
        <button className={`tab ${tab === "auto" ? "active" : ""}`} onClick={() => setTab("auto")}>Auto-trader</button>
        <button className={`tab ${tab === "flow" ? "active" : ""}`} onClick={() => setTab("flow")}>Flow</button>
        <button className={`tab ${tab === "history" ? "active" : ""}`} onClick={() => setTab("history")}>History</button>
      </div>
      {/* Keyed by tab so switching tabs clears a previous crash rather than
          leaving the boundary latched on the error from another view. */}
      <ErrorBoundary name={tab} key={tab}>
        {tab === "backtest" ? <FaberView /> : tab === "paper" ? <PaperTradingView /> :
         tab === "gex" ? <GexView /> : tab === "voldesk" ? <VolDeskView /> :
         tab === "auto" ? <AutoTraderView /> : tab === "flow" ? <FlowUploadView /> : <HistoryView />}
      </ErrorBoundary>
    </div>
  );
}
