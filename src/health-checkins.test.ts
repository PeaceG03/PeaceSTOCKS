import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { MemoryObjectClient } from "./object-store";
import {
  HEALTH_CHECKIN_PREFIX,
  HEALTH_PARTS,
  latestHealthCheckin,
  listHealthCheckins,
  redactHealthMessage,
  reportPart,
  writeHealthCheckin,
} from "./health-checkins";

test("check-in: written once per run under its part and day, read back by size and checksum", async () => {
  const store = new MemoryObjectClient();
  const { key, checkin } = await writeHealthCheckin(store, { part: "scan", state: "OK", at: "2026-10-27T05:31:00.000Z", runId: "123" }, "n1");
  assert.equal(key, `${HEALTH_CHECKIN_PREFIX}scan/2026-10-27/20261027053100000-123-n1.json`);
  assert.equal(checkin.state, "OK");
  assert.ok((await store.head(key))!.metadata["health-checkin-sha256"]);
  await writeHealthCheckin(store, { part: "scan", state: "ERROR", at: "2026-10-28T05:31:00.000Z", message: "MASSIVE_HTTP_500" }, "n2");
  await store.put(`${HEALTH_CHECKIN_PREFIX}scan/2026-10-29/x.json`, new TextEncoder().encode("{not json"));
  const week = await listHealthCheckins(store, "scan", "2026-10-27T00:00:00.000Z", "2026-10-29T23:59:59.999Z");
  assert.deepEqual(week.map((c) => c.state), ["OK", "ERROR", "UNREADABLE"]);
  assert.equal((await latestHealthCheckin(store, "scan"))!.state, "UNREADABLE");
  assert.equal(await latestHealthCheckin(store, "gap-refill"), undefined);
});

test("check-in: no key, token, signature, or query string ever reaches a stored message", async () => {
  // Plainly fake values (no real credential format), one per kind the redactor removes.
  const opaque = `FAKEOPAQUE${"0".repeat(30)}`;
  const raw = `MASSIVE_HTTP_403 https://api.example.invalid/v2/aggs/ticker/AAA?apiKey=FAKE-QUERY-KEY Bearer FAKE-BEARER token=FAKE-TOKEN ${opaque}`;
  const safe = redactHealthMessage(raw)!;
  for (const secret of ["FAKE-QUERY-KEY", "FAKE-BEARER", "FAKE-TOKEN", opaque]) assert.ok(!safe.includes(secret), secret);
  assert.match(safe, /^MASSIVE_HTTP_403 /u);
  assert.ok(redactHealthMessage("x".repeat(500))!.length <= 200);
  const store = new MemoryObjectClient();
  const { key } = await writeHealthCheckin(store, { part: "gap-refill", state: "ERROR", at: "2026-10-27T15:00:00.000Z", message: raw });
  assert.ok(!new TextDecoder().decode((await store.get(key))!).includes("FAKE-TOKEN"));
});

test("reportPart: writes on Actions (R2 set), skips locally, and never throws", async () => {
  const lines: string[] = [];
  const store = new MemoryObjectClient();
  const now = () => new Date("2026-10-27T06:21:00.000Z");
  assert.equal(await reportPart({}, "tenmin-daily", "OK", undefined, { log: (l) => lines.push(l) }), "SKIPPED_NO_STORE");
  assert.equal(await reportPart({ PEACESTOCKS_R2_BUCKET: "b" }, "tenmin-daily", "OK", "RAN", { openStore: () => store, now, log: (l) => lines.push(l) }), "WRITTEN");
  assert.deepEqual(lines, ["CHECKIN|tenmin-daily|OK|RAN"]);
  assert.equal((await latestHealthCheckin(store, "tenmin-daily"))!.at, "2026-10-27T06:21:00.000Z");
  const broken = { ...store, put: async () => { throw new Error("R2_PUT_500"); }, get: store.get.bind(store), head: store.head.bind(store), list: store.list.bind(store) };
  assert.equal(await reportPart({ PEACESTOCKS_R2_BUCKET: "b" }, "scan", "ERROR", "x", { openStore: () => broken, log: (l) => lines.push(l) }), "FAILED");
  assert.match(lines.at(-1)!, /^HEALTH_CHECKIN_FAILED:scan:R2_PUT_500/u);
});

test("parts: the five real parts each declare a schedule", () => {
  assert.deepEqual(HEALTH_PARTS.map((p) => p.id), ["scan", "tenmin-daily", "history-chain", "backfill", "gap-refill"]);
  for (const p of HEALTH_PARTS) assert.ok(Array.isArray(p.schedule.utcDays) && p.schedule.perDay >= 0, p.id);
  assert.equal(HEALTH_PARTS.find((p) => p.id === "backfill")!.allowedSilenceMinutes, undefined, "manual only: never silent");
});

test("wiring: scan, daily 10-minute step, history chain, backfill and gap refill report in on success and on failure", async () => {
  const src = async (file: string) => readFile(new URL(`./${file}`, import.meta.url), "utf8");
  const host = await src("host.ts");
  for (const part of ["scan", "history-chain"]) {
    assert.ok(new RegExp(`reportPart\\(process\\.env, "${part}", "ERROR"`, "u").test(host), `${part} on a thrown error`);
    assert.ok(new RegExp(`reportPart\\(\\s*process\\.env,\\s*"${part}",\\s*[^;]*?\\? "ERROR" : "OK"`, "u").test(host), `${part} on a finished run`);
  }
  const daily = await src("tenmin-daily-liquid.ts");
  assert.match(daily, /reportPart\(process\.env, "tenmin-daily", isScanCheckFailure\(yielded\) \? "ERROR" : "OK"/u);
  assert.match(daily, /reportPart\(process\.env, "tenmin-daily", "ERROR", errorMessage\(error\)\)/u);
  const backfill = await src("backfill.ts");
  assert.match(backfill, /reportPart\(process\.env, "backfill", "ERROR", errorMessage\(error\)\)/u);
  assert.match(backfill, /reportPart\(process\.env, "backfill", result\.stoppedOnError \? "ERROR" : "OK"/u);
  const refill = await src("gap-refill.ts");
  // Both outcomes (success and thrown failure) go through refillCheckin (tested in gap-refill.health-checkin.test.ts).
  assert.match(refill, /await checkIn\(\{ code: c/u);
  assert.match(refill, /await checkIn\(\{ fail: why \}\)/u);
  assert.match(refill, /reportPart\(process\.env, "gap-refill", c\.state, c\.message/u);
});
