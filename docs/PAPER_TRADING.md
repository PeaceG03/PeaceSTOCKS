# Paper trading (simulated only)

**Paper trading: simulated, no real money.** The picks it trades are labelled experimental:
back-tests on held-out data show no reliable edge over random picks (docs/SCANNER.md, PR #124).
Paper trading exists to measure the picks forward, under fixed rules, before anyone considers more.

There is **no broker** in this repository: no broker client, no broker key, no order is ever sent
anywhere. Every "order" is a row in a simulated ledger, filled from the stored daily bars.
`src/paper-no-live-broker.test.ts` fails if a live broker endpoint appears in `src/` or the workflows.
Going to real money is out of scope and would need Peace's own explicit yes first.

## Pre-registered rules (`config/paper-rules-v2.json`, rulesVersion `paper-rules-v2`)

These were committed before any paper result existed. They are not tuned. A rule change is a new file
(`paper-rules-v3.json`) with a new version, never an edit; every ledger row records `rulesVersion` and
`rulesSha256` (sha256 of the exact file bytes).

Version history:
- `paper-rules-v1` (Nov 24, never run; no ledger row was ever written under it). It had an extra rule
  not in Peace's approved list: a held name whose open-to-open move was 1.8x or more either way was
  closed flat at its entry price. Because split records arrive days late, that rule also closed real
  crashes at 0% and flattered paper P&L (Auditor review of #127). Removed.
- `paper-rules-v2` (Nov 24): v1 without the gap rule, exits always at the actual open, plus the
  write-off rule below (a rule addition, **pending Peace's confirmation**). The config file changed, so
  the version was bumped.

| Rule | Value |
| --- | --- |
| List traded | `TOP_15_OVERALL` of the frozen session, every name, equal weight |
| Starting paper capital | $100,000 (simulated) |
| Entry | at the open (09:30 ET) of the next trading session after the freeze |
| Exit | at the open of the following trading session (1-session hold, open to open) |
| Position cap | at most 10% of equity per name (equal weight of 15 is about 6.7%) |
| Daily loss limit | if the book lost 3% or more from its open to the close of the last trading day, no new entries at the next open (exits still happen) |
| Commission | $0 per order |
| Slippage | 10 bps per side: buys fill at open x 1.001, sells at open x 0.999 |
| Shares | whole shares only (rounded down); leftover stays in cash |
| Exit price | always at the actual open, adjusted only by split records known at fill time; no move is ever filled flat |
| Write-off (pending Peace's confirmation) | a held name with no open for 5 exit attempts in a row (halted, delisted) is written off at its last known close, no slippage (`writeOffAfterMissedExits`) |

Note on timing: the held-out eval's h1 outcome (src/holdout-eval.ts) is next open to the close h
sessions later, so h1 is open to close of the entry day. Paper trading holds open to open, one session
longer by the overnight gap, so the two are close but not identical.

## Which picks may be traded

Only picks frozen before the 09:30 ET open they are traded at. The ledger reuses the scanner's stored
freeze status (`permanent/prediction-status/<D>.jsonl`, resolved with `resolveSessionPredictionStatus`,
the same rule the site uses) and never recomputes it. For entries at the open of session T, with D the
trading session before T, all of these must hold, else no entries are made (exits still happen):

1. D has at least one status record, and none of D's records is `EVIDENCE_ONLY`.
2. The resolved status is `FROZEN` with reason `PREDICTIONS_FROZEN` (so `UNAVAILABLE` of any reason,
   and `NO_QUALIFYING_CANDIDATES`, are refused).
3. The freeze proof is present: `predictedAt`, `nextSessionOpen` and `nextSessionDate`.
4. `nextSessionDate` is T, and `predictedAt` is strictly before `nextSessionOpen`.
5. D's stored `TOP_15_OVERALL` set exists, is not marked unavailable, is non-empty, and its `frozenAt`
   is strictly before `nextSessionOpen`.
6. The paper run writing the entry orders runs before T's open (`now < nextSessionOpen`). Orders are
   never written after the open, so nothing can be entered with hindsight.

When D has no status record yet (the scan has not frozen D), the run writes nothing for T and tries
again on its next run.

## Switches (all default off)

| Switch | Where | Effect |
| --- | --- | --- |
| `PAPER_TRADING_ENABLED` | repository variable (Settings → Secrets and variables → Actions → Variables) | must be exactly `true`; anything else and the workflow job is skipped and the CLI does nothing |
| `PAPER_TRADING_KILL` | repository variable | any value except empty or `false` (fail-safe; use `true`) stops all new orders (entries and exits) and all ledger writes |
| `PAPER_TRADING_KILL` | a file of that name at the repository root | same, when committed to main |
| `paper/KILL` | an object in the bucket | same |

The workflow (`.github/workflows/paper-trading.yml`) runs only on main, only when the variable is
`true`, at 11:15, 12:15 and 13:15 UTC on weekdays (06:15-09:15 ET, always before the 09:30 open).

## Ledger

Stored in the same R2 bucket the scanner uses, under `paper/v1/`, written by the paper workflow only:

| Key | Written | What |
| --- | --- | --- |
| `paper/v1/intents/<T>.json` | before T's open | the orders for T's open: SELL every held name, BUY each picked name, or why entries were refused |
| `paper/v1/fills/<T>.json` | once T's bars are stored | each order's fill (price, shares, slippage, commission) or why it did not fill; cash and positions after |
| `paper/v1/days/<T>.json` | with the fills | the window from the previous open to T's open: paper return vs SPY and vs the equal-weight universe, plus cumulative |
| `paper/v1/corrections/<S>/<securityId>_<n>.json` | when a late split record changes an exit's price | the n-th correction of the exit fill of that name at S's open: old and new split factor and price, and the cash difference |

- **Append-only**: every object is written once and never overwritten or deleted. Each write is a
  single conditional put (`If-None-Match: *`): R2 itself refuses to overwrite an existing key (412),
  so even a writer racing outside the workflow's concurrency group cannot replace a stored object; the
  run keeps the stored object. The ledger writer can only write keys of exactly these
  four shapes; it has no delete.
- **Idempotent orders**: each order's id is `<rulesVersion>_<session>_<securityId>_<side>` (the
  client order id), unique per session, name and side. A retried run finds the object already stored
  and does not write or fill it again.
- **Restart-safe**: state (cash, positions) is read back from the newest fills object; a crash between
  steps is finished by the next run, with the same result as an uninterrupted run.
- Order of a run: fill any stored intents whose session bars exist (oldest first, stopping at the first
  session not yet stored), write the missing day rows, then write the intents for the next open.

### Fill rules
- Exits first, at the session's actual open. Splits effective after entry and on or before the exit
  session are applied from the split records stored at fill time. Conflicting split records use the
  raw open (factor 1, flagged `SPLIT_UNRECONCILED`). There is no gap filter: a real crash or spike is
  booked as it happened.
- A name with no open that session stays held (marked at its last stored close, or its entry open),
  its `missedExits` count goes up, and it gets a new SELL at the next open. When the count reaches 5
  (`writeOffAfterMissedExits`) it is written off (`WRITTEN_OFF`) at its last stored close, split-adjusted
  the same way, with no slippage or commission.
- Then entries: per-name notional = min(equity at the open / number of names, 10% of equity);
  never more than the cash left. A name still held (its exit had no price) is not bought again.

### Late split records: corrections, never rewrites
Split records often arrive days after the split. A fill is never rewritten. Each run re-checks the
exit fills of the last 30 filled sessions against the split records stored now. When the factor
differs from the one the fill (or its latest correction) used, a correction is appended with the
corrected price and `cashAdjustmentUsd = shares x (new price - old price)`. That cash enters the
book at the next open that is filled (`correctionsUsd` and the cumulative `correctionsApplied` on the
fills, `correctionsUsd` on that day row), exactly once. So the window in which a correction lands
includes it in its return; earlier day rows are not changed. Benchmarks are not corrected after the
fact; they used the records known when their day row was written, the same as the paper fill.

### Benchmarks (same window, open to open)
- **SPY**: the security-master SPY ETF, no costs.
- **Equal-weight universe**: the average open-to-open return of every security-master record that is
  `ACTIVE` with eligibility `LEVEL_2`/`LEVEL_3` (the current master, not point in time) with a positive
  open on both sessions. No costs.
- Both benchmarks treat a name exactly as paper exits do: actual opens, split-adjusted by the stored
  records, conflicting records use the raw open, and no move is dropped or flattened. Only a missing
  price leaves a name out.

## Site
The site's **Paper trading** card shows the newest days: paper, SPY and universe returns per day and
cumulative, with the experimental label and "Paper trading: simulated, no real money."
