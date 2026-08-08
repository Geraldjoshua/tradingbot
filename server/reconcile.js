// Reconcile local position state against Alpaca — run on every boot.
//
// WHY THIS IS NEEDED: you shut the laptop down each evening, so the bot is blind
// overnight while Alpaca keeps living. Our JSON store can therefore be wrong by
// morning in several ways, and every one of them is dangerous in a different way:
//
//   1. PHANTOM OPEN — store says OPEN, Alpaca has no such position. It expired,
//      was assigned, or you closed it by hand. Left alone the loop keeps trying to
//      "manage" something that doesn't exist, and every exit attempt errors.
//
//   2. UNRESOLVED ENTRY — we placed a marketable limit near the close and shut
//      down before knowing the outcome. The order may have filled (we're actually
//      in the trade, with no stop being watched), or expired unfilled (we think
//      we're in a trade we never got).
//
//   3. UNTRACKED POSITION — Alpaca holds something the store doesn't know about.
//      Nothing is managing its stop. We flag it loudly rather than adopting it
//      silently, because inventing entry levels for a position we didn't plan
//      would be worse than saying "a human should look at this".
//
// Alpaca is the source of truth for WHAT WE HOLD. The local store is the source of
// truth for WHY (levels, targets, flow context) — that can't be recovered from the
// broker, which is exactly why we don't auto-adopt.

import * as alpaca from "./alpaca.js";
import * as vd from "./voldesk_trades.js";
import * as flow from "./flow.js";
import * as playbook from "./playbook.js";
import * as discovery from "./discovery.js";

const iso = () => new Date().toISOString().slice(0, 10);

// ---- OCC symbol parsing ---------------------------------------------------
// AAPL251219C00250000 -> { underlying: "AAPL", expiry: "2025-12-19",
//                          type: "call", strike: 250 }
// Needed to adopt an untracked OPTION: we cannot re-derive levels without
// knowing which underlying it belongs to.
export function parseOcc(sym) {
  const m = /^([A-Z]+)(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/.exec(String(sym || ""));
  if (!m) return null;
  return {
    underlying: m[1],
    expiry: `20${m[2]}-${m[3]}-${m[4]}`,
    type: m[5] === "C" ? "call" : "put",
    strike: parseInt(m[6], 10) / 1000,
  };
}

// ---- Recovering a real entry from the broker ledger ------------------------
// The first version of adoption stamped entrySpot with TODAY'S spot and admitted
// it was an estimate. That is worse than it sounds: the day-7 time stop and the
// progress-to-target maths both key off entry, so an adopted position silently
// claimed to be zero days old with zero progress. A trade opened three weeks ago
// would look brand new, and one already 80% of the way to target would look like
// it had gone nowhere and get stopped out for stalling.
//
// It does not have to be a guess. /v2/account/activities is the one record that
// forgets nothing — history.js already uses it as its spine. Walk this symbol's
// fills forward, find where the CURRENT continuous holding period began, and
// that is the real entry: real date, real price. Then the underlying's close on
// that date gives a real entrySpot.
async function recoverEntry(symbol, lp) {
  const out = { entryDate: null, entryPrice: parseFloat(lp.avg_entry_price) || null,
                entrySpot: null, recovered: false };
  let acts = [];
  try {
    acts = await alpaca.getActivities({
      types: ["FILL"],
      after: new Date(Date.now() - 180 * 864e5).toISOString().slice(0, 10),
    });
  } catch { return out; }

  const mine = acts
    .filter((a) => a.symbol === symbol)
    .sort((a, b) => String(a.transaction_time || "").localeCompare(String(b.transaction_time || "")));
  if (!mine.length) return out;

  // Walk forward tracking net quantity. The most recent transition from flat to
  // non-flat is when the position we are holding right now was opened.
  let running = 0, openedAt = null;
  for (const a of mine) {
    const q = Math.abs(parseFloat(a.qty) || 0);
    const signed = String(a.side || "").startsWith("s") ? -q : q;
    const before = running;
    running += signed;
    if (before === 0 && running !== 0) openedAt = a;
  }
  if (!openedAt) return out;

  out.entryDate = String(openedAt.transaction_time || "").slice(0, 10) || null;
  const px = parseFloat(openedAt.price);
  if (Number.isFinite(px) && px > 0) out.entryPrice = px;
  out.recovered = Boolean(out.entryDate);
  return out;
}

// Underlying close on a given date — the entrySpot the stop framework needs.
async function spotOn(ticker, dateIso) {
  try {
    const start = new Date(Date.parse(dateIso) - 6 * 864e5).toISOString();
    const end = new Date(Date.parse(dateIso) + 864e5).toISOString();
    const bars = await alpaca.getBars(ticker, "1Day", start, end);
    if (!bars?.length) return null;
    const exact = bars.find((b) => String(b.t).slice(0, 10) === dateIso);
    return +(exact?.c ?? bars[bars.length - 1].c);
  } catch { return null; }
}

// ---- Adoption -------------------------------------------------------------
// An untracked position is one the broker holds and the store doesn't know
// about. The original reasoning for refusing to adopt was sound — inventing
// entry levels for a position we didn't plan is worse than saying "a human
// should look at this" — but it left a real gap: the position then sits with NO
// stop, NO target and NO time limit, forever. That is what "it goes to profit
// and then comes back out" looks like from the outside. Nothing is managing it.
//
// The resolution is not to invent levels. It is to RE-DERIVE them: run the same
// Vol Desk scan the bot would have run, take pTrans/nTrans/T1 from real GEX
// data, and use the broker's own average entry price as the entry. The only
// thing we cannot recover is the original thesis, so the adopted row is marked
// `adopted: true` and carries no flow context.
//
// Off by default. A position you opened deliberately by hand should not start
// being sold by a loop you didn't point at it.
async function adoptOne(lp, cfg, mode = "protect") {
  const isOption = /^[A-Z]+\d{6}[CP]\d{8}$/.test(lp.symbol);
  const occ = isOption ? parseOcc(lp.symbol) : null;
  const ticker = isOption ? occ?.underlying : lp.symbol;
  if (!ticker) return { ok: false, reason: `cannot parse symbol ${lp.symbol}` };

  let snap = vd.latestSnapshot(ticker);
  if (!snap) {
    try { await discovery.scanTicker(ticker, cfg); } catch {}
    snap = vd.latestSnapshot(ticker);
  }
  if (!snap?.levels) return { ok: false, reason: `no Vol Desk levels for ${ticker}` };

  // Direction from the position itself, not from a guess: a long put is a
  // bearish position even though the option leg is "long".
  const side = isOption ? (occ.type === "put" ? "short" : "long")
                        : (parseFloat(lp.qty) < 0 ? "short" : "long");
  const lv = playbook.levelsFor(snap, side);
  if (!lv) return { ok: false, reason: `snapshot for ${ticker} lacks usable levels` };

  const qty = Math.abs(parseFloat(lp.qty)) || 0;
  if (!qty) return { ok: false, reason: "zero quantity" };

  const rec = await recoverEntry(lp.symbol, lp);
  const avg = rec.entryPrice;
  const entryDate = rec.entryDate || iso();
  const entrySpot = (rec.entryDate ? await spotOn(ticker, rec.entryDate) : null) ?? snap.spot ?? null;

  const pos = {
    id: `${ticker}-adopted-${Date.now()}`,
    ticker, side,
    instrument: isOption ? "option" : "shares",
    ...(isOption ? {
      optionType: occ.type, optionSymbol: lp.symbol,
      strike: occ.strike, expiry: occ.expiry, contracts: qty,
      entryPremium: avg,
    } : { shares: qty, entryPrice: avg }),
    entryFilled: true,
    entryDate,
    entrySpot,
    // True only when the broker ledger could not be read. When false, the date
    // and price came from the actual opening fill, so the time stop and the
    // progress maths are measuring the real trade rather than a fiction.
    entrySpotIsEstimate: !rec.recovered,
    entryRecoveredFromLedger: rec.recovered,
    manageMode: mode,
    pTrans: snap.levels.pTrans, nTrans: snap.levels.nTrans,
    trigger: lv.trigger, stopLevel: lv.stop, t1: lv.t1, t2: lv.t2,
    lockedToBreakeven: false,
    status: "OPEN",
    orderId: null,
    adopted: true,
    adoptedAt: new Date().toISOString(),
    triggeredBy: "adopted-from-broker",
    flowAtEntry: null,
  };
  vd.adoptPosition(pos);
  return { ok: true, position: pos };
}

// Single-flight. Two concurrent reconciles both load the store before either
// writes, so both conclude the same position is untracked and both adopt it —
// which is exactly how every row ended up duplicated. Callers that arrive while
// one is running get the SAME promise rather than starting a second pass.
let inFlight = null;

export async function reconcile(opts = {}) {
  if (inFlight) return inFlight;
  inFlight = _reconcile(opts).finally(() => { inFlight = null; });
  return inFlight;
}

async function _reconcile({ apply = true, cfg = null } = {}) {
  cfg = cfg || flow.loadConfig();
  const out = {
    ranAt: new Date().toISOString(),
    checked: 0, phantomsClosed: [], entriesResolved: [], untracked: [], errors: [],
  };

  // Live truth from the broker.
  let livePositions = [], liveOrders = [];
  try {
    livePositions = await alpaca.getPositions();
  } catch (e) {
    out.errors.push(`getPositions failed: ${String(e.message || e)}`);
    return out;   // without broker truth, changing local state would be guessing
  }
  try {
    // "all" so we can see yesterday's filled/expired/canceled entry orders.
    liveOrders = await alpaca.getOrders("all");
  } catch (e) {
    out.errors.push(`getOrders failed: ${String(e.message || e)}`);
  }

  const heldBySymbol = new Map(livePositions.map((p) => [p.symbol, p]));
  const orderById = new Map((liveOrders || []).map((o) => [o.id, o]));

  const rows = vd.listAll();
  const open = rows.filter((p) => p.status === "OPEN");
  out.checked = open.length;

  for (const p of open) {
    // The symbol we'd actually be holding: option contract, or the ticker itself.
    const sym = p.instrument === "shares" ? p.ticker : p.optionSymbol;
    const held = heldBySymbol.get(sym);
    const entryOrder = p.orderId ? orderById.get(p.orderId) : null;
    const orderStatus = entryOrder?.status || null;

    if (held) {
      // We really hold it. If the entry filled overnight, record the real fill
      // price — our stored entryPremium was only an estimate at placement.
      const filledAvg = parseFloat(entryOrder?.filled_avg_price ?? "");
      if (Number.isFinite(filledAvg) && filledAvg > 0) {
        const stored = p.instrument === "shares" ? p.entryPrice : p.entryPremium;
        if (!stored || Math.abs(stored - filledAvg) / Math.max(stored, 0.01) > 0.02) {
          if (apply) {
            vd.patchPosition(p.id, p.instrument === "shares"
              ? { entryPrice: +filledAvg.toFixed(2), fillReconciled: true }
              : { entryPremium: +filledAvg.toFixed(2), fillReconciled: true });
          }
          out.entriesResolved.push({
            ticker: p.ticker, id: p.id, action: "fill-price-corrected",
            from: stored ?? null, to: +filledAvg.toFixed(2),
          });
        }
      }
      continue;
    }

    // Not held at Alpaca. Which case is it?
    if (orderStatus && ["new", "accepted", "held", "partially_filled", "pending_new"].includes(orderStatus)) {
      // Entry still working — leave it alone, the loop will see the fill.
      out.entriesResolved.push({ ticker: p.ticker, id: p.id, action: "entry-still-working", orderStatus });
      continue;
    }

    if (orderStatus && ["canceled", "expired", "rejected"].includes(orderStatus)) {
      if (apply) vd.markStatus(p.id, "CANCELED", `reconcile: entry ${orderStatus} overnight (never filled)`);
      out.entriesResolved.push({ ticker: p.ticker, id: p.id, action: "entry-never-filled", orderStatus });
      continue;
    }

    // Order filled (or unknown) yet nothing is held → the position is gone:
    // expired worthless, assigned, or closed outside the bot.
    const why = orderStatus === "filled"
      ? "position no longer at broker (expired / assigned / closed outside the bot)"
      : `position not at broker and entry order status unknown${orderStatus ? ` (${orderStatus})` : ""}`;
    if (apply) vd.markStatus(p.id, "CLOSED", `reconcile: ${why}`);
    out.phantomsClosed.push({ ticker: p.ticker, id: p.id, reason: why, orderStatus });
  }

  // Anything at the broker we aren't tracking?
  const trackedSymbols = new Set(open.map((p) => p.instrument === "shares" ? p.ticker : p.optionSymbol));
  // ---- ORPHAN vs MANUAL --------------------------------------------------
  // These are not the same thing and they deserve opposite defaults.
  //
  //   ORPHAN — a position the bot itself opened and then lost track of. This is
  //     not exotic: data/ is gitignored and wiped on every redeploy, so the bot
  //     routinely orphans its OWN trades. Refusing to manage those is indefensible
  //     — they were placed under the framework and should stay under it.
  //
  //   MANUAL — something you bought yourself, with your own thesis and horizon.
  //     Applying a GEX swing playbook to a LEAP or a hedge would sell it for
  //     reasons that have nothing to do with why you own it.
  //
  // TWO independent ways to recognise our own work, because the obvious one is
  // destroyed by the event that matters most.
  //
  //   (1) the local store has ever held this symbol. Precise, but data/ is
  //       gitignored and wiped on redeploy — so after the very failure that
  //       creates orphans, this evidence is gone. It only helps in the partial
  //       case, which is the one that needed help least.
  //
  //   (2) the opening order's client_order_id starts with "vd-". The BROKER
  //       stores that, so it survives any local wipe, any redeploy, any fresh
  //       clone. This is the one that actually answers "was this mine?" after a
  //       deployment.
  //
  // (2) only works for orders placed after order tagging existed. Anything older
  // has a broker-generated UUID and will fall back to (1), then to "manual".
  const everKnown = new Set(rows.map((p) => (p.instrument === "shares" ? p.ticker : p.optionSymbol)));
  const rc = cfg.reconcile || {};

  async function provenance(lp) {
    if (everKnown.has(lp.symbol)) return { isOrphan: true, via: "local store" };
    // Ask the broker. Find the fill that opened the current holding period and
    // look at the order behind it.
    try {
      const acts = await alpaca.getActivities({
        types: ["FILL"],
        after: new Date(Date.now() - 180 * 864e5).toISOString().slice(0, 10),
      });
      const mine = acts
        .filter((a) => a.symbol === lp.symbol)
        .sort((a, b) => String(a.transaction_time || "").localeCompare(String(b.transaction_time || "")));
      let running = 0, openedAt = null;
      for (const a of mine) {
        const q = Math.abs(parseFloat(a.qty) || 0);
        const before = running;
        running += String(a.side || "").startsWith("s") ? -q : q;
        if (before === 0 && running !== 0) openedAt = a;
      }
      if (openedAt?.order_id) {
        const ord = await alpaca.getOrder(openedAt.order_id);
        if (alpaca.isOurClientOrderId(ord?.client_order_id)) {
          return { isOrphan: true, via: `broker tag ${ord.client_order_id}` };
        }
        return { isOrphan: false, via: "broker tag absent — placed outside the bot" };
      }
    } catch { /* fall through */ }
    return { isOrphan: false, via: "no provenance found" };
  }

  out.adopted = [];
  for (const lp of livePositions) {
    if (trackedSymbols.has(lp.symbol)) continue;
    const prov = await provenance(lp);
    const isOrphan = prov.isOrphan;
    const mode = isOrphan ? (rc.orphanMode ?? "full") : (rc.adoptUntracked ?? "off");

    const row = {
      symbol: lp.symbol, qty: lp.qty, side: lp.side, isOrphan,
      provenance: prov.via,
      marketValue: lp.market_value, unrealizedPl: lp.unrealized_pl,
      note: mode === "off"
        ? "held at Alpaca but NOT in the bot's store — nothing is applying a stop, "
          + "target or time limit. It will drift to profit and back indefinitely. "
          + `Set reconcile.${isOrphan ? "orphanMode" : "adoptUntracked"} to "protect" or `
          + '"full" to have the bot manage it, or close it by hand.'
        : "untracked — adopting",
    };

    if (mode !== "off" && apply) {
      try {
        const r = await adoptOne(lp, cfg, mode);
        if (r.ok && r.position?.duplicateSkipped) {
          // Already tracked by a concurrent pass — not an error, but worth
          // counting so a race shows up in the log instead of as a double row.
          out.adopted.push({ symbol: lp.symbol, ticker: r.position.ticker,
                             skipped: "already tracked (concurrent reconcile)" });
          continue;
        }
        if (r.ok) {
          const p = r.position;
          out.adopted.push({
            symbol: lp.symbol, ticker: p.ticker, side: p.side,
            isOrphan, mode, provenance: prov.via,
            stop: p.stopLevel, t1: p.t1,
            entryDate: p.entryDate, entrySpot: p.entrySpot,
            fromLedger: p.entryRecoveredFromLedger,
            note: (p.entryRecoveredFromLedger
                    ? `entry recovered from the broker ledger (${p.entryDate}) — the time `
                      + "stop and progress maths measure the real trade"
                    : "LEDGER UNREADABLE — entry date/spot are estimates, so the day-7 time "
                      + "stop restarts from now")
                  + (mode === "protect"
                      ? ". PROTECT mode: structural + catastrophic stops only, no time stop "
                        + "and no auto-take-profit — your thesis, your exit."
                      : ". FULL mode: the complete Stop 1-6 / T1 framework applies."),
          });
          continue;
        }
        row.adoptFailed = r.reason;
      } catch (e) {
        row.adoptFailed = String(e.message || e);
      }
    }
    out.untracked.push(row);
  }

  return out;
}

// Human-readable one-liner for the boot log.
export function summarize(r) {
  if (r.errors.length && !r.checked) return `reconcile skipped: ${r.errors[0]}`;
  const bits = [`${r.checked} open checked`];
  if (r.phantomsClosed.length) bits.push(`${r.phantomsClosed.length} phantom closed`);
  if (r.entriesResolved.length) bits.push(`${r.entriesResolved.length} entry resolved`);
  if (r.adopted?.length) bits.push(`${r.adopted.length} adopted`);
  if (r.untracked.length) bits.push(`${r.untracked.length} UNTRACKED at broker`);
  if (r.errors.length) bits.push(`${r.errors.length} error(s)`);
  return bits.join(", ");
}
