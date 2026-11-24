# Research harness (walk-forward, offline)

The research harness answers one question about a scanner list or strategy idea: **is there evidence,
after costs and after correcting for everything we tried, that it beats simply holding the market?**
It runs only on files already on disk. It has no provider, object-store or network client and reads
no credentials.

A verdict is either `IMPROVEMENT` or `NOT_PROVEN`. Even `IMPROVEMENT` carries the note that a live
paper run is still required before any real money (see the paper-trading PR, #127). Real money is
always Peace's own decision.

## Pieces

| Piece | File | What it guarantees |
|---|---|---|
| Point-in-time sessions | `src/research-harness-data.ts` | Session D sees only the names a scan on D would have seen. That includes names that are INACTIVE in today's master, on the days they traded. It uses D's bar window, split records known before the next open (split-adjust `as-known`), and the production `rankSecurities`. The outcome is open(D+1) to open(D+2). A name whose split takes effect between the two opens has no outcome. |
| Survivorship in the backfill | `src/pit-universe.ts`, `src/backfill.ts` | Each backfilled session binds the provider to the names listed **on that date**, ACTIVE and INACTIVE, using the ticker each one held then. Previously it bound today's ACTIVE ids, so later-delisted names lost their history. A ticker reused by two listings resolves by date. If it can't be resolved it is dropped and counted (`survivorship.ambiguousSymbolSessions`). |
| Walk-forward folds | `src/research-folds.ts` | `walkForwardFolds(heldOutStart, {trainSessions, testSessions, embargoSessions, mode})` builds rolling or expanding folds. `assertFoldOrder` refuses a fold where the test window does not start strictly after train plus the embargo, where test windows overlap, or where a test outcome (2 sessions after the pick) would read a held-out price. |
| Held-out seal | `src/research-folds.ts` (`HeldOutSeal`) | A strategy is REGISTERED with its held-out window before any price is opened. `evaluateOnce` writes an EVALUATE record and an exclusive-create marker file (`heldout-markers/<hash>.<n>.json`) **before** running, so a crash still uses up the look, and deleting log lines does not reopen the seal. A second look throws `HELD_OUT_SEALED` unless a human UNSEAL is recorded (`research-harness-cli unseal`, which needs a TTY, `--by` and `--reason`). Changing the window after registering throws `HELD_OUT_WINDOW_CHANGED`. |
| Costs | `src/research-costs.ts` | Equal weight over the list's picks that have an outcome. turnover_t = Σ\|w_t − w_{t−1}\|, counting entry, sells and the final exit. cost_t = turnover_t × bps per side / 10⁴. Every result carries gross, cost, net and turnover. The benchmarks (equal-weight universe, SPY) carry no cost. |
| Variant log | `src/append-only-log.ts`, `src/research-variants.ts` | `variants.jsonl` is a hash-chained, append-only JSONL file. Each line holds seq, prev, at, entry and hash. The chain refuses an edited or reordered line, a forged line whose own hash was recomputed, and a cut through a line. The chain alone cannot see whole lines dropped from the end or a deleted line with every later hash recomputed, so the log is anchored outside itself: a head file `<log>.head` (seq and hash of the tip) is rewritten after each append and checked on every read, and it is committed to git, where `gitCommittedHead` checks the committed head is still in the chain. A truncated tail, a deleted-and-rechained middle line, an emptied log or a missing head is refused (`LOG_TAMPERED`), and so is rewriting the log and its head file together **while the rewrite is uncommitted** (the committed head is no longer in the chain). The read-time anchor only compares with the head committed at the current HEAD, so a rewrite committed as a plain new commit passes it; CI catches that instead: `src/research-ledger-check.ts` (Tests workflow, every push and PR) refuses a branch whose ledger no longer contains the heads committed on main at the merge base, or whose committed held-out markers were deleted or changed. The anchor fails open outside git: with no git, or a ledger outside a git work tree or not yet committed, only the head file guards the log, so a log and head rewritten together there are not detected until CI. The trust root is main's git history; someone who can rewrite main's history (force-push) is out of scope. The head may be one line behind the tip (a crash between the two writes); the next append repairs it. Each record has the strategy's config hash, every candidate variant's hash, per-fold metrics and the pooled metrics. The pick for each fold is made **on train only**. |
| Multiple testing | `src/research-stats.ts` | One-sided t-tests run on the pooled daily excess series, against the universe and against SPY. A strategy's p is the larger of the two (intersection-union). Holm step-down is applied over the latest record of every strategy in the log (one definition, `holmFamily`, used by both the evaluator and the CLI). The family size is max(distinct variants ever tried, strategies), so trying more variants makes the same evidence worth less. |
| Verdict | `src/research-verdict.ts` | `IMPROVEMENT` only if **all** of these hold: (1) pooled net-of-cost mean beats the equal-weight universe; (2) it also beats SPY; (3) more than half the folds (strictly) are positive, where a fold is positive only if its test-window net beats **both** the equal-weight universe and SPY; (4) Holm-adjusted p < 0.05; (5) the held-out period was evaluated once and is positive vs both; (6) at least 3 folds were scored (`TOO_FEW_FOLDS` otherwise: with 1 or 2 folds a majority is one or two lucky windows, and 3 is the smallest count where a majority still leaves a fold to disagree); (7) costs were at least 5 bps per side (`COST_BELOW_FLOOR`). Anything else is `NOT_PROVEN`, with every failed reason listed. Thresholds passed by a library caller can only tighten these (alpha no higher, fold share, fold count and cost floor no lower; a non-finite value means the default), so `verdictFor` cannot be loosened into an `IMPROVEMENT`. |

## Running it

```bash
# Baseline: the current 5 scanner lists, development period only. The held-out window is registered, not evaluated.
pnpm research baseline --data <local raw dir> --out <dir> \
  --from 2025-03-03 --heldout-from 2026-08-27 --heldout-to 2026-11-20 \
  --bps 10 --train 63 --test 63 --embargo 2 --mode rolling --scanner "<head> <config>"

# A recorded human decision to allow one more held-out look (TTY only):
pnpm research unseal --out <dir> --strategy <strategyHash> --by <name> --reason "<why>"
```

`--bps` below 5 (bps per side) or not a number is refused (`COST_BELOW_FLOOR`) before any data is read: 5 bps is a conservative floor for one-way slippage on these names, and anything lower would make turnover look nearly free.

The baseline loads only bars dated before `--heldout-from`. Its bar window starts 370 days before
`--from` so a year of eligibility history exists. Outputs in `<dir>`:
- `baseline.json`: folds, variants tried, exclusions, per-list results and warnings
- `<LIST>.json`

The variant log and the held-out seal are **not** in `<dir>`. There is one pinned ledger,
`research-ledger/` in this repository (`variants.jsonl`, `heldout.jsonl`, their `.head` files and
`heldout-markers/`), and no argument moves it (`--ledger`, `--variants`, `--seal` are refused with
`LEDGER_IS_PINNED`). So a new `--out` folder cannot reset the Holm family or reopen the seal. Commit
the ledger after every run; reads are anchored to its committed heads. It starts with the harness-v1
baseline's 5 variants and 5 registrations.

No command in this PR evaluates the held-out period. That is a deliberate, separate step.

## Baseline (harness-v1, 2026-11-24)

Data: the local copy of the 2-year store (bars 2024-10-07 onward). Development sessions
2025-03-03..2026-08-26: 374 sessions, 5 rolling folds of 63/63 with a 2-session embargo, 307 pooled
test sessions (2025-06-04..2026-08-24). Costs: 10 bps per side. Variants tried: 5 (Holm family 5).
Held-out 2026-08-27..2026-11-20: registered, **not evaluated**.

Mean per session, net of costs (universe +0.081%, SPY +0.083%):

| List | gross | cost | turnover | net | vs universe (t) | vs SPY (t) | Holm p | folds + | verdict |
|---|---|---|---|---|---|---|---|---|---|
| TOP_15_OVERALL | −0.400% | 0.054% | 0.54 | −0.454% | −0.535% (−2.33) | −0.537% (−2.32) | 1.000 | 0/5 | NOT_PROVEN |
| TOP_50_OVERALL | +0.051% | 0.048% | 0.48 | +0.003% | −0.078% (−0.51) | −0.080% (−0.52) | 1.000 | 1/5 | NOT_PROVEN |
| STRONGEST_MOMENTUM | −0.267% | 0.038% | 0.38 | −0.305% | −0.386% (−1.61) | −0.388% (−1.59) | 1.000 | 0/5 | NOT_PROVEN |
| FASTEST_IMPROVING | −0.317% | 0.064% | 0.64 | −0.381% | −0.462% (−1.79) | −0.464% (−1.78) | 1.000 | 0/5 | NOT_PROVEN |
| DEFENSIVE_LOW_RISK | −0.005% | 0.036% | 0.36 | −0.040% | −0.121% (−2.59) | −0.123% (−2.82) | 1.000 | 0/5 | NOT_PROVEN |

None of the five lists beats holding the market after costs in this development period, and all
are `NOT_PROVEN`. As a cross-check, the independent held-out evaluator (`holdout-eval-cli`,
open-to-close, as-known splits) on the last fold's dates (2026-06-05..08-24) shows the same signs:
TOP_15 −0.63%, MOMENTUM −0.85%, FASTEST −0.49%, TOP_50 −0.27% vs universe per session.

### Caveats (read before trusting any number)
- **The data is not survivorship-free yet.** The local bars came from the old ACTIVE-only backfill.
  7,582 INACTIVE names are in the master, but only 181 have bars. The fix in this PR only applies to
  sessions backfilled after it. Delisted names missing their last bars are dropped from returns,
  which biases results **upward** (delisting losses are missing).
- **The held-out window is not pristine.** 2026-08-27..11-20 was already looked at in the earlier
  held-out eval (#124). Treat a future held-out result as confirmation, not discovery.
- The baseline is one period (about 15 months, one market regime) and the picks are unadjusted
  open-to-open. A real held-out evaluation and a live paper run are both still required.
