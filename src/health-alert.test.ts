import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { HEALTH_ALERT_TITLE, HEALTH_CHECK_DID_NOT_FINISH, healthAlertBody, runHealthAlert } from "./health-alert";
import { HEALTH_CHECK_LATEST_KEY, runHealthCheck } from "./health-check";
import { HEALTH_CHECKIN_PREFIX, pruneHealthCheckins, writeHealthCheckin } from "./health-checkins";
import { MemoryObjectClient } from "./object-store";

const ENV = { GITHUB_TOKEN: "FAKE-TOKEN", GITHUB_REPOSITORY: "owner/repo", GITHUB_RUN_ID: "1" };
const NOW = new Date("2026-11-23T19:40:00Z");

/** A fake GitHub issues API: keeps issues and comments in memory, records each call. */
function fakeGitHub(initial: { number: number; title: string; labels: string[] }[] = []) {
  const issues = initial.map((i) => ({ ...i, state: "open" as const }));
  const comments: { issue: number; body: string }[] = [];
  const calls: string[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const path = String(url).replace("https://api.github.com/repos/owner/repo", "");
    const method = init?.method ?? "GET";
    calls.push(`${method} ${path.split("?")[0]}`);
    const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
    if (method === "GET" && path.startsWith("/issues?")) {
      const label = new URL(`https://x${path}`).searchParams.get("labels");
      return json(issues.filter((i) => i.state === "open" && (!label || i.labels.includes(label))));
    }
    if (method === "POST" && path === "/issues") {
      const body = JSON.parse(String(init?.body)) as { title: string; labels: string[] };
      const number = 100 + issues.length;
      issues.push({ number, title: body.title, labels: body.labels, state: "open" });
      return json({ number });
    }
    const comment = /^\/issues\/(\d+)\/comments$/u.exec(path);
    if (method === "POST" && comment) {
      comments.push({ issue: Number(comment[1]), body: (JSON.parse(String(init?.body)) as { body: string }).body });
      return json({ id: comments.length });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  return { issues, comments, calls, fetchImpl };
}

const notOk = { headline: "needs attention: gap refill (error)", lines: ["needs attention: gap refill (error)", "errors: 1, missing: 0", "gap refill: error: GAP_REFILL_EXIT_2"] };

test("health alert: a non-OK result opens one issue, later runs comment on it (never a new issue per run)", async () => {
  const gh = fakeGitHub([{ number: 7, title: "Scanner stopped: STOP_ERROR", labels: ["scanner-alert"] }]);
  assert.equal(await runHealthAlert({ result: notOk, env: ENV, now: NOW, fetchImpl: gh.fetchImpl }), "opened #101");
  assert.equal(await runHealthAlert({ result: notOk, env: ENV, now: NOW, fetchImpl: gh.fetchImpl }), "commented on #101");
  assert.equal(await runHealthAlert({ result: undefined, env: ENV, now: NOW, fetchImpl: gh.fetchImpl }), "commented on #101");
  const health = gh.issues.filter((i) => i.title === HEALTH_ALERT_TITLE);
  assert.equal(health.length, 1, "one health issue across three non-OK runs");
  assert.deepEqual(health[0]!.labels, ["scanner-alert"]);
  assert.equal(gh.comments.filter((c) => c.issue === 7).length, 0, "another scanner-alert issue is never used");
  assert.match(gh.comments[1]!.body, new RegExp(HEALTH_CHECK_DID_NOT_FINISH, "u"));
});

test("health alert: Healthy does nothing (no GitHub call); the body carries the lines and the run", async () => {
  const gh = fakeGitHub();
  assert.equal(await runHealthAlert({ result: { headline: "Healthy", lines: ["Healthy"] }, env: ENV, now: NOW, fetchImpl: gh.fetchImpl }), "none: Healthy");
  assert.deepEqual(gh.calls, []);
  const body = healthAlertBody(notOk, "https://github.com/owner/repo/actions/runs/1", NOW)!;
  assert.match(body, /^\*\*needs attention: gap refill \(error\)\*\* \(Nov 23, 2026, 12:40 PM MST\)/u);
  assert.match(body, /- gap refill: error: GAP_REFILL_EXIT_2/u);
  assert.match(body, /Run: https:\/\/github\.com\/owner\/repo\/actions\/runs\/1$/u);
});

test("retention: check-ins older than one month are pruned on each health check; newer ones and other files stay", async () => {
  const store = new MemoryObjectClient();
  await writeHealthCheckin(store, { part: "scan", state: "OK", at: "2026-10-22T09:31:00.000Z" }); // 32 days old
  await writeHealthCheckin(store, { part: "scan", state: "OK", at: "2026-10-23T09:31:00.000Z" }); // 31 days old
  await writeHealthCheckin(store, { part: "scan", state: "OK", at: "2026-10-24T09:31:00.000Z" }); // 30 days old
  await writeHealthCheckin(store, { part: "gap-refill", state: "OK", at: "2026-11-22T15:00:00.000Z" });
  await store.put(`${HEALTH_CHECKIN_PREFIX}README.txt`, new TextEncoder().encode("not a check-in"));
  await store.put("permanent/health/weekly/2026-10-18.json", new TextEncoder().encode("{}"));
  const result = await runHealthCheck(store, NOW);
  assert.equal(result.prunedCheckins, 2);
  const left = await store.list(HEALTH_CHECKIN_PREFIX);
  assert.ok(left.every((k) => !k.includes("/2026-10-22/") && !k.includes("/2026-10-23/")));
  assert.ok(left.some((k) => k.includes("/2026-10-24/")));
  assert.ok(left.includes(`${HEALTH_CHECKIN_PREFIX}README.txt`), "only exact check-in keys are deleted");
  assert.ok(await store.get("permanent/health/weekly/2026-10-18.json"), "weekly reviews are not check-ins");
  const latest = JSON.parse(new TextDecoder().decode((await store.get(HEALTH_CHECK_LATEST_KEY))!)) as { prunedCheckins: number };
  assert.equal(latest.prunedCheckins, 2);
  assert.equal(await pruneHealthCheckins(store, NOW), 0, "nothing left to prune");
});

test("health workflow: the check job can open the issue and always runs the alert step, without R2 secrets", async () => {
  const yml = await readFile(new URL("../.github/workflows/health.yml", import.meta.url), "utf8");
  const check = yml.slice(yml.indexOf("  check:"), yml.indexOf("  weekly:"));
  assert.match(check, /permissions:\n {6}contents: read\n {6}issues: write/u);
  const alert = check.slice(check.indexOf("- name: Health alert (issue)"));
  assert.match(alert, /if: \$\{\{ always\(\) \}\}/u);
  assert.match(alert, /run: pnpm -s exec tsx src\/health-alert\.ts/u);
  assert.ok(!/R2_/u.test(alert), "the alert step gets no R2 secrets");
});
