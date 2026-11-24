// The scanner's data secrets (Massive key, R2 keys, the net-rerun dispatch token) live in the GitHub
// environment "scanner-data", whose deployment branch policy is main only. Every job that reads one
// must declare that environment, so a branch-edited workflow (or a run dispatched from a branch) gets
// no secret; and no job declaring it may run on pull_request / push triggers.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

const DIR = new URL("../.github/workflows/", import.meta.url);
const SECRET = /secrets\.(MASSIVE_API_KEY|NET_RERUN_DISPATCH_TOKEN|PEACESTOCKS_R2_(ACCESS_KEY_ID|SECRET_ACCESS_KEY|ACCOUNT_ID|BUCKET))\b/u;
const ENV_FILES = ["scanner.yml", "gap-refill.yml", "health.yml", "net-rerun.yml", "oct2024-tenmin.yml", "paper-trading.yml"];

/** Top-level `jobs:` split into { name, text } by the two-space job keys. */
function jobs(yml: string): Array<{ name: string; text: string }> {
  const body = yml.slice(yml.search(/^jobs:\s*$/mu));
  const out: Array<{ name: string; text: string }> = [];
  for (const line of body.split("\n").slice(1)) {
    const m = /^ {2}([A-Za-z0-9_-]+):\s*$/u.exec(line);
    if (m) out.push({ name: m[1]!, text: "" });
    else if (out.length) out.at(-1)!.text += `${line}\n`;
  }
  return out;
}
/** The `on:` block only (up to the next top-level key). */
function triggers(yml: string): string {
  const from = yml.search(/^on:/mu);
  const rest = yml.slice(from + 3);
  const next = rest.search(/^[A-Za-z]/mu);
  return yml.slice(from, next < 0 ? undefined : from + 3 + next);
}
const environmentOf = (text: string) => /^ {4}environment:\s*(\S+)\s*$/mu.exec(text)?.[1];

test("every job in the scanner-data workflows that reads a data secret declares environment scanner-data", () => {
  let checked = 0;
  for (const file of ENV_FILES) {
    const yml = readFileSync(new URL(file, DIR), "utf8");
    const all = jobs(yml);
    assert.ok(all.length > 0, file);
    for (const job of all) {
      if (!SECRET.test(job.text)) continue;
      checked += 1;
      assert.equal(environmentOf(job.text), "scanner-data", `${file}:${job.name}`);
    }
  }
  assert.ok(checked >= 12, `checked ${checked} jobs`); // scanner 5, gap-refill 1, health 2, net-rerun 1, oct2024 2, paper 1
});

test("no other workflow reads the data secrets outside an environment, and site-deploy keeps 'site'", () => {
  for (const file of readdirSync(DIR).filter((f) => f.endsWith(".yml") && !ENV_FILES.includes(f))) {
    const yml = readFileSync(new URL(file, DIR), "utf8");
    for (const job of jobs(yml)) {
      if (!SECRET.test(job.text)) continue;
      assert.equal(file, "site-deploy.yml", `${file}:${job.name} reads a data secret`);
      assert.equal(environmentOf(job.text), "site", `${file}:${job.name}`);
    }
  }
});

test("no pull_request- or push-triggered workflow has a scanner-data job; the Tests workflow has no environment", () => {
  for (const file of readdirSync(DIR).filter((f) => f.endsWith(".yml"))) {
    const yml = readFileSync(new URL(file, DIR), "utf8");
    const usesEnv = jobs(yml).some((job) => environmentOf(job.text) === "scanner-data");
    if (!usesEnv) continue;
    assert.doesNotMatch(triggers(yml), /^ {2}(pull_request|pull_request_target|push):/mu, file);
    // Main-only environment: every trigger must run on main (schedule, workflow_run and repository_dispatch
    // run on the default branch; workflow_dispatch runs where it is dispatched, and the chains pin --ref main).
    for (const m of triggers(yml).matchAll(/^ {2}([a-z_]+):/gmu))
      assert.ok(["schedule", "workflow_dispatch", "workflow_run", "repository_dispatch"].includes(m[1]!), `${file}: ${m[1]}`);
    for (const m of yml.matchAll(/gh workflow run \S+ [^\n]*/gu)) assert.match(m[0], /--ref main/u, `${file}: ${m[0]}`);
  }
  assert.equal(environmentOf(readFileSync(new URL("tests.yml", DIR), "utf8")), undefined);
});
