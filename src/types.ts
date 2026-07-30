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
  rr: number;
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
  };
  error?: string;
}

export interface VolDeskPosition {
  id: string;
  ticker: string;
  optionSymbol: string;
  strike: number;
  expiry: string;
  dte: number;
  contracts: number;
  entryPremium: number;
  entryDate: string;
  entrySpot: number;
  pTrans: number;
  nTrans: number;
  t1: number;
  t2: number;
  status: string;
  currentSpot: number | null;
  optMid: number | null;
  optPnl: number | null;
  daysHeld: number;
  progressPct: number;
  action: "HOLD" | "WATCH" | "EXIT" | "T1_HIT";
  reason: string;
  urgent: boolean;
  lockedToBreakeven?: boolean;
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
