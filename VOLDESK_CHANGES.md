# Vol Desk — changes before tomorrow's session

All changes are in `server/`. 22 unit tests + 14 integration tests against a stubbed
broker, all passing. Run them yourself with `node tools/vd_selftest.mjs`.

---

## The headline: your safety net was not connected

You found the symptom in (e). The cause is worse than "shares never fire."

The R/R selector was doing its job — rejecting contracts for fat spreads, breakevens
past T1, delta outside band, ratios under 1.5:1. When it came back empty, a second
picker chose a contract by DTE and moneyness alone, and the only check between that
contract and a live order was a spread test. **A contract the selector had just
refused at 0.03:1 was bought thirty lines later.**

And it was the path that ran *most* of the time. The share fallback was guarded by:

```js
const noOption = !call || !(call.mid || call.ask);
```

That asks whether a contract with a quote *exists*. On a liquid name one always does.
So the share route was structurally unreachable and the bypass ran instead — which
is almost certainly why you got trades yesterday and why they were poor ones.

**Fixed.** Every nomination — grid, legacy picker, anything — now routes through the
same `evaluate()`. `contract_select.evaluatePick()` exists solely so no call site can
skip the bar by forgetting to re-check. The guard now asks whether a contract
*qualifies*, not whether one exists.

Verified against a fully-quoted junk chain (35–37% spreads, breakevens past T1):

| `onNoQualifyingContract` | Result |
|---|---|
| `"shares"` *(set)* | Share route. No option ordered. |
| `"skip"` | `NO_QUALIFYING_CONTRACT`, nothing traded, reasons logged per strike. |
| `"fallback"` | Nominee scored → refused at 0.03:1. Not a pardon, just a second way to nominate. |

Control: a clean contract (8.00/8.20, breakeven under T1) still selects normally at
R/R 2.42, delta 0.72. The bar is tight, not unreachable.

---

## (a) Chasing — the gate you actually needed

`triggerMode: intraday` was already set; that wasn't the problem. The problem is that
every number the setup was approved on — extension, R/R, cushion — is computed by
`voldesk.py` at **scan** time and frozen into the daily snapshot. Entry happens hours
later. The snapshot honestly reports 1% extension on a name you're about to buy 6%
extended, because it's describing a moment that has passed. No scan-time filter can
fix that; only a live check at the instant of committing capital can.

Three gates now run against live spot in `enterTrade()`:

1. **`STRUCTURE_BROKEN`** — spot already through the stop. Dead, not late. Also drops
   the name from the observe list rather than re-pricing a corpse every cooldown.
2. **`CHASED`** — R/R measured from where the order will actually fill, floor 1.5:1.
3. **thin-upside routing** — if T1 is under 5% from spot, route to shares.

Why (2) matters more than extension %: extension hurts twice, shortening the run to T1
*and* lengthening the fall to the stop. Worked example on your own level structure
(pTrans 100, nTrans 96, T1 112):

| Fill | Scan-time R/R says | R/R you actually own | Verdict |
|---|---|---|---|
| 100.4 | 3.0:1 | 2.6:1 | trades |
| 106.0 | **3.0:1** | **0.60:1** | **CHASED** |

Your `voldesk.py` already computes this as `rr_at_fill` and explicitly declines to
filter on it, reasoning that filtering would mask bad *timing* rather than fix it.
That's right about the scan and wrong about the order: at scan time it's a diagnostic,
at the moment of buying it is simply the trade's reward:risk, and refusing 0.6:1 masks
nothing.

**On scan cadence** — your open question. Levels move slowly; *spot* is what goes
stale, and these gates read it live. I'd leave discovery at 30 min rather than pay for
more Python spawns inside the tick.

---

## (b) Breakeven ratchet — plus a stop that has never once fired

**The ratchet.** Stops 1–4 all answer "when do I give up on a loser?" Nothing answered
"when do I stop being willing to hand back the whole move?" A position could travel 80%
to T1 and stop out at its original nTrans for a loss, having been right the entire time.

`management.stopRatchet`, tightening only, capped by the position's own entry→T1 span:

- **50% to T1** → stop to entry
- **75% to T1** → lock 40% of the move

Independent of `scaleOut` (still off, correctly — it needs ≥2 contracts and your
budget usually buys one).

**Stop 4 was dead code.** `evaluatePositions()` built `progressLog` on every pass and
never wrote it back. `rows` comes from `load()`, which re-reads the file, so every
evaluation started from an empty log. It never reached the four entries the stall test
requires — `stalled` was permanently `false`. The stalling rule has never fired since
it was written. Now persisted; verified across two passes with no duplicate days.

**Two new backstops**, deliberately wide:

- **Stop 5** — premium −60% from entry. Stops 1–4 measure the *underlying*, which is
  right for the thesis and blind to the instrument; a vol crush can halve the option
  while spot sits comfortably inside structure. Confirmed not to fire at −40%:
  structure gets to be wrong first.
- **Stop 6** — 10 DTE. Never carry long premium into the theta cliff.

Ordering verified: Stop 1 still outranks Stop 5, and T1 is not pre-empted by the ratchet.

---

## (c) Assessment cadence

`maybeAssess` was gated on `st.lastAssessDay === todayISO()`. One line, and it's why the
list felt frozen: a name that firmed up at 10:15 could not become READY until tomorrow,
by which point the reclaim had happened without us. Discovery was running every 30
minutes and feeding an assessment that ran once.

Now `observe.assessEveryMinutes` (60), throttled per row, so calling it more often is
cheap — recently-read rows return `skipped` without spawning a scan. Logging stays quiet
when nothing moved.

---

## (d) Side unfreezing

Your framing was right, so the implementation follows it literally: **flow widens the
search, it does not fix direction.**

`observe.seed` stamped `side` once and never revisited it, so a long that broke its stop
was dropped — throwing the name away at precisely the moment it got interesting, because
a failed long is the setup that most reliably produces a good short.

A flip now requires **both**: the current side structurally dead (or abandoned by flow),
**and** the opposite side grading out on its own merits on the same scan. Flow disagreeing
with structure is a reason to stand aside, not to reverse. One flip per row — a name that
wants to reverse twice is chop.

This required reordering `assessAll` to scan *before* applying the flow rules. The old
order (flow decides, then maybe scan) made the flip physically impossible to evaluate.

Test worth noting: a broken long whose mirrored short comes to 1.22:1 is **refused**, not
taken. Flipping is not a consolation prize.

---

## Two risk items I changed on your instruction

**`overrunTolerance` 15 → 2.** This was the quiet one. A $300 budget could buy a $4,500
contract, which made the budget, the flow size multipliers *and* the daily loss cap all
describe a position ten times smaller than the one actually held.

⚠️ **Expect fewer option entries tomorrow.** With `basePremium: 300` the per-contract
ceiling is now ~$600, so expensive names will skip or route to shares. If participation
drops more than you want, **raise `basePremium` — do not raise the tolerance.** One is
a sizing decision; the other silently unbinds every other control.

**`risk.maxDailyLoss: 600`** — new. `maxDailyEntries` capped how many trades could be
*opened*; nothing capped how much could be *lost* before opening the next. Realized only
(open drawdown is noise until it closes). Halts entries, never exits.

---

## Data layer — what's actually wired to Alpaca

Your read is two-thirds right.

| Input | Source | Status |
|---|---|---|
| Open interest | `/v2/options/contracts` → `open_interest`, `open_interest_date` | ✅ already read, in `gex/dataprovider.py` |
| Implied volatility | `/v1beta1/options/snapshots/{underlying}` → `impliedVolatility` | ✅ already read |
| **Gamma** | **not fetched — computed locally** | `gexcore.bs_gamma()`, Black-Scholes off that IV |

**Gamma is computed, not fetched, and I'd leave it that way.** Alpaca ships
`greeks.gamma` on the snapshot and `dataprovider.py` discards it. Switching would not
be an upgrade: their gamma is also Black-Scholes, just with their rate and dividend
assumptions instead of yours, and the wall vote is a *ranking* — what matters is that
every strike is measured the same way. Vendor greeks are missing on illiquid strikes,
so adopting them would silently drop exactly the far strikes that carry tail-hedge OI,
biasing the walls. The real error term is the SqueezeMetrics long-calls/short-puts
convention, as your own header comment says — not the gamma formula.

There is one good use for their greeks you don't have: cross-checking IV. When vendor
gamma and `bs_gamma` diverge badly on a strike, that strike's IV is bad — a cleaner
version of the ±3× ATM-IV heuristic in `gexcore.py`. Worth a session, not worth tonight.

### Two gaps I did close

**1. `oi_date` was written to every snapshot and never read.** Same failure mode as
the regime gates before you enforced them. This one is worse, because pTrans, nTrans
and +GEX *are* the trade — entry, stop and target. Computing them from a stale OCC file
means trading last week's dealer map against this week's price, and nothing could tell
the difference.

Now an enforced filter, `oi_age<=3d`, in business days. One day's lag is normal (OI for
today's session doesn't exist yet) so the default is generous; four-plus means a holiday
gap or a dead feed. Unknown age passes and says so — Yahoo never exposes an OI date, and
blocking the whole book because you're on the backup feed would look identical to "the
whole book is stale." Tunable via `OI_MAX_AGE_DAYS`. Weekend arithmetic verified: Friday's
file read on Monday is 1 day, not 3.

**2. Contract selection had no liquidity input.** `open_interest` arrives in a response
`contract_select.js` already makes, and was thrown away — so selection saw only the
instantaneous spread. Those are different things: a quiet strike can quote tight for one
lot with nothing behind it, and that is exactly the strike you can't get *out* of. Given
your exits ride a patient ladder, this is a direct fill-quality lever.

`minOpenInterest: 250`, applied before quoting. No fallback when it empties the grid —
"the chain is too thin" is a real answer and the share route exists for it. Verified: OI
4200 selects normally, OI 40 routes to shares with the reason naming open interest rather
than a generic "no contract".

### One thing I flagged rather than changed

`getOptionQuotes` uses `feed: "indicative"`. Fine for the ranking it was written for, but
`working_orders.quoteFor()` now prices **live ladder rungs** off that same call. Indicative
quotes are derived, not the real NBBO — so your limit prices may be set against a book
that doesn't exist. If your Alpaca plan includes OPRA, changing that one string is probably
the highest fill-quality-per-character edit in the repo. I didn't touch it because if you
*don't* have the subscription it fails closed and you'd find out at 09:30 tomorrow.

---

## What to watch tomorrow

1. **`entry-skip` with `status: CHASED`** — logs `rrAtFill`, `floor`, `extension`. If you
   see a lot of these, the 1.5 floor is doing real work; if the same names appear at 08:00
   with good numbers and get chased by 10:00, the answer is faster promotion, not a lower floor.
2. **`NO_QUALIFYING_CONTRACT` / share routes** — `whyRejected` names the failing bar per
   strike. If it's mostly `breakeven beyond target`, your T1s are too close for 45-DTE
   premium and the real fix is shorter DTE, not a looser filter.
3. **`SIDE_FLIPPED`** in `observe-assessed`. Shorts are opt-in and the bearish playbook is
   a mirror heuristic with far less forward-testing than the long side. Watch the first few.
4. **`daily-loss-halt`** — if this fires, that was the point.

5. **`oi_age<=3d` in `filter_reasons`** — if this appears on many names at once it is a
   feed problem, not a market one. If it appears on a few, those contract sets stopped
   updating and you don't want them.
6. **`chain too thin to trade`** — if good names keep hitting it, lower `minOpenInterest`
   toward 100 rather than to 0. Zero restores the old blind spot.

## What I did *not* do

- No earnings blackout. Buying 45-DTE premium through a print is an IV-crush trap and the
  codebase has no earnings feed wired in. You have a UW connector — worth a session.
- No correlation cap. `maxConcurrent: 5` can currently be five semis on one thesis.
- `sides.short: true` with `shares.allowShort: false` means a bearish setup with no usable
  put is now a clean no-trade (it says so in the log) rather than a silent failure.
