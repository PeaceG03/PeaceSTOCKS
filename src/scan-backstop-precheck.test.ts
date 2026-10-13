// Builder teaching example: the bash pre-check never skips a case planOpenScanAt would dispatch.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { planOpenScanAt } from "./scan-backstop";

const script = new URL("../scripts/scan-backstop-precheck.sh", import.meta.url).pathname;

function precheck(nowIso: string, ghCount: string | "fail"): string {
  const dir = mkdtempSync(join(tmpdir(), "pre-"));
  writeFileSync(join(dir, "gh"), ghCount === "fail" ? "#!/bin/sh\nexit 1\n" : `#!/bin/sh\necho ${ghCount}\n`);
  chmodSync(join(dir, "gh"), 0o755);
  const out = join(dir, "out");
  writeFileSync(out, "");
  execFileSync("bash", [script], { env: { PATH: `${dir}:${process.env.PATH}`, NOW_EPOCH: String(Date.parse(nowIso) / 1000), GITHUB_OUTPUT: out, GITHUB_REPOSITORY: "o/r" }, stdio: ["ignore", "ignore", "ignore"] });
  return readFileSync(out, "utf8").trim();
}

test("precheck: skips guard windows, early ticks, and slots a scheduled scan covered; errors fail open", () => {
  assert.equal(precheck("2026-10-13T12:11:00Z", "0"), "due=true");
  assert.equal(precheck("2026-10-13T12:11:00Z", "1"), "due=false");
  assert.equal(precheck("2026-10-13T10:00:00Z", "0"), "due=false");
  assert.equal(precheck("2026-10-13T05:40:00Z", "0"), "due=false");
  assert.equal(precheck("2026-10-13T07:47:00Z", "fail"), "due=true");
  assert.equal(precheck("2026-10-12T12:00:00Z", "0"), "due=true", "Monday looks back to Saturday 09:30");
});

test("precheck never says due=false where the full planner (no runs) would dispatch", () => {
  for (let h = 0; h < 7 * 24; h += 1) {
    const iso = new Date(Date.parse("2026-10-11T00:47:00Z") + h * 3_600_000).toISOString();
    if (planOpenScanAt(iso, []) === "dispatch") assert.equal(precheck(iso, "0"), "due=true", iso);
  }
});
