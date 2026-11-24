import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { researchMain } from "./research-harness-cli";

test("baseline refuses --bps below the 5 bps per side floor (or not a number) before reading any data", async () => {
  const out = mkdtempSync(join(tmpdir(), "research-args-"));
  try {
    for (const bps of ["0", "4.9", "abc", "-10"])
      await assert.rejects(
        researchMain(["baseline", "--data", join(out, "does-not-exist"), "--out", out, "--bps", bps, "--scanner", "test"], { ledgerDir: join(out, "ledger") }),
        /COST_BELOW_FLOOR/u,
        bps,
      );
  } finally { rmSync(out, { recursive: true, force: true }); }
});
