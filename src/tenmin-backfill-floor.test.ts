// Builder teaching example: stored-floor walk (read-only) and workflow wiring for scan + gap-refill.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { earliestStoredPairStart } from "./tenmin-backfill";

test("floor walk: stops at the first unsealed older pair, starts below the one-off pair, bounded", async () => {
  assert.equal(await earliestStoredPairStart(async () => false), "2024-09-01");
  const sealed = new Set(["2024-07-01", "2024-05-01"]);
  assert.equal(await earliestStoredPairStart(async (p) => sealed.has(p)), "2024-05-01");
  sealed.delete("2024-07-01");
  assert.equal(await earliestStoredPairStart(async (p) => sealed.has(p)), "2024-09-01", "a hole stops the walk");
  let calls = 0;
  assert.equal(await earliestStoredPairStart(async () => { calls += 1; return true; }, "2024-09-01", 3), "2024-03-01");
  assert.equal(calls, 3);
});

for (const [file, job] of [["scanner.yml", "scan"], ["gap-refill.yml", ""]] as const) {
  test(`${file}: floor -> probe (with earliest) -> decide, all always() + continue-on-error`, () => {
    let y = readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), "utf8");
    if (job) { const s = y.indexOf(`\n  ${job}:\n`); y = y.slice(s, s + 1 + y.slice(s + 1).search(/\n  [a-z_]+:\n/u)); }
    const a = y.indexOf("tenmin-backfill-cli.ts floor"), b = y.indexOf("src/massive-plan-probe.ts"), c = y.indexOf("tenmin-backfill-cli.ts decide");
    assert.ok(a > 0 && a < b && b < c, "order");
    assert.doesNotMatch(y.slice(y.lastIndexOf("- name:", a), c), /tenmin-backfill-cli\.ts (?!floor|decide)/u);
    for (const at of [a, b, c]) {
      const step = y.slice(y.lastIndexOf("- name:", at), at);
      assert.match(step, /continue-on-error: true/u);
      assert.match(step, /always\(\)/u);
    }
    assert.match(y.slice(y.lastIndexOf("- name:", b), b), /TENMIN_EARLIEST_STORED: \$\{\{ steps\.backfill_floor\.outputs\.earliest_stored \}\}/u);
  });
}
