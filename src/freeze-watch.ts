// Freeze watch (scanner-quality batch). A trading session "misses the freeze" when the next session
// opens without picks frozen before that open: frozen late, unavailable, or no decision stored at all
// (for example the scan never ran). Each missed session raises the existing alert once: the one
// "PeaceSTOCKS health needs attention" issue (label scanner-alert, src/health-alert.ts), opened or
// commented on; a marker under permanent/health/scan/missed-freeze-alerts/ keeps it to once per
// session. Reads prediction-status records only; no Massive request, no tickers in the alert.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { PredictionStatus } from "./contracts";
import { type HealthCheckinStore, errorMessage, redactHealthMessage, writeVerifiedHealthJson } from "./health-checkins";
import { runHealthAlert } from "./health-alert";
import { R2ObjectClient } from "./object-store";
import { resolveSessionPredictionStatus } from "./prediction-status";
import { MISSED_FREEZE_ALERT_PREFIX } from "./scan-health";
import { type EligibleSessionCalendar, nextSessionOpen, previousEligibleSession } from "./session-open";
import { US_EQUITY_MARKET_CALENDAR } from "./us-calendar";

export type FreezeOutcome = "ON_TIME" | "LATE" | "UNAVAILABLE" | "NO_RECORD";

export interface SessionFreeze {
  sessionDate: string;
  nextSessionOpen: string;
  outcome: FreezeOutcome;
  reason?: string;
}

/** Sessions checked for a missed freeze on each run (the newest ones whose next open has passed). */
export const MISSED_FREEZE_LOOKBACK_SESSIONS = 3;

/**
 * Pure: the newest `count` trading sessions whose NEXT session's open is at or before `now`
 * (newest first). A session whose next open is still ahead is not judged yet.
 */
export function judgedSessions(
  now: Date,
  count: number,
  calendar: EligibleSessionCalendar = US_EQUITY_MARKET_CALENDAR,
): Array<{ sessionDate: string; nextSessionOpen: Date }> {
  const out: Array<{ sessionDate: string; nextSessionOpen: Date }> = [];
  // Start from tomorrow (UTC) and walk back through trading sessions.
  let cursor: string | undefined = new Date(now.getTime() + 86_400_000).toISOString().slice(0, 10);
  while (out.length < count && cursor) {
    cursor = previousEligibleSession(cursor, calendar);
    if (!cursor) break;
    const next = nextSessionOpen(cursor, calendar);
    if (next && next.nextSessionOpen.getTime() <= now.getTime())
      out.push({ sessionDate: cursor, nextSessionOpen: next.nextSessionOpen });
  }
  return out;
}

/** Pure: how one session's freeze went, from its prediction-status records. */
export function sessionFreezeOutcome(
  sessionDate: string,
  open: Date,
  statuses: readonly PredictionStatus[],
): SessionFreeze {
  const base = { sessionDate, nextSessionOpen: open.toISOString() };
  const resolved = resolveSessionPredictionStatus(statuses.filter((s) => s.sessionDate === sessionDate));
  if (!resolved) return { ...base, outcome: "NO_RECORD" };
  if (resolved.status === "FROZEN") {
    // Freeze records since S4 carry predictedAt; the scanner refuses a forward freeze at or after the open.
    if (!resolved.predictedAt) return { ...base, outcome: "ON_TIME", reason: resolved.reason };
    const at = Date.parse(resolved.predictedAt);
    return {
      ...base,
      outcome: Number.isFinite(at) && at < open.getTime() ? "ON_TIME" : "LATE",
      reason: resolved.reason,
    };
  }
  return { ...base, outcome: resolved.reason === "FREEZE_AFTER_OPEN" ? "LATE" : "UNAVAILABLE", reason: resolved.reason };
}

export function describeMiss(miss: SessionFreeze): string {
  const what =
    miss.outcome === "LATE"
      ? "picks were not frozen before the open (frozen too late)"
      : miss.outcome === "UNAVAILABLE"
        ? `picks unavailable (${miss.reason ?? "no reason"})`
        : "no freeze decision was stored (the scan did not finish)";
  return `session ${miss.sessionDate}: missed the freeze, ${what}; next open ${miss.nextSessionOpen}`;
}

function jsonl<T>(bytes: Uint8Array | undefined): T[] {
  if (!bytes) return [];
  return new TextDecoder()
    .decode(bytes)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

export async function loadSessionStatuses(store: Pick<HealthCheckinStore, "get">, sessionDate: string): Promise<PredictionStatus[]> {
  return jsonl<PredictionStatus>(await store.get(`permanent/prediction-status/${sessionDate}.jsonl`));
}

export interface FreezeWatchDeps {
  store: HealthCheckinStore;
  env: NodeJS.ProcessEnv;
  now?: Date;
  calendar?: EligibleSessionCalendar;
  alert?: typeof runHealthAlert;
  fetchImpl?: typeof fetch;
}

/** Check the newest judged sessions; alert once per missed one. Returns a log line (no tickers). */
export async function runFreezeWatch(deps: FreezeWatchDeps): Promise<{ missed: SessionFreeze[]; alerted: string[]; line: string }> {
  const now = deps.now ?? new Date();
  const calendar = deps.calendar ?? US_EQUITY_MARKET_CALENDAR;
  const missed: SessionFreeze[] = [];
  for (const { sessionDate, nextSessionOpen: open } of judgedSessions(now, MISSED_FREEZE_LOOKBACK_SESSIONS, calendar)) {
    const outcome = sessionFreezeOutcome(sessionDate, open, await loadSessionStatuses(deps.store, sessionDate));
    if (outcome.outcome !== "ON_TIME") missed.push(outcome);
  }
  const fresh: SessionFreeze[] = [];
  for (const miss of missed)
    if (!(await deps.store.head(`${MISSED_FREEZE_ALERT_PREFIX}${miss.sessionDate}.json`))) fresh.push(miss);
  if (!fresh.length)
    return { missed, alerted: [], line: `freeze watch: ${missed.length} missed in the last ${MISSED_FREEZE_LOOKBACK_SESSIONS} sessions, none new` };
  const headline = `missed freeze: ${fresh.length} session${fresh.length === 1 ? "" : "s"}`;
  const alert = deps.alert ?? runHealthAlert;
  const did = await alert({
    result: { headline, lines: [headline, ...fresh.map(describeMiss)], attention: true },
    env: deps.env,
    now,
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  });
  // Marker only after the alert went out, so a failed alert is retried by the next run.
  for (const miss of fresh)
    await writeVerifiedHealthJson(deps.store, `${MISSED_FREEZE_ALERT_PREFIX}${miss.sessionDate}.json`, {
      at: now.toISOString(),
      ...miss,
      alert: did,
    });
  return { missed, alerted: fresh.map((m) => m.sessionDate), line: `freeze watch: ${headline}; alert ${did}` };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  runFreezeWatch({ store: R2ObjectClient.fromEnv(process.env), env: process.env })
    .then((result) => process.stdout.write(`${result.line}\n`))
    .catch((error: unknown) => {
      process.stdout.write(`FREEZE_WATCH_FAILED:${redactHealthMessage(errorMessage(error))?.slice(0, 160) ?? ""}\n`);
      process.exitCode = 1;
    });
}
