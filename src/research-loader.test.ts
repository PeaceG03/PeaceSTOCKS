import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadResearchData } from "./research-harness-cli";
import { openToNextOpen } from "./research-harness-data";

test("loader physically excludes the held-out boundary and later prices, including low-count sessions and outcome lookahead", async () => {
  const root = mkdtempSync(join(tmpdir(), "research-loader-"));
  try {
    mkdirSync(join(root, "permanent/daily-bars"), { recursive: true });
    writeFileSync(join(root, "permanent/security-master.json"), "[]");
    writeFileSync(join(root, "permanent/corporate-actions.jsonl"), "");
    const days = ["2026-08-25", "2026-08-26", "2026-08-27", "2026-08-28"];
    const rows = days.flatMap((sessionDate, k) => ["fixture-a", "fixture-b"].map((securityId) => ({ securityId, sessionDate, open: 10 + k, close: 10 + k, volume: 100, revision: 1 })));
    // A held-out row below minBars must not hide in history's private per-security lookup either.
    rows.push({ securityId: "heldout-only", sessionDate: "2026-08-31", open: 999, close: 999, volume: 1, revision: 1 });
    const path = join(root, "permanent/daily-bars/2026-08.jsonl");
    writeFileSync(path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const { history } = await loadResearchData(root, "2026-08-25", "2026-08-27", 2);
    assert.deepEqual(history.sessions, days.slice(0, 2));
    for (const day of days.slice(2).concat("2026-08-31")) {
      assert.deepEqual(history.barsOn(day), []);
      for (const id of ["fixture-a", "fixture-b", "heldout-only"]) assert.equal(history.bar(id, day), undefined);
    }
    assert.equal(openToNextOpen(history, "fixture-a", 0), undefined, "D+2 may not look into the held-out period");
    writeFileSync(path, rows.map((r) => JSON.stringify(r.sessionDate >= "2026-08-27" ? { ...r, open: 1e20, close: -1e20 } : r)).join("\n") + "\n");
    const changed = await loadResearchData(root, "2026-08-25", "2026-08-27", 2);
    assert.deepEqual(changed.history.sessions, history.sessions);
    assert.deepEqual(changed.history.barsOn("2026-08-26"), history.barsOn("2026-08-26"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
