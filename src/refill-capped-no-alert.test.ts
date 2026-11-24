// A capped run is not a failure: it must not open or comment on the "needs a person" issue.
// The scan host's BACKLOG_REMAINS already exits 0. The after-scan refill's budget stop (DEADLINE) used to exit 4,
// which made the step's outcome 'failure' and fired the shared alert on every backlog day.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { refillStopExit } from "./gap-refill";

const gh = new URL("../.github/", import.meta.url);
const action = readFileSync(new URL("actions/refill-backup-and-alert/action.yml", gh), "utf8");
const scanner = readFileSync(new URL("workflows/scanner.yml", gh), "utf8");
const source = readFileSync(new URL("./gap-refill.ts", import.meta.url), "utf8");

/** What the scan job's tail sees for an exit code (continue-on-error keeps outcome = the real result). */
const outcome = (code: number) => (code === 0 ? "success" : "failure");
/** The alert step's condition in the shared action, evaluated for an outcome. */
function alertFires(stepOutcome: string): boolean {
  const cond = /- name: Alert on FAIL\n {6}if: \$\{\{ inputs\.outcome == '([a-z]+)' \}\}/u.exec(action)?.[1];
  assert.ok(cond, "alert condition found");
  return stepOutcome === cond;
}

test("after-scan budget stop: exit 0 with a BACKLOG_REMAINS line, no alert", () => {
  const r = refillStopExit("DEADLINE", true, { fetched: 7, sessions: 28 });
  assert.equal(r.code, 0);
  assert.equal(r.line, "gap-refill: BACKLOG_REMAINS stopped=DEADLINE fetched=7/28");
  assert.equal(alertFires(outcome(r.code)), false);
});

test("real failures still alert; the weekly refill's budget stop is unchanged", () => {
  const weekly = refillStopExit("DEADLINE", false, { fetched: 7, sessions: 28 });
  assert.equal(weekly.code, 4);
  assert.equal(alertFires(outcome(weekly.code)), true);
  const other = refillStopExit("SOMETHING_ELSE", true, { fetched: 0, sessions: 3 });
  assert.equal(other.code, 4);
  assert.equal(alertFires(outcome(other.code)), true);
  assert.equal(alertFires(outcome(2)), true); // VERIFY FAIL
});

test("gap-refill.ts main uses refillStopExit, and the scan job's tail passes the refill's own outcome", () => {
  assert.match(source, /if \(res\.stopped\) \{\n\s+const stop = refillStopExit\(res\.stopped, Boolean\(afterScan\), \{ fetched, sessions: sessions\.length \}\);\n\s+console\.log\(stop\.line\);\n\s+if \(stop\.behind\) behindRemaining = stop\.behind\.remaining;\n\s+if \(stop\.runsCheckFailed\) runsCheckFailedUntilDeadline = true;\n\s+return stop\.code;\n\s+\}/u);
  assert.match(scanner, /outcome: \$\{\{ steps\.post_scan_refill\.outcome \}\}/u);
});
