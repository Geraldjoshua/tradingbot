// Gap-and-Go Opening Range Breakout — ported 1:1 from the validated Python.
//
// Rules per trading day:
//   - Opening range (OR) = the first regular-hours bar (09:30-09:45 ET for 15Min).
//   - gap = (today's open - prior day's close) / prior day's close.
//   - Only trade if gapMin <= |gap| <= gapMax.  Direction follows the gap:
//       gap up   -> long  breakout above OR-high
//       gap down -> short breakdown below OR-low
//   - Stop = other side of OR. Target = entry +/- rTarget * OR-range.
//   - If a later bar trades through the stop AND target, assume STOP first (conservative).
//   - If neither hits by 15:45, exit at the last bar's close (time stop).
//   - Position sized so a full stop-out ("1R") loses exactly riskPerTrade dollars.

const ET = "America/New_York";
const OPEN_MIN = 9 * 60 + 30; // 09:30
const CLOSE_MIN = 15 * 60 + 45; // 15:45 (last valid OR/entry window bar start)

// Convert a UTC ISO timestamp -> { date: "YYYY-MM-DD", hm: minutes-since-midnight } in ET.
// Uses Intl so DST (EDT/EST) is handled correctly.
const fmt = new Intl.DateTimeFormat("en-US", {
  timeZone: ET,
  hour12: false,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});
function etParts(iso) {
  const parts = Object.fromEntries(
    fmt.formatToParts(new Date(iso)).map((p) => [p.type, p.value])
  );
  let hour = parseInt(parts.hour, 10);
  if (hour === 24) hour = 0; // Intl can emit "24" for midnight
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hm: hour * 60 + parseInt(parts.minute, 10),
  };
}

// Group bars into regular-hours sessions keyed by ET date.
export function sessions(bars) {
  const days = {};
  for (const b of bars) {
    const { date, hm } = etParts(b.t);
    if (hm >= OPEN_MIN && hm <= CLOSE_MIN) {
      (days[date] || (days[date] = [])).push(b);
    }
  }
  for (const d in days) days[d].sort((a, b) => (a.t < b.t ? -1 : 1));
  return days;
}

export function runBacktest(bars, params = {}) {
  const {
    gapMin = 0.01,
    gapMax = 0.025,
    rTarget = 2,
    riskPerTrade = 100,
  } = params;

  const days = sessions(bars);
  const dates = Object.keys(days).sort();
  const trades = [];
  const skipped = [];

  for (let i = 1; i < dates.length; i++) {
    const bs = days[dates[i]];
    const prev = days[dates[i - 1]];
    if (bs.length < 4 || !prev.length) continue;

    const prevClose = prev[prev.length - 1].c;
    const dayOpen = bs[0].o;
    const gap = (dayOpen - prevClose) / prevClose;

    if (Math.abs(gap) < gapMin || Math.abs(gap) > gapMax) {
      skipped.push({ date: dates[i], gap, reason: "gap-out-of-band" });
      continue;
    }

    const side = gap > 0 ? "long" : "short";
    const orb = bs[0];
    const orh = orb.h;
    const orl = orb.l;
    const rng = orh - orl;
    if (rng <= 0) continue;

    let entered = false;
    let entry, stop, tgt, entryBar;
    let r = null;
    let exitBar = null;
    let exitPrice = null;
    let outcome = null;

    for (let j = 1; j < bs.length; j++) {
      const b = bs[j];
      if (!entered) {
        if (side === "long" && b.h >= orh) {
          entry = orh; stop = orl; tgt = orh + rTarget * rng; entered = true; entryBar = b;
        } else if (side === "short" && b.l <= orl) {
          entry = orl; stop = orh; tgt = orl - rTarget * rng; entered = true; entryBar = b;
        }
      }
      if (entered) {
        if (side === "long") {
          if (b.l <= stop) { r = -1; exitPrice = stop; exitBar = b; outcome = "stop"; break; }
          if (b.h >= tgt) { r = rTarget; exitPrice = tgt; exitBar = b; outcome = "target"; break; }
        } else {
          if (b.h >= stop) { r = -1; exitPrice = stop; exitBar = b; outcome = "stop"; break; }
          if (b.l <= tgt) { r = rTarget; exitPrice = tgt; exitBar = b; outcome = "target"; break; }
        }
      }
    }

    if (!entered) {
      skipped.push({ date: dates[i], gap, reason: "no-breakout" });
      continue;
    }

    if (r === null) {
      // time stop: exit at last bar close
      const last = bs[bs.length - 1];
      exitBar = last;
      exitPrice = last.c;
      r = side === "long" ? (last.c - entry) / rng : (entry - last.c) / rng;
      outcome = "eod";
    }

    const shares = Math.max(1, Math.floor(riskPerTrade / rng));
    trades.push({
      date: dates[i],
      side,
      gap,
      orHigh: orh,
      orLow: orl,
      orRange: rng,
      entry,
      stop,
      target: tgt,
      entryTime: entryBar.t,
      exitTime: exitBar.t,
      exitPrice,
      outcome,
      r,
      shares,
      pnl: r * riskPerTrade,
    });
  }

  return { trades, skipped, stats: computeStats(trades, riskPerTrade) };
}

export function computeStats(trades, riskPerTrade = 100) {
  const n = trades.length;
  if (!n) {
    return {
      n: 0, wins: 0, losses: 0, winRate: 0, expectancyR: 0, avgWinR: 0,
      avgLossR: 0, totalR: 0, totalPnl: 0, profitFactor: 0, maxDrawdownR: 0,
      equityCurve: [],
    };
  }
  let wins = 0, losses = 0, grossWin = 0, grossLoss = 0, totalR = 0;
  const equityCurve = [];
  let cum = 0, peak = 0, maxDD = 0;
  for (const t of trades) {
    totalR += t.r;
    if (t.r > 0) { wins++; grossWin += t.r; }
    else { losses++; grossLoss += Math.abs(t.r); }
    cum += t.r;
    peak = Math.max(peak, cum);
    maxDD = Math.max(maxDD, peak - cum);
    equityCurve.push({ date: t.date, cumR: +cum.toFixed(3), cumPnl: +(cum * riskPerTrade).toFixed(2) });
  }
  return {
    n,
    wins,
    losses,
    winRate: +(wins / n).toFixed(4),
    expectancyR: +(totalR / n).toFixed(4),
    avgWinR: wins ? +(grossWin / wins).toFixed(3) : 0,
    avgLossR: losses ? +(-grossLoss / losses).toFixed(3) : 0,
    totalR: +totalR.toFixed(3),
    totalPnl: +(totalR * riskPerTrade).toFixed(2),
    profitFactor: grossLoss ? +(grossWin / grossLoss).toFixed(3) : (grossWin ? Infinity : 0),
    maxDrawdownR: +maxDD.toFixed(3),
    equityCurve,
  };
}
