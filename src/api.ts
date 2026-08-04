import type { BacktestParams, BacktestResponse } from "./types";

async function j<T>(url: string, opts?: RequestInit): Promise<T> {
  const r = await fetch(url, opts);
  // A missing API route falls through to the SPA handler and returns index.html,
  // so .json() blows up with a browser-specific parser message ("The string did
  // not match the expected pattern" on Safari) that says nothing about the cause.
  // Check the content type first and name the real problem.
  const ct = r.headers.get("content-type") || "";
  if (!ct.includes("application/json")) {
    throw new Error(
      r.status === 404 || ct.includes("text/html")
        ? `${url} isn't served by the running backend (got ${r.status} ${ct.split(";")[0] || "no content-type"}). `
          + "It's usually a server started before this route existed — restart it (npm run dev / npm start)."
        : `${url} returned ${r.status} ${ct || "no content-type"} instead of JSON.`
    );
  }
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data as T;
}

export function runBacktest(body: {
  symbols: string[];
  start: string;
  end: string;
  timeframe: string;
  params: BacktestParams;
}) {
  return j<BacktestResponse>("/api/backtest", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export const getAccount = () => j<any>("/api/account");
export const getPositions = () => j<any[]>("/api/positions");
export const getOrders = (status = "open") => j<any[]>(`/api/orders?status=${status}`);
export const scan = (gapMin: number, gapMax: number) =>
  j<{ rows: any[] }>(`/api/scan?gapMin=${gapMin}&gapMax=${gapMax}`);

export const optionSelect = (symbol: string, side: "call" | "put") =>
  j<import("./types").OptionSelect>(`/api/option-select?symbol=${symbol}&side=${side}`);

export const getFaber = (symbol: string, sma: number, startYear?: number) =>
  j<import("./types").FaberResult>(
    `/api/faber?symbol=${symbol}&sma=${sma}${startYear ? `&startYear=${startYear}` : ""}`
  );

export const getGex = (symbol: string, maxExpiries = 4, maxDte = 45) =>
  j<import("./types").GexResult>(`/api/gex?symbol=${symbol}&maxExpiries=${maxExpiries}&maxDte=${maxDte}`);

export const runVolDesk = (tickers: string[], maxDte = 45, requireDb = true) =>
  j<{ results: import("./types").VolDeskSnapshot[] }>("/api/voldesk", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tickers, maxDte, requireDb }),
  });

const post = (url: string, body: any) =>
  j<any>(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

export const voldeskEnter = (
  ticker: string, riskPremium: number, force: boolean, confirm: boolean,
  dteTarget: number, moneyness: string
) => post("/api/voldesk/enter", { ticker, riskPremium, force, confirm, dteTarget, moneyness });
export const voldeskPositions = () =>
  j<{ positions: import("./types").VolDeskPosition[] }>("/api/voldesk/positions");
export const voldeskExit = (id: string, reason: string) => post("/api/voldesk/exit", { id, reason });
export const voldeskLock = (id: string) => post("/api/voldesk/lock", { id });

// Every executed trade on the account, round-tripped with realized P&L.
export const getHistory = (days = 365) =>
  j<import("./types").HistoryResponse>(`/api/history?days=${days}`);

export const placeOrder = (body: any) =>
  j<any>("/api/orders", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

export const cancelOrder = (id: string) => j<any>(`/api/orders/${id}`, { method: "DELETE" });
export const closePosition = (symbol: string) =>
  j<any>(`/api/positions/${symbol}`, { method: "DELETE" });

// ---- Flow conviction + auto-trader ---------------------------------------
export const getFlow = (ticker: string, side: "long" | "short" = "long") =>
  j<any>(`/api/flow?ticker=${encodeURIComponent(ticker)}&side=${side}`);

export const runDiscovery = () => j<any>("/api/discovery");
export const runDiagnostics = (probe = "SPY") => j<any>(`/api/diagnostics?probe=${probe}`);
export const getLocal = () => j<any>("/api/local");
export const localRebuild = () => post("/api/local/rebuild", {});
export const reconcileNow = (dry = false) => j<any>(`/api/reconcile${dry ? "?dry=1" : ""}`);

// ---- Nightly flow upload + observe list ----------------------------------
export const uploadFlowFile = (file: File) =>
  j<any>(`/api/flow-upload?filename=${encodeURIComponent(file.name)}`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: file,
  });
export const listFlowFiles = () => j<{ dir: string; files: any[] }>("/api/flow-upload");
export const ingestFlow = () => post("/api/flow-ingest", {});
export const getObserve = () => j<any>("/api/observe");
export const assessObserve = (force = false) => post("/api/observe/assess", { force });
export const dropObserve = (ticker: string, reason?: string) => post("/api/observe/drop", { ticker, reason });
export const autoStatus = () => j<any>("/api/autotrader/status");
export const autoStart = () => post("/api/autotrader/start", {});
export const autoStop = () => post("/api/autotrader/stop", {});
export const autoGetConfig = () => j<any>("/api/autotrader/config");
export const autoSetConfig = (partial: any) => post("/api/autotrader/config", partial);
export const autoSetWatchlist = (tickers: string[]) => post("/api/autotrader/watchlist", { tickers });
