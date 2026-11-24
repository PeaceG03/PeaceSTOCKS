# Massive Starter upgrade: readiness and upgrade-day runbook

This page covers what happens if Peace moves the Massive stocks plan from Basic to Starter to get
5 years of daily bars instead of 2. Everything here was proven offline, with fakes: no Massive or
Cloudflare calls, no live keys, and the live bucket was not touched. **The upgrade itself, any
spend, and any workflow dispatch are Peace's own decisions. Nothing in this PR does them.**

## What changes with the plan

Read on 2026-11-24 from Massive's knowledge base and pages (confirm on massive.com/pricing before buying):
- Daily bars reach back **5 years on Starter**, against 2 on Basic. The window counts back from each request, so it moves forward one day every day.
- Paid plans have no per-minute cap on API calls. Basic allows 5 calls a minute.
- Starter is listed at $29/month. That price comes from third-party copies of the pricing page read in November 2026; massive.com/pricing loads its plan table with script.

Downgrading never deletes anything already stored. See [Rollback](#rollback--downgrade).

## What has to be fetched

The local copy of the store starts at **2024-10-07**. Check the bucket's first month read-only on
the day. For an upgrade on, say, 2026-11-27, the 5-year floor is 2021-11-27, so the missing range is
**2021-11-29..2024-10-04: 717 trading sessions** (US calendar, holidays excluded). Start a couple
of sessions after the floor. If the start lands before the plan window, the run simply stops with
`PLAN_WINDOW` and keeps its checkpoint (proven below).

## Upgrade-day commands (Peace runs these; this PR dispatches nothing)

`scanner.yml` with `mode=backfill` runs `pnpm backfill`, which is the verified job
(`src/backfill-job-cli.ts` -> `runBackfillJob`): Reply Dust on, a sealed daily-bars pack per session,
and both re-verified against their sha. The range is split into fixed chunks of
`backfill_chunk_sessions` (default 150) sessions, each with its own checkpoint. `max_sessions` caps
the sessions **fetched** in this run (already-stored sessions are skipped and not counted), and the
run also stops at a session boundary after a 110-minute budget, inside the 120-minute job timeout.
So the same command is simply re-dispatched, unchanged, until it reports complete:

```bash
gh workflow run scanner.yml -R PeaceG03/PeaceSTOCKS -f mode=backfill -f from=2021-11-29 -f to=2024-10-04 \
  -f max_sessions=1000 -f backfill_request_spacing_ms=12500 -f backfill_chunk_sessions=150
# wait for it to finish green; re-dispatch the same command until the last line says "complete":true
```

| exit | meaning | next |
|---|---|---|
| 0, `complete:true` | every chunk COMPLETE and verified | go to "How to verify" |
| 0, `complete:false` | stopped at `MAX_SESSIONS`, `BUDGET` or `YIELDED` (a queued scan) | re-dispatch unchanged |
| 2 | a session failed (`PLAN_WINDOW`, auth, 5xx after retries) | see the table below, then re-dispatch |
| 3 | `REFUSED_SHA_MISMATCH` or `REFUSED_PACK_CONFLICT` | stop and investigate; nothing is overwritten |

The run logs JSON lines with codes, dates and counts only (no symbols, no keys).

Run them during US market hours or the afternoon. The backfill shares the `peacestocks-r2-writer`
concurrency group with the scan and yields to a queued scan, so the 05:30/09:30 UTC freeze keeps
priority. Avoid starting a chunk late in the evening ET anyway.

## Expected API calls and hours

| | per session | 717 sessions |
|---|---|---|
| grouped daily + splits + dividends | 3 requests | 2,151 |
| ticker list (active + inactive passes, 1,000 per page; about 11 + 8 pages from today's master of 10,892 ACTIVE / 7,582 INACTIVE) | about 19 per dispatch | about 95 over 5 dispatches |
| **total** | | **about 2,250 requests** |

The provider's default spacing is 12.5 s between requests, which is Basic-safe. That works out to
**about 7.8 hours of request time** across about 5 dispatches. The offline dry run measured the same
shape: 755 mocked paid-tier sessions took 2,267 requests and 7.92 simulated hours at 12.5 s with
250 ms latency. Starter has no per-minute cap, so a smaller spacing would cut this to well under an
hour via `backfill_request_spacing_ms` (0..600000; the spacing also holds across chunk boundaries).
Keeping 12.5 s on day one is the conservative choice: about 175 sessions per 110-minute run, so about
5 dispatches of the same command.

## R2 size and cost

Measured, not guessed:
- daily-bars JSONL: **6.8 MB per session** in the dry run (Nov 2026 universe), and 7.0 MB per session in the local Oct 2026 month file. That gives **about 4.9 GB** for 717 sessions. It's an upper bound, since older years list somewhat fewer names.
- Reply Dust plus a daily-bars pack (the workflow now writes both): 0.40 MB per session, about 0.29 GB.
- The current 2 years of daily-bars JSONL is 2.9 GB locally.

The total after the backfill is about 8 GB. R2's free tier is 10 GB-month, then $0.015/GB-month
(Cloudflare docs), so the expected storage cost is $0 to a few cents a month. Writes run to a few
thousand Class A operations, far under the 1M free.

## Failures and resume

The backfill checkpoint (`backfill-state.json`) is written after every completed session, and a
session's bars are stored before it is marked complete.

| What happens | What the run does | What to do |
|---|---|---|
| 403 "plan doesn't include this timeframe" (start before the 5-year floor, or the plan not active yet) | stops at the session boundary; earlier sessions kept; `failedSessions` has the 403 | move `from` later (or wait for the plan), re-dispatch |
| 403 not authorized / 401 | stops; nothing partial is marked complete | check the key and plan on the Massive dashboard |
| 429 or a network error / any 5xx | 429 and network errors are retried with backoff; a 5xx, or retries used up, fails the session and stops the run | re-dispatch the same chunk; completed sessions are skipped |
| job timeout or cancel | the in-flight session is not marked complete | re-dispatch the same chunk; only the missing sessions are fetched |
| checkpoint lost | sessions with stored bars are skipped, with no refetch and no overwrite (and no corporate-action refetch) | nothing |
| a sealed daily-bars pack holds a row the store no longer has, or differs | `REFUSED_PACK_CONFLICT` (exit 3), never overwritten | investigate. Rows stored **after** a pack was sealed are not a conflict: they are reported in `rowsOutsidePack` and the pack is kept (see below) |
| sha mismatch in a pack or Reply Dust file (verified job) | `REFUSED_SHA_MISMATCH` | investigate; do not delete by hand |

### Proven offline (this PR)

- `src/backfill-job.ts`: `runBackfillJob` runs the real backfill and real provider with Reply Dust on. It then seals a daily-bars pack per session and re-verifies the Reply Dust file and the pack against their sha. Run statuses are COMPLETE, STOPPED_RESUMABLE, REFUSED_SHA_MISMATCH and REFUSED_PACK_CONFLICT.
- `src/fake-massive.ts`: an in-process fake that answers only `https://massive.invalid`, with a plan window that returns 403s like Massive.
- `src/backfill-job.test.ts` covers:
  - a restart resumes
  - a lost checkpoint causes no refetch or overwrite
  - a valid-but-different pack is refused, not overwritten
  - a sha mismatch is refused, including on an empty session
  - the spacing is ≥ 12.5 s
  - a plan-window 403 stops cleanly, then resumes after an upgrade
  - a 403 mid-range keeps the earlier sessions
- Mutants on each guard are in the PR description.
- `pnpm backfill:dry-run --data <local raw> --out <dir>` result (2026-11-24, `DRY RUN PASS`):
  - Slice 2026-11-02..06, rebuilt from the local 2-year store:
    - Run 1 stopped after 2 sessions (STOPPED_RESUMABLE).
    - The resume completed 5/5 sessions, with 3 grouped fetches on resume (only the missing days) and 2 packs already sealed.
    - 53,439 rows were compared field by field with 0 mismatches. 195 local rows (0.4%) couldn't be replayed because the master has no symbol for them on that date.
  - Mocked paid tier:
    - A probe one week before 2021-11-01 gave PLAN_WINDOW with 0 sessions written.
    - 2021-11-01..2024-10-31 completed 755/755 sessions, verified, with 0 duplicate rows: 2,267 requests, minimum gap 12,500 ms, 7.92 simulated hours.

### Workflow wiring (this PR)

- `src/backfill-workflow-wiring.test.ts` reads the workflow's own backfill run line and the
  `pnpm backfill` script, then drives the job through them against the in-process fake: chunked,
  spaced (≥ the input, across chunks too), every session packed and sha-checked; a
  `max_sessions` stop then an unchanged re-dispatch finishes; the budget stop exits 0 and is
  resumable; a plan-window 403 exits 2; a missing key or a required-but-missing object store is
  refused. The old direct entry (`src/backfill.ts`) refuses to run. Nothing is dispatched.
- Pinned zstd 1.5.7 is blocking in the backfill job (packs need it).

### `DAILY_BARS_PACK_EXISTS_DIFFERENT` (live scan, 2026-11-24 02:09 UTC): root cause and status

- Evidence (read-only: `gh run view --log-failed` error codes only, plus the code; the live bucket was
  not read): run 45310223847 on `ec79883` failed sessions 2026-10-13..10-21 with
  `DAILY_BARS_PACK_EXISTS_DIFFERENT`, then `COLLECTION_FAILED`, leaving 10-22..11-20 as backlog.
- Cause: that scanner re-collected past sessions whose daily-bars pack was already sealed, using
  today's universe, and appended a few new rows per session (other identities, revision 1). The
  pack writer compared the sealed pack with the grown row set, got "different", and failed every
  catch-up session. Nothing was overwritten.
- Scanner path: already fixed on `main` by `922e085` (in this branch's base); later scan runs
  (45339628953, 45373705249, 45432365569) succeeded with no pack codes.
- Backfill job path: had the same pattern (write first, then check), so a range overlapping those
  sessions would have refused. Fixed here (`8b16174`): an already-sealed pack is checked first; if
  every packed row is still stored it is kept, and rows stored later are counted per session in
  `rowsOutsidePack`. A packed row missing from the store, or a tampered pack, still refuses.
- Not in scope here: why sessions 10-13..11-20 were late (another branch), and `gap-refill-lib`
  (it skips sessions that already have a pack). The month JSONL file is still rewritten per
  session; that's unchanged.

## How to verify after each chunk

1. The run is green, and its backfill summary shows completed = chunk sessions and `failedSessions` empty.
2. Read-only listing of `permanent/daily-bars/<month>.jsonl` objects: every month in the chunk is present. Session count per month matches `tradingSessionsInRange` (no gaps, no extra days).
3. The `survivorship` counters in the summary are non-zero for older chunks. INACTIVE names are now included on the dates they traded.
4. After the last chunk, a research-harness run with an earlier `--from` loads the older sessions offline (from a local read-only copy).

## Rollback / downgrade

- **Downgrading the plan keeps all saved data.** The bars are our objects in our R2 bucket. On Basic, daily scans keep working on the recent window. A backfill reaching older dates would stop cleanly with `PLAN_WINDOW` and never delete anything.
- Code rollback is a revert of this PR. There is no data migration and nothing is rewritten.
- To avoid a second charge, cancel or downgrade in the Massive dashboard before the renewal date.

## Scan reliability (from existing evidence, read-only)

From the local prediction-status copy (taken 2026-11-24 02:42 MT) and 323 `scanner.yml` "Scanner"
runs (2026-10-09..2026-11-24, `gh run view` job names and conclusions only; failure codes from a
sample of `--log-failed`, error-code tokens only, no symbols):

- 36 sessions from 2026-10-05 to 2026-11-23. **5 were frozen before the next 09:30 ET open:** 10-06, 10-07, 10-08, 10-09 and 11-23 (11-23 was frozen 490 minutes before the open).
- **Current streak: 1. Longest: 4.**
- **31 misses:**
  - 10-05: evidence only.
  - 10-12: no record, although 2 scan jobs succeeded.
  - Every session 10-13..11-20: EVIDENCE_ONLY. These records were written later as catch-up, on 2026-11-24.
- Cause from the Actions history: 93 runs had a failed `scan` job between 10-14 and 11-24:
  - at first `MARKETS_SCHEDULER_HOST_FAILED`
  - from about 10-17: `DAILY_BARS_COVERAGE_STALE` / `DAILY_BARS_COVERAGE_GAP` / `CORPORATE_ACTIONS_COVERAGE_GAP`
  - on 11-24 02:09 UTC: `DAILY_BARS_PACK_EXISTS_DIFFERENT` (root cause above; fixed), then a later run froze 11-23 on time
- Re-run with `pnpm scan:reliability --status <prediction-status dir> --from <d> --to <d> --runs <jobs.jsonl> --out <dir>`.

**The scan has not yet shown sustained on-time freezes.** A suggested gate before paying, which is
Peace's call: several consecutive on-time sessions (for example 5) after 11-23, plus a clean pack
check (fixed paths above; confirm no pack codes in those runs).

## Paper ledger

The simulated paper ledger is the separate paper-trading PR (#127, branch `builder/paper-trading`).
It is not part of this PR.
