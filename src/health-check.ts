// Health check (Peace, Oct 26-27). Pure core: one status per part from its latest check-in.
// - A part that does not report is not an error: it is tracked as missing with
//   "no response from (part), requested health check X time/s" (always the static "time/s").
// - Unknown state words never count against a part (status "unrecognized word").
// - Winner order: error > no response > unrecognized word > OK.
// - 3 or more silent parts at once: the health check's own likely fault is flagged, and the silent
//   parts are still listed by name.
// - No parts reporting: "no parts reporting", never "Healthy".
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { dayStuck } from "./day-stuck";
import { countErrorParts } from "./health-error-count";
import {
  HEALTH_PARTS,
  type HealthCheckinStore,
  type HealthPruneStore,
  errorMessage,
  pruneHealthCheckins,
  recentHealthCheckins,
  redactHealthMessage,
  writeVerifiedHealthJson,
} from "./health-checkins";
import { likelyCheckFault } from "./health-check-fault";
import { countMissingParts } from "./health-missing-count";
import { noResponseLine } from "./health-no-response-line";
import { partOkLine } from "./health-part-ok-line";
import { type HealthPartStatus, isRecognizedStateWord, partStatus } from "./health-part-state";
import { isCheckinSilent } from "./health-silent";
import { silentParts } from "./health-silent-parts";
import { R2ObjectClient } from "./object-store";
import { expectedTenMinBars } from "./tenmin-day-done";
import {
  TENMIN_DAILY_CATCHUP_SESSIONS,
  type TenMinDailyStuckShort,
  isPreRuleIndex,
  listTenMinDailyIndexDays,
  readTenMinDailyIndex,
  tenMinDailyCatchupSessions,
  tenMinDailyIndexCounts,
} from "./tenmin-daily-liquid";
import { lastCompletedSessionDate } from "./tenmin-history";

export const HEALTHY = "Healthy" as const;
export const NO_PARTS_REPORTING = "no parts reporting" as const;

/** One part as the health check sees it. */
export interface HealthCheckPart {
  name: string;
  /** Minutes a part may go without a check-in before it counts as silent; undefined = never silent (runs only by hand). */
  allowedSilenceMinutes?: number;
}

/** A check-in as written by a part. `state` is the part's own word. */
export interface HealthCheckinFacts {
  part: string;
  state: string;
  at: string;
  message?: string;
  /** BEHIND check-ins: what the capped run left (sessions). */
  remaining?: number;
}

export interface HealthPartResult {
  name: string;
  status: HealthPartStatus;
  line: string;
  /** Consecutive health checks this part did not answer (0 when it answered). */
  requests: number;
  lastCheckinAt?: string;
  /** Behind parts: the remaining count from the latest check-in. */
  remaining?: number;
  /** Behind and the remaining count did not shrink since the previous capped run (stall rule). */
  stalled?: boolean;
}

/** A day the daily 10-minute step keeps re-running without finishing it. */
export interface HealthStuckDay {
  sessionDate: string;
  expectedBars: number;
  shortNames: number;
  missingDailyBars: number;
  reRuns: number;
  /** Ten-minute bars stored vs. needed over every selected stock, e.g. "19461/19500". */
  bars: string;
  /** Daily bars saved vs. needed, e.g. "500/500". */
  dailyBars: string;
  /** Each short stock with its bars stored vs. needed, e.g. "38/39" (R2 only; lines carry counts). */
  shortStocks: { securityId: string; bars: string }[];
  /** The STUCK_SHORT record (counts when the day was marked); absent on indexes written before it. */
  stuckShort?: TenMinDailyStuckShort;
  /**
   * The day is older than the daily step's window (no longer retried): STUCK_SHORT LEFT_WINDOW, or not
   * stamped yet while the step is paused. Listed for 31 days; it needs a person when it left with
   * fewer than 6 failed passes (it skipped the usual STUCK_SHORT route, Auditor B2).
   */
  leftWindow?: boolean;
}

/** Days a left-window STUCK_SHORT day stays listed in health. */
export const HEALTH_LEFT_WINDOW_DAYS = 31;

/** Pure: a stuck day that needs a person (in the window, or left it with fewer than 6 failed passes). */
export function stuckDayNeedsAttention(day: Pick<HealthStuckDay, "leftWindow" | "reRuns" | "stuckShort">): boolean {
  return !day.leftWindow || !dayStuck(day.stuckShort?.passes ?? day.reRuns);
}

/** Pure: "2 at 38/39, 1 at 0/39" from short stocks (no stock names), fewest bars first. */
export function shortStocksLine(shortStocks: readonly { bars: string }[]): string {
  const counts = new Map<string, number>();
  for (const stock of shortStocks) counts.set(stock.bars, (counts.get(stock.bars) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => Number(a[0].split("/")[0]) - Number(b[0].split("/")[0]))
    .map(([bars, n]) => `${n} at ${bars}`)
    .join(", ");
}

export interface HealthCheckResult {
  headline: string;
  parts: HealthPartResult[];
  errors: number;
  missing: number;
  silentParts: string[];
  likelyCheckFault: boolean;
  stuckDays: HealthStuckDay[];
  lines: string[];
  /** True when the result needs a person (opens or comments on the health issue). Behind alone does not. */
  attention: boolean;
  /** Carry to the next check: no-response counts per part. */
  requests: Record<string, number>;
}

function ageMinutes(atIso: string, now: Date): number {
  const at = Date.parse(atIso);
  return Number.isFinite(at) ? (now.getTime() - at) / 60_000 : Number.POSITIVE_INFINITY;
}

/** Plain line for a behind part: "scan: behind, 12 remaining (CATCH_UP_COMPLETED:BACKLOG_REMAINS remaining=12)". */
export function behindLine(name: string, latest: HealthCheckinFacts | undefined, stalledSince?: HealthCheckinFacts): string {
  const remaining = latest?.remaining === undefined ? "unknown count" : `${latest.remaining} remaining`;
  const what = stalledSince ? `behind and not shrinking, ${remaining} (was ${stalledSince.remaining} on the previous capped run)` : `behind, ${remaining}`;
  return `${name}: ${what}${latest?.message?.trim() ? ` (${latest.message.trim()})` : ""}`;
}

/**
 * Pure stall rule (Peace, Nov 23): the latest and the previous check-in are both capped runs (BEHIND,
 * with counts) and the remaining count did not shrink. Then the health issue opens or gets a comment.
 */
export function backlogStalled(latest: HealthCheckinFacts | undefined, previous: HealthCheckinFacts | undefined): boolean {
  return (
    latest?.state === "BEHIND" &&
    previous?.state === "BEHIND" &&
    latest.remaining !== undefined &&
    previous.remaining !== undefined &&
    latest.remaining >= previous.remaining
  );
}

/** Plain line for a stuck day (the health check flags days stuck short of 39 bars, 21 on half days). */
export function stuckDayLine(day: HealthStuckDay): string {
  const what =
    day.shortNames > 0
      ? `STUCK_SHORT, short of ${day.expectedBars} bars: ${day.bars} bars, ${day.shortNames} stock/s short (${shortStocksLine(day.shortStocks)})`
      : `STUCK_SHORT, waiting for daily bars: ${day.bars} bars`;
  if (day.leftWindow) {
    const passes = day.stuckShort?.passes ?? day.reRuns;
    const fewer = dayStuck(passes) ? "" : ", fewer than 6 failed passes";
    return `daily 10-minute step: ${day.sessionDate} ${what}, daily bars ${day.dailyBars}, left the window after ${passes} failed pass/es${fewer} (not done, no longer retried)`;
  }
  return `daily 10-minute step: ${day.sessionDate} ${what}, daily bars ${day.dailyBars}, after ${day.reRuns} re-run/s (not done, still retried)`;
}

export function evaluateHealth(input: {
  parts: readonly HealthCheckPart[];
  latest: ReadonlyMap<string, HealthCheckinFacts | undefined>;
  /** Each part's check-in before the latest one (the stall rule compares two consecutive capped runs). */
  previous?: ReadonlyMap<string, HealthCheckinFacts | undefined>;
  /** No-response counts from the previous check. */
  priorRequests?: Readonly<Record<string, number>>;
  now: Date;
  stuckDays?: readonly HealthStuckDay[];
}): HealthCheckResult {
  const results: HealthPartResult[] = [];
  const requests: Record<string, number> = {};
  for (const part of input.parts) {
    const latest = input.latest.get(part.name);
    const silent =
      part.allowedSilenceMinutes !== undefined &&
      (!latest || isCheckinSilent(ageMinutes(latest.at, input.now), part.allowedSilenceMinutes));
    const word = latest?.state ?? "";
    const status = partStatus({
      error: latest?.state === "ERROR",
      silent,
      unrecognized: !!latest && !isRecognizedStateWord(word),
      behind: latest?.state === "BEHIND",
    });
    const stalled = status === "behind" && backlogStalled(latest, input.previous?.get(part.name));
    const asked = silent ? (input.priorRequests?.[part.name] ?? 0) + 1 : 0;
    requests[part.name] = asked;
    const line =
      status === "error"
        ? `${part.name}: error: ${latest?.message?.trim() || "(no message)"}`
        : status === "no response"
          ? noResponseLine(part.name, asked)
          : status === "behind"
            ? behindLine(part.name, latest, stalled ? input.previous?.get(part.name) : undefined)
          : status === "unrecognized word"
            ? `${part.name}: unrecognized word ${JSON.stringify(word)}`
            : latest
              ? partOkLine(part.name)
              : `${part.name}: OK (runs only when started; no check-in yet)`;
    results.push({
      name: part.name,
      status,
      line,
      requests: asked,
      ...(latest ? { lastCheckinAt: latest.at } : {}),
      ...(status === "behind" && latest?.remaining !== undefined ? { remaining: latest.remaining } : {}),
      ...(stalled ? { stalled: true } : {}),
    });
  }
  const states = results.map((r) => (r.status === "error" ? "ERROR" : r.status === "no response" ? "SILENT" : "OK"));
  const errors = countErrorParts(states);
  const missing = countMissingParts(states);
  const silent = silentParts(results.map((r) => ({ name: r.name, silent: r.status === "no response" || (r.status === "error" && r.requests > 0) })));
  const fault = likelyCheckFault(silent.length);
  const stuckDays = [...(input.stuckDays ?? [])];
  const anyReported = results.some((r) => r.lastCheckinAt !== undefined);
  const attention = results.filter((r) => r.status === "error" || r.status === "no response").map((r) => `${r.name} (${r.status})`);
  for (const r of results.filter((x) => x.stalled)) attention.push(`${r.name} (behind, not shrinking)`);
  const stuckAttention = stuckDays.filter(stuckDayNeedsAttention);
  if (stuckAttention.length) attention.push(`daily 10-minute step (${stuckAttention.length} stuck day/s)`);
  const behind = results.filter((r) => r.status === "behind" && !r.stalled).map((r) => `${r.name} (${r.remaining ?? "?"} remaining)`);
  const headline = !input.parts.length || !anyReported
    ? NO_PARTS_REPORTING
    : attention.length
      ? `needs attention: ${attention.join(", ")}${behind.length ? `; behind: ${behind.join(", ")}` : ""}`
      : behind.length
        ? `behind: ${behind.join(", ")}`
        : HEALTHY;
  const lines = [headline, `errors: ${errors}, missing: ${missing}`];
  if (fault) lines.push(`health check likely at fault: ${silent.length} parts silent at once (${silent.join(", ")})`);
  lines.push(...results.map((r) => r.line), ...stuckDays.map(stuckDayLine));
  const needsPerson = headline === NO_PARTS_REPORTING || attention.length > 0;
  return { headline, parts: results, errors, missing, silentParts: silent, likelyCheckFault: fault, stuckDays, lines, attention: needsPerson, requests };
}

export const HEALTH_CHECK_SCHEMA = "health-check-v1" as const;
export const HEALTH_CHECK_LATEST_KEY = "permanent/health/check/latest.json" as const;
export const HEALTH_CHECK_STATE_KEY = "permanent/health/check/state.json" as const;

/**
 * Days in the daily step's catch-up window it keeps re-running without finishing (dayStuck), and
 * (Auditor B2) tracked days that left the window not done in the last 31 days.
 */
export async function readStuckDays(
  store: Pick<HealthCheckinStore, "get" | "list">,
  now: Date,
  catchupSessions: number = TENMIN_DAILY_CATCHUP_SESSIONS,
): Promise<HealthStuckDay[]> {
  const output: HealthStuckDay[] = [];
  const window = tenMinDailyCatchupSessions(lastCompletedSessionDate(now), catchupSessions);
  const since = new Date(now.getTime() - HEALTH_LEFT_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
  const windowStart = window[0] ?? lastCompletedSessionDate(now);
  const leftDays = (await listTenMinDailyIndexDays(store, windowStart).catch(() => [] as string[])).filter((d) => d < windowStart && d >= since);
  for (const sessionDate of [...leftDays, ...window]) {
    const leftWindow = sessionDate < windowStart;
    const index = await readTenMinDailyIndex(store, sessionDate).catch(() => undefined);
    // STUCK_SHORT days (and older indexes past 6 failed passes) are flagged; they are never done.
    if (!index || index.done) continue;
    if (leftWindow ? isPreRuleIndex(index) : !(index.stuckShort || dayStuck(index.notDoneRuns ?? 0))) continue;
    const expectedBars = expectedTenMinBars(sessionDate);
    output.push({
      sessionDate,
      expectedBars,
      shortNames: index.shortNames ?? 0,
      missingDailyBars: index.missingDailyBars ?? 0,
      reRuns: index.notDoneRuns ?? 0,
      ...(({ dayBars, ...rest }) => ({ bars: dayBars, ...rest }))(tenMinDailyIndexCounts(index, expectedBars)),
      ...(index.stuckShort ? { stuckShort: index.stuckShort } : {}),
      ...(leftWindow ? { leftWindow: true } : {}),
    });
  }
  return output;
}

/** One health check: latest check-in per declared part, stuck days, carried no-response counts. Writes latest.json. */
export async function runHealthCheck(
  store: HealthPruneStore,
  now: Date = new Date(),
): Promise<HealthCheckResult & { prunedCheckins: number; pruneError?: string }> {
  const latest = new Map<string, HealthCheckinFacts | undefined>();
  const previous = new Map<string, HealthCheckinFacts | undefined>();
  for (const part of HEALTH_PARTS) {
    const [newest, before] = await recentHealthCheckins(store, part.id, 2);
    latest.set(part.name, newest);
    previous.set(part.name, before);
  }
  let priorRequests: Record<string, number> = {};
  const stateBytes = await store.get(HEALTH_CHECK_STATE_KEY);
  if (stateBytes) {
    try {
      const parsed = JSON.parse(new TextDecoder().decode(stateBytes)) as { requests?: Record<string, number> };
      if (parsed.requests && typeof parsed.requests === "object") priorRequests = parsed.requests;
    } catch {
      // An unreadable state starts the counts again; it never stops the check.
    }
  }
  const result = evaluateHealth({
    parts: HEALTH_PARTS.map((p) => ({ name: p.name, ...(p.allowedSilenceMinutes === undefined ? {} : { allowedSilenceMinutes: p.allowedSilenceMinutes }) })),
    latest,
    previous,
    priorRequests,
    now,
    stuckDays: await readStuckDays(store, now),
  });
  const at = now.toISOString();
  // Retention: check-ins older than one month are pruned (after the latest ones were read). A prune
  // failure never stops the check: latest.json and the state are still written, with the error.
  let prunedCheckins = 0;
  let pruneError: string | undefined;
  try {
    prunedCheckins = await pruneHealthCheckins(store, now);
  } catch (error) {
    pruneError = redactHealthMessage(errorMessage(error))?.slice(0, 120) ?? "error";
    result.lines.push(`pruning old check-ins failed (kept for the next check): ${pruneError}`);
  }
  await writeVerifiedHealthJson(store, HEALTH_CHECK_STATE_KEY, { schemaVersion: HEALTH_CHECK_SCHEMA, requests: result.requests, updatedAt: at });
  await writeVerifiedHealthJson(store, HEALTH_CHECK_LATEST_KEY, { schemaVersion: HEALTH_CHECK_SCHEMA, at, ...result, prunedCheckins, ...(pruneError ? { pruneError } : {}) });
  return { ...result, prunedCheckins, ...(pruneError ? { pruneError } : {}) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runHealthCheck(R2ObjectClient.fromEnv(process.env))
    .then(async (result) => {
      for (const line of result.lines) process.stdout.write(`${line}\n`);
      process.stdout.write(`pruned check-ins older than one month: ${result.prunedCheckins}\n`);
      if (result.attention) process.stdout.write(`::warning title=PeaceSTOCKS health::${result.headline}\n`);
      // The alert step (src/health-alert.ts) reads this file; a missing file means the check failed.
      if (process.env.HEALTH_RESULT_FILE)
        await writeFile(process.env.HEALTH_RESULT_FILE, `${JSON.stringify({ headline: result.headline, lines: result.lines, attention: result.attention })}\n`, "utf8");
    })
    .catch((error: unknown) => {
      process.stdout.write(`HEALTH_CHECK_FAILED:${redactHealthMessage(errorMessage(error))?.slice(0, 120) ?? ""}\n`);
      process.exitCode = 1;
    });
}
