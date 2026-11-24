import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { afterScanRunId, refillPauseReason } from "./gap-refill";

const t = (h: number, m: number) => new Date(Date.UTC(2026, 10, 24, h, m));

test("after a scan, the refill does not wait on its own scan run or the guard window", () => {
  const own = { id: 45000000001, status: "in_progress", display_title: "Scanner" };
  assert.equal(refillPauseReason(t(5, 40), [own], { ownRunId: own.id }), undefined);
  assert.equal(refillPauseReason(t(12, 0), [own], { ownRunId: own.id }), undefined);
  // Another scanner run in progress still pauses it; runs queued (or waiting/pending) behind this scan's
  // own job do not, since they cannot start until it ends. A failed runs check still fails closed.
  assert.equal(
    refillPauseReason(t(12, 0), [own, { id: 45000000002, status: "in_progress", display_title: "Scanner" }], { ownRunId: own.id }),
    "ACTIVE_SCANNER_RUN",
  );
  for (const status of ["queued", "waiting", "pending", "requested"])
    assert.equal(
      refillPauseReason(t(12, 0), [own, { id: 45000000003, status, display_title: "Scanner" }], { ownRunId: own.id }),
      undefined,
      status,
    );
  assert.equal(refillPauseReason(t(12, 0), { error: "http-403" }, { ownRunId: own.id }), "RUNS_CHECK_FAILED");
  // A run listed without an id is never mistaken for the scan's own run.
  assert.equal(refillPauseReason(t(12, 0), [{ status: "in_progress", display_title: "Scanner" }], { ownRunId: own.id }), "ACTIVE_SCANNER_RUN");
  // Without --after-scan nothing changes: the weekly refill still yields to every scan and guard window.
  assert.equal(refillPauseReason(t(12, 0), [own]), "ACTIVE_SCANNER_RUN");
  assert.equal(refillPauseReason(t(12, 0), [{ status: "queued", display_title: "Scanner" }]), "ACTIVE_SCANNER_RUN");
  assert.equal(refillPauseReason(t(5, 40), []), "GUARD_WINDOW");
});

test("--after-scan needs a numeric GITHUB_RUN_ID; without the flag there is no after-scan mode", () => {
  assert.deepEqual(afterScanRunId(["--after-scan"], "45269146558"), { ownRunId: 45269146558 });
  assert.equal(afterScanRunId([], "45269146558"), undefined);
  assert.throws(() => afterScanRunId(["--after-scan"], undefined), /AFTER_SCAN_RUN_ID_INVALID/u);
  assert.throws(() => afterScanRunId(["--after-scan"], "12x"), /AFTER_SCAN_RUN_ID_INVALID/u);
});

test("scanner.yml scan job runs the gap refill after a successful scan, before the coverage check, main only", () => {
  const yml = readFileSync(new URL("../.github/workflows/scanner.yml", import.meta.url), "utf8");
  const scan = yml.indexOf("      - name: Run online scanner host");
  const refill = yml.indexOf("      - name: Fill daily-bars coverage after the scan");
  const coverage = yml.indexOf("      - name: Daily-bars coverage check");
  assert.ok(scan > 0 && refill > scan && coverage > refill, "order: scan, refill, coverage check");
  const step = yml.slice(refill, yml.indexOf("\n      - name:", refill + 1));
  assert.match(step, /if: \$\{\{ success\(\) && github\.ref == 'refs\/heads\/main' \}\}/u);
  assert.match(step, /continue-on-error: true/u);
  assert.match(step, /run: pnpm -s exec tsx src\/gap-refill\.ts --after-scan\n/u);
  assert.match(step, /NET_READ_TOKEN: \$\{\{ secrets\.NET_RERUN_DISPATCH_TOKEN \}\}/u);
});
