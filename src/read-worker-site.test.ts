import assert from "node:assert/strict";
import { createSign, generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { clearAccessCertCache } from "./access-jwt";
import worker, { createSiteWorker } from "./read-worker";
import { MemoryObjectClient } from "./object-store";

const TEAM = "https://example-team.cloudflareaccess.com";
const AUD = "aud-tag-123";
const EMAIL = "owner@example.test";
const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...pair.publicKey.export({ format: "jwk" }), kid: "k1" };

function token(email = EMAIL): string {
  const b64u = (v: string) => Buffer.from(v).toString("base64url");
  const head = b64u(JSON.stringify({ alg: "RS256", kid: "k1" }));
  const body = b64u(JSON.stringify({ iss: TEAM, aud: [AUD], email, exp: Math.floor(Date.now() / 1000) + 600 }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${head}.${body}`);
  return `${head}.${body}.${signer.sign(pair.privateKey).toString("base64url")}`;
}

const ENV = {
  ACCESS_TEAM_DOMAIN: TEAM,
  ACCESS_AUD: AUD,
  ALLOWED_EMAIL: EMAIL,
  R2_ACCOUNT_ID: "acct",
  R2_BUCKET: "bucket",
  R2_READ_ACCESS_KEY_ID: "READKEYID",
  R2_READ_SECRET_ACCESS_KEY: "read-secret",
};

/** Stubs global fetch: Access certs, and an empty bucket for R2 GETs. Records every call. */
async function withFetch<T>(run: (calls: Array<{ method: string; url: string }>) => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  const calls: Array<{ method: string; url: string }> = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push({ method: (init?.method ?? "GET").toUpperCase(), url });
    if (url === `${TEAM}/cdn-cgi/access/certs`) return Response.json({ keys: [jwk] });
    if (new URL(url).searchParams.get("list-type") === "2")
      return new Response("<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>", { status: 200 });
    return new Response("", { status: 404 });
  }) as typeof fetch;
  try {
    return await run(calls);
  } finally {
    globalThis.fetch = original;
  }
}

const r2Calls = <T extends { url: string }>(calls: T[]) => calls.filter((c) => c.url.includes("r2.cloudflarestorage.com"));

test("site worker: no Access JWT, a bad one, or another email gets 403 and never touches storage", async () => {
  clearAccessCertCache();
  await withFetch(async (calls) => {
    for (const headers of [{}, { "cf-access-jwt-assertion": "garbage" }, { "cf-access-jwt-assertion": token("someone@example.test") }]) {
      for (const path of ["/", "/scanner/health", "/scanner/latest", "/anything"]) {
        const response = await worker.fetch(new Request(`https://stocks.example.test${path}`, { headers }), ENV);
        assert.equal(response.status, 403, `${path} ${JSON.stringify(headers).slice(0, 40)}`);
        assert.equal(await response.text(), "Forbidden.");
      }
    }
    assert.equal(r2Calls(calls).length, 0);
  });
});

test("site worker: missing Access settings fail closed (503) with no storage reads", async () => {
  clearAccessCertCache();
  await withFetch(async (calls) => {
    for (const drop of ["ACCESS_AUD", "ACCESS_TEAM_DOMAIN", "ALLOWED_EMAIL"] as const) {
      const env = { ...ENV, [drop]: undefined };
      const response = await worker.fetch(new Request("https://stocks.example.test/", { headers: { "cf-access-jwt-assertion": token() } }), env);
      assert.equal(response.status, 503);
    }
    assert.equal(r2Calls(calls).length, 0);
  });
});

test("site worker: a valid JWT for the allowed email gets the page, read-only over the S3 API", async () => {
  clearAccessCertCache();
  await withFetch(async (calls) => {
    const headers = { "cf-access-jwt-assertion": token() };
    const page = await worker.fetch(new Request("https://stocks.example.test/", { headers }), ENV);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type") ?? "", /text\/html/u);
    assert.equal(page.headers.get("cache-control"), "private, no-store");
    const html = await page.text();
    assert.match(html, /PeaceSTOCKS/u);
    assert.match(html, /Predictions off/u);
    const reads = r2Calls(calls);
    assert.ok(reads.length > 0);
    assert.ok(reads.every((c) => c.method === "GET" || c.method === "HEAD"));
    assert.equal((await worker.fetch(new Request("https://stocks.example.test/", { method: "POST", headers, body: "x" }), ENV)).status, 405);
    const missingStorage = await worker.fetch(new Request("https://stocks.example.test/", { headers }), { ...ENV, R2_READ_SECRET_ACCESS_KEY: undefined });
    assert.equal(missingStorage.status, 503);
  });
});

test("site worker: JSON scanner routes stay available behind the same gate", async () => {
  const client = new MemoryObjectClient();
  const site = createSiteWorker({ verify: async () => ({ ok: true, email: EMAIL }), client });
  const health = await site.fetch(new Request("https://stocks.example.test/scanner/health"));
  assert.equal(health.status, 200);
  assert.equal(await health.json(), null);
  const denied = createSiteWorker({ verify: async () => { throw new Error("x"); }, client });
  assert.equal((await denied.fetch(new Request("https://stocks.example.test/scanner/health"))).status, 403);
});

test("site worker: HEAD and OPTIONS without a token are refused like GET, with no storage reads", async () => {
  clearAccessCertCache();
  await withFetch(async (calls) => {
    for (const method of ["HEAD", "OPTIONS", "GET", "POST", "PUT", "DELETE"]) {
      for (const path of ["/", "/scanner/health"]) {
        const response = await worker.fetch(new Request(`https://stocks.example.test${path}`, { method }), ENV);
        assert.equal(response.status, 403, `${method} ${path}`);
      }
    }
    assert.equal(r2Calls(calls).length, 0);
    // OPTIONS with a valid token is still not a read: 405.
    const options = await worker.fetch(new Request("https://stocks.example.test/", { method: "OPTIONS", headers: { "cf-access-jwt-assertion": token() } }), ENV);
    assert.equal(options.status, 405);
  });
});

test("site worker: the page carries the CSP (incl. frame-ancestors 'none'), nosniff and no-frame headers", async () => {
  clearAccessCertCache();
  await withFetch(async () => {
    const page = await worker.fetch(new Request("https://stocks.example.test/", { headers: { "cf-access-jwt-assertion": token() } }), ENV);
    assert.equal(page.status, 200);
    const csp = page.headers.get("content-security-policy") ?? "";
    for (const directive of ["default-src 'none'", "style-src 'unsafe-inline'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'none'"])
      assert.ok(csp.split(";").map((d) => d.trim()).includes(directive), directive);
    assert.doesNotMatch(csp, /script-src/u);
    assert.equal(page.headers.get("x-content-type-options"), "nosniff");
    assert.equal(page.headers.get("x-frame-options"), "DENY");
    assert.equal(page.headers.get("referrer-policy"), "no-referrer");
    assert.equal(page.headers.get("x-robots-tag"), "noindex, nofollow");
  });
});
