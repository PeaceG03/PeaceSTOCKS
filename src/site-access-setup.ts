import { appendFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { normalizeTeamDomain } from "./access-jwt";

/**
 * Creates or updates, idempotently, the Cloudflare Access protection for the private site:
 * one reusable allow policy whose only rule is the one allowed email, and one self-hosted Access app
 * for the site hostname that uses only that policy. Then reads both back and fails unless the app
 * covers the hostname with exactly that one policy and the policy allows exactly that one email.
 * Run by site-deploy.yml BEFORE the Worker deploy, so a failure here means nothing is deployed.
 * The email is never printed: errors replace it with [email].
 */

export const SITE_ACCESS_APP_NAME = "PeaceSTOCKS private site";
export const SITE_ACCESS_POLICY_NAME = "PeaceSTOCKS site owner";
const SESSION = "24h";
const API = "https://api.cloudflare.com/client/v4";
const MAX_PAGES = 20;
const EMAIL = /^[^\s@,;<>"']+@[^\s@,;<>"']+\.[^\s@,;<>"']+$/u;
const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u;

export interface AccessSetupInput {
  apiToken: string | undefined;
  accountId: string | undefined;
  hostname: string | undefined;
  allowedEmail: string | undefined;
  /** Required: <team>.cloudflareaccess.com (with or without https://). */
  teamDomain: string | undefined;
  fetchImpl?: typeof fetch;
}

export interface AccessSetupResult {
  appId: string;
  policyId: string;
  aud: string;
  teamDomain: string;
  created: { app: boolean; policy: boolean };
}

interface ApiEnvelope<T> {
  success?: boolean;
  errors?: Array<{ code?: number; message?: string }>;
  result?: T;
  result_info?: { page?: number; total_pages?: number };
}

interface AccessRule {
  email?: { email?: string };
  [kind: string]: unknown;
}

interface AccessPolicy {
  id?: string;
  name?: string;
  decision?: string;
  include?: AccessRule[];
  exclude?: AccessRule[];
  require?: AccessRule[];
}

interface AccessApp {
  id?: string;
  name?: string;
  domain?: string;
  type?: string;
  aud?: string;
  policies?: Array<{ id?: string }>;
}

export class AccessSetupError extends Error {}

function redact(text: string, secret: string): string {
  return secret ? text.split(secret).join("[email]") : text;
}

function client(input: { apiToken: string; accountId: string; email: string; fetchImpl: typeof fetch }) {
  const base = `${API}/accounts/${encodeURIComponent(input.accountId)}/access`;
  return async function call<T>(method: string, path: string, body?: unknown): Promise<ApiEnvelope<T>> {
    const response = await input.fetchImpl(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${input.apiToken}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    let parsed: ApiEnvelope<T> = {};
    try {
      parsed = (await response.json()) as ApiEnvelope<T>;
    } catch {
      parsed = {};
    }
    if (!response.ok || parsed.success === false) {
      const detail = (parsed.errors ?? []).map((e) => `${e.code ?? "?"} ${e.message ?? ""}`.trim()).join("; ");
      throw new AccessSetupError(redact(`ACCESS_API_${response.status}:${method} ${path.split("?")[0]}${detail ? `: ${detail}` : ""}`, input.email));
    }
    return parsed;
  };
}

async function listAll<T>(call: ReturnType<typeof client>, path: string): Promise<T[]> {
  const items: T[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const body = await call<T[]>("GET", `${path}?page=${page}&per_page=50`);
    const batch = Array.isArray(body.result) ? body.result : [];
    items.push(...batch);
    const total = body.result_info?.total_pages;
    if (total !== undefined ? page >= total : batch.length < 50) return items;
  }
  throw new AccessSetupError(`ACCESS_LIST_TOO_MANY_PAGES:${path}`);
}

function onlyEmailRule(policy: AccessPolicy, email: string): boolean {
  const include = policy.include ?? [];
  const rule = include[0];
  return (
    policy.decision === "allow" &&
    include.length === 1 &&
    rule !== undefined &&
    Object.keys(rule).length === 1 &&
    (rule.email?.email ?? "").toLowerCase() === email &&
    (policy.exclude ?? []).length === 0 &&
    (policy.require ?? []).length === 0
  );
}

export async function setupSiteAccess(input: AccessSetupInput): Promise<AccessSetupResult> {
  const apiToken = input.apiToken?.trim();
  const accountId = input.accountId?.trim();
  const hostname = input.hostname?.trim().toLowerCase();
  const email = input.allowedEmail?.trim().toLowerCase() ?? "";
  if (!apiToken) throw new AccessSetupError("CLOUDFLARE_API_TOKEN missing");
  if (!accountId) throw new AccessSetupError("account id missing");
  if (!hostname || !HOSTNAME.test(hostname)) throw new AccessSetupError("site hostname missing or invalid");
  if (!EMAIL.test(email)) throw new AccessSetupError("allowed email missing or not exactly one address");
  const call = client({ apiToken, accountId, email, fetchImpl: input.fetchImpl ?? fetch });

  // Given explicitly (site-deploy.yml input, default blue-leaf-13b3.cloudflareaccess.com): never looked
  // up, so the token needs no Access: Organizations permission.
  const teamDomain = normalizeTeamDomain(input.teamDomain);
  if (!teamDomain) throw new AccessSetupError("team domain missing or not <team>.cloudflareaccess.com");

  const policyBody = {
    name: SITE_ACCESS_POLICY_NAME,
    decision: "allow",
    include: [{ email: { email } }],
    exclude: [],
    require: [],
    session_duration: SESSION,
  };
  // Look up both and check they are unambiguous before any write, so an ambiguous account is left
  // exactly as it was.
  const policies = (await listAll<AccessPolicy>(call, "/policies")).filter((p) => p.name === SITE_ACCESS_POLICY_NAME);
  if (policies.length > 1) throw new AccessSetupError(`more than one Access policy named "${SITE_ACCESS_POLICY_NAME}"`);
  const existingPolicy = policies[0];
  const apps = (await listAll<AccessApp>(call, "/apps")).filter((a) => (a.domain ?? "").toLowerCase() === hostname);
  if (apps.length > 1) throw new AccessSetupError(`more than one Access app covers ${hostname}`);
  const existingApp = apps[0];
  const savedPolicy = existingPolicy?.id
    ? await call<AccessPolicy>("PUT", `/policies/${encodeURIComponent(existingPolicy.id)}`, policyBody)
    : await call<AccessPolicy>("POST", "/policies", policyBody);
  const policyId = savedPolicy.result?.id;
  if (!policyId) throw new AccessSetupError("Access policy save returned no id");

  const appBody = {
    name: SITE_ACCESS_APP_NAME,
    type: "self_hosted",
    domain: hostname,
    destinations: [{ type: "public", uri: hostname }],
    session_duration: SESSION,
    app_launcher_visible: false,
    http_only_cookie_attribute: true,
    same_site_cookie_attribute: "lax",
    policies: [{ id: policyId, precedence: 1 }],
  };
  const savedApp = existingApp?.id
    ? await call<AccessApp>("PUT", `/apps/${encodeURIComponent(existingApp.id)}`, appBody)
    : await call<AccessApp>("POST", "/apps", appBody);
  const appId = savedApp.result?.id;
  if (!appId) throw new AccessSetupError("Access app save returned no id");

  // Read back: the gate must be exactly what we asked for, or nothing gets deployed.
  const app = (await call<AccessApp>("GET", `/apps/${encodeURIComponent(appId)}`)).result ?? {};
  const policy = (await call<AccessPolicy>("GET", `/policies/${encodeURIComponent(policyId)}`)).result ?? {};
  if ((app.domain ?? "").toLowerCase() !== hostname) throw new AccessSetupError("Access app read-back: wrong hostname");
  if (app.type !== "self_hosted") throw new AccessSetupError("Access app read-back: not self_hosted");
  const appPolicies = app.policies ?? [];
  if (appPolicies.length !== 1 || appPolicies[0]?.id !== policyId)
    throw new AccessSetupError(`Access app read-back: expected exactly 1 policy, found ${appPolicies.length}`);
  if (!onlyEmailRule(policy, email)) throw new AccessSetupError("Access policy read-back: not exactly one allowed email");
  const aud = app.aud ?? savedApp.result?.aud;
  if (!aud) throw new AccessSetupError("Access app has no AUD tag");
  return { appId, policyId, aud, teamDomain, created: { app: !existingApp?.id, policy: !existingPolicy?.id } };
}

async function main(): Promise<void> {
  const result = await setupSiteAccess({
    apiToken: process.env.CLOUDFLARE_API_TOKEN,
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    hostname: process.env.SITE_HOSTNAME,
    allowedEmail: process.env.SITE_ALLOWED_EMAIL,
    teamDomain: process.env.ACCESS_TEAM_DOMAIN,
  });
  process.stdout.write(
    `SITE_ACCESS_OK app=${result.created.app ? "created" : "updated"} policy=${result.created.policy ? "created" : "updated"} team=${result.teamDomain}\n`,
  );
  if (process.env.GITHUB_OUTPUT)
    await appendFile(process.env.GITHUB_OUTPUT, `aud=${result.aud}\nteam_domain=${result.teamDomain}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    const email = process.env.SITE_ALLOWED_EMAIL?.trim() ?? "";
    process.stderr.write(`SITE_ACCESS_FAILED:${redact(error instanceof Error ? error.message : String(error), email)}\n`);
    process.exit(1);
  });
}
