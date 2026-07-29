#!/usr/bin/env python3
"""Meb Faber timing model backtest (from "A Quantitative Approach to Tactical
Asset Allocation", Faber 2007).

Rule, on MONTHLY data:
  - Long the asset when the monthly close is ABOVE its N-month SMA (default 10).
  - Move to CASH when the monthly close is BELOW the N-month SMA.
  - Decision at month-end; hold the position through the next month. Long/flat only.

Outputs (JSON on stdout): the monthly price/SMA/in-market series, an equity curve
for the strategy vs. buy-and-hold, the round-trip trades, and summary stats
(CAGR, max drawdown, annualized vol, Sharpe, % time in market, # trades).

Usage: faber.py SYMBOL [sma_months] [start_year]
"""
import sys, json, math


def annualized_vol(monthly_rets):
    n = len(monthly_rets)
    if n < 2:
        return 0.0
    m = sum(monthly_rets) / n
    var = sum((r - m) ** 2 for r in monthly_rets) / (n - 1)
    return math.sqrt(var) * math.sqrt(12)


def max_drawdown(equity):
    peak, mdd = equity[0], 0.0
    for v in equity:
        peak = max(peak, v)
        mdd = max(mdd, (peak - v) / peak)
    return mdd


def cagr(equity, n_months):
    if n_months <= 0 or equity[-1] <= 0:
        return 0.0
    return equity[-1] ** (12.0 / n_months) - 1


def stats_block(rets, equity):
    n = len(rets)
    vol = annualized_vol(rets)
    mean_m = sum(rets) / n if n else 0
    return {
        "totalReturn": round(equity[-1] - 1, 4),
        "cagr": round(cagr(equity, n), 4),
        "maxDrawdown": round(max_drawdown(equity), 4),
        "vol": round(vol, 4),
        "sharpe": round((mean_m * 12) / vol, 3) if vol else 0.0,
    }


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "usage: faber.py SYMBOL [sma_months] [start_year]"}))
        return
    symbol = sys.argv[1].upper()
    sma_n = int(sys.argv[2]) if len(sys.argv) > 2 else 10
    start_year = int(sys.argv[3]) if len(sys.argv) > 3 else None

    try:
        import yfinance as yf
    except Exception as e:
        print(json.dumps({"error": f"yfinance not installed: {e}"}))
        return

    try:
        h = yf.Ticker(symbol).history(period="max", interval="1mo", auto_adjust=True)
        h = h.dropna(subset=["Close"])
        rows = [(str(idx.date()), float(c)) for idx, c in zip(h.index, h["Close"]) if c > 0]
        if start_year:
            rows = [r for r in rows if int(r[0][:4]) >= start_year]
        if len(rows) < sma_n + 3:
            print(json.dumps({"error": f"not enough monthly data for {symbol} ({len(rows)} months)"}))
            return

        dates = [r[0] for r in rows]
        close = [r[1] for r in rows]

        # N-month SMA (None until enough history)
        sma = [None] * len(close)
        for i in range(sma_n - 1, len(close)):
            sma[i] = sum(close[i - sma_n + 1:i + 1]) / sma_n

        # signal[i] = 1 if close>SMA at end of month i (else 0/cash). Position held
        # next month uses the PRIOR month's signal.
        signal = [0] * len(close)
        for i in range(len(close)):
            if sma[i] is not None:
                signal[i] = 1 if close[i] > sma[i] else 0

        first = sma_n - 1  # first month with a valid SMA/signal
        series, equity_rows = [], []
        strat_eq, bh_eq = 1.0, 1.0
        strat_rets, bh_rets = [], []
        trades, in_pos, entry = [], False, None

        for i in range(first, len(close)):
            in_market = bool(signal[i])
            series.append({"date": dates[i], "close": round(close[i], 2),
                           "sma": round(sma[i], 2), "inMarket": in_market})

            if i > first:
                mkt_ret = close[i] / close[i - 1] - 1
                strat_ret = mkt_ret if signal[i - 1] == 1 else 0.0
                strat_eq *= (1 + strat_ret)
                bh_eq *= (1 + mkt_ret)
                strat_rets.append(strat_ret)
                bh_rets.append(mkt_ret)
                equity_rows.append({"date": dates[i], "strat": round(strat_eq, 4), "bh": round(bh_eq, 4)})

            # trade bookkeeping on signal transitions (enter/exit at month close)
            if signal[i] == 1 and not in_pos:
                in_pos, entry = True, (dates[i], close[i])
            elif signal[i] == 0 and in_pos:
                in_pos = False
                ret = close[i] / entry[1] - 1
                trades.append({"entryDate": entry[0], "entryPrice": round(entry[1], 2),
                               "exitDate": dates[i], "exitPrice": round(close[i], 2),
                               "months": dates.index(dates[i]) - dates.index(entry[0]),
                               "ret": round(ret, 4)})
        if in_pos:  # still open at the end
            ret = close[-1] / entry[1] - 1
            trades.append({"entryDate": entry[0], "entryPrice": round(entry[1], 2),
                           "exitDate": "OPEN", "exitPrice": round(close[-1], 2),
                           "months": dates.index(dates[-1]) - dates.index(entry[0]),
                           "ret": round(ret, 4)})

        strat_stats = stats_block(strat_rets, [r["strat"] for r in equity_rows] or [1.0])
        bh_stats = stats_block(bh_rets, [r["bh"] for r in equity_rows] or [1.0])
        strat_stats["timeInMarket"] = round(sum(signal[first:]) / max(1, len(signal[first:])), 3)
        strat_stats["nTrades"] = len(trades)
        wins = [t for t in trades if t["ret"] > 0]
        strat_stats["winRate"] = round(len(wins) / len(trades), 3) if trades else 0.0

        print(json.dumps({
            "symbol": symbol, "smaMonths": sma_n,
            "start": dates[first], "end": dates[-1], "months": len(series),
            "series": series, "equity": equity_rows, "trades": trades,
            "strat": strat_stats, "bh": bh_stats,
        }))
    except Exception as e:
        import traceback
        print(json.dumps({"error": f"{type(e).__name__}: {e}", "trace": traceback.format_exc()[-400:]}))


if __name__ == "__main__":
    main()
