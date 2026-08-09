import { useState } from "react";
import { getGex } from "../api";
import type { GexResult } from "../types";

// ---- Reading the map: which side does this structure favour? --------------
//
// This is NOT a new opinion. It is the SAME playbook the auto-trader runs
// (server/playbook.js levelsFor), just rendered on the chart:
//
//   LONG  trigger = reclaim the gamma flip   stop = put wall   target = call wall
//   SHORT trigger = lose the put wall        stop = flip       target = measured move
//
// The reasoning behind it: below the flip, dealers are short gamma and hedge
// WITH the move, so moves get amplified — breakdowns run. Above it they are long
// gamma and hedge against the move, so price tends to get pulled toward the call
// wall and pin there. The walls are where that hedging concentrates, which is why
// they act as target and stop rather than arbitrary levels.
//
// DELIBERATELY NOT A SIGNAL. This reads raw GEX geometry only. It does not know
// about the 11-rule grade, db_change, the cushion to put mass, the spike-crash
// check, or R/R at the actual fill — all of which the Vol Desk scan applies and
// any of which can block a setup that looks clean here. Treat it as "what shape
// is this chart", not "take this trade".
type Verdict = {
  side: "call" | "put" | "none";
  label: string; entry: number | null; stop: number | null;
  target: number | null; rr: number | null; why: string; caution?: string;
};

function readStructure(
  spot: number, flip: number | null, callWall: number | null,
  putWall: number | null, regime: string | null,
): Verdict {
  const rr = (e: number, s: number, t: number) => {
    const risk = Math.abs(e - s), reward = Math.abs(t - e);
    return risk > 0 ? +(reward / risk).toFixed(2) : null;
  };

  // Put wall already broken -> dealers accelerate downside. Bearish mirror.
  if (putWall != null && spot < putWall) {
    const band = flip != null ? Math.max(flip - putWall, 0.01) : spot * 0.02;
    const target = +(putWall - band).toFixed(2);
    return {
      side: "put", label: "PUTS", entry: +spot.toFixed(2),
      stop: flip ?? +(putWall * 1.01).toFixed(2), target,
      rr: rr(spot, flip ?? putWall * 1.01, target),
      why: `Spot ${spot.toFixed(2)} is below the put wall ${putWall}. That wall was the `
        + "support dealers were hedging against; through it they sell into weakness "
        + "instead of buying it, so downside accelerates.",
      caution: "The bearish side is a mirror heuristic with far less forward-testing "
        + "than the long side, and shorts are opt-in in the auto-trader.",
    };
  }

  // Above the flip with a wall overhead -> the reclaim setup the bot trades.
  if (flip != null && spot > flip && callWall != null && callWall > spot && putWall != null && putWall < spot) {
    const r = rr(spot, putWall, callWall);
    return {
      side: "call", label: "CALLS", entry: +spot.toFixed(2),
      stop: putWall, target: callWall, rr: r,
      why: `Spot ${spot.toFixed(2)} is above the gamma flip ${flip}, so dealers are long `
        + `gamma and hedging pulls price toward the call wall ${callWall}. The put wall `
        + `${putWall} is the level that invalidates it.`,
      caution: r != null && r < 1.5
        ? `R/R from here is only ${r}:1 — the move to the wall no longer pays for the risk `
          + "to the stop. This is what the CHASED gate refuses at entry."
        : undefined,
    };
  }

  // Between the levels: the setup exists but has not triggered.
  if (flip != null && spot <= flip && putWall != null && spot >= putWall) {
    const dist = ((flip - spot) / spot) * 100;
    return {
      side: "none", label: "WAIT",
      entry: flip, stop: putWall, target: callWall,
      rr: callWall != null ? rr(flip, putWall, callWall) : null,
      why: `Spot ${spot.toFixed(2)} sits between the put wall ${putWall} and the flip ${flip} `
        + `(${dist.toFixed(1)}% below it). Dealers are short gamma here, so it is the noisy `
        + "part of the map. The long setup starts on a 5-min close back above the flip.",
    };
  }

  return {
    side: "none", label: "NO READ", entry: null, stop: null, target: null, rr: null,
    why: regime === null
      ? "No gamma flip found inside the scanned band — one side dominates every strike, "
        + "so there is no pivot to trade against."
      : "The levels do not form a usable structure (missing a wall, or spot outside them).",
  };
}

function fmtB(n: number) {
  const a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return n.toFixed(0);
}

export default function GexView() {
  const [symbol, setSymbol] = useState("SPY");
  const [maxDte, setMaxDte] = useState(45);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [errDetail, setErrDetail] = useState<any>(null);
  const [gex, setGex] = useState<GexResult | null>(null);

  async function run() {
    setBusy(true); setErr(""); setErrDetail(null);
    try {
      setErrDetail(null);
      setGex(await getGex(symbol.toUpperCase(), 4, maxDte));
    } catch (e: any) { setErr(e.message || String(e)); setErrDetail(e.detail || null); setGex(null); }
    finally { setBusy(false); }
  }

  // window the profile to ±8% around spot for a readable chart
  // Defensive on purpose. `gex.profile` was read straight off the response, so a
  // payload without one — which /api/gex used to return with a 200 whenever
  // gex.py printed {"error": ...} — threw
  //   TypeError: Cannot read properties of undefined (reading 'filter')
  // and took the whole tab down. The server now returns a proper status, but the
  // view should not depend on that to stay alive.
  const profile = Array.isArray(gex?.profile) ? gex!.profile : [];
  const windowed = gex && gex.spot
    ? profile.filter((p) => Math.abs(p.strike - gex.spot) <= gex.spot * 0.08)
    : [];
  const maxAbs = Math.max(1, ...windowed.map((p) => Math.abs(p.gex)));

  // ---- MARK EXACTLY ONE STRIKE PER LEVEL ----------------------------------
  // The old test was `Math.abs(p.strike - gex.spot) < gex.spot * 0.0025`, i.e. a
  // ±0.25% tolerance. On SPY at 774 that is ±1.94 points, and SPY strikes are $1
  // apart — so FOUR strikes were labelled "◄spot" and four more "◄flip". Stacked
  // in an 18px row they read as garbage (spp3 / spp4 / spot on top of each other).
  //
  // A marker means "this is the level", so it belongs on the single nearest
  // strike. Computed once here instead of re-tested per row.
  const nearestTo = (target: number | null | undefined) => {
    if (target == null || !windowed.length) return null;
    return windowed.reduce((best, p) =>
      Math.abs(p.strike - target) < Math.abs(best.strike - target) ? p : best).strike;
  };
  const spotStrike = nearestTo(gex?.spot);
  const flipStrike = gex?.flipFound === false ? null : nearestTo(gex?.gammaFlip);
  const callWallStrike = nearestTo(gex?.callWall?.strike);
  const putWallStrike = nearestTo(gex?.putWall?.strike);

  // Where a PUT trade actually takes profit — which is NOT the put wall.
  // The put wall is where a short is TRIGGERED (dealers flip from buying weakness
  // to selling it); the target is a measured move BELOW it, the same
  // nTrans - (pTrans - nTrans) that playbook.levelsFor(snap,"short") computes.
  // Without this marker the chart showed where to ENTER puts and nowhere to
  // exit them, which reads as though the put wall were the target.
  //
  // TWO GEOMETRIES, and the first version only handled one.
  //
  //   NORMAL   put wall < flip < spot
  //            The flip is the long trigger and the put wall is the stop below
  //            it. A short's target is a measured move below the wall:
  //            putWall - (flip - putWall).
  //
  //   INVERTED flip < put wall < spot        (seen live on NVDA: 207.5 / 220 / 225)
  //            The zero-crossing sits BELOW the biggest put-gamma strike. Here
  //            `flip - putWall` is negative, so the measured move lands ABOVE the
  //            wall — nonsense — and the old guard returned null and drew nothing.
  //
  //            Silence was the wrong answer. There IS a downside objective in this
  //            shape and it is the flip: from the wall down to it dealers are still
  //            long gamma so the fall is dampened, and BELOW it they are short
  //            gamma and selling feeds selling. That is exactly where a put taken
  //            at the wall should come off.
  // Mirrors WALL_MIN_DIST_PCT in gexcore.py (config: walls.minDistancePct).
  const wallMinDist = 0.015;
  const flipVal = gex?.flipFound === false ? null : (gex?.gammaFlip ?? null);
  const putWallVal = gex?.putWall?.strike ?? null;
  const inverted = flipVal != null && putWallVal != null && flipVal < putWallVal;
  const putTargetStrike = (() => {
    if (flipVal == null || putWallVal == null) return null;
    if (inverted) return nearestTo(flipVal);                       // the flip is the objective
    return nearestTo(putWallVal - (flipVal - putWallVal));         // measured move below the wall
  })();

  return (
    <div>
      <div className="panel">
        <div className="row">
          <div className="field"><label>Underlying</label>
            <input value={symbol} onChange={(e) => setSymbol(e.target.value)} /></div>
          <div className="field"><label>Max DTE (days)</label>
            <input type="number" value={maxDte} onChange={(e) => setMaxDte(+e.target.value)} /></div>
          <button className="primary" onClick={run} disabled={busy}>{busy ? "Computing…" : "Compute GEX"}</button>
        </div>
        <p className="hint" style={{ marginTop: 10 }}>
          Open interest and implied vol come from Alpaca (Yahoo is the fallback when Alpaca
          keys are missing or the API is down); gamma is computed locally via Black-Scholes.
          Aggregates the nearest expiries within Max DTE. Dealer convention: long calls, short puts.
        </p>
      </div>

      {err && (
        <div className="panel" style={{ borderColor: "var(--red)" }}>
          <strong style={{ color: "var(--red)" }}>Couldn't compute GEX for {symbol.toUpperCase()}</strong>
          <p className="hint" style={{ marginTop: 6 }}>{err}</p>
          {/* Which feeds were tried, and what each one said. Without this the tab
              just went quiet and you could not tell "no keys on Render" from
              "Alpaca is 403ing" from "this symbol has no chain". */}
          {Array.isArray(errDetail?.providerTrace) && errDetail.providerTrace.length > 0 && (
            <table style={{ marginTop: 8, fontSize: 12 }}>
              <thead><tr><th style={{ textAlign: "left" }}>Data source</th>
                <th style={{ textAlign: "left" }}>Result</th>
                <th style={{ textAlign: "left" }}>Detail</th></tr></thead>
              <tbody>
                {errDetail.providerTrace.map((t: any, i: number) => (
                  <tr key={i}>
                    <td style={{ paddingRight: 14, fontWeight: 700 }}>{t.provider}</td>
                    <td style={{ paddingRight: 14, color: t.result === "ok" ? "var(--green)" : "var(--red)" }}>
                      {t.result}
                    </td>
                    <td style={{ color: "var(--muted)" }}>{t.detail || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {errDetail?.hint && (
            <p className="sub" style={{ marginTop: 8, color: "#e0b341" }}>{errDetail.hint}</p>
          )}
        </div>
      )}

      {/* A response with no usable profile is a data problem, not a crash. */}
      {gex && !windowed.length && (
        <div className="panel">
          <strong>No strike profile returned for {gex.symbol || symbol}</strong>
          <p className="hint" style={{ marginTop: 6 }}>
            The request succeeded but came back without usable strikes. Usually the option
            chain was empty for the DTE window, or every strike failed the IV/open-interest
            sanity filters. Try a longer Max DTE, or a more liquid underlying.
          </p>
        </div>
      )}
      {gex && windowed.length > 0 && (
        <>
          <div className="panel">
            <div className="spread" style={{ marginBottom: 12 }}>
              <strong>{gex.symbol} — dealer gamma exposure</strong>
              <span className="hint">
                expiries: {gex.expiries.join(", ")}
                {(gex as any).dataQuality?.provider && (
                  <> · source <b style={{
                    color: (gex as any).dataQuality.provider === "alpaca" ? "var(--green)" : "#e0b341",
                  }}>{(gex as any).dataQuality.provider}</b></>
                )}
                {(gex as any).dataQuality?.oiDate
                  ? <> · OI as of {(gex as any).dataQuality.oiDate}</>
                  : (gex as any).dataQuality?.provider === "yahoo"
                    ? <> · <span style={{ color: "#e0b341" }}>OI date unknown (Yahoo never says)</span></>
                    : null}
              </span>
            </div>
            <div className="stats-grid">
              <div className="stat"><div className="k">Spot</div><div className="v">${gex.spot}</div></div>
              <div className="stat"><div className="k">Gamma flip</div>
                <div className="v">{gex.flipFound === false ? "none in range" : (gex.gammaFlip ?? "—")}</div></div>
              <div className="stat"><div className="k">Regime</div>
                <div className={`v ${gex.regime === "long_gamma" ? "pos" : "neg"}`}>
                  {gex.regime === "long_gamma" ? "Long γ" : gex.regime === "short_gamma" ? "Short γ" : "—"}
                </div></div>
              <div className="stat"><div className="k">Call wall (resist.)</div><div className="v pos">{gex.callWall?.strike ?? "—"}</div></div>
              <div className="stat"><div className="k">Put wall (support)</div><div className="v neg">{gex.putWall?.strike ?? "—"}</div></div>
              <div className="stat"><div className="k">Total GEX /1%</div>
                <div className={`v ${gex.totalGex >= 0 ? "pos" : "neg"}`}>{fmtB(gex.totalGex)}</div></div>
            </div>
            <p className="hint" style={{ marginTop: 10 }}>
              {gex.regime === "long_gamma"
                ? "Spot above flip → dealers long gamma → moves tend to get dampened (mean-revert)."
                : "Spot below flip → dealers short gamma → moves tend to get amplified (trend/vol up)."}
            </p>

            {/* ---- What the structure favours ---------------------------- */}
            {(() => {
              const v = readStructure(
                gex.spot,
                gex.flipFound === false ? null : gex.gammaFlip,
                gex.callWall?.strike ?? null,
                gex.putWall?.strike ?? null,
                gex.regime,
              );
              const tone = v.side === "call" ? "var(--green)"
                : v.side === "put" ? "var(--red)" : "var(--muted)";
              return (
                <div style={{
                  marginTop: 12, padding: "10px 12px", borderRadius: 6,
                  border: `1px solid ${tone}`, background: "rgba(255,255,255,.02)",
                }}>
                  <div className="row" style={{ alignItems: "baseline", gap: 10 }}>
                    <span style={{ color: tone, fontWeight: 800, fontSize: 15 }}>
                      {v.side === "call" ? "▲ " : v.side === "put" ? "▼ " : "• "}{v.label}
                    </span>
                    {v.rr != null && (
                      <span className="hint">
                        R/R from here <b style={{ color: v.rr >= 2 ? "var(--green)" : v.rr >= 1.5 ? "#e0b341" : "var(--red)" }}>
                          {v.rr}:1</b>
                      </span>
                    )}
                    {v.entry != null && (
                      <span className="hint">
                        {v.side === "none" ? "trigger" : "entry"} <b>{v.entry}</b>
                        {v.stop != null && <> · stop <b>{v.stop}</b></>}
                        {v.target != null && <> · target <b>{v.target}</b></>}
                      </span>
                    )}
                  </div>
                  <p className="sub" style={{ margin: "6px 0 0" }}>{v.why}</p>
                  {v.caution && (
                    <p className="sub" style={{ margin: "4px 0 0", color: "#e0b341" }}>
                      ⚠ {v.caution}
                    </p>
                  )}
                  <p className="sub" style={{ margin: "6px 0 0", color: "var(--muted)" }}>
                    This is the raw GEX geometry only — the same levels the auto-trader uses, but
                    none of its filters. Grade, db_change, cushion to put mass, the spike-crash
                    check and R/R at the actual fill are all applied by the <b>Vol Desk</b> scan and
                    any one of them can block a chart that looks clean here. Read it as the shape of
                    the map, not as a trade.
                  </p>
                </div>
              );
            })()}
          </div>

          <div className="panel">
            <strong>GEX by strike (±8% of spot)</strong>
            <div style={{ marginTop: 12 }}>
              {windowed.map((p) => {
                const pct = (p.gex / maxAbs) * 50; // half-width %
                const isSpot = p.strike === spotStrike;
                const isFlip = p.strike === flipStrike;
                const isCall = p.strike === callWallStrike;
                const isPut = p.strike === putWallStrike;
                const isPutTgt = p.strike === putTargetStrike && !isPut;
                // spot wins over flip wins over a wall, so one row never tries to
                // render two markers in a box sized for one.
                const marker = isSpot ? "spot" : isFlip ? "flip" : isCall ? "call wall"
                  : isPut ? "put wall" : isPutTgt ? "put target" : "";
                // What the level is FOR, not just what it is called. A chart that
                // says "flip" assumes you remember that the flip is the long
                // trigger; saying so removes the step.
                // ENTRY vs EXIT stated explicitly. "PUTS below" was ambiguous —
                // it reads as "puts profit below here" when it means "puts are
                // TRIGGERED below here". Those are opposite ends of the trade.
                // In the inverted shape the flip is BOTH the gamma pivot and the
                // downside objective, so it has to say both — otherwise the chart
                // shows a put entry with no exit anywhere on it.
                const role = isSpot ? "you are here"
                  : isFlip ? (inverted
                      ? "PUT take-profit · below here selling accelerates"
                      : "buy CALLS above · short stop")
                  : isCall ? "CALL take-profit"
                  : isPut ? (inverted
                      ? "CALL stop-out · buy PUTS below"
                      : "CALL stop-out · buy PUTS below")
                  : isPutTgt ? "PUT take-profit"
                  : "";
                const colour = isSpot ? "var(--accent)" : isFlip ? "#e0b341"
                  : isCall ? "var(--green)" : isPut ? "var(--red)"
                  : isPutTgt ? "var(--red)" : "var(--muted)";
                // Strikes inside WALL_MIN_DIST_PCT of spot cannot normally be a
                // wall, however big their bar. Without showing it, the obvious
                // reading of this chart is "the wall marker is on the wrong bar".
                const inDeadZone = Math.abs(p.strike - gex.spot) < gex.spot * wallMinDist;
                return (
                  <div key={p.strike} style={{ display: "flex", alignItems: "center", height: 18, fontSize: 11 }}>
                    {/* Number and marker are SEPARATE fixed-width cells. Previously
                        both lived in one 54px box, so "773 ◄spot" wrapped to a
                        second line inside an 18px row and bled into the row below —
                        that was the squashing, not a spacing problem. */}
                    <div style={{
                      width: 46, textAlign: "right", paddingRight: 6,
                      color: colour, fontWeight: marker ? 700 : 400,
                      whiteSpace: "nowrap", overflow: "hidden",
                    }}>
                      {p.strike}
                    </div>
                    {/* Fixed width is deliberate — the bars must start at the same
                        x on every row or the chart stops being readable. So the
                        label cannot flex, and the question becomes what happens
                        when text is too long for it.

                        nowrap already makes the original bug impossible: it can
                        never spill onto a second line and bleed into the row
                        below. What it COULD still do is clip, and plain
                        overflow:hidden clips silently — you would read a
                        truncated label as the whole label.

                        ellipsis makes truncation visible, and title puts the full
                        text one hover away. So the worst case is now "…" plus a
                        tooltip, not a wrong label and not a broken layout. */}
                    <div
                      title={marker ? `${p.strike} — ${marker}: ${role}` : undefined}
                      style={{
                        width: 250, paddingRight: 8, color: colour, fontWeight: 700,
                        whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                        fontSize: 10,
                      }}>
                      {marker && (
                        <>
                          ◄ {marker}
                          <span style={{ color: "var(--muted)", fontWeight: 400 }}>
                            {" · "}{role}
                          </span>
                        </>
                      )}
                    </div>
                    <div style={{
                      position: "relative", flex: 1, height: "100%",
                      borderLeft: "1px solid var(--border)",
                      // faint tint = too close to spot to qualify as a wall
                      background: inDeadZone ? "rgba(255,255,255,.035)" : undefined,
                    }}>
                      <div style={{ position: "absolute", left: "50%", top: 0, bottom: 0, width: 1, background: "var(--border)" }} />
                      <div style={{
                        position: "absolute", top: 3, bottom: 3,
                        left: p.gex >= 0 ? "50%" : `${50 + pct}%`,
                        width: `${Math.abs(pct)}%`,
                        background: p.gex >= 0 ? "var(--green)" : "var(--red)",
                        opacity: 0.8, borderRadius: 2,
                      }} />
                    </div>
                  </div>
                );
              })}
            </div>
            <p className="hint" style={{ marginTop: 10 }}>
              Green = positive GEX (dealers buy dips / sell rips near these strikes → resistance-ish).
              Red = negative GEX (support-ish).
            </p>
            <p className="sub" style={{ marginTop: 4 }}>
              <b>The wall is not always the biggest bar.</b> Per-contract gamma peaks
              at-the-money, so "largest gamma above spot" would return the next strike up almost
              every time — a target 0.3% away that could never clear the 2:1 filter. Strikes within{" "}
              <b>{(wallMinDist * 100).toFixed(1)}%</b> of spot (the shaded band) are therefore
              excluded from wall selection however large they look. A big bar in that band is real
              gamma; it just isn't far enough away to be a target or a stop.
            </p>
            {Array.isArray((gex as any).dataQuality?.wallNotes)
              && (gex as any).dataQuality.wallNotes.length > 0 && (
              <p className="sub" style={{ marginTop: 4, color: "#e0b341" }}>
                ⚠ Wall selection had to relax its rules here:{" "}
                {(gex as any).dataQuality.wallNotes.join("; ")}. That means the marked wall came
                from a fallback — it may sit inside the shaded band or outside the usual moneyness
                window, so treat it as weaker than a clean pick.
              </p>
            )}
            <div className="sub" style={{ marginTop: 6, lineHeight: 1.7 }}>
              <b>Reading the three marked levels</b> — these are the same ones the auto-trader
              uses, from <code>playbook.levelsFor()</code>:
              <br />
              <b style={{ color: "#e0b341" }}>flip</b> — the pivot. Above it dealers hedge
              against the move and price gets pulled up toward the call wall, so it is the LONG
              trigger. Below it they hedge with the move and selling feeds selling.
              <br />
              <b style={{ color: "var(--green)" }}>call wall</b> — where call gamma concentrates.
              Price tends to stall or pin here, which is why it is the target rather than a level
              to break through.
              <br />
              <b style={{ color: "var(--red)" }}>put wall</b> — the support dealers are hedging.
              It is the long STOP, and losing it is where a short STARTS: through it they sell
              weakness instead of buying it. It is an entry for puts, not an exit.
              <br />
              <b style={{ color: "var(--red)" }}>put target</b> — where a put trade takes profit.
              Normally a measured move below the wall; when the flip sits BELOW the put wall it is
              the flip itself, because that is the point where dealers stop dampening the fall and
              start feeding it. Only shown when it lands inside the ±8% window.
              <br />
              <span style={{ color: "var(--muted)" }}>
                Nothing here is filtered. The Vol Desk tab runs the same levels through grade,
                cushion, spike-crash, R/R and OI-freshness, and only a CONFIRMED tag is tradeable —
                so this chart can look clean on a name the bot refuses. It blocks the TRADE, never
                this chart.
              </span>
              <br />
              <span style={{ color: "var(--muted)" }}>
                <b>One place the map and the bot genuinely differ.</b> This chart's put wall is the
                biggest put-gamma strike below <i>spot</i>. The bot's stop (nTrans) is the biggest
                put-gamma strike below <i>pTrans</i> — below the level it would ENTER on, not below
                today's price, because a stop belongs under your entry. When spot has run well past
                the flip the two anchors point at different strikes, and the bot's stop is the lower
                one. Read this chart for shape; read the Vol Desk row for the levels it will
                actually trade.
              </span>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
