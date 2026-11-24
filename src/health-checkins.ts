// Health check-ins: each real part (scan, daily 10-minute step, history chain, backfill, gap refill)
// writes one small JSON record to R2 every time it runs, and declares the schedule it is expected
// to keep. The health check and the weekly review read these records. Writes follow the R2 writer
// pattern used for the daily index (put, then HEAD read-back of size + checksum metadata). A new key
// per check-in: nothing is ever overwritten or deleted. A failed check-in never fails the part.
import { sha256Hex } from "./intraday-reply-dust";
import { checkinLine } from "./health-checkin-line";
import type { ObjectHead, ObjectMetadata } from "./object-store";
import { R2ObjectClient } from "./object-store";

export const HEALTH_CHECKIN_SCHEMA = "health-checkin-v1" as const;
import { isCheckinExpired } from "./health-expired";

export const HEALTH_CHECKIN_PREFIX = "permanent/health/checkins/" as const;
const CHECKSUM_META = "health-checkin-sha256";
const WRITE_TIMEOUT_MS = 20_000;
const MESSAGE_MAX = 200;

export type HealthPartId = "scan" | "tenmin-daily" | "history-chain" | "backfill" | "gap-refill";

/** Expected check-ins: perDay on each listed UTC weekday (0 = Sunday). */
export interface HealthPartSchedule {
  utcDays: readonly number[];
  perDay: number;
}

export interface HealthPartDeclaration {
  id: HealthPartId;
  name: string;
  schedule: HealthPartSchedule;
  /** Minutes without a check-in before the part counts as silent; undefined = runs only by hand. */
  allowedSilenceMinutes?: number;
}

const TUE_TO_SAT = [2, 3, 4, 5, 6] as const;
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6] as const;

/** Each part's own schedule (from its workflow crons). */
export const HEALTH_PARTS: readonly HealthPartDeclaration[] = [
  // scanner.yml crons 05:30 + 09:30 UTC Tue-Sat; Sat 09:30 -> Tue 05:30 is the longest normal gap (68 h).
  { id: "scan", name: "scan", schedule: { utcDays: TUE_TO_SAT, perDay: 2 }, allowedSilenceMinutes: 74 * 60 },
  // scanner.yml crons 06:20 + 10:20 UTC Tue-Sat (only while TENMIN_DAILY_ENABLED is true).
  { id: "tenmin-daily", name: "daily 10-minute step", schedule: { utcDays: TUE_TO_SAT, perDay: 2 }, allowedSilenceMinutes: 74 * 60 },
  // Dispatched chain plus the hourly restarter: at least one run a day while the chain is working.
  { id: "history-chain", name: "history chain", schedule: { utcDays: EVERY_DAY, perDay: 1 }, allowedSilenceMinutes: 26 * 60 },
  // Manual dispatch only: no expected check-ins, never silent.
  { id: "backfill", name: "backfill", schedule: { utcDays: [], perDay: 0 } },
  // gap-refill.yml cron 14:40 UTC Sunday.
  { id: "gap-refill", name: "gap refill", schedule: { utcDays: [0], perDay: 1 }, allowedSilenceMinutes: 8 * 24 * 60 },
];

export interface HealthCheckin {
  schemaVersion: typeof HEALTH_CHECKIN_SCHEMA;
  part: HealthPartId;
  /** The part's own state word: OK or ERROR (anything else is an unrecognized word). */
  state: string;
  at: string;
  message?: string;
  runId?: string;
  /** BEHIND only: how much the capped run left for the next run (sessions). */
  remaining?: number;
}

export interface HealthCheckinStore {
  get(key: string): Promise<Uint8Array | undefined>;
  put(key: string, body: Uint8Array, metadata?: ObjectMetadata): Promise<void>;
  head(key: string): Promise<ObjectHead | undefined>;
  list(prefix: string): Promise<string[]>;
}

/**
 * Pure: a short, safe message. Query strings, key/token/secret/signature values, bearer tokens and
 * long opaque strings are removed so no credential can reach a check-in or a report.
 */
export function redactHealthMessage(message: string | undefined): string | undefined {
  if (message === undefined) return undefined;
  const cleaned = message
    .replace(/\?[^\s"']*/gu, "?[redacted]")
    .replace(/\b(api[_-]?key|apikey|token|secret|signature|password|authorization|credential)\b\s*[=:]\s*\S+/giu, "$1=[redacted]")
    .replace(/\bBearer\s+\S+/giu, "Bearer [redacted]")
    .replace(/[A-Za-z0-9+/_=-]{32,}/gu, "[redacted]")
    .replace(/\s+/gu, " ")
    .trim();
  return cleaned.slice(0, MESSAGE_MAX);
}

/** A check-in store that can also prune old check-ins. */
export type HealthPruneStore = HealthCheckinStore & { delete(key: string): Promise<void> };

/** At most this many old check-ins are deleted per health check (the rest go on the next one). */
export const HEALTH_PRUNE_MAX_PER_RUN = 2000;
const CHECKIN_KEY = /^permanent\/health\/checkins\/[a-z-]+\/(\d{4}-\d{2}-\d{2})\/[0-9A-Za-z-]+\.json$/u;

/**
 * Retention (Peace's Oct 22 spec, settled Nov 23): check-ins are kept for one month. Deletes
 * check-ins filed under a day 31 or more days before `now` (isCheckinExpired), only keys that are
 * exactly check-in keys under permanent/health/checkins/. Returns how many were deleted.
 */
export async function pruneHealthCheckins(store: Pick<HealthPruneStore, "list" | "delete">, now: Date): Promise<number> {
  const today = Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`);
  let deleted = 0;
  for (const key of await store.list(HEALTH_CHECKIN_PREFIX)) {
    if (deleted >= HEALTH_PRUNE_MAX_PER_RUN) break;
    const day = CHECKIN_KEY.exec(key)?.[1];
    if (!day) continue;
    const ageDays = (today - Date.parse(`${day}T00:00:00Z`)) / 86_400_000;
    if (!Number.isFinite(ageDays) || !isCheckinExpired(ageDays)) continue;
    await store.delete(key);
    deleted += 1;
  }
  return deleted;
}

function validRemaining(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

export function healthCheckinKey(checkin: Pick<HealthCheckin, "part" | "at" | "runId">, nonce: string): string {
  const stamp = checkin.at.replaceAll(/[^0-9]/gu, "").slice(0, 17);
  const run = (checkin.runId ?? "local").replaceAll(/[^A-Za-z0-9-]/gu, "").slice(0, 24) || "local";
  return `${HEALTH_CHECKIN_PREFIX}${checkin.part}/${checkin.at.slice(0, 10)}/${stamp}-${run}-${nonce}.json`;
}

export async function writeHealthCheckin(
  store: HealthCheckinStore,
  input: { part: HealthPartId; state: string; at: string; message?: string; runId?: string; remaining?: number },
  nonce: string = Math.random().toString(36).slice(2, 8),
): Promise<{ key: string; checkin: HealthCheckin }> {
  const message = redactHealthMessage(input.message);
  const checkin: HealthCheckin = {
    schemaVersion: HEALTH_CHECKIN_SCHEMA,
    part: input.part,
    state: input.state,
    at: input.at,
    ...(message ? { message } : {}),
    ...(input.runId ? { runId: input.runId } : {}),
    ...(validRemaining(input.remaining) ? { remaining: input.remaining } : {}),
  };
  const key = healthCheckinKey(checkin, nonce);
  const bytes = new TextEncoder().encode(`${JSON.stringify(checkin)}\n`);
  const checksum = sha256Hex(bytes);
  await store.put(key, bytes, { [CHECKSUM_META]: checksum });
  const head = await store.head(key);
  if (!head || head.size !== bytes.length || head.metadata[CHECKSUM_META] !== checksum)
    throw new Error(`HEALTH_CHECKIN_READBACK_MISMATCH:${input.part}`);
  return { key, checkin };
}

/** Parse one stored check-in. An unreadable one keeps its key's part/date with the word "UNREADABLE". */
function parseCheckin(key: string, bytes: Uint8Array | undefined, part: HealthPartId): HealthCheckin & { key: string } {
  const day = key.slice(HEALTH_CHECKIN_PREFIX.length).split("/")[1] ?? "";
  try {
    const raw = JSON.parse(new TextDecoder().decode(bytes ?? new Uint8Array())) as Partial<HealthCheckin>;
    if (typeof raw.state !== "string" || typeof raw.at !== "string") throw new Error("shape");
    return {
      key,
      schemaVersion: HEALTH_CHECKIN_SCHEMA,
      part: (raw.part ?? part) as HealthPartId,
      state: raw.state,
      at: raw.at,
      ...(typeof raw.message === "string" ? { message: raw.message } : {}),
      ...(typeof raw.runId === "string" ? { runId: raw.runId } : {}),
      ...(validRemaining(raw.remaining) ? { remaining: raw.remaining } : {}),
    };
  } catch {
    return { key, schemaVersion: HEALTH_CHECKIN_SCHEMA, part, state: "UNREADABLE", at: `${day}T00:00:00.000Z` };
  }
}

/** Check-ins for one part with `at` in [fromIso, toIso], oldest first. */
export async function listHealthCheckins(
  store: Pick<HealthCheckinStore, "get" | "list">,
  part: HealthPartId,
  fromIso: string,
  toIso: string,
): Promise<Array<HealthCheckin & { key: string }>> {
  const prefix = `${HEALTH_CHECKIN_PREFIX}${part}/`;
  const fromDay = fromIso.slice(0, 10);
  const toDay = toIso.slice(0, 10);
  const keys = (await store.list(prefix))
    .filter((key) => {
      const day = key.slice(prefix.length, prefix.length + 10);
      return day >= fromDay && day <= toDay;
    })
    .sort();
  const output: Array<HealthCheckin & { key: string }> = [];
  for (const key of keys) {
    const checkin = parseCheckin(key, await store.get(key), part);
    if (checkin.at >= fromIso && checkin.at <= toIso) output.push(checkin);
  }
  return output.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

/** The newest check-in for one part, or undefined. */
export async function latestHealthCheckin(
  store: Pick<HealthCheckinStore, "get" | "list">,
  part: HealthPartId,
): Promise<(HealthCheckin & { key: string }) | undefined> {
  const keys = (await store.list(`${HEALTH_CHECKIN_PREFIX}${part}/`)).sort();
  const key = keys.at(-1);
  return key ? parseCheckin(key, await store.get(key), part) : undefined;
}

/** Write one JSON report with the same read-back check as a check-in (size + checksum metadata). */
export async function writeVerifiedHealthJson(store: HealthCheckinStore, key: string, value: unknown): Promise<void> {
  const bytes = new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);
  const checksum = sha256Hex(bytes);
  await store.put(key, bytes, { [CHECKSUM_META]: checksum });
  const head = await store.head(key);
  if (!head || head.size !== bytes.length || head.metadata[CHECKSUM_META] !== checksum)
    throw new Error(`HEALTH_REPORT_READBACK_MISMATCH:${key}`);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Part entry points call this once per run. Writes to R2 when PEACESTOCKS_R2_BUCKET is set (Actions),
 * otherwise does nothing. Never throws: a failed check-in is logged and the part goes on, so the
 * health check later sees silence ("no response"), not a broken part.
 */
export async function reportPart(
  env: NodeJS.ProcessEnv,
  part: HealthPartId,
  state: "OK" | "ERROR" | "BEHIND",
  message?: string,
  deps: { openStore?: (env: NodeJS.ProcessEnv) => HealthCheckinStore; now?: () => Date; log?: (line: string) => void } = {},
  facts: { remaining?: number } = {},
): Promise<string> {
  const log = deps.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  if (!env.PEACESTOCKS_R2_BUCKET?.trim()) return "SKIPPED_NO_STORE";
  try {
    const store = (deps.openStore ?? ((e) => R2ObjectClient.fromEnv(e)))(env);
    const at = (deps.now ?? (() => new Date()))().toISOString();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("HEALTH_CHECKIN_TIMEOUT")), WRITE_TIMEOUT_MS);
      timer.unref?.();
    });
    const { checkin } = await Promise.race([
      writeHealthCheckin(store, {
        part,
        state,
        at,
        ...(message ? { message } : {}),
        ...(env.GITHUB_RUN_ID ? { runId: env.GITHUB_RUN_ID } : {}),
        ...(facts.remaining === undefined ? {} : { remaining: facts.remaining }),
      }),
      timeout,
    ]).finally(() => clearTimeout(timer));
    log(checkinLine(part, state, checkin.message ?? ""));
    return "WRITTEN";
  } catch (error) {
    log(`HEALTH_CHECKIN_FAILED:${part}:${redactHealthMessage(errorMessage(error))?.slice(0, 80) ?? ""}`);
    return "FAILED";
  }
}
