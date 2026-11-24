import assert from "node:assert/strict";
import test from "node:test";
import { SITE_ACCESS_APP_NAME, SITE_ACCESS_POLICY_NAME, setupSiteAccess } from "./site-access-setup";

const EMAIL = "owner@example.test";
const HOST = "stocks.example.test";

/** In-memory stand-in for the Cloudflare Access API (account-level apps, reusable policies, org). */
function fakeCloudflare(options: { ignoreAppPolicies?: boolean; failPolicyPost?: string } = {}) {
  const apps = new Map<string, Record<string, unknown>>();
  const policies = new Map<string, Record<string, unknown>>();
  const calls: string[] = [];
  let next = 1;
  const ok = (result: unknown, status = 200) => Response.json({ success: true, errors: [], result, result_info: { page: 1, total_pages: 1 } }, { status });
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-token");
    const path = url.pathname.replace("/client/v4/accounts/acct/access", "");
    calls.push(`${method} ${path}`);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (path === "/policies" && method === "GET") return ok([...policies.values()]);
    if (path === "/policies" && method === "POST") {
      if (options.failPolicyPost) return Response.json({ success: false, errors: [{ code: 12130, message: options.failPolicyPost }] }, { status: 400 });
      const id = `pol-${next++}`;
      policies.set(id, { ...body, id });
      return ok(policies.get(id));
    }
    const policyMatch = /^\/policies\/(.+)$/u.exec(path);
    if (policyMatch) {
      const id = policyMatch[1]!;
      if (method === "PUT") policies.set(id, { ...body, id });
      return ok(policies.get(id));
    }
    if (path === "/apps" && method === "GET") return ok([...apps.values()]);
    if (path === "/apps" && method === "POST") {
      const id = `app-${next++}`;
      apps.set(id, { ...body, id, aud: `aud-${id}`, ...(options.ignoreAppPolicies ? { policies: [] } : {}) });
      return ok(apps.get(id));
    }
    const appMatch = /^\/apps\/(.+)$/u.exec(path);
    if (appMatch) {
      const id = appMatch[1]!;
      if (method === "PUT") apps.set(id, { ...apps.get(id), ...body, id, ...(options.ignoreAppPolicies ? { policies: apps.get(id)?.policies } : {}) });
      return ok(apps.get(id));
    }
    return Response.json({ success: false, errors: [{ code: 7003, message: "no route" }] }, { status: 404 });
  }) as typeof fetch;
  return { apps, policies, calls, fetchImpl };
}

const input = (fetchImpl: typeof fetch, over: Record<string, unknown> = {}) => ({
  apiToken: "test-token",
  accountId: "acct",
  hostname: HOST,
  allowedEmail: EMAIL,
  teamDomain: "example-team.cloudflareaccess.com",
  fetchImpl,
  ...over,
});

test("access setup: creates one app with one single-email policy, then is idempotent", async () => {
  const cf = fakeCloudflare();
  const first = await setupSiteAccess(input(cf.fetchImpl));
  assert.deepEqual(first.created, { app: true, policy: true });
  assert.equal(first.teamDomain, "https://example-team.cloudflareaccess.com");
  assert.equal(first.aud, `aud-${first.appId}`);
  const policy = cf.policies.get(first.policyId)!;
  assert.equal(policy.name, SITE_ACCESS_POLICY_NAME);
  assert.deepEqual(policy.include, [{ email: { email: EMAIL } }]);
  const app = cf.apps.get(first.appId)!;
  assert.equal(app.name, SITE_ACCESS_APP_NAME);
  assert.equal(app.domain, HOST);
  assert.deepEqual(app.policies, [{ id: first.policyId, precedence: 1 }]);
  const second = await setupSiteAccess(input(cf.fetchImpl, { teamDomain: "example-team.cloudflareaccess.com", allowedEmail: " Owner@Example.test " }));
  assert.deepEqual(second.created, { app: false, policy: false });
  assert.equal(second.appId, first.appId);
  assert.equal(second.aud, first.aud);
  assert.equal(cf.apps.size, 1);
  assert.equal(cf.policies.size, 1);
  assert.ok(!cf.calls.some((c) => c.includes("/organizations")), "team domain is never looked up");
  assert.ok(!cf.calls.slice(cf.calls.lastIndexOf("GET /policies")).includes("POST /apps"));
});

test("access setup: an existing app that kept extra policies is rejected on read-back (fail closed)", async () => {
  const cf = fakeCloudflare({ ignoreAppPolicies: true });
  await assert.rejects(setupSiteAccess(input(cf.fetchImpl)), /expected exactly 1 policy, found 0/u);
});

test("access setup: refuses bad input before any API call, and never prints the email", async () => {
  const cf = fakeCloudflare();
  for (const allowedEmail of ["", "a@example.test,b@example.test", "a@example.test b@example.test", "not-an-email"]) {
    await assert.rejects(setupSiteAccess(input(cf.fetchImpl, { allowedEmail })), /allowed email missing or not exactly one address/u);
  }
  await assert.rejects(setupSiteAccess(input(cf.fetchImpl, { hostname: "https://x" })), /hostname/u);
  await assert.rejects(setupSiteAccess(input(cf.fetchImpl, { apiToken: "" })), /CLOUDFLARE_API_TOKEN missing/u);
  await assert.rejects(setupSiteAccess(input(cf.fetchImpl, { teamDomain: "evil.example.com" })), /team domain/u);
  assert.equal(cf.calls.length, 0);
  const echo = fakeCloudflare({ failPolicyPost: `bad rule for ${EMAIL}` });
  await assert.rejects(setupSiteAccess(input(echo.fetchImpl)), (error: Error) => {
    assert.match(error.message, /ACCESS_API_400:POST \/policies: 12130 bad rule for \[email\]/u);
    assert.ok(!error.message.includes(EMAIL));
    return true;
  });
  const quiet = fakeCloudflare();
  for (const teamDomain of [undefined, "", "   "]) {
    await assert.rejects(setupSiteAccess(input(quiet.fetchImpl, { teamDomain })), /team domain missing/u);
  }
  assert.deepEqual(quiet.calls, []);
});
