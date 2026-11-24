import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import test from "node:test";

const gh = new URL("../.github/", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, gh), "utf8");
const ACTION = "actions/refill-backup-and-alert/action.yml";

test("one shared refill tail: pre-images artifact and failure alert", () => {
  assert.ok(existsSync(new URL(ACTION, gh)), ACTION);
  const action = read(ACTION);
  assert.match(action, /using: composite/u);
  assert.match(action, /uses: actions\/upload-artifact@v4\n {6}with:\n {8}name: \$\{\{ inputs\.artifact-name \}\}\n {8}path: refill-backup\//u);
  assert.match(action, /- name: Alert on FAIL\n {6}if: \$\{\{ inputs\.outcome == 'failure' \}\}/u);
  assert.ok(action.indexOf("Alert on FAIL") < action.indexOf("upload-artifact"), "alert runs before the upload");
  // The upload must run even if the alert step fails (a gh error would otherwise skip the backups).
  assert.match(action, /- name: Keep pre-images\n {6}if: \$\{\{ always\(\) \}\}\n {6}uses: actions\/upload-artifact@v4/u);
  // The alert logic lives only in the shared action.
  const files = readdirSync(new URL("workflows/", gh)).map((f) => `workflows/${f}`);
  const withAlert = [ACTION, ...files].filter((f) => read(f).includes('t="Daily-bars gap refill needs a person"'));
  assert.deepEqual(withAlert, [ACTION]);
});

test("gap-refill.yml and the scan job's inline refill both use the shared tail", () => {
  const weekly = read("workflows/gap-refill.yml");
  assert.match(weekly, /uses: \.\/\.github\/actions\/refill-backup-and-alert\n {8}with:\n {10}artifact-name: refill-backup\n {10}outcome: \$\{\{ job\.status \}\}/u);
  assert.doesNotMatch(weekly, /actions\/upload-artifact/u);

  const scanner = read("workflows/scanner.yml");
  const job = scanner.slice(scanner.indexOf("\n  scan:\n"), scanner.indexOf("\n  tenmin_daily:"));
  const refill = job.indexOf("      - name: Fill daily-bars coverage after the scan");
  const tail = job.indexOf("      - name: Keep refill pre-images and alert on FAIL");
  assert.ok(refill > 0 && tail > refill, "tail step follows the inline refill");
  const step = job.slice(tail, job.indexOf("\n      - name:", tail + 1));
  assert.match(step, /if: \$\{\{ always\(\) && \(steps\.post_scan_refill\.outcome == 'success' \|\| steps\.post_scan_refill\.outcome == 'failure'\) \}\}/u);
  assert.match(step, /uses: \.\/\.github\/actions\/refill-backup-and-alert/u);
  assert.match(step, /outcome: \$\{\{ steps\.post_scan_refill\.outcome \}\}/u);
  // The alert needs issues: write on the scan job (repo default token is read-only).
  assert.match(job, /\n {4}permissions:\n {6}contents: read\n {6}actions: read\n {6}issues: write\n/u);
});
