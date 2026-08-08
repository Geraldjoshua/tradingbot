// Share fallback — take the trade with stock when the option isn't worth taking.
//
// Options fail for mundane reasons: no chain at the DTE you want, every strike's
// bid/ask eats the edge, nothing clears your R/R bar, or the breakeven sits past
// your own target. Previously the bot fell back to an arbitrary contract; now it
// can express the same thesis in shares instead, where there is no spread problem
// and no theta.
//
// Sizing is RISK-based, not premium-based, which is the honest way to size stock:
//
//     shares = floor(riskBudget / |entry - stop|)
//
// so a full stop-out costs about `riskBudget` either way — directly comparable to
// the option's premium budget. Capped by `maxNotionalPct` of buying power so one
// wide-stop name can't consume the account.
//
// Shorting: Alpaca paper supports short selling, but the asset must be shortable
// and easy-to-borrow. We check that and refuse rather than fire an order that
// bounces.

import * as alpaca from "./alpaca.js";

export const DEFAULTS = {
  enabled: true,
  minShares: 1,
  // ---- THE CAP THAT ACTUALLY BINDS ---------------------------------------
  // Notional is capped at `maxNotionalMultiple` x the trade's effective budget.
  // Without this the only ceiling was maxNotionalPct of BUYING POWER, which on a
  // paper account with ~$256k of buying power meant $25.6k per position — so a
  // $6,000 budget bought $25,572 of AMD and basePremium never entered the
  // calculation at all. The budget has to be a real constraint on the share path
  // the way it is on the option path, or it is decoration.
  //
  // 1.0 = "a $6,000 budget buys about $6,000 of stock", which is what the number
  // reads like it should mean.
  maxNotionalMultiple: 1.0,
  maxNotionalPct: 0.10,      // additional ceiling: ≤10% of buying power
  allowShort: true,          // shorting stock for bearish plays
  requireEasyToBorrow: true,
};

const cfgFor = (cfg) => ({ ...DEFAULTS, ...(cfg?.shares || {}) });

// Is this name tradeable as stock in the direction we want?
export async function checkTradable(ticker, side, cfg) {
  const c = cfgFor(cfg);
  try {
    const a = await alpaca.getAsset(ticker);
    if (!a) return { ok: false, reason: "asset not found" };
    if (a.tradable === false) return { ok: false, reason: "not tradable" };
    if (side === "short") {
      if (!c.allowShort) return { ok: false, reason: "shorting disabled" };
      if (a.shortable === false) return { ok: false, reason: "not shortable" };
      if (c.requireEasyToBorrow && a.easy_to_borrow === false) {
        return { ok: false, reason: "not easy-to-borrow" };
      }
    }
    return { ok: true, asset: { symbol: a.symbol, shortable: a.shortable, etb: a.easy_to_borrow } };
  } catch (e) {
    return { ok: false, reason: `asset lookup failed: ${String(e.message || e)}` };
  }
}

// Size the position. Three independent ceilings; the tightest wins, and we say
// which one it was — "53 shares" is not a useful answer when the question is
// "why is a $6,000 budget holding $25,000 of stock".
//
// HONEST NOTE ON WHAT THIS CHANGES
// Sizing purely off the distance to the stop is the textbook-correct way to size
// STOCK, and it is what this did. But it answers "how many shares lose $X at the
// stop", not "how much capital am I putting up" — and on a $482 name with a 5%
// stop those differ by 20x. Tying notional to the budget means the share path
// now RISKS LESS per trade than the option path for the same budget number.
// That is not a bug: an unlevered share position genuinely carries less risk per
// dollar deployed than long premium. If you want them comparable, raise
// maxNotionalMultiple deliberately rather than discovering it through a fill.
export function size(entry, stop, riskBudget, buyingPower, cfg, opts = {}) {
  const c = cfgFor(cfg);
  const perShareRisk = Math.abs(entry - stop);
  if (!(perShareRisk > 0)) return { shares: 0, reason: "entry equals stop" };
  if (!(entry > 0)) return { shares: 0, reason: "no entry price" };

  const notionalBudget = opts.notionalBudget || 0;
  const caps = [];
  caps.push({ by: "risk budget", n: Math.floor(riskBudget / perShareRisk) });
  if (notionalBudget > 0 && c.maxNotionalMultiple > 0) {
    caps.push({ by: "budget notional",
                n: Math.floor((notionalBudget * c.maxNotionalMultiple) / entry) });
  }
  if (buyingPower > 0 && c.maxNotionalPct > 0) {
    caps.push({ by: "buying power",
                n: Math.floor((buyingPower * c.maxNotionalPct) / entry) });
  }

  const binding = caps.reduce((a, b) => (b.n < a.n ? b : a));
  const shares = binding.n;

  if (shares < c.minShares) {
    return {
      shares: 0, perShareRisk: +perShareRisk.toFixed(2),
      caps, boundBy: binding.by,
      reason: `${binding.by} allows only ${shares} shares at $${entry.toFixed(2)} `
        + `(stop is $${perShareRisk.toFixed(2)} wide)`,
    };
  }
  return {
    shares,
    perShareRisk: +perShareRisk.toFixed(2),
    notional: +(shares * entry).toFixed(2),
    riskAtStop: +(shares * perShareRisk).toFixed(2),
    boundBy: binding.by,
    caps,
    note: `${shares} shares = $${(shares * entry).toFixed(0)} notional, `
      + `risking $${(shares * perShareRisk).toFixed(0)} at the stop `
      + `(capped by ${binding.by})`,
  };
}

// Place the entry. Marketable limit so it behaves during RTH and is still
// accepted off-hours (same approach as the options path).
export async function enter({ ticker, side, spot, stop, riskBudget, cfg, notionalBudget = 0 }) {
  const c = cfgFor(cfg);
  if (!c.enabled) throw new Error("share fallback disabled");

  const tradable = await checkTradable(ticker, side, cfg);
  if (!tradable.ok) throw new Error(`shares unavailable: ${tradable.reason}`);

  let buyingPower = 0;
  try { buyingPower = parseFloat((await alpaca.getAccount()).buying_power) || 0; } catch {}

  const sized = size(spot, stop, riskBudget, buyingPower, cfg, { notionalBudget });
  if (!sized.shares) throw new Error(sized.reason);

  const limit = side === "short"
    ? +(spot * 0.995).toFixed(2)     // selling: a hair below
    : +(spot * 1.005).toFixed(2);    // buying: a hair above
  const order = await alpaca.placeOrder({
    symbol: ticker,
    qty: sized.shares,
    side: side === "short" ? "sell" : "buy",
    type: "limit", limit_price: limit,
    time_in_force: "day",
  }, { kind: "entry", ticker });
  return { order, sized, limit, asset: tradable.asset };
}

// Flatten a share position.
export async function exit({ ticker, side, shares }) {
  let bid = null;
  try { bid = await alpaca.getLatestTrade(ticker, "delayed_sip"); } catch {}
  const px = bid || 0;
  const limit = side === "short"
    ? +((px || 1) * 1.005).toFixed(2)   // buying to cover
    : +((px || 1) * 0.995).toFixed(2);  // selling to close
  return alpaca.placeOrder({
    symbol: ticker, qty: shares,
    side: side === "short" ? "buy" : "sell",
    type: "limit", limit_price: limit, time_in_force: "day",
  }, { kind: "exit", ticker });
}
