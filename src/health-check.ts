// Health check (Peace, Oct 26-27). Pure core: one status per part from its latest check-in.
// - A part that does not report is not an error: it is tracked as missing with
//   "no response from (part), requested health check X time/s" (always the static "time/s").
// - Unknown state words never count against a part (status "unrecognized word").
// - Winner order: error > no response > unrecognized word > OK.
// - 3 or more silent parts at once: the health check's own likely fault is flagged, and the silent
//   parts are still listed by name.
// - No parts reporting: "no parts reporting", never "Healthy".
import { countErrorParts } from "./health-error-count";
import { likelyCheckFault } from "./health-check-fault";
import { countMissingParts } from "./health-missing-count";
import { noResponseLine } from "./health-no-response-line";
import { partOkLine } from "./health-part-ok-line";
import { type HealthPartStatus, isRecognizedStateWord, partStatus } from "./health-part-state";
import { isCheckinSilent } from "./health-silent";
import { silentParts } from "./health-silent-parts";

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
}

export interface HealthPartResult {
  name: string;
  status: HealthPartStatus;
  line: string;
  /** Consecutive health checks this part did not answer (0 when it answered). */
  requests: number;
  lastCheckinAt?: string;
}

/** A day the daily 10-minute step keeps re-running without finishing it. */
export interface HealthStuckDay {
  sessionDate: string;
  expectedBars: number;
  shortNames: number;
  missingDailyBars: number;
  reRuns: number;
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
  /** Carry to the next check: no-response counts per part. */
  requests: Record<string, number>;
}

function ageMinutes(atIso: string, now: Date): number {
  const at = Date.parse(atIso);
  return Number.isFinite(at) ? (now.getTime() - at) / 60_000 : Number.POSITIVE_INFINITY;
}

/** Plain line for a stuck day (the health check flags days stuck short of 39 bars, 21 on half days). */
export function stuckDayLine(day: HealthStuckDay): string {
  const what =
    day.shortNames > 0
      ? `stuck short of ${day.expectedBars} bars (${day.shortNames} stock/s short)`
      : `stuck waiting for daily bars (${day.missingDailyBars} stock/s)`;
  return `daily 10-minute step: ${day.sessionDate} ${what} after ${day.reRuns} re-run/s`;
}

export function evaluateHealth(input: {
  parts: readonly HealthCheckPart[];
  latest: ReadonlyMap<string, HealthCheckinFacts | undefined>;
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
    });
    const asked = silent ? (input.priorRequests?.[part.name] ?? 0) + 1 : 0;
    requests[part.name] = asked;
    const line =
      status === "error"
        ? `${part.name}: error: ${latest?.message?.trim() || "(no message)"}`
        : status === "no response"
          ? noResponseLine(part.name, asked)
          : status === "unrecognized word"
            ? `${part.name}: unrecognized word ${JSON.stringify(word)}`
            : latest
              ? partOkLine(part.name)
              : `${part.name}: OK (runs only when started; no check-in yet)`;
    results.push({ name: part.name, status, line, requests: asked, ...(latest ? { lastCheckinAt: latest.at } : {}) });
  }
  const states = results.map((r) => (r.status === "error" ? "ERROR" : r.status === "no response" ? "SILENT" : "OK"));
  const errors = countErrorParts(states);
  const missing = countMissingParts(states);
  const silent = silentParts(results.map((r) => ({ name: r.name, silent: r.status === "no response" || (r.status === "error" && r.requests > 0) })));
  const fault = likelyCheckFault(silent.length);
  const stuckDays = [...(input.stuckDays ?? [])];
  const anyReported = results.some((r) => r.lastCheckinAt !== undefined);
  const attention = results.filter((r) => r.status === "error" || r.status === "no response").map((r) => `${r.name} (${r.status})`);
  if (stuckDays.length) attention.push(`daily 10-minute step (${stuckDays.length} stuck day/s)`);
  const headline = !input.parts.length || !anyReported
    ? NO_PARTS_REPORTING
    : attention.length
      ? `needs attention: ${attention.join(", ")}`
      : HEALTHY;
  const lines = [headline, `errors: ${errors}, missing: ${missing}`];
  if (fault) lines.push(`health check likely at fault: ${silent.length} parts silent at once (${silent.join(", ")})`);
  lines.push(...results.map((r) => r.line), ...stuckDays.map(stuckDayLine));
  return { headline, parts: results, errors, missing, silentParts: silent, likelyCheckFault: fault, stuckDays, lines, requests };
}
