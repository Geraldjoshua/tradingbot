export interface Bar {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface Trade {
  date: string;
  side: "long" | "short";
  gap: number;
  orHigh: number;
  orLow: number;
  orRange: number;
  entry: number;
  stop: number;
  target: number;
  entryTime: string;
  exitTime: string;
  exitPrice: number;
  outcome: "stop" | "target" | "eod";
  r: number;
  shares: number;
  pnl: number;
}

export interface Stats {
  n: number;
  wins: number;
  losses: number;
  winRate: number;
  expectancyR: number;
  avgWinR: number;
  avgLossR: number;
  totalR: number;
  totalPnl: number;
  profitFactor: number;
  maxDrawdownR: number;
  equityCurve: { date: string; cumR: number; cumPnl: number }[];
}

export interface OptionLeg {
  date: string;
  type: "call" | "put";
  strike: number;
  dte: number;
  contracts: number;
  premiumIn: number;
  premiumOut: number;
  entryDelta: number;
  cost: number;
  proceeds: number;
  pnl: number;
  roi: number;
  underlyingR: number;
}

export interface OptionOverlay {
  ivUsed: number;
  trades: OptionLeg[];
  stats: {
    n: number;
    wins: number;
    losses: number;
    winRate: number;
    totalPnl: number;
    totalCost: number;
    avgRoi: number;
    returnOnCapital: number;
  };
}

export interface SymbolResult {
  bars: Bar[];
  trades: Trade[];
  skipped: { date: string; gap: number; reason: string }[];
  stats: Stats;
  option?: OptionOverlay | null;
}

export interface BacktestResponse {
  results: Record<string, SymbolResult>;
  pooled: Stats;
}

export interface BacktestParams {
  gapMin: number;
  gapMax: number;
  rTarget: number;
  riskPerTrade: number;
  optionMode?: boolean;
  dte?: number;
  iv?: number;
  riskPremium?: number;
}

export interface OptionCandidate {
  symbol: string;
  strike: number;
  expiry: string;
  bid: number | null;
  ask: number | null;
  mid: number | null;
  distFromSpot: number;
}

export interface OptionSelect {
  spot: number;
  side: "call" | "put";
  expiries: string[];
  nearest: string;
  candidates: OptionCandidate[];
}

export interface VolDeskSnapshot {
  ticker: string;
  date: string;
  spot: number;
  tag: "CONFIRMED" | "PENDING" | "BLOCKED";
  levels: {
    pTrans: number; nTrans: number; zeroGEX: number;
    plusGEX_T1: number; T2: number; COTMP: number; COTMC: number;
  };
  db: number;
  prior_db: number | null;
  db_change: number | null;
  db_status: string;
  pegged: boolean;
  grade: number;
  grade_rules: Record<string, boolean>;
  deep: boolean;
  minervini: number;
  cushion_pct: number;
  rr: number;                  // from pTrans — the trade the setup describes
  rr_at_fill?: number | null;  // from spot — the trade you'd actually get
  extension_pct?: number | null;
  spike_crash: boolean;
  call_oi: number;
  put_oi: number;
  total_gex: number;
  filters: Record<string, boolean>;
  filter_reasons: string[];
  regime: {
    spy_chg: number | null; qqq_chg: number | null; vix_chg: number | null;
    basket_gate: boolean; vix_gate: boolean; bull_bear_gate: boolean | null;
    gates_passed: number; gates_note: string;
    // Which feed each half came from. Optional: snapshots written before the
    // Alpaca/Yahoo split don't carry them.
    regime_source?: string | null;   // "alpaca" | "yahoo" | "none"
    vix_source?: string | null;      // "yahoo ^VIX" | "VIXY proxy (...)" | unavailable
  };
  error?: string;
}

// A position is EITHER an option or shares, and the option-only fields are
// genuinely absent on a share row. They were typed as required, which is why
// `p.expiry.slice(5)` compiled happily and then threw at runtime the first time
// the share fallback fired. Optional is the truth.
export interface VolDeskPosition {
  id: string;
  ticker: string;
  side?: "long" | "short";
  instrument?: "option" | "shares";

  // ---- options only ----
  optionSymbol?: string;
  optionType?: "call" | "put";
  strike?: number;
  expiry?: string;
  dte?: number;
  dteLeft?: number | null;
  contracts?: number;
  entryPremium?: number;

  // ---- shares only ----
  shares?: number;
  entryPrice?: number;
  notional?: number;
  sizedBy?: string;
  riskAtStop?: number;

  entryDate: string;
  entrySpot: number;
  pTrans: number;
  nTrans: number;
  trigger?: number;
  stopLevel?: number;
  effectiveStop?: number;      // after the ratchet has moved it
  t1: number;
  t2: number;
  status: string;
  currentSpot: number | null;
  optMid: number | null;
  optPnl: number | null;
  daysHeld: number;
  progressPct: number;
  // T1_INFO = target reached on a protect-mode position and deliberately NOT
  // auto-sold. T2_HIT = a scale-out runner reaching its second target.
  action: "HOLD" | "WATCH" | "EXIT" | "T1_HIT" | "T1_INFO" | "T2_HIT";
  reason: string;
  urgent: boolean;
  lockedToBreakeven?: boolean;
  t1Taken?: boolean;
  manageMode?: "full" | "protect";
  adopted?: boolean;
  peakValue?: number | null;
  profitRatchet?: { peak: number; floor: number; peakGainPct: number; stillUpPct: number };
  stopRatchet?: { at: number; lock: number; movedTo: number; on: string; progressPct: number };
  progressLog?: { d: string; p: number }[];
}

// ---- Trade history --------------------------------------------------------
export interface HistoryTrade {
  id: string;
  symbol: string;          // OCC contract symbol, or the ticker for equities
  ticker: string;
  side: "long" | "short";
  qty: number;
  assetClass: "option" | "equity";
  contract: { underlying: string; expiry: string; type: "call" | "put"; strike: number } | null;
  entryPrice: number | null;
  exitPrice: number | null;
  entryTime: string;
  exitTime: string | null;
  entryDate: string;
  exitDate: string | null;
  entryOrderId: string | null;
  exitOrderId: string | null;
  closedBy: "fill" | "expired" | "assigned" | "exercised" | "store" | null;
  cost: number;
  pnl: number | null;
  pnlPct: number | null;
  currentPrice?: number | null;
  holdDays: number | null;
  open: boolean;
  origin: "broker" | "store";
  // enrichment from the local Vol Desk store (absent for untracked trades)
  strategy: "voldesk" | "manual";
  tracked: boolean;
  positionId?: string;
  exitReason?: string | null;
  triggeredBy?: string | null;
  levels?: { trigger: number | null; stop: number | null; t1: number | null; t2: number | null } | null;
  entrySpot?: number | null;
  flowStance?: string | null;
  storedPnl?: number | null;
  pnlIsEstimate?: boolean;
}

export interface HistorySummary {
  n: number; wins: number; losses: number; scratches: number;
  winRate: number | null;
  realizedPnl: number; grossWin: number; grossLoss: number;
  avgWin: number | null; avgLoss: number | null;
  profitFactor: number | null; expectancy: number | null;
  totalCost: number; returnOnCost: number | null;
  best: HistoryTrade | null; worst: HistoryTrade | null;
  avgHoldDays: number | null;
}

// One calendar bucket (day / week / month). `opened` counts trades TAKEN in the
// period; `realizedPnl` is what the period's EXITS banked — different dates, so
// both are carried rather than conflated.
export interface CalendarPeriod {
  key: string;
  label: string;
  opened: number;
  openedCost: number;
  stillOpen: number;
  closed: number;
  wins: number;
  losses: number;
  winRate: number | null;
  realizedPnl: number;
  cumulativePnl: number;
  tickers: string[];
  openedIds: string[];
  closedIds: string[];
}

export interface HistoryResponse {
  since: string;
  source: "activities" | "orders" | null;
  errors: string[];
  trades: HistoryTrade[];
  openTrades: HistoryTrade[];
  unfilled: { id: string; ticker: string; symbol: string; date: string; reason: string; quotedPrice: number | null; contracts: number | null }[];
  summary: HistorySummary;
  unrealizedPnl: number;
  openCost: number;
  fees: number;
  equityCurve: { date: string; value: number }[];
  bySymbol: { key: string; n: number; wins: number; pnl: number; winRate: number }[];
  byDay: CalendarPeriod[];
  byWeek: CalendarPeriod[];
  byMonth: CalendarPeriod[];
  counts: { fills: number; activities: number };
}

export interface FaberResult {
  symbol: string;
  smaMonths: number;
  start: string;
  end: string;
  months: number;
  series: { date: string; close: number; sma: number; inMarket: boolean }[];
  equity: { date: string; strat: number; bh: number }[];
  trades: { entryDate: string; entryPrice: number; exitDate: string; exitPrice: number; months: number; ret: number }[];
  strat: {
    totalReturn: number; cagr: number; maxDrawdown: number; vol: number; sharpe: number;
    timeInMarket: number; nTrades: number; winRate: number;
  };
  bh: { totalReturn: number; cagr: number; maxDrawdown: number; vol: number; sharpe: number };
  error?: string;
}

export interface GexResult {
  symbol: string;
  spot: number;
  asof: string;
  expiries: string[];
  gammaFlip: number | null;
  flipFound?: boolean;
  flipNote?: string | null;
  regime: "long_gamma" | "short_gamma" | null;
  // null when no strike on that side survives the sanity filters
  callWall: { strike: number; gex: number; oi?: number } | null;
  putWall: { strike: number; gex: number; oi?: number } | null;
  totalGex: number;
  callGex?: number;
  putGex?: number;
  netGex?: number;
  grossGex?: number;
  dataQuality?: Record<string, any>;
  profile: { strike: number; gex: number }[];
}
