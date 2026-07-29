import { useState } from "react";
import FaberView from "./components/FaberView";
import PaperTradingView from "./components/PaperTradingView";
import GexView from "./components/GexView";
import VolDeskView from "./components/VolDeskView";
import AutoTraderView from "./components/AutoTraderView";

type Tab = "backtest" | "paper" | "gex" | "voldesk" | "auto";

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
      </div>
      {tab === "backtest" ? <FaberView /> : tab === "paper" ? <PaperTradingView /> :
       tab === "gex" ? <GexView /> : tab === "voldesk" ? <VolDeskView /> : <AutoTraderView />}
    </div>
  );
}
