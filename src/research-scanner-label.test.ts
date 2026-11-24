import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { stableJson } from "./append-only-log";
import { SCANNER_VERSION } from "./contracts";
import { ELIGIBILITY_FLOOR } from "./eligibility-floor";
import { DEFAULT_SCANNER_CONFIG, STOCK_LIST_ASSET_TYPE } from "./ranking";
import { researchMain } from "./research-harness-cli";
import { writeSyntheticStore } from "./research-fixture";
import { deriveScannerLabel, scannerConfigHash } from "./research-scanner-label";

const git = (dir: string, ...args: string[]) =>
  execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" });

test("config hash covers the scanner version, ranking config, list asset type and eligibility floor", () => {
  const expected = createHash("sha256")
    .update(stableJson({ scannerVersion: SCANNER_VERSION, scannerConfig: DEFAULT_SCANNER_CONFIG, stockListAssetType: STOCK_LIST_ASSET_TYPE, eligibilityFloor: ELIGIBILITY_FLOOR }))
    .digest("hex")
    .slice(0, 12);
  assert.equal(scannerConfigHash(), expected);
  assert.match(scannerConfigHash(), /^[0-9a-f]{12}$/u);
});

test("label = commit + scanner version + config hash; refused when src/ or config/ is dirty or there is no git", () => {
  const dir = mkdtempSync(join(tmpdir(), "label-"));
  try {
    mkdirSync(join(dir, "src"));
    mkdirSync(join(dir, "config"));
    writeFileSync(join(dir, "src", "a.ts"), "export {};\n");
    writeFileSync(join(dir, "config", "c.json"), "{}\n");
    assert.throws(() => deriveScannerLabel(dir), /SCANNER_LABEL_NEEDS_GIT/u);
    git(dir, "init", "-q");
    assert.throws(() => deriveScannerLabel(dir), /SCANNER_LABEL_NEEDS_GIT/u); // no commit yet
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "c");
    const sha = git(dir, "rev-parse", "HEAD").trim();
    const label = deriveScannerLabel(dir);
    assert.equal(label, `${sha.slice(0, 12)} ${SCANNER_VERSION} config-${scannerConfigHash()}`);
    assert.notEqual(label, "main@f1605fe7 scanner-config-v0.1");
    writeFileSync(join(dir, "notes.md"), "outside src/ and config/ does not matter\n");
    assert.equal(deriveScannerLabel(dir), label);
    writeFileSync(join(dir, "src", "a.ts"), "export const x = 1;\n");
    assert.throws(() => deriveScannerLabel(dir), /SCANNER_TREE_DIRTY/u);
    git(dir, "checkout", "-q", "--", "src");
    writeFileSync(join(dir, "config", "new.json"), "{}\n"); // untracked counts too
    assert.throws(() => deriveScannerLabel(dir), /SCANNER_TREE_DIRTY/u);
    rmSync(join(dir, "config", "new.json"));
    git(dir, "commit", "-q", "--allow-empty", "-m", "next");
    assert.notEqual(deriveScannerLabel(dir), label); // a new commit is a new label
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the CLI stamps the derived label (or refuses with its error) when no label is injected", async () => {
  let expected: string | Error;
  try {
    expected = deriveScannerLabel();
  } catch (error) {
    expected = error as Error;
  }
  const root = mkdtempSync(join(tmpdir(), "label-cli-"));
  const ledgerDir = join(root, "ledger");
  const args = [
    "baseline", "--data", root, "--out", join(root, "out"), "--from", "2025-04-01", "--heldout-from", "2025-08-01", "--heldout-to", "2025-08-29",
    "--train", "20", "--test", "20", "--embargo", "1", "--min-bars", "1",
  ];
  try {
    writeSyntheticStore(root, { from: "2025-01-01", to: "2025-08-29" });
    if (expected instanceof Error) {
      await assert.rejects(researchMain(args, { ledgerDir }), { message: expected.message });
    } else {
      await researchMain(args, { ledgerDir });
      const report = JSON.parse(readFileSync(join(root, "out", "baseline.json"), "utf8")) as { scanner: string };
      assert.equal(report.scanner, expected);
      const scanners = readFileSync(join(ledgerDir, "heldout.jsonl"), "utf8").match(/"scanner":"[^"]*"/gu) ?? [];
      assert.ok(scanners.length === 5 && scanners.every((s) => s === `"scanner":"${expected as string}"`));
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
