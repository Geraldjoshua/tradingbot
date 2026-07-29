// Options layer for the Gap-and-Go strategy.
//
// Alpaca does not provide option greeks (OPRA feed is unsigned) or open interest
// on this account, so we price options ourselves with Black-Scholes. This powers
// a MODELED options overlay on the stock backtest: for each ORB trade we buy an
// ATM call (long/gap-up) or put (short/gap-down) and estimate its P&L from the
// underlying's entry->exit move, assuming constant implied vol.
//
// Caveats (shown in the UI): assumes ATM strike, a fixed days-to-expiry, constant
// IV (no IV crush/expansion), and mid-price fills (ignores the bid/ask spread).
// It is an ESTIMATE of how the option would have behaved, not a tick-accurate fill.

function erf(x) {
  // Abramowitz & Stegun 7.1.26
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t *
      Math.exp(-x * x);
  return x >= 0 ? y : -y;
}
const normCdf = (x) => 0.5 * (1 + erf(x / Math.SQRT2));
const normPdf = (x) => Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);

// Black-Scholes price + delta + gamma for a European call/put.
export function bs(type, S, K, T, r, sigma) {
  if (T <= 0 || sigma <= 0) {
    const intrinsic = type === "call" ? Math.max(S - K, 0) : Math.max(K - S, 0);
    return { price: intrinsic, delta: type === "call" ? (S > K ? 1 : 0) : S < K ? -1 : 0, gamma: 0 };
  }
  const sq = sigma * Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + (sigma * sigma) / 2) * T) / sq;
  const d2 = d1 - sq;
  const price =
    type === "call"
      ? S * normCdf(d1) - K * Math.exp(-r * T) * normCdf(d2)
      : K * Math.exp(-r * T) * normCdf(-d2) - S * normCdf(-d1);
  const delta = type === "call" ? normCdf(d1) : normCdf(d1) - 1;
  const gamma = normPdf(d1) / (S * sq);
  return { price, delta, gamma };
}

// Annualized realized volatility from daily close-to-close returns.
export function realizedVol(dailyBars) {
  const closes = dailyBars.map((b) => b.c).filter((c) => c > 0);
  if (closes.length < 3) return 0.4; // fallback 40%
  const rets = [];
  for (let i = 1; i < closes.length; i++) rets.push(Math.log(closes[i] / closes[i - 1]));
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const varc = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(varc) * Math.sqrt(252);
}

const YEAR_MS = 365 * 24 * 3600 * 1000;

// Model each stock trade as an ATM option and return option-level results + stats.
// params: { dte, iv, riskPremium, r }
export function optionOverlay(trades, dailyBars, params = {}) {
  const { dte = 3, iv, riskPremium = 150, r = 0.04 } = params;
  const sigma = iv && iv > 0 ? iv : realizedVol(dailyBars);
  const results = [];

  for (const t of trades) {
    const type = t.side === "long" ? "call" : "put";
    const S0 = t.entry;
    const K = Math.round(S0); // nearest whole-dollar strike ≈ ATM
    const Tin = dte / 365;
    const heldMs = Date.parse(t.exitTime) - Date.parse(t.entryTime);
    const Tout = Math.max(Tin - heldMs / YEAR_MS, 1e-5);

    const entryLeg = bs(type, S0, K, Tin, r, sigma);
    const exitLeg = bs(type, t.exitPrice, K, Tout, r, sigma);
    const premIn = Math.max(entryLeg.price, 0.01);
    const premOut = Math.max(exitLeg.price, 0);

    const contracts = Math.max(1, Math.floor(riskPremium / (premIn * 100)));
    const cost = contracts * premIn * 100;
    const proceeds = contracts * premOut * 100;
    const pnl = proceeds - cost;

    results.push({
      date: t.date,
      type,
      strike: K,
      dte,
      contracts,
      premiumIn: +premIn.toFixed(2),
      premiumOut: +premOut.toFixed(2),
      entryDelta: +entryLeg.delta.toFixed(3),
      cost: +cost.toFixed(2),
      proceeds: +proceeds.toFixed(2),
      pnl: +pnl.toFixed(2),
      roi: +(pnl / cost).toFixed(4),
      underlyingR: t.r,
    });
  }

  return { ivUsed: +sigma.toFixed(4), trades: results, stats: optionStats(results) };
}

function optionStats(rows) {
  const n = rows.length;
  if (!n) return { n: 0, winRate: 0, totalPnl: 0, avgRoi: 0, totalCost: 0, returnOnCapital: 0, wins: 0, losses: 0 };
  const wins = rows.filter((x) => x.pnl > 0).length;
  const totalPnl = rows.reduce((a, x) => a + x.pnl, 0);
  const totalCost = rows.reduce((a, x) => a + x.cost, 0);
  const avgRoi = rows.reduce((a, x) => a + x.roi, 0) / n;
  return {
    n,
    wins,
    losses: n - wins,
    winRate: +(wins / n).toFixed(4),
    totalPnl: +totalPnl.toFixed(2),
    totalCost: +totalCost.toFixed(2),
    avgRoi: +avgRoi.toFixed(4),
    returnOnCapital: totalCost ? +(totalPnl / totalCost).toFixed(4) : 0,
  };
}
