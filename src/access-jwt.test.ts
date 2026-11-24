import assert from "node:assert/strict";
import { generateKeyPairSync, createSign } from "node:crypto";
import test from "node:test";
import { clearAccessCertCache, normalizeTeamDomain, verifyAccessJwt, type AccessJwtConfig } from "./access-jwt";

const TEAM = "https://example-team.cloudflareaccess.com";
const AUD = "aud-tag-123";
const EMAIL = "owner@example.test";

const good = generateKeyPairSync("rsa", { modulusLength: 2048 });
const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...good.publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };

const b64u = (value: string | Buffer) => Buffer.from(value).toString("base64url");

function sign(payload: Record<string, unknown>, options: { key?: typeof good.privateKey; kid?: string; alg?: string } = {}): string {
  const header = b64u(JSON.stringify({ alg: options.alg ?? "RS256", kid: options.kid ?? "k1", typ: "JWT" }));
  const body = b64u(JSON.stringify(payload));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${body}`);
  return `${header}.${body}.${signer.sign(options.key ?? good.privateKey).toString("base64url")}`;
}

const NOW = 1_800_000_000;
const claims = (over: Record<string, unknown> = {}) => ({ iss: TEAM, aud: [AUD], email: EMAIL, exp: NOW + 600, iat: NOW, nbf: NOW, sub: "u1", ...over });

function config(over: Partial<AccessJwtConfig> = {}): AccessJwtConfig & { calls: string[] } {
  const calls: string[] = [];
  return {
    teamDomain: TEAM,
    aud: AUD,
    allowedEmail: EMAIL,
    nowSeconds: () => NOW,
    fetchImpl: (async (url: string) => {
      calls.push(String(url));
      return Response.json({ keys: [jwk] });
    }) as typeof fetch,
    calls,
    ...over,
  };
}

test("access jwt: a valid token for the one allowed email passes; certs come from the team domain", async () => {
  clearAccessCertCache();
  const c = config();
  assert.deepEqual(await verifyAccessJwt(sign(claims()), c), { ok: true, email: EMAIL });
  assert.deepEqual(c.calls, [`${TEAM}/cdn-cgi/access/certs`]);
  assert.deepEqual(await verifyAccessJwt(sign(claims({ email: "Owner@Example.test", aud: AUD })), c), { ok: true, email: EMAIL });
});

test("access jwt: missing, malformed, forged, wrong-audience, wrong-issuer, expired and other-email tokens are refused", async () => {
  clearAccessCertCache();
  const c = config();
  const reason = async (token: string | null) => {
    const result = await verifyAccessJwt(token, c);
    return result.ok ? "OK" : result.reason;
  };
  assert.equal(await reason(null), "MISSING_TOKEN");
  assert.equal(await reason(""), "MISSING_TOKEN");
  assert.equal(await reason("not-a-jwt"), "MALFORMED_TOKEN");
  assert.equal(await reason("a.b.c"), "MALFORMED_TOKEN");
  assert.equal(await reason(sign(claims(), { key: other.privateKey })), "BAD_SIGNATURE");
  const [h, , s] = sign(claims()).split(".");
  assert.equal(await reason(`${h}.${b64u(JSON.stringify(claims({ email: "x@example.test" })))}.${s}`), "BAD_SIGNATURE");
  assert.equal(await reason(sign(claims(), { alg: "HS256" })), "BAD_ALGORITHM");
  assert.equal(await reason(sign(claims(), { alg: "none" })), "BAD_ALGORITHM");
  assert.equal(await reason(sign(claims(), { kid: "unknown" })), "UNKNOWN_KEY");
  assert.equal(await reason(sign(claims({ aud: ["other-aud"] }))), "BAD_AUDIENCE");
  assert.equal(await reason(sign(claims({ iss: "https://evil.cloudflareaccess.com" }))), "BAD_ISSUER");
  assert.equal(await reason(sign(claims({ exp: NOW - 3600 }))), "EXPIRED");
  assert.equal(await reason(sign(claims({ exp: undefined }))), "EXPIRED");
  assert.equal(await reason(sign(claims({ nbf: NOW + 3600 }))), "NOT_YET_VALID");
  assert.equal(await reason(sign(claims({ email: "someone-else@example.test" }))), "EMAIL_NOT_ALLOWED");
  assert.equal(await reason(sign(claims({ email: undefined }))), "EMAIL_NOT_ALLOWED");
});

test("access jwt: missing config or unreachable certs fail closed", async () => {
  clearAccessCertCache();
  const token = sign(claims());
  for (const over of [{ aud: undefined }, { aud: "" }, { teamDomain: undefined }, { teamDomain: "https://evil.example.com" }, { allowedEmail: undefined }]) {
    assert.deepEqual(await verifyAccessJwt(token, config(over)), { ok: false, reason: "ACCESS_NOT_CONFIGURED" });
  }
  const down = config({ fetchImpl: (async () => new Response("no", { status: 500 })) as typeof fetch });
  assert.deepEqual(await verifyAccessJwt(token, down), { ok: false, reason: "CERTS_UNAVAILABLE" });
  assert.equal(normalizeTeamDomain("example-team.cloudflareaccess.com/"), TEAM);
});
