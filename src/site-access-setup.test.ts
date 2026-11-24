import assert from "node:assert/strict";
import test from "node:test";
import { SITE_ACCESS_APP_NAME, SITE_ACCESS_POLICY_NAME, setupSiteAccess } from "./site-access-setup";

const EMAIL = "owner@example.test";
const HOST = "stocks.example.test";

/** In-memory stand-in for the Cloudflare Access API (account-level apps, reusable policies, org). */
function fakeCloudflare(
  options: { extraAppPolicy?: boolean | "first" | "second"; policyReadBack?: (stored: Record<string, unknown>) => Record<string, unknown>; failPolicyPost?: string } = {},
) {
  const apps = new Map<string, Record<string, unknown>>();
  const policies = new Map<string, Record<string, unknown>>();
  const calls: string[] = [];
  let next = 1;
  // extraAppPolicy: a stray app-level policy stays on the app next to ours, first (true/"first") or second.
  const keep = (body: Record<string, unknown>) => {
    if (!options.extraAppPolicy) return {};
    const ours = (body.policies as unknown[]) ?? [];
    const stray = { id: "legacy-app-policy" };
    return { policies: options.extraAppPolicy === "second" ? [...ours, stray] : [stray, ...ours] };
  };
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
      if (method === "GET" && options.policyReadBack) return ok(options.policyReadBack(policies.get(id)!));
      return ok(policies.get(id));
    }
    if (path === "/apps" && method === "GET") return ok([...apps.values()]);
    if (path === "/apps" && method === "POST") {
      const id = `app-${next++}`;
      const kept = keep(body);
      apps.set(id, { ...body, id, aud: `aud-${id}`, ...kept });
      return ok(apps.get(id));
    }
    const appMatch = /^\/apps\/(.+)$/u.exec(path);
    if (appMatch) {
      const id = appMatch[1]!;
      if (method === "PUT") {
        const kept = keep(body);
        apps.set(id, { ...apps.get(id), ...body, id, ...kept });
      }
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

test("access setup: an app that kept another policy next to ours is rejected on read-back (fail closed)", async () => {
  for (const position of ["first", "second"] as const) {
    const cf = fakeCloudflare({ extraAppPolicy: position });
    await assert.rejects(setupSiteAccess(input(cf.fetchImpl)), /expected exactly 1 policy, found 2/u, position);
    const app = [...cf.apps.values()][0]!;
    const ids = (app.policies as Array<{ id: string }>).map((p) => p.id);
    assert.equal(ids.length, 2);
    assert.equal(ids.indexOf("legacy-app-policy"), position === "first" ? 0 : 1, "stray policy is where the case says");
  }
});

test("access setup: the policy read-back must be exactly one allow rule for the one email", async () => {
  const drifts: Array<[string, (p: Record<string, unknown>) => Record<string, unknown>]> = [
    ["extra include rule", (p) => ({ ...p, include: [...(p.include as unknown[]), { everyone: {} }] })],
    ["include replaced by everyone", (p) => ({ ...p, include: [{ everyone: {} }] })],
    ["email domain rule", (p) => ({ ...p, include: [{ email_domain: { domain: "example.test" } }] })],
    ["lookalike email", (p) => ({ ...p, include: [{ email: { email: `x${EMAIL}` } }] })],
    ["email plus a second key", (p) => ({ ...p, include: [{ email: { email: EMAIL }, everyone: {} }] })],
    ["decision bypass", (p) => ({ ...p, decision: "bypass" })],
    ["non-empty exclude", (p) => ({ ...p, exclude: [{ email: { email: "x@example.test" } }] })],
    ["non-empty require", (p) => ({ ...p, require: [{ email: { email: EMAIL } }] })],
    ["no include", (p) => ({ ...p, include: [] })],
  ];
  for (const [label, drift] of drifts) {
    const cf = fakeCloudflare({ policyReadBack: drift });
    await assert.rejects(setupSiteAccess(input(cf.fetchImpl)), /Access policy read-back: not exactly one allowed email/u, label);
  }
  const same = fakeCloudflare({ policyReadBack: (p) => ({ ...p }) });
  assert.equal((await setupSiteAccess(input(same.fetchImpl))).created.policy, true);
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

test("access setup: a retry after a failed deploy reuses the app and policy the earlier run created", async () => {
  const cf = fakeCloudflare();
  // State left by a prior partial run (e.g. 45357759855: Access step succeeded, Worker deploy failed),
  // plus drift since: the policy's rule changed and the app gained a second policy.
  cf.policies.set("pol-prior", {
    id: "pol-prior",
    name: SITE_ACCESS_POLICY_NAME,
    decision: "allow",
    include: [{ email: { email: "old@example.test" } }, { everyone: {} }],
    exclude: [],
    require: [],
  });
  cf.policies.set("pol-unrelated", { id: "pol-unrelated", name: "Some other app", decision: "allow", include: [{ everyone: {} }] });
  cf.apps.set("app-prior", {
    id: "app-prior",
    name: SITE_ACCESS_APP_NAME,
    type: "self_hosted",
    domain: HOST,
    aud: "aud-prior",
    policies: [{ id: "pol-prior" }, { id: "pol-unrelated" }],
  });
  cf.apps.set("app-other", { id: "app-other", name: "Other", type: "self_hosted", domain: "other.example.test", aud: "aud-other", policies: [] });

  const result = await setupSiteAccess(input(cf.fetchImpl));
  assert.deepEqual(result, {
    appId: "app-prior",
    policyId: "pol-prior",
    aud: "aud-prior",
    teamDomain: "https://example-team.cloudflareaccess.com",
    created: { app: false, policy: false },
  });
  assert.ok(!cf.calls.some((c) => c.startsWith("POST ")), `no create calls: ${cf.calls.join(", ")}`);
  assert.ok(cf.calls.includes("PUT /policies/pol-prior") && cf.calls.includes("PUT /apps/app-prior"));
  assert.equal(cf.apps.size, 2);
  assert.equal(cf.policies.size, 2);
  assert.deepEqual(cf.policies.get("pol-prior")!.include, [{ email: { email: EMAIL } }], "policy updated to the single email");
  assert.deepEqual(cf.apps.get("app-prior")!.policies, [{ id: "pol-prior", precedence: 1 }], "app back to exactly our policy");
  assert.deepEqual(cf.apps.get("app-other")!.policies, [], "other apps untouched");
  assert.deepEqual(cf.policies.get("pol-unrelated")!.include, [{ everyone: {} }], "other policies untouched");
  // And a second retry is a no-op in shape: same ids, still nothing created.
  const again = await setupSiteAccess(input(cf.fetchImpl));
  assert.equal(again.appId, "app-prior");
  assert.equal(again.aud, "aud-prior");
  assert.ok(!cf.calls.some((c) => c.startsWith("POST ")));
});

test("access setup: the app is found by hostname only; a same-named app on another hostname is never chosen", async () => {
  // Only a same-named app elsewhere: ours must be created, the other left alone.
  const elsewhere = { id: "app-elsewhere", name: SITE_ACCESS_APP_NAME, type: "self_hosted", domain: "other.example.test", aud: "aud-elsewhere", policies: [{ id: "pol-x" }] };
  const lone = fakeCloudflare();
  lone.apps.set("app-elsewhere", structuredClone(elsewhere));
  const created = await setupSiteAccess(input(lone.fetchImpl));
  assert.deepEqual(created.created, { app: true, policy: true });
  assert.notEqual(created.appId, "app-elsewhere");
  assert.ok(lone.calls.includes("POST /apps"), lone.calls.join(", "));
  assert.ok(!lone.calls.some((c) => c.startsWith("PUT /apps")), lone.calls.join(", "));
  assert.deepEqual(lone.apps.get("app-elsewhere"), elsewhere);
  assert.equal(lone.apps.size, 2);

  // Ours on the hostname (under an old name) plus the same-named app elsewhere: ours is updated.
  const both = fakeCloudflare();
  both.apps.set("app-elsewhere", structuredClone(elsewhere));
  both.apps.set("app-ours", { id: "app-ours", name: "renamed earlier", type: "self_hosted", domain: HOST, aud: "aud-ours", policies: [] });
  const updated = await setupSiteAccess(input(both.fetchImpl));
  assert.equal(updated.appId, "app-ours");
  assert.equal(updated.aud, "aud-ours");
  assert.equal(updated.created.app, false);
  assert.ok(!both.calls.includes("POST /apps"), both.calls.join(", "));
  assert.deepEqual(both.calls.filter((c) => c.startsWith("PUT /apps")), ["PUT /apps/app-ours"]);
  assert.equal(both.apps.get("app-ours")!.name, SITE_ACCESS_APP_NAME);
  assert.deepEqual(both.apps.get("app-elsewhere"), elsewhere);
});

test("access setup: the policy is found by name; an unrelated policy listed first is never overwritten", async () => {
  const unrelated = { id: "pol-unrelated", name: "Someone else's policy", decision: "allow", include: [{ everyone: {} }], exclude: [], require: [] };
  // Unrelated first and ours second: ours is updated, the unrelated one untouched.
  const both = fakeCloudflare();
  both.policies.set("pol-unrelated", structuredClone(unrelated));
  both.policies.set("pol-ours", { id: "pol-ours", name: SITE_ACCESS_POLICY_NAME, decision: "allow", include: [{ email: { email: "old@example.test" } }] });
  const updated = await setupSiteAccess(input(both.fetchImpl));
  assert.equal(updated.policyId, "pol-ours");
  assert.equal(updated.created.policy, false);
  assert.deepEqual(both.calls.filter((c) => c.startsWith("PUT /policies") || c === "POST /policies"), ["PUT /policies/pol-ours"]);
  assert.deepEqual(both.policies.get("pol-unrelated"), unrelated);
  assert.deepEqual(both.policies.get("pol-ours")!.include, [{ email: { email: EMAIL } }]);

  // Only the unrelated one: ours is created, the unrelated one untouched and not attached.
  const lone = fakeCloudflare();
  lone.policies.set("pol-unrelated", structuredClone(unrelated));
  const created = await setupSiteAccess(input(lone.fetchImpl));
  assert.equal(created.created.policy, true);
  assert.notEqual(created.policyId, "pol-unrelated");
  assert.ok(!lone.calls.some((c) => c.startsWith("PUT /policies")), lone.calls.join(", "));
  assert.deepEqual(lone.policies.get("pol-unrelated"), unrelated);
  assert.deepEqual(lone.apps.get(created.appId)!.policies, [{ id: created.policyId, precedence: 1 }]);
});
