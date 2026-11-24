import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

/**
 * Runs the "Confirm the site is not public" script under bash -e (as Actions does) with fake curl,
 * date and sleep on a shared fake clock, so ten minutes pass in milliseconds and nothing touches the
 * network. `answer(t)` gives what https://SITE_HOSTNAME/ returns at fake second t:
 * [http_code, redirect_url, curl exit code].
 */
function runPostCheck(answer: string): { status: number; out: string; elapsed: number; curls: number } {
  const step = block("Confirm the site is not public");
  const lines = step.slice(step.indexOf("run: |\n") + "run: |\n".length).split("\n");
  const script = lines.map((line) => line.replace(/^ {10}/u, "")).join("\n");
  const dir = mkdtempSync(join(tmpdir(), "postcheck-"));
  try {
    writeFileSync(join(dir, "clock"), "1000\n");
    writeFileSync(join(dir, "curls"), "");
    const tick = (n: string) => `c=$(cat "$FAKE_DIR/clock"); echo $((c + ${n})) > "$FAKE_DIR/clock"`;
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "date"), `#!/bin/bash\n[ "$1" = "+%s" ] && exec cat "$FAKE_DIR/clock"\nexec /bin/date "$@"\n`, { mode: 0o755 });
    writeFileSync(join(bin, "sleep"), `#!/bin/bash\n${tick("$1")}\n`, { mode: 0o755 });
    // Fake curl: honours -w with %{http_code} and %{redirect_url}; each call costs 2 fake seconds.
    writeFileSync(
      join(bin, "curl"),
      `#!/bin/bash
fmt=""; while [ $# -gt 0 ]; do [ "$1" = "-w" ] && { fmt="$2"; shift; }; shift; done
echo x >> "$FAKE_DIR/curls"
t=$(( $(cat "$FAKE_DIR/clock") - 1000 ))
${tick("2")}
answer() { ${answer}; }
read -r code loc rc <<< "$(answer "$t")"
[ "$loc" = "-" ] && loc=""
fmt=\${fmt//%\\{http_code\\}/$code}; fmt=\${fmt//%\\{redirect_url\\}/$loc}
printf '%s' "$fmt"
exit "\${rc:-0}"
`,
      { mode: 0o755 },
    );
    const result = spawnSync("bash", ["-e", "-c", script], {
      env: { PATH: `${bin}:/usr/bin:/bin`, FAKE_DIR: dir, SITE_HOSTNAME: "stocks.example.test" },
      encoding: "utf8",
      timeout: 30_000,
    });
    return {
      status: result.status ?? -1,
      out: `${result.stdout}${result.stderr}`,
      elapsed: Number(readFileSync(join(dir, "clock"), "utf8")) - 1000,
      curls: readFileSync(join(dir, "curls"), "utf8").split("\n").filter(Boolean).length,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const LOGIN = "https://blue-leaf-13b3.cloudflareaccess.com/cdn-cgi/access/login/stocks.example.test";

test("site deploy post-check: a new custom domain gets ~10 minutes; 000/DNS/TLS errors are retried", () => {
  // Run 45359206951: curl 000 for the first minutes while DNS and the certificate came up.
  for (const rc of [6, 7, 28, 35, 60]) {
    const late = runPostCheck(`if [ "$1" -lt 480 ]; then echo "000 - ${rc}"; else echo "302 ${LOGIN} 0"; fi`);
    assert.equal(late.status, 0, `curl exit ${rc} for 8 minutes, then the Access login: ${late.out}`);
    assert.match(late.out, /SITE_GATED: redirects to the Access login \(302\)/u);
    assert.ok(late.elapsed >= 480, `${late.elapsed}`);
  }
  const never = runPostCheck(`echo "000 - 6"`);
  assert.equal(never.status, 1, never.out);
  assert.ok(never.elapsed >= 600 && never.elapsed <= 660, `gives up after ~10 minutes, took ${never.elapsed}s`);
  assert.match(never.out, /::error::could not confirm the Access login/u);
  const step = block("Confirm the site is not public");
  const stepTimeout = Number(/\n        timeout-minutes: (\d+)\n/u.exec(step)?.[1]);
  const jobTimeout = Number(/\n    timeout-minutes: (\d+)\n/u.exec(workflow)?.[1]);
  assert.ok(stepTimeout >= 11, `step timeout ${stepTimeout} leaves room for the 10-minute wait`);
  assert.ok(jobTimeout >= stepTimeout + 10, `job timeout ${jobTimeout} leaves room for the earlier steps`);
});

test("site deploy post-check: only an Access login redirect or 401/403 passes; any 2xx fails at once", () => {
  for (const code of ["302", "301", "303", "307", "308"]) {
    const ok = runPostCheck(`echo "${code} ${LOGIN} 0"`);
    assert.equal(ok.status, 0, `${code}: ${ok.out}`);
    assert.equal(ok.curls, 1);
  }
  for (const code of ["401", "403"]) {
    const ok = runPostCheck(`echo "${code} - 0"`);
    assert.equal(ok.status, 0, `${code}: ${ok.out}`);
    assert.match(ok.out, new RegExp(`SITE_GATED: refused without a login \\(${code}\\)`, "u"));
  }
  for (const code of ["200", "204", "206"]) {
    const open = runPostCheck(`if [ "$1" -lt 60 ]; then echo "000 - 7"; else echo "${code} - 0"; fi`);
    assert.equal(open.status, 1, `${code}: ${open.out}`);
    assert.match(open.out, new RegExp(`::error::https://stocks\\.example\\.test/ answered ${code} without a login`, "u"));
    assert.ok(open.elapsed < 120, `${code} fails at once, not after the wait (${open.elapsed}s)`);
  }
  // Redirects anywhere but the Access login, and other codes, never pass: wait, then fail.
  for (const answer of [
    `echo "302 https://evil.example/cdn-cgi/access/login/x 0"`,
    `echo "302 https://example.com/?r=team.cloudflareaccess.com/cdn-cgi/access/login/ 0"`,
    `echo "302 http://blue-leaf-13b3.cloudflareaccess.com/cdn-cgi/access/login/x 0"`,
    `echo "302 - 0"`,
    `echo "404 ${LOGIN} 0"`,
    `echo "500 - 0"`,
    `echo "000 ${LOGIN} 35"`,
  ]) {
    const bad = runPostCheck(answer);
    assert.equal(bad.status, 1, `${answer}: ${bad.out}`);
    assert.match(bad.out, /::error::could not confirm the Access login/u, answer);
  }
});

/** Runs the Worker-secrets step's `node -e` script (not wrangler) and returns the JSON it writes. */
function runSecretsScript(env: Record<string, string>): { status: number; out: string; json?: Record<string, string> } {
  const step = block("Worker secrets");
  const line = step.split("\n").find((l) => l.trim().startsWith("node -e "));
  assert.ok(line, "the step builds the secrets file with node -e");
  const dir = mkdtempSync(join(tmpdir(), "secrets-"));
  try {
    const file = join(dir, "site-secrets.json");
    const result = spawnSync("bash", ["-e", "-c", line!.trim()], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", file, ...env },
      encoding: "utf8",
    });
    let json: Record<string, string> | undefined;
    try {
      json = JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;
    } catch {
      json = undefined;
    }
    return { status: result.status ?? -1, out: `${result.stdout}${result.stderr}`, ...(json ? { json } : {}) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const SECRET_ENV = {
  ALLOWED_EMAIL: " owner@example.test\n",
  CLOUDFLARE_ACCOUNT_ID: "acct123\n",
  R2_BUCKET: "\tbucket-aaa \n",
  R2_READ_ACCESS_KEY_ID: "READKEYIDAAA\r\n",
  R2_READ_SECRET_ACCESS_KEY: "  read-secret-bbb\n",
};

test("site deploy workflow: every Worker secret is trimmed (pasted values often end in a newline)", () => {
  const result = runSecretsScript(SECRET_ENV);
  assert.equal(result.status, 0, result.out);
  assert.deepEqual(result.json, {
    ALLOWED_EMAIL: "owner@example.test",
    R2_ACCOUNT_ID: "acct123",
    R2_BUCKET: "bucket-aaa",
    R2_READ_ACCESS_KEY_ID: "READKEYIDAAA",
    R2_READ_SECRET_ACCESS_KEY: "read-secret-bbb",
  });
});

test("site deploy workflow: a secret that is missing or empty after trimming stops the step, naming it only", () => {
  for (const [name, written] of [
    ["R2_READ_SECRET_ACCESS_KEY", "R2_READ_SECRET_ACCESS_KEY"],
    ["R2_READ_ACCESS_KEY_ID", "R2_READ_ACCESS_KEY_ID"],
    ["CLOUDFLARE_ACCOUNT_ID", "R2_ACCOUNT_ID"],
    ["R2_BUCKET", "R2_BUCKET"],
    ["ALLOWED_EMAIL", "ALLOWED_EMAIL"],
  ] as const) {
    for (const value of [" \n", undefined]) {
      const env: Record<string, string> = { ...SECRET_ENV };
      if (value === undefined) delete env[name];
      else env[name] = value;
      const result = runSecretsScript(env);
      assert.notEqual(result.status, 0, `${name}=${JSON.stringify(value)}`);
      assert.equal(result.json, undefined, "no secrets file written");
      assert.match(result.out, new RegExp(`::error::${written} is missing or empty after trimming`, "u"));
      for (const secret of Object.values(SECRET_ENV)) assert.ok(!result.out.includes(secret.trim()), "no value in the output");
    }
  }
});
