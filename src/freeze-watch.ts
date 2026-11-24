// Freeze watch (scanner-quality batch). A trading session "misses the freeze" when the next session
// opens without picks frozen before that open: frozen late, unavailable, or no decision stored at all
// (for example the scan never ran). Each missed session raises the existing alert once: the one
// "PeaceSTOCKS health needs attention" issue (label scanner-alert, src/health-alert.ts), opened or
// commented on; a marker under permanent/health/scan/missed-freeze-alerts/, claimed with one conditional
// put (If-None-Match: *) before the alert, keeps it to once per session even when two runs race. Reads prediction-status records only; no Massive request, no tickers in the alert.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { PredictionStatus } from "./contracts";
import { type HealthCheckinStore, errorMessage, redactHealthMessage, writeVerifiedHealthJson } from "./health-checkins";
import { runHealthAlert } from "./health-alert";
import { R2ObjectClient } from "./object-store";
import { resolveSessionPredictionStatus } from "./prediction-status";
import {
  FREEZE_RELIABILITY_KEY,
  FREEZE_RELIABILITY_SCHEMA,
  type FreezeReliability,
  type FreezeShare,
  MISSED_FREEZE_ALERT_PREFIX,
} from "./scan-health";
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
/** The on-time windows shown on the site. */
export const FREEZE_SHARE_WINDOWS = [20, 60] as const;

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

/**
 * Pure: on-time share over the newest `window` judged sessions (`outcomes` newest first). A session
 * with no record counts against the share: a scan that never ran is a missed freeze.
 */
export function onTimeShare(outcomes: readonly SessionFreeze[], window: number): FreezeShare {
  const slice = outcomes.slice(0, window);
  const count = (o: FreezeOutcome) => slice.filter((x) => x.outcome === o).length;
  const onTime = count("ON_TIME");
  return {
    sessions: slice.length,
    onTime,
    late: count("LATE"),
    unavailable: count("UNAVAILABLE"),
    noRecord: count("NO_RECORD"),
    share: slice.length ? onTime / slice.length : null,
  };
}

/** Pure: the reliability record the site reads. */
export function freezeReliability(outcomes: readonly SessionFreeze[], now: Date): FreezeReliability {
  return {
    schemaVersion: FREEZE_RELIABILITY_SCHEMA,
    at: now.toISOString(),
    ...(outcomes[0] ? { through: outcomes[0].sessionDate } : {}),
    last20: onTimeShare(outcomes, 20),
    last60: onTimeShare(outcomes, 60),
  };
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

/**
 * The health store plus a create-only put (the alert marker claim), delete (release a failed claim), and a
 * versioned read and conditional replace (take over an expired claim).
 */
export type FreezeWatchStore = HealthCheckinStore & {
  putIfAbsent(key: string, body: Uint8Array): Promise<boolean>;
  delete(key: string): Promise<void>;
  getWithEtag(key: string): Promise<{ body: Uint8Array; etag: string } | undefined>;
  putIfMatch(key: string, body: Uint8Array, etag: string): Promise<boolean>;
};

/**
 * A claim older than this that never reached ALERTED was left by a run killed between the claim and the
 * alert; the next run takes it over. Far above an alert's few seconds, so a live claim is never taken.
 */
export const MISSED_FREEZE_CLAIM_EXPIRY_MS = 2 * 60 * 60 * 1000;

/** Pure: the marker is a claim (never ALERTED) older than the expiry. Unreadable markers are not. */
export function claimExpired(body: Uint8Array, now: Date): boolean {
  let marker: { at?: unknown; alert?: unknown; state?: unknown };
  try {
    marker = JSON.parse(new TextDecoder().decode(body)) as typeof marker;
  } catch {
    return false;
  }
  if (!marker || marker.state === "ALERTED" || marker.alert !== "CLAIMED") return false;
  const at = typeof marker.at === "string" ? Date.parse(marker.at) : Number.NaN;
  return Number.isFinite(at) && now.getTime() - at > MISSED_FREEZE_CLAIM_EXPIRY_MS;
}

export interface FreezeWatchDeps {
  store: FreezeWatchStore;
  env: NodeJS.ProcessEnv;
  now?: Date;
  calendar?: EligibleSessionCalendar;
  alert?: typeof runHealthAlert;
  fetchImpl?: typeof fetch;
}

/** Check the newest judged sessions; alert once per missed one. Returns a log line (no tickers). */
export async function runFreezeWatch(
  deps: FreezeWatchDeps,
): Promise<{ missed: SessionFreeze[]; alerted: string[]; reliability: FreezeReliability; line: string }> {
  const now = deps.now ?? new Date();
  const calendar = deps.calendar ?? US_EQUITY_MARKET_CALENDAR;
  const outcomes: SessionFreeze[] = [];
  for (const { sessionDate, nextSessionOpen: open } of judgedSessions(now, Math.max(...FREEZE_SHARE_WINDOWS), calendar))
    outcomes.push(sessionFreezeOutcome(sessionDate, open, await loadSessionStatuses(deps.store, sessionDate)));
  // Reliability first: a failed alert below must not leave the site's on-time share stale.
  const reliability = freezeReliability(outcomes, now);
  await writeVerifiedHealthJson(deps.store, FREEZE_RELIABILITY_KEY, reliability);
  const missed = outcomes.slice(0, MISSED_FREEZE_LOOKBACK_SESSIONS).filter((o) => o.outcome !== "ON_TIME");
  // Claim each marker with one conditional put (If-None-Match: *). The scan job's last step and the :47 tick
  // are in different concurrency groups; head-then-put let both see no marker and both alert. A refused
  // claim (412) means another run already alerted (or is alerting) for that session, unless that claim
  // expired: then one conditional replace (If-Match: <etag>) takes it over, and only one racer wins.
  const fresh: SessionFreeze[] = [];
  const markerKey = (miss: SessionFreeze) => `${MISSED_FREEZE_ALERT_PREFIX}${miss.sessionDate}.json`;
  for (const miss of missed) {
    const key = markerKey(miss);
    const claim = new TextEncoder().encode(`${JSON.stringify({ at: now.toISOString(), ...miss, alert: "CLAIMED", state: "CLAIMED" }, null, 2)}\n`);
    if (await deps.store.putIfAbsent(key, claim)) {
      fresh.push(miss);
      continue;
    }
    const existing = await deps.store.getWithEtag(key);
    if (existing && claimExpired(existing.body, now) && (await deps.store.putIfMatch(key, claim, existing.etag))) fresh.push(miss);
  }
  if (!fresh.length)
    return { missed, alerted: [], reliability, line: `freeze watch: ${shareLine(reliability)}; ${missed.length} missed in the last ${MISSED_FREEZE_LOOKBACK_SESSIONS} sessions, none new` };
  const headline = `missed freeze: ${fresh.length} session${fresh.length === 1 ? "" : "s"}`;
  const alert = deps.alert ?? runHealthAlert;
  let did: string;
  try {
    did = await alert({
      result: { headline, lines: [headline, ...fresh.map(describeMiss)], attention: true },
      env: deps.env,
      now,
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    });
  } catch (error) {
    // A failed alert releases its claims, so the next run retries.
    for (const miss of fresh) await deps.store.delete(markerKey(miss)).catch(() => undefined);
    throw error;
  }
  // The claim is ours: record what the alert did.
  for (const miss of fresh)
    await writeVerifiedHealthJson(deps.store, markerKey(miss), { at: now.toISOString(), ...miss, alert: did, state: "ALERTED" });
  return { missed, alerted: fresh.map((m) => m.sessionDate), reliability, line: `freeze watch: ${shareLine(reliability)}; ${headline}; alert ${did}` };
}

function shareLine(r: FreezeReliability): string {
  return `on time ${r.last20.onTime}/${r.last20.sessions} (last 20), ${r.last60.onTime}/${r.last60.sessions} (last 60)`;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  runFreezeWatch({ store: R2ObjectClient.fromEnv(process.env), env: process.env })
    .then((result) => process.stdout.write(`${result.line}\n`))
    .catch((error: unknown) => {
      process.stdout.write(`FREEZE_WATCH_FAILED:${redactHealthMessage(errorMessage(error))?.slice(0, 160) ?? ""}\n`);
      process.exitCode = 1;
    });
}
