// Weekly health review (approved Oct 26). For each part over the last 7 days:
// missed check-ins (sent vs expected from the schedule the part declares), errors grouped by
// message with counts plus the latest one, wrong-fact count, unrecognized words, longest silence,
// and the change from last week ("first week" when there is no prior week). A top line lists the
// parts needing attention and flags a likely health-check fault. Runs Sunday after the gap refill
// (health.yml) and writes permanent/health/weekly/<date>.json with the R2 read-back check.
import { pathToFileURL } from "node:url";
import { attentionParts } from "./health-attention-parts";
import { likelyCheckFault } from "./health-check-fault";
import { checkinLine as checkinCountLine } from "./health-checkin-count-line";
import {
  HEALTH_PARTS,
  type HealthCheckinStore,
  type HealthPartDeclaration,
  type HealthPartSchedule,
  errorMessage,
  listHealthCheckins,
  redactHealthMessage,
  writeVerifiedHealthJson,
} from "./health-checkins";
import type { HealthCheckinFacts } from "./health-check";
import { errorCountLine } from "./health-error-count-line";
import { countErrorMessage } from "./health-error-message-count";
import { gotBetter } from "./health-got-better";
import { gotWorse } from "./health-got-worse";
import { missedCheckins } from "./health-missed-checkins";
import { needsAttention } from "./health-needs-attention";
import { isRecognizedStateWord } from "./health-part-state";
import { isCheckinSilent } from "./health-silent";
import { weekChange } from "./health-week-change";
import { weeklyExpected } from "./health-weekly-expected";
import { countWrongFacts } from "./health-wrong-facts";
import { R2ObjectClient } from "./object-store";

export const HEALTH_WEEKLY_SCHEMA = "health-weekly-review-v1" as const;
export const HEALTH_WEEKLY_PREFIX = "permanent/health/weekly/" as const;
const DAY_MS = 86_400_000;
/** Clock skew allowed before a check-in time counts as a wrong fact (in the future). */
const FUTURE_SKEW_MS = 5 * 60_000;

export interface HealthWindow {
  from: string;
  to: string;
}

export function weeklyWindow(now: Date): HealthWindow {
  return { from: new Date(now.getTime() - 7 * DAY_MS).toISOString(), to: now.toISOString() };
}

/**
 * Pure: check-ins a part's schedule expects in the window. Calendar days counted are those after the
 * window's first (partial) day through its last day, so a Sunday review counts Monday..Sunday:
 * 7 days for a 7-day window, each scheduled weekday once.
 */
export function expectedCheckins(schedule: HealthPartSchedule, window: HealthWindow): number {
  const fromDay = Date.parse(`${window.from.slice(0, 10)}T00:00:00Z`);
  const toDay = Date.parse(`${window.to.slice(0, 10)}T00:00:00Z`);
  if (schedule.utcDays.length === 7 && toDay - fromDay === 7 * DAY_MS) return weeklyExpected(schedule.perDay);
  let total = 0;
  for (let day = fromDay + DAY_MS; day <= toDay; day += DAY_MS)
    if (schedule.utcDays.includes(new Date(day).getUTCDay())) total += schedule.perDay;
  return total;
}

/**
 * Pure: a check-in whose own facts cannot be true: unreadable or future time, a part other than the
 * one it was filed under, or an ERROR with no message.
 */
export function isWrongFact(checkin: HealthCheckinFacts, partId: string, windowTo: string): boolean {
  const at = Date.parse(checkin.at);
  if (!Number.isFinite(at)) return true;
  if (at > Date.parse(windowTo) + FUTURE_SKEW_MS) return true;
  if (checkin.part !== partId) return true;
  return checkin.state === "ERROR" && !checkin.message?.trim();
}

/** Pure: the longest stretch in the window with no check-in (window edges count), in minutes. */
export function longestSilenceMinutes(checkins: readonly HealthCheckinFacts[], window: HealthWindow): number {
  const times = checkins.map((c) => Date.parse(c.at)).filter(Number.isFinite).sort((a, b) => a - b);
  const points = [Date.parse(window.from), ...times, Date.parse(window.to)];
  let longest = 0;
  for (let i = 1; i < points.length; i += 1) longest = Math.max(longest, points[i]! - points[i - 1]!);
  return Math.round(longest / 60_000);
}

export interface HealthErrorGroup {
  message: string;
  count: number;
  line: string;
  latestAt: string;
}

export interface HealthPartWeek {
  part: string;
  name: string;
  sent: number;
  expected: number;
  missed: number;
  errors: HealthErrorGroup[];
  latestError?: { message: string; at: string };
  wrongFacts: number;
  unrecognizedWords: Array<{ word: string; count: number }>;
  longestSilenceMinutes: number;
  /** Went past its allowed silence at some point this week. */
  wentSilent: boolean;
  /** missed + errors + wrong facts (unrecognized words never count against a part). */
  score: number;
  change: string;
  attention: boolean;
  lines: string[];
}

/** Pure: one part's week. `previousScore` undefined = no prior week ("first week"). */
export function reviewPart(input: {
  part: HealthPartDeclaration;
  checkins: readonly HealthCheckinFacts[];
  window: HealthWindow;
  previousScore?: number;
}): HealthPartWeek {
  const { part, checkins, window } = input;
  const sent = checkins.length;
  const expected = expectedCheckins(part.schedule, window);
  const missed = missedCheckins(expected, sent);
  const errorCheckins = checkins.filter((c) => c.state === "ERROR");
  const messages = errorCheckins.map((c) => c.message?.trim() || "(no message)");
  const errors: HealthErrorGroup[] = [...new Set(messages)]
    .map((message) => {
      const count = countErrorMessage(messages, message);
      const latestAt = errorCheckins.filter((c) => (c.message?.trim() || "(no message)") === message).map((c) => c.at).sort().at(-1)!;
      return { message, count, line: errorCountLine(message, count), latestAt };
    })
    .sort((a, b) => b.count - a.count || (a.latestAt < b.latestAt ? 1 : -1));
  const latest = [...errorCheckins].sort((a, b) => (a.at < b.at ? -1 : 1)).at(-1);
  const wrongFacts = countWrongFacts(checkins.map((c) => isWrongFact(c, part.id, window.to)));
  const words = checkins.map((c) => c.state).filter((w) => !isRecognizedStateWord(w));
  const unrecognizedWords = [...new Set(words)].sort().map((word) => ({ word, count: words.filter((w) => w === word).length }));
  const silence = longestSilenceMinutes(checkins, window);
  const wentSilent = part.allowedSilenceMinutes !== undefined && isCheckinSilent(silence, part.allowedSilenceMinutes);
  const errorTotal = errorCheckins.length;
  const score = missed + errorTotal + wrongFacts;
  const first = input.previousScore === undefined;
  const last = input.previousScore ?? 0;
  const change = weekChange(first, gotWorse(score, last), gotBetter(score, last));
  const attention = needsAttention([missed, errorTotal, wrongFacts]);
  const lines = [
    `${checkinCountLine(part.name, sent, expected)} (${missed} missed)`,
    errors.length ? `errors: ${errors.map((e) => e.line).join("; ")}` : "errors: none",
    ...(latest ? [`latest error: ${latest.message?.trim() || "(no message)"} at ${latest.at}`] : []),
    `wrong facts: ${wrongFacts}`,
    unrecognizedWords.length
      ? `unrecognized words: ${unrecognizedWords.map((u) => `${JSON.stringify(u.word)} x${u.count}`).join(", ")}`
      : "unrecognized words: none",
    `longest silence: ${(silence / 60).toFixed(1)} h`,
    `change from last week: ${change}`,
  ];
  return {
    part: part.id,
    name: part.name,
    sent,
    expected,
    missed,
    errors,
    ...(latest ? { latestError: { message: latest.message?.trim() || "(no message)", at: latest.at } } : {}),
    wrongFacts,
    unrecognizedWords,
    longestSilenceMinutes: silence,
    wentSilent,
    score,
    change,
    attention,
    lines,
  };
}

export interface WeeklyHealthReview {
  schemaVersion: typeof HEALTH_WEEKLY_SCHEMA;
  window: HealthWindow;
  topLine: string;
  likelyCheckFault: boolean;
  parts: HealthPartWeek[];
  lines: string[];
}

/** Pure: the top line and the whole review from each part's week. */
export function buildWeeklyReview(window: HealthWindow, parts: HealthPartWeek[]): WeeklyHealthReview {
  const needing = attentionParts(parts.map((p) => ({ name: p.name, attention: p.attention })));
  const silent = parts.filter((p) => p.wentSilent).map((p) => p.name);
  const fault = likelyCheckFault(silent.length);
  const topLine =
    `Parts needing attention: ${needing.length ? needing.join(", ") : "none"}` +
    (fault ? `. Likely health-check fault: ${silent.length} parts went silent (${silent.join(", ")})` : "");
  const lines = [topLine, ...parts.flatMap((p) => [`${p.name}:`, ...p.lines.map((l) => `  ${l}`)])];
  return { schemaVersion: HEALTH_WEEKLY_SCHEMA, window, topLine, likelyCheckFault: fault, parts, lines };
}

export function weeklyReviewKey(window: HealthWindow): string {
  return `${HEALTH_WEEKLY_PREFIX}${window.to.slice(0, 10)}.json`;
}

/** The most recent stored review before `key`, or undefined (then every part is "first week"). */
async function previousReview(store: Pick<HealthCheckinStore, "get" | "list">, key: string): Promise<WeeklyHealthReview | undefined> {
  const prior = (await store.list(HEALTH_WEEKLY_PREFIX)).filter((k) => k < key).sort().at(-1);
  if (!prior) return undefined;
  try {
    return JSON.parse(new TextDecoder().decode((await store.get(prior)) ?? new Uint8Array())) as WeeklyHealthReview;
  } catch {
    return undefined;
  }
}

/** Weekly run: review every declared part over the last 7 days and store the report (once per day). */
export async function runWeeklyHealthReview(
  store: HealthCheckinStore,
  now: Date = new Date(),
  options: { force?: boolean } = {},
): Promise<{ status: "WRITTEN" | "ALREADY_WRITTEN"; key: string; review: WeeklyHealthReview }> {
  const window = weeklyWindow(now);
  const key = weeklyReviewKey(window);
  const existing = await store.get(key);
  if (existing && !options.force) return { status: "ALREADY_WRITTEN", key, review: JSON.parse(new TextDecoder().decode(existing)) as WeeklyHealthReview };
  const previous = await previousReview(store, key);
  const parts: HealthPartWeek[] = [];
  for (const part of HEALTH_PARTS) {
    const checkins = await listHealthCheckins(store, part.id, window.from, window.to);
    const prior = previous?.parts?.find((p) => p.part === part.id)?.score;
    parts.push(reviewPart({ part, checkins, window, ...(typeof prior === "number" ? { previousScore: prior } : {}) }));
  }
  const review = buildWeeklyReview(window, parts);
  await writeVerifiedHealthJson(store, key, review);
  return { status: "WRITTEN", key, review };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runWeeklyHealthReview(R2ObjectClient.fromEnv(process.env), new Date(), { force: process.env.HEALTH_WEEKLY_FORCE === "true" })
    .then(({ status, key, review }) => {
      process.stdout.write(`weekly health review: ${status} ${key}\n`);
      for (const line of review.lines) process.stdout.write(`${line}\n`);
    })
    .catch((error: unknown) => {
      process.stdout.write(`HEALTH_WEEKLY_FAILED:${redactHealthMessage(errorMessage(error))?.slice(0, 120) ?? ""}\n`);
      process.exitCode = 1;
    });
}
