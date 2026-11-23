import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { HEALTH_PARTS, writeHealthCheckin } from "./health-checkins";
import { MemoryObjectClient } from "./object-store";
import {
  HEALTH_WEEKLY_PREFIX,
  buildWeeklyReview,
  expectedCheckins,
  isWrongFact,
  longestSilenceMinutes,
  reviewPart,
  runWeeklyHealthReview,
  weeklyWindow,
} from "./health-weekly-review";

// Sunday 2026-10-25 21:30 UTC, after the 14:40 gap refill.
const NOW = new Date("2026-10-25T21:30:00Z");
const WINDOW = weeklyWindow(NOW);
const part = (id: string) => HEALTH_PARTS.find((p) => p.id === id)!;
const ci = (p: string, at: string, state = "OK", message?: string) => ({ part: p, state, at, ...(message ? { message } : {}) });

/** The scan's ten Tue-Sat slots in the window (05:30 + 09:30 UTC). */
const scanSlots = ["2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24"].flatMap((d) => [`${d}T05:31:00Z`, `${d}T09:31:00Z`]);

test("weekly: missed check-ins use the schedule each part declares (sent vs expected)", () => {
  assert.equal(expectedCheckins(part("scan").schedule, WINDOW), 10);
  assert.equal(expectedCheckins(part("tenmin-daily").schedule, WINDOW), 10);
  assert.equal(expectedCheckins(part("history-chain").schedule, WINDOW), 7);
  assert.equal(expectedCheckins(part("gap-refill").schedule, WINDOW), 1);
  assert.equal(expectedCheckins(part("backfill").schedule, WINDOW), 0);
  const week = reviewPart({ part: part("scan"), checkins: scanSlots.slice(0, 8).map((at) => ci("scan", at)), window: WINDOW });
  assert.deepEqual([week.sent, week.expected, week.missed], [8, 10, 2]);
  assert.equal(week.lines[0], "scan: sent 8 of 10 check-ins (2 missed)");
  assert.equal(week.attention, true);
});

test("weekly: errors are grouped by message with counts, plus the latest one", () => {
  const checkins = [
    ci("scan", scanSlots[0]!, "ERROR", "MASSIVE_HTTP_500"),
    ci("scan", scanSlots[1]!, "ERROR", "R2_PUT_503"),
    ci("scan", scanSlots[2]!, "ERROR", "MASSIVE_HTTP_500"),
    ...scanSlots.slice(3).map((at) => ci("scan", at)),
  ];
  const week = reviewPart({ part: part("scan"), checkins, window: WINDOW });
  assert.deepEqual(week.errors.map((e) => [e.message, e.count]), [["MASSIVE_HTTP_500", 2], ["R2_PUT_503", 1]]);
  assert.ok(week.lines.includes("errors: MASSIVE_HTTP_500: 2 time/s; R2_PUT_503: 1 time/s"));
  assert.deepEqual(week.latestError, { message: "MASSIVE_HTTP_500", at: scanSlots[2] });
});

test("weekly: wrong facts, unrecognized words (never against the part), longest silence", () => {
  const checkins = [
    ...scanSlots.map((at) => ci("scan", at)),
    ci("scan", "2026-10-25T23:59:00Z"), // later than the review: cannot be true
    ci("gap-refill", "2026-10-24T05:35:00Z"), // filed under scan but says another part
    ci("scan", "2026-10-24T05:40:00Z", "ERROR"), // an error with no message
    ci("scan", "2026-10-24T05:45:00Z", "GREENISH"),
  ];
  const week = reviewPart({ part: part("scan"), checkins, window: WINDOW });
  assert.equal(week.wrongFacts, 3);
  assert.deepEqual(week.unrecognizedWords, [{ word: "GREENISH", count: 1 }]);
  assert.equal(isWrongFact(ci("scan", "nonsense"), "scan", WINDOW.to), true);
  const words = reviewPart({ part: part("scan"), checkins: [...scanSlots.map((at) => ci("scan", at)), ci("scan", "2026-10-24T05:45:00Z", "GREENISH")], window: WINDOW });
  assert.equal(words.attention, false, "an unrecognized word alone never needs attention");
  assert.equal(words.score, 0);
  // Sat 09:31 -> Sun 21:30 is the longest gap in the scan's week.
  assert.equal(longestSilenceMinutes(scanSlots.map((at) => ci("scan", at)), WINDOW), 36 * 60 - 1);
  assert.ok(reviewPart({ part: part("scan"), checkins: scanSlots.map((at) => ci("scan", at)), window: WINDOW }).lines.includes("longest silence: 36.0 h"));
});

test("weekly: change from last week, 'first week' when there is no prior week", () => {
  const checkins = scanSlots.slice(0, 9).map((at) => ci("scan", at));
  assert.equal(reviewPart({ part: part("scan"), checkins, window: WINDOW }).change, "first week");
  assert.equal(reviewPart({ part: part("scan"), checkins, window: WINDOW, previousScore: 3 }).change, "better");
  assert.equal(reviewPart({ part: part("scan"), checkins, window: WINDOW, previousScore: 0 }).change, "worse");
  assert.equal(reviewPart({ part: part("scan"), checkins, window: WINDOW, previousScore: 1 }).change, "same");
});

test("weekly: the top line lists the parts needing attention and flags a likely health-check fault", () => {
  const quiet = HEALTH_PARTS.map((p) => reviewPart({ part: p, checkins: [], window: WINDOW }));
  const review = buildWeeklyReview(WINDOW, quiet);
  assert.equal(
    review.topLine,
    "Parts needing attention: scan, daily 10-minute step, history chain, gap refill. Likely health-check fault: 3 parts went silent (scan, daily 10-minute step, history chain)",
  );
  assert.equal(review.likelyCheckFault, true);
  const healthy = buildWeeklyReview(WINDOW, [reviewPart({ part: part("scan"), checkins: scanSlots.map((at) => ci("scan", at)), window: WINDOW })]);
  assert.equal(healthy.topLine, "Parts needing attention: none");
});

test("weekly run: reviewPart for every part from R2 check-ins, writes the report, next week compares with it", async () => {
  const store = new MemoryObjectClient();
  for (const at of scanSlots) await writeHealthCheckin(store, { part: "scan", state: "OK", at });
  await writeHealthCheckin(store, { part: "gap-refill", state: "ERROR", at: "2026-10-25T15:00:00Z", message: "GAP_REFILL_EXIT_2" });
  const first = await runWeeklyHealthReview(store, NOW);
  assert.equal(first.status, "WRITTEN");
  assert.equal(first.key, `${HEALTH_WEEKLY_PREFIX}2026-10-25.json`);
  assert.deepEqual(first.review.parts.map((p) => p.part), ["scan", "tenmin-daily", "history-chain", "backfill", "gap-refill"]);
  assert.ok(first.review.parts.every((p) => p.change === "first week"));
  const stored = JSON.parse(new TextDecoder().decode((await store.get(first.key))!)) as { topLine: string };
  assert.equal(stored.topLine, first.review.topLine);
  assert.ok((await store.head(first.key))!.metadata["health-checkin-sha256"], "written with the read-back check");
  assert.equal((await runWeeklyHealthReview(store, new Date("2026-10-25T22:00:00Z"))).status, "ALREADY_WRITTEN", "the backstop cron does nothing twice");
  const next = await runWeeklyHealthReview(store, new Date("2026-11-01T21:30:00Z"));
  assert.equal(next.review.parts.find((p) => p.part === "scan")!.change, "worse", "0 problems last week, 10 missed now");
  assert.equal(next.review.parts.find((p) => p.part === "gap-refill")!.change, "same");
});

test("weekly workflow: Sunday after the gap refill (workflow_run + backstop cron), R2 only", async () => {
  const yml = await readFile(new URL("../.github/workflows/health.yml", import.meta.url), "utf8");
  assert.match(yml, /workflow_run:\n    workflows: \["Daily-bars gap refill"\]\n    types: \[completed\]/u);
  assert.match(yml, /cron: "30 21 \* \* 0"/u);
  assert.match(yml, /github\.event\.workflow_run\.event == 'schedule'/u);
  assert.match(yml, /run: pnpm -s exec tsx src\/health-weekly-review\.ts/u);
  assert.ok(!/MASSIVE_API_KEY/u.test(yml));
  const refill = await readFile(new URL("../.github/workflows/gap-refill.yml", import.meta.url), "utf8");
  assert.match(refill, /^name: Daily-bars gap refill$/mu);
  assert.match(refill, /cron: "40 14 \* \* 0"/u);
});
