// Stall rule (Peace, Nov 23): a backlog that does not shrink between consecutive capped runs needs a person.
import assert from "node:assert/strict";
import test from "node:test";
import { runHealthAlert } from "./health-alert";
import { runHealthCheck } from "./health-check";
import { writeHealthCheckin } from "./health-checkins";
import { MemoryObjectClient } from "./object-store";

const NOW = new Date("2026-11-25T13:40:00Z");
const ENV = { GITHUB_TOKEN: "FAKE-TOKEN", GITHUB_REPOSITORY: "owner/repo", GITHUB_RUN_ID: "1" };

async function capped(store: MemoryObjectClient, at: string, remaining: number) {
  await writeHealthCheckin(store, { part: "scan", state: "BEHIND", at, message: `CATCH_UP_COMPLETED:BACKLOG_REMAINS remaining=${remaining}`, remaining });
}

/** A fake GitHub issues API: records calls and issues. */
function fakeGitHub() {
  const issues: { number: number; title: string; labels: string[] }[] = [];
  const calls: string[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push(method);
    if (method === "GET") return new Response(JSON.stringify(issues.map((i) => ({ ...i, labels: i.labels.map((name) => ({ name })) }))));
    if (String(url).endsWith("/issues")) {
      const body = JSON.parse(String(init?.body)) as { title: string; labels: string[] };
      issues.push({ number: 200 + issues.length, title: body.title, labels: body.labels });
      return new Response(JSON.stringify({ number: issues.at(-1)!.number }));
    }
    return new Response(JSON.stringify({ id: 1 }));
  }) as typeof fetch;
  return { issues, calls, fetchImpl };
}

test("stall: the remaining count did not shrink between two capped runs -> needs attention, the issue opens", async () => {
  const store = new MemoryObjectClient();
  await capped(store, "2026-11-25T05:40:00.000Z", 12);
  await capped(store, "2026-11-25T09:40:00.000Z", 12);
  const run = await runHealthCheck(store, NOW);
  const scan = run.parts.find((p) => p.name === "scan")!;
  assert.equal(scan.status, "behind");
  assert.equal(scan.stalled, true);
  assert.equal(run.attention, true);
  assert.match(run.headline, /^needs attention: .*scan \(behind, not shrinking\)/u);
  assert.ok(run.lines.includes("scan: behind and not shrinking, 12 remaining (was 12 on the previous capped run) (CATCH_UP_COMPLETED:BACKLOG_REMAINS remaining=12)"));
  const gh = fakeGitHub();
  assert.match(await runHealthAlert({ result: run, env: ENV, now: NOW, fetchImpl: gh.fetchImpl }), /^opened #/u);
});

test("stall: a growing backlog also stalls; a shrinking one is only behind (no issue)", async () => {
  const grows = new MemoryObjectClient();
  await capped(grows, "2026-11-25T05:40:00.000Z", 12);
  await capped(grows, "2026-11-25T09:40:00.000Z", 13);
  assert.equal((await runHealthCheck(grows, NOW)).parts.find((p) => p.name === "scan")!.stalled, true);
  const shrinks = new MemoryObjectClient();
  await capped(shrinks, "2026-11-25T05:40:00.000Z", 12);
  await capped(shrinks, "2026-11-25T09:40:00.000Z", 9);
  const run = await runHealthCheck(shrinks, NOW);
  const scan = run.parts.find((p) => p.name === "scan")!;
  assert.equal(scan.status, "behind");
  assert.equal(scan.stalled, undefined);
  assert.ok(!run.headline.includes("scan (behind, not shrinking)"));
});

test("stall: only consecutive capped runs count (an OK run in between resets it)", async () => {
  const store = new MemoryObjectClient();
  await capped(store, "2026-11-24T05:40:00.000Z", 12);
  await writeHealthCheckin(store, { part: "scan", state: "OK", at: "2026-11-24T09:40:00.000Z", message: "COMPLETED:NO_MISSED_SESSION" });
  await capped(store, "2026-11-25T09:40:00.000Z", 12);
  assert.equal((await runHealthCheck(store, NOW)).parts.find((p) => p.name === "scan")!.stalled, undefined);
});
