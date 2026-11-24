// The missed-freeze alert is wired twice: as the scan job's last step and on the hourly :47 tick.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const yml = readFileSync(new URL("../.github/workflows/scanner.yml", import.meta.url), "utf8");
const jobBody = (name: string) => {
  const start = yml.indexOf(`\n  ${name}:\n`);
  assert.ok(start >= 0, `job ${name} present`);
  const next = yml.slice(start + 1).search(/\n  [a-z_]+:\n/u);
  return next < 0 ? yml.slice(start) : yml.slice(start, start + 1 + next);
};
const stepOf = (job: string, needle: string) => {
  const at = job.indexOf(needle);
  assert.ok(at >= 0, needle);
  const begin = job.lastIndexOf("- name:", at);
  const end = job.indexOf("- name:", at);
  return job.slice(begin, end < 0 ? undefined : end);
};

test("scan job: freeze watch is the last step, always() on main, with the issue token; job may write issues", () => {
  const scan = jobBody("scan");
  const at = scan.indexOf("run: pnpm -s exec tsx src/freeze-watch.ts");
  assert.ok(at > scan.indexOf("run: pnpm scheduler"), "after the scan host");
  assert.equal(scan.indexOf("- name:", at), -1, "last step");
  const step = stepOf(scan, "run: pnpm -s exec tsx src/freeze-watch.ts");
  assert.match(step, /if: \$\{\{ always\(\) && github\.ref == 'refs\/heads\/main' \}\}/u);
  assert.match(step, /GITHUB_TOKEN: \$\{\{ github\.token \}\}/u);
  assert.doesNotMatch(step, /continue-on-error/u);
  assert.match(scan, /issues: write/u);
  assert.match(scan, /PEACESTOCKS_R2_BUCKET: \$\{\{ secrets\.PEACESTOCKS_R2_BUCKET \}\}/u);
});

test("freeze_watch job: the :47 tick on main, R2 read and issues write, nothing that dispatches or touches Massive", () => {
  const job = jobBody("freeze_watch");
  assert.match(job, /if: \$\{\{ github\.event_name == 'schedule' && github\.event\.schedule == '47 \* \* \* \*' && github\.ref == 'refs\/heads\/main' \}\}/u);
  assert.match(job, /issues: write/u);
  assert.doesNotMatch(job, /actions: write/u);
  assert.doesNotMatch(job, /MASSIVE_API_KEY/u);
  for (const name of ["PEACESTOCKS_R2_ACCOUNT_ID", "PEACESTOCKS_R2_BUCKET", "PEACESTOCKS_R2_ACCESS_KEY_ID", "PEACESTOCKS_R2_SECRET_ACCESS_KEY"])
    assert.match(job, new RegExp(`${name}: \\$\\{\\{ secrets\\.${name} \\}\\}`, "u"), name);
  assert.match(job, /GITHUB_TOKEN: \$\{\{ github\.token \}\}/u);
  assert.match(job, /run: pnpm -s exec tsx src\/freeze-watch\.ts/u);
  // The scan job never runs on the :47 tick, so the tick job is what covers a scan that never ran.
  assert.match(jobBody("scan"), /github\.event\.schedule != '47 \* \* \* \*'/u);
});

test("freeze watch never gets the Massive key: the scan job's step blanks the job-level secret, the :47 job has none", () => {
  const scan = jobBody("scan");
  assert.match(scan, /MASSIVE_API_KEY: \$\{\{ secrets\.MASSIVE_API_KEY \}\}/u, "the scan host itself still needs it");
  const step = stepOf(scan, "run: pnpm -s exec tsx src/freeze-watch.ts");
  // A step cannot unset a job env var; it overrides it with an empty value.
  assert.match(step, /\n {10}MASSIVE_API_KEY: ""\n/u);
  assert.doesNotMatch(step, /secrets\.MASSIVE_API_KEY/u);
  assert.doesNotMatch(jobBody("freeze_watch"), /MASSIVE_API_KEY/u);
  // The script itself never reads it.
  const source = readFileSync(new URL("./freeze-watch.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /MASSIVE/u);
});
