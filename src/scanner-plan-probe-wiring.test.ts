// Builder teaching example: the daily scan job runs the 1-request plan probe after the scan, never blocking it.
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

test("scan job: plan probe runs once, after the scanner host, always(), continue-on-error, plan file set", () => {
  const scan = jobBody("scan");
  const probe = scan.indexOf("src/massive-plan-probe.ts");
  assert.ok(probe > scan.indexOf("run: pnpm scheduler"), "after the scan");
  assert.equal(scan.split("src/massive-plan-probe.ts").length, 2, "exactly one probe");
  const step = scan.slice(scan.lastIndexOf("- name:", probe), probe);
  assert.match(step, /if: \$\{\{ always\(\) \}\}/u);
  assert.match(step, /continue-on-error: true/u);
  assert.match(step, /TENMIN_PLAN_FILE:/u);
  assert.match(scan, /MASSIVE_API_KEY: \$\{\{ secrets\.MASSIVE_API_KEY \}\}/u, "key comes from the job env");
});

test("chain job keeps its own probe (unchanged)", () => {
  assert.ok(jobBody("tenmin_history").includes("src/massive-plan-probe.ts"));
});
