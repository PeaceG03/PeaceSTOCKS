/**
 * Cloudflare Access JWT check for the private site (defense in depth behind the Access app).
 * Verifies the Cf-Access-Jwt-Assertion header: RS256 signature against the team's published certs,
 * issuer = team domain, aud contains the app's AUD tag, not expired, and (when set) the email claim
 * equals the one allowed email. Any missing config or failed check is a refusal (fail closed).
 * WebCrypto only, so it runs in Workers and in Node tests.
 */

export interface AccessJwtConfig {
  /** https://<team>.cloudflareaccess.com */
  teamDomain: string | undefined;
  aud: string | undefined;
  allowedEmail: string | undefined;
  fetchImpl?: typeof fetch;
  /** Seconds since epoch. */
  nowSeconds?: () => number;
}

export type AccessJwtResult = { ok: true; email: string } | { ok: false; reason: string };

interface Jwk {
  kid?: string;
  kty?: string;
  n?: string;
  e?: string;
  alg?: string;
}

const TEAM_DOMAIN = /^https:\/\/[a-z0-9][a-z0-9-]{0,62}\.cloudflareaccess\.com$/u;
const CERTS_TTL_MS = 10 * 60_000;
const CLOCK_SKEW_SECONDS = 60;

const certCache = new Map<string, { at: number; keys: Jwk[] }>();

/** Test hook: forget cached certs. */
export function clearAccessCertCache(): void {
  certCache.clear();
}

export function normalizeTeamDomain(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim().replace(/\/+$/u, "").toLowerCase();
  const withScheme = trimmed.startsWith("https://") ? trimmed : `https://${trimmed}`;
  return TEAM_DOMAIN.test(withScheme) ? withScheme : undefined;
}

function base64UrlBytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/u.test(value)) throw new Error("BAD_BASE64URL");
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function base64UrlJson(value: string): Record<string, unknown> {
  const parsed = JSON.parse(new TextDecoder().decode(base64UrlBytes(value))) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("BAD_JSON");
  return parsed as Record<string, unknown>;
}

async function certs(teamDomain: string, fetchImpl: typeof fetch, refresh: boolean): Promise<Jwk[]> {
  const cached = certCache.get(teamDomain);
  if (cached && !refresh && Date.now() - cached.at < CERTS_TTL_MS) return cached.keys;
  const response = await fetchImpl(`${teamDomain}/cdn-cgi/access/certs`);
  if (!response.ok) throw new Error(`CERTS_${response.status}`);
  const body = (await response.json()) as { keys?: Jwk[] };
  const keys = Array.isArray(body.keys) ? body.keys : [];
  certCache.set(teamDomain, { at: Date.now(), keys });
  return keys;
}

export async function verifyAccessJwt(token: string | null | undefined, config: AccessJwtConfig): Promise<AccessJwtResult> {
  const teamDomain = normalizeTeamDomain(config.teamDomain);
  const aud = config.aud?.trim();
  const allowed = config.allowedEmail?.trim().toLowerCase();
  if (!teamDomain || !aud || !allowed) return { ok: false, reason: "ACCESS_NOT_CONFIGURED" };
  if (!token) return { ok: false, reason: "MISSING_TOKEN" };
  const pieces = token.split(".");
  if (pieces.length !== 3) return { ok: false, reason: "MALFORMED_TOKEN" };
  const [rawHeader, rawPayload, rawSignature] = pieces as [string, string, string];
  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  let signature: Uint8Array;
  try {
    header = base64UrlJson(rawHeader);
    payload = base64UrlJson(rawPayload);
    signature = base64UrlBytes(rawSignature);
  } catch {
    return { ok: false, reason: "MALFORMED_TOKEN" };
  }
  if (header.alg !== "RS256" || typeof header.kid !== "string") return { ok: false, reason: "BAD_ALGORITHM" };
  const fetchImpl = config.fetchImpl ?? fetch;
  let jwk: Jwk | undefined;
  try {
    jwk = (await certs(teamDomain, fetchImpl, false)).find((key) => key.kid === header.kid);
    // Access rotates keys: an unknown kid gets one fresh fetch.
    if (!jwk) jwk = (await certs(teamDomain, fetchImpl, true)).find((key) => key.kid === header.kid);
  } catch {
    return { ok: false, reason: "CERTS_UNAVAILABLE" };
  }
  if (!jwk || jwk.kty !== "RSA" || !jwk.n || !jwk.e) return { ok: false, reason: "UNKNOWN_KEY" };
  let valid = false;
  try {
    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      signature,
      new TextEncoder().encode(`${rawHeader}.${rawPayload}`),
    );
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: "BAD_SIGNATURE" };
  if (payload.iss !== teamDomain) return { ok: false, reason: "BAD_ISSUER" };
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audiences.includes(aud)) return { ok: false, reason: "BAD_AUDIENCE" };
  const now = (config.nowSeconds ?? (() => Math.floor(Date.now() / 1000)))();
  if (typeof payload.exp !== "number" || payload.exp <= now - CLOCK_SKEW_SECONDS) return { ok: false, reason: "EXPIRED" };
  if (typeof payload.nbf === "number" && payload.nbf > now + CLOCK_SKEW_SECONDS) return { ok: false, reason: "NOT_YET_VALID" };
  const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
  if (!email || email !== allowed) return { ok: false, reason: "EMAIL_NOT_ALLOWED" };
  return { ok: true, email };
}
