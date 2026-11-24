import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(new URL("../.github/workflows/site-deploy.yml", import.meta.url), "utf8");
const wrangler = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");

function block(name: string): string {
  const start = workflow.indexOf(`- name: ${name}`);
  assert.ok(start >= 0, `missing step ${name}`);
  const next = workflow.indexOf("\n      - ", start + 1);
  return workflow.slice(start, next < 0 ? undefined : next);
}

test("site deploy workflow: manual only, read-only repo permission", () => {
  const triggers = workflow.slice(workflow.indexOf("\non:"), workflow.indexOf("\npermissions:"));
  assert.match(triggers, /workflow_dispatch:/u);
  assert.doesNotMatch(triggers, /\b(push|pull_request|schedule|workflow_run|repository_dispatch):/u);
  assert.match(workflow, /\npermissions:\n  contents: read\n/u);
});

test("site deploy workflow: the Access team domain is passed explicitly (no Organizations lookup)", () => {
  assert.match(workflow, /\n      team_domain:\n[^\n]*\n        required: true\n        default: "blue-leaf-13b3\.cloudflareaccess\.com"\n/u);
  assert.match(block("Cloudflare Access app"), /ACCESS_TEAM_DOMAIN: \$\{\{ inputs\.team_domain \}\}/u);
});

test("site deploy workflow: the deploy job runs only from main, in the 'site' environment", () => {
  const job = workflow.slice(workflow.indexOf("\n  deploy:\n"), workflow.indexOf("\n    steps:\n"));
  assert.match(job, /\n    if: github\.ref == 'refs\/heads\/main'\n/u);
  assert.match(job, /\n    environment: site\n/u);
  assert.equal(workflow.match(/\n  [a-z-]+:\n    /gu)?.length, 1, "exactly one job");
});

test("site deploy workflow: Access is set up and read back before the deploy, which uses its AUD", () => {
  const access = workflow.indexOf("- name: Cloudflare Access app");
  const deploy = workflow.indexOf("- name: Deploy Worker");
  const secrets = workflow.indexOf("- name: Worker secrets");
  assert.ok(access > 0 && access < deploy && deploy < secrets);
  assert.match(block("Cloudflare Access app"), /run: pnpm exec tsx src\/site-access-setup\.ts/u);
  assert.match(block("Cloudflare Access app"), /SITE_ALLOWED_EMAIL: \$\{\{ secrets\.PEACESTOCKS_SITE_ALLOWED_EMAIL \}\}/u);
  const deployStep = block("Deploy Worker");
  assert.match(deployStep, /ACCESS_AUD: \$\{\{ steps\.access\.outputs\.aud \}\}/u);
  assert.match(deployStep, /ACCESS_TEAM_DOMAIN: \$\{\{ steps\.access\.outputs\.team_domain \}\}/u);
  assert.match(deployStep, /--var "ACCESS_AUD:\$\{ACCESS_AUD\}" --var "ACCESS_TEAM_DOMAIN:\$\{ACCESS_TEAM_DOMAIN\}"/u);
  assert.match(deployStep, /CLOUDFLARE_API_TOKEN: \$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}/u);
});

test("site deploy workflow: only read-only R2 keys reach the Worker; nothing secret is echoed", () => {
  assert.doesNotMatch(workflow, /PEACESTOCKS_R2_(ACCESS_KEY_ID|SECRET_ACCESS_KEY)\b/u);
  assert.match(block("Worker secrets"), /R2_READ_SECRET_ACCESS_KEY: \$\{\{ secrets\.PEACESTOCKS_R2_READ_SECRET_ACCESS_KEY \}\}/u);
  assert.match(block("Worker secrets"), /umask 077[\s\S]*trap 'rm -f "\$file"' EXIT/u);
  assert.doesNotMatch(workflow, /echo[^\n]*\$\{\{ *secrets\./u);
  assert.doesNotMatch(workflow, /echo[^\n]*\$(ALLOWED_EMAIL|SITE_ALLOWED_EMAIL|R2_READ_)/u);
  assert.doesNotMatch(workflow, /@[a-z0-9-]+\.(com|net|org)/iu);
  // ${{ }} expressions only in env:, never spliced into run scripts.
  for (const line of workflow.split("\n")) if (/\$\{\{/u.test(line)) assert.match(line, /^\s+[A-Za-z0-9_]+: \$\{\{ [^}]+ \}\}$/u, line);
});

test("wrangler.toml: custom domain only, no workers.dev or preview URL, no R2 binding", () => {
  assert.match(wrangler, /\[\[routes\]\]\npattern = "stocks\.jjpeace\.com"\ncustom_domain = true/u);
  assert.match(wrangler, /\nworkers_dev = false\n/u);
  assert.match(wrangler, /\npreview_urls = false\n/u);
  assert.doesNotMatch(wrangler, /r2_buckets/u);
});

const SITE_SECRETS = [
  "CLOUDFLARE_API_TOKEN",
  "PEACESTOCKS_R2_ACCOUNT_ID",
  "PEACESTOCKS_R2_BUCKET",
  "PEACESTOCKS_R2_READ_ACCESS_KEY_ID",
  "PEACESTOCKS_R2_READ_SECRET_ACCESS_KEY",
  "PEACESTOCKS_SITE_ALLOWED_EMAIL",
];

test("site deploy workflow: the 6 secrets are read only inside the 'site' deploy job, and the docs move/copy exactly those", () => {
  const jobStart = workflow.indexOf("\n  deploy:\n");
  const header = workflow.slice(jobStart, workflow.indexOf("\n    steps:\n"));
  assert.match(header, /\n    environment: site\n/u);
  const refs = [...workflow.matchAll(/secrets\.([A-Z0-9_]+)/gu)];
  assert.ok(refs.every((m) => (m.index ?? 0) > jobStart), "no secret is read outside the deploy job");
  assert.deepEqual([...new Set(refs.map((m) => m[1]))].sort(), SITE_SECRETS);

  // Which of them other workflows also read decides move (site-only) vs copy (shared with the scanner).
  const dir = new URL("../.github/workflows/", import.meta.url);
  const others = readdirSync(dir).filter((f) => f.endsWith(".yml") && f !== "site-deploy.yml").map((f) => readFileSync(new URL(f, dir), "utf8")).join("\n");
  const shared = SITE_SECRETS.filter((name) => new RegExp(`secrets\\.${name}\\b`, "u").test(others));
  assert.deepEqual(shared, ["PEACESTOCKS_R2_ACCOUNT_ID", "PEACESTOCKS_R2_BUCKET"]);

  const docs = readFileSync(new URL("../docs/SITE.md", import.meta.url), "utf8");
  const section = docs.slice(docs.indexOf("### Before the first run: the `site` environment"), docs.indexOf("### Cloudflare API token"));
  assert.ok(section.length > 0, "docs have the environment step");
  assert.match(section, /Deployment branches and tags[\s\S]*pattern `main`/u);
  for (const name of SITE_SECRETS) {
    const row = section.split("\n").find((line) => line.includes(`| \`${name}\` |`));
    assert.ok(row, `docs list ${name}`);
    assert.match(row!, shared.includes(name) ? /\*\*keep\*\* the repository secret/u : /\*\*delete\*\* the repository secret/u, name);
  }
  assert.match(section, /fresh\s+site-only R2 API token: Object Read only, on the `peacestocks` bucket only/u);
});

test("site deploy workflow: runs on Node >= 22.12 (wrangler 4 and miniflare require it)", () => {
  const versions = [...workflow.matchAll(/\n\s+node-version: "?([0-9.x]+)"?\n/gu)].map((m) => m[1]!);
  assert.equal(versions.length, 1, "one setup-node step");
  const [major, minor = "x"] = versions[0]!.split(".");
  const okMajor = Number(major) >= 23;
  const ok22 = Number(major) === 22 && (minor === "x" || minor === undefined || Number(minor) >= 12);
  assert.ok(okMajor || ok22, `node-version ${versions[0]} is below 22.12`);
});
