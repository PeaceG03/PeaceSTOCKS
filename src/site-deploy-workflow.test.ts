import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
  assert.doesNotMatch(workflow, /environment:/u);
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
