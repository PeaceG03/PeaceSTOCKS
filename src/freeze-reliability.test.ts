import assert from "node:assert/strict";
import test from "node:test";
import type { PredictionStatus } from "./contracts";
import { judgedSessions, onTimeShare, runFreezeWatch, type SessionFreeze } from "./freeze-watch";
import { MemoryObjectClient } from "./object-store";
import { FREEZE_RELIABILITY_KEY, type FreezeReliability } from "./scan-health";
import { loadSiteData } from "./site-data";
import { freezeShareBlock, renderSitePage } from "./site-page";

const o = (outcome: SessionFreeze["outcome"], i = 0): SessionFreeze => ({ sessionDate: `d${i}`, nextSessionOpen: "x", outcome });

test("on-time share: newest N sessions only; late, unavailable and no-record all count against it", () => {
  const outcomes = [
    ...Array.from({ length: 15 }, (_, i) => o("ON_TIME", i)),
    o("LATE", 15),
    o("UNAVAILABLE", 16),
    o("NO_RECORD", 17),
    o("ON_TIME", 18),
    o("ON_TIME", 19),
    // 21st and older: outside the 20 window
    ...Array.from({ length: 40 }, (_, i) => o("UNAVAILABLE", 20 + i)),
    o("ON_TIME", 99), // 61st: outside the 60 window too
  ];
  assert.deepEqual(onTimeShare(outcomes, 20), { sessions: 20, onTime: 17, late: 1, unavailable: 1, noRecord: 1, share: 17 / 20 });
  assert.deepEqual(onTimeShare(outcomes, 60), { sessions: 60, onTime: 17, late: 1, unavailable: 41, noRecord: 1, share: 17 / 60 });
  assert.deepEqual(onTimeShare([], 20), { sessions: 0, onTime: 0, late: 0, unavailable: 0, noRecord: 0, share: null });
  assert.equal(onTimeShare([o("ON_TIME")], 20).share, 1);
});

const frozen = (sessionDate: string, predictedAt: string): PredictionStatus => ({
  predictionStatusId: `prediction-status_x_${sessionDate}`,
  sessionDate,
  status: "FROZEN",
  reason: "PREDICTIONS_FROZEN",
  scannerVersion: "v",
  configFingerprint: "f",
  recordedAt: `${sessionDate}T23:59:59.999Z`,
  predictedAt,
  supersedesPredictionIds: [],
});

test("freeze watch writes the 20/60 reliability record from prediction statuses, even when the alert fails", async () => {
  const now = new Date("2026-11-24T16:00:00.000Z");
  const sessions = judgedSessions(now, 60);
  assert.equal(sessions.length, 60);
  assert.equal(sessions[0]!.sessionDate, "2026-11-23");
  const client = new MemoryObjectClient();
  // Newest 2 sessions frozen before their next open; one frozen after it; the rest have no record.
  for (const s of sessions.slice(0, 2))
    await client.put(`permanent/prediction-status/${s.sessionDate}.jsonl`, new TextEncoder().encode(JSON.stringify(frozen(s.sessionDate, new Date(s.nextSessionOpen.getTime() - 60_000).toISOString())) + "\n"));
  const lateOne = sessions[2]!;
  await client.put(`permanent/prediction-status/${lateOne.sessionDate}.jsonl`, new TextEncoder().encode(JSON.stringify(frozen(lateOne.sessionDate, lateOne.nextSessionOpen.toISOString())) + "\n"));
  const failingAlert = async () => {
    throw new Error("HEALTH_ALERT_GITHUB_500:POST");
  };
  await assert.rejects(runFreezeWatch({ store: client, env: {}, now, alert: failingAlert as never }), /HEALTH_ALERT_GITHUB_500/u);
  const bytes = await client.get(FREEZE_RELIABILITY_KEY);
  assert.ok(bytes);
  const r = JSON.parse(new TextDecoder().decode(bytes)) as FreezeReliability;
  assert.equal(r.through, "2026-11-23");
  assert.deepEqual(r.last20, { sessions: 20, onTime: 2, late: 1, unavailable: 0, noRecord: 17, share: 0.1 });
  assert.deepEqual(r.last60, { sessions: 60, onTime: 2, late: 1, unavailable: 0, noRecord: 57, share: 2 / 60 });
  assert.ok(await client.head(FREEZE_RELIABILITY_KEY));
  // Shown on the site.
  const html = renderSitePage(await loadSiteData(client));
  const health = html.slice(html.indexOf("<h2>Health</h2>"), html.indexOf("<h2>Catch-up</h2>"));
  assert.match(health, /Picks frozen before the next open, sessions through 2026-11-23/u);
  assert.match(health, /class="bad">Last 20 sessions: 2 of 20 on time \(10%\)<\/span> <span class="mute">1 late, 17 with no record/u);
  assert.match(health, /Last 60 sessions: 2 of 60 on time \(3%\)/u);
});

test("site: on-time share colours and the empty state", () => {
  const s = (onTime: number, sessions = 20) => ({ sessions, onTime, late: sessions - onTime, unavailable: 0, noRecord: 0, share: onTime / sessions });
  assert.match(freezeShareBlock({ at: "", last20: s(19), last60: s(57, 60) }), /class="ok">Last 20 sessions: 19 of 20 on time \(95%\)/u);
  assert.match(freezeShareBlock({ at: "", last20: s(18), last60: s(57, 60) }), /class="warn">Last 20 sessions: 18 of 20 on time \(90%\)/u);
  assert.match(freezeShareBlock({ at: "", last20: s(15), last60: s(48, 60) }), /class="bad">Last 20 sessions: 15 of 20/u);
  assert.match(freezeShareBlock(undefined), /No freeze on-time record has been saved yet\./u);
  // Stored numbers are re-derived, not trusted: a bogus share is recomputed from the counts.
  assert.match(freezeShareBlock({ at: "", last20: { ...s(10), share: 1 }, last60: s(10, 60) }), /10 of 20 on time \(50%\)/u);
});
