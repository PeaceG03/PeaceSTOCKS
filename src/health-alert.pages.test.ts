// The open health issue is found on any page of open scanner-alert issues (Auditor, early review d).
import assert from "node:assert/strict";
import test from "node:test";
import { HEALTH_ALERT_TITLE, runHealthAlert } from "./health-alert";

test("health alert: the open health issue on page 2 of open scanner-alert issues gets the comment (no duplicate)", async () => {
  const issues = [
    ...Array.from({ length: 150 }, (_, i) => ({ number: 1 + i, title: `Scanner stopped: STOP_ERROR ${i}`, labels: [{ name: "scanner-alert" }] })),
    { number: 151, title: HEALTH_ALERT_TITLE, labels: [{ name: "scanner-alert" }] },
  ];
  const calls: string[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    const method = init?.method ?? "GET";
    calls.push(`${method} ${u.pathname.replace("/repos/owner/repo", "")}`);
    if (method === "GET") {
      const page = Number(u.searchParams.get("page") ?? "1");
      const per = Number(u.searchParams.get("per_page") ?? "30");
      return new Response(JSON.stringify(issues.slice((page - 1) * per, page * per)));
    }
    return new Response(JSON.stringify({ id: 1, number: 999 }));
  }) as typeof fetch;
  const result = { headline: "needs attention: scan (error)", lines: ["needs attention: scan (error)", "scan: error: X"] };
  const out = await runHealthAlert({ result, env: { GITHUB_TOKEN: "FAKE-TOKEN", GITHUB_REPOSITORY: "owner/repo", GITHUB_RUN_ID: "1" }, now: new Date("2026-11-24T01:00:00Z"), fetchImpl });
  assert.equal(out, "commented on #151");
  assert.ok(!calls.includes("POST /issues"), "no new issue");
});
