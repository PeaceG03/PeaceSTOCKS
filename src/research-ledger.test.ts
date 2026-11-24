// The variant log and the held-out seal live in ONE pinned ledger, not in --out: a fresh --out
// folder can neither reset the Holm family nor reopen / re-register the seal.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AppendOnlyLog, gitCommittedHead, stableJson } from "./append-only-log";
import { RESEARCH_LEDGER_DIR, researchMain } from "./research-harness-cli";
import type { VariantRecord } from "./research-variants";
import { writeSyntheticStore } from "./research-fixture";

const base = (root: string, out: string, scanner: string, heldOutTo = "2025-08-29") => [
  "baseline", "--data", root, "--out", out, "--from", "2025-04-01", "--heldout-from", "2025-08-01", "--heldout-to", heldOutTo,
  "--train", "20", "--test", "20", "--embargo", "1", "--scanner", scanner, "--min-bars", "1",
];
const report = (out: string) => JSON.parse(readFileSync(join(out, "baseline.json"), "utf8")) as { variantsTried: number; results: Array<{ familySize: number }> };
const lines = (path: string) => readFileSync(path, "utf8").trimEnd().split("\n").length;

test("a new --out folder neither resets the variant count / Holm family nor the held-out seal", async () => {
  const root = mkdtempSync(join(tmpdir(), "research-ledger-"));
  const ledgerDir = join(root, "ledger");
  try {
    writeSyntheticStore(root, { from: "2025-01-01", to: "2025-08-29" });
    await researchMain(base(root, join(root, "out1"), "scanner-a"), { ledgerDir });
    assert.equal(report(join(root, "out1")).variantsTried, 5);
    // Same experiment, brand-new output folder: same 5 variants, the log keeps growing in the ledger.
    await researchMain(base(root, join(root, "out2"), "scanner-a"), { ledgerDir });
    assert.equal(report(join(root, "out2")).variantsTried, 5);
    assert.equal(lines(join(ledgerDir, "variants.jsonl")), 10);
    // New scanner code, another fresh folder: 10 variants tried, every result corrected for 10.
    await researchMain(base(root, join(root, "out3"), "scanner-b"), { ledgerDir });
    assert.equal(report(join(root, "out3")).variantsTried, 10);
    assert.ok(report(join(root, "out3")).results.every((r) => r.familySize === 10));
    // The seal is the ledger's: 10 registrations (re-running scanner-a registers nothing new) ...
    assert.equal(lines(join(ledgerDir, "heldout.jsonl")), 10);
    // ... and moving the held-out window is refused even from a fresh folder.
    await assert.rejects(researchMain(base(root, join(root, "out4"), "scanner-a", "2025-08-28"), { ledgerDir }), /HELD_OUT_WINDOW_CHANGED/u);
    for (const out of ["out1", "out2", "out3"]) assert.deepEqual(readdirSync(join(root, out)).filter((f) => /jsonl|head|marker/u.test(f)), [], `${out} holds no log`);
    assert.ok(existsSync(join(ledgerDir, "variants.jsonl.head")) && existsSync(join(ledgerDir, "heldout.jsonl.head")));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the CLI's ledger is pinned in the repository (research-ledger/), and no argument moves it", async () => {
  assert.equal(RESEARCH_LEDGER_DIR, new URL("../research-ledger/", import.meta.url).pathname.replace(/\/$/u, ""));
  for (const flag of ["--ledger", "--variants", "--seal"])
    await assert.rejects(researchMain(["baseline", "--out", tmpdir(), flag, "x"]), /LEDGER_IS_PINNED/u, flag);
});

test("the committed ledger carries the harness-v1 baseline and verifies against its committed heads", () => {
  for (const [file, min] of [["variants.jsonl", 5], ["heldout.jsonl", 5]] as const) {
    const path = join(RESEARCH_LEDGER_DIR, file);
    const read = new AppendOnlyLog(path, undefined, { anchor: () => gitCommittedHead(path) }).read();
    assert.ok(read.length >= min, `${file}: ${read.length}`);
  }
});

test("the CLI's Holm family counts every candidate variant in the ledger, not just the strategies", async () => {
  const root = mkdtempSync(join(tmpdir(), "research-family-"));
  const ledgerDir = join(root, "ledger");
  try {
    writeSyntheticStore(root, { from: "2025-01-01", to: "2025-08-29" });
    mkdirSync(ledgerDir, { recursive: true });
    // An earlier experiment: ONE strategy that tried THREE candidate variants inside it.
    const earlier = new AppendOnlyLog<VariantRecord>(join(ledgerDir, "variants.jsonl"));
    const none = { sessions: 0, mean: 0, t: 0, p: 1 };
    earlier.append({
      strategyHash: "earlier-multi-candidate", name: "EARLIER", candidateHashes: ["v1", "v2", "v3"], folds: [],
      pooled: { sessions: 0, meanGross: 0, meanNet: 0, meanCost: 0, meanTurnover: 0, meanUniverse: 0, meanSpy: 0, excessUniverse: none, excessSpy: none, sharpeNet: 0 },
      pooledP: 1,
    });
    await researchMain(base(root, join(root, "out"), "scanner-a"), { ledgerDir });
    const r = report(join(root, "out"));
    assert.equal(r.variantsTried, 8); // 3 earlier + 5 now
    assert.ok(r.results.every((x) => x.familySize === 8), JSON.stringify(r.results.map((x) => x.familySize))); // 6 strategies, 8 variants
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the CLI reads its ledger against the committed heads: rewriting a committed log and its head file is refused", async () => {
  const root = mkdtempSync(join(tmpdir(), "research-anchor-"));
  const ledgerDir = join(root, "repo", "research-ledger");
  const git = (...args: string[]) => execFileSync("git", ["-C", join(root, "repo"), "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" });
  try {
    writeSyntheticStore(root, { from: "2025-01-01", to: "2025-08-29" });
    mkdirSync(ledgerDir, { recursive: true });
    git("init", "-q");
    await researchMain(base(root, join(root, "out1"), "scanner-a"), { ledgerDir });
    git("add", "research-ledger");
    git("commit", "-q", "-m", "ledger");
    // Drop the last variant record, re-chain, and write a matching head file (no git change).
    const path = join(ledgerDir, "variants.jsonl");
    const kept = readFileSync(path, "utf8").trimEnd().split("\n").slice(0, -1).map((l) => JSON.parse(l) as { at: string; entry: unknown });
    let prev = "";
    const text = kept.map((l, seq) => {
      const hash = createHash("sha256").update(`${seq}|${prev}|${l.at}|${stableJson(l.entry)}`).digest("hex");
      const line = JSON.stringify({ seq, prev, at: l.at, entry: l.entry, hash });
      prev = hash;
      return `${line}\n`;
    }).join("");
    writeFileSync(path, text);
    writeFileSync(`${path}.head`, `${JSON.stringify({ seq: kept.length - 1, hash: prev })}\n`);
    await assert.rejects(researchMain(base(root, join(root, "out2"), "scanner-a"), { ledgerDir }), /LOG_TAMPERED.*anchor/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("A9: with no injected ledger the CLI uses the repository ledger (research-ledger/), never --out", async () => {
  // Same TOP_15_OVERALL config the committed seal registered, but a different held-out window: the
  // committed seal must refuse it before any data is read. Were the ledger defaulted to --out (an
  // empty folder), registration would succeed and the run would fail later on the missing data.
  const out = mkdtempSync(join(tmpdir(), "a9-out-"));
  const files = ["variants.jsonl", "variants.jsonl.head", "heldout.jsonl", "heldout.jsonl.head"];
  const before = files.map((f) => readFileSync(join(RESEARCH_LEDGER_DIR, f), "utf8"));
  try {
    await assert.rejects(
      researchMain([
        "baseline", "--data", join(out, "no-data"), "--out", out, "--scanner", "main@f1605fe7 scanner-config-v0.1",
        "--from", "2025-03-03", "--heldout-from", "2026-08-27", "--heldout-to", "2026-11-19",
        "--bps", "10", "--train", "63", "--test", "63", "--embargo", "2", "--mode", "rolling",
      ]),
      /HELD_OUT_WINDOW_CHANGED/u,
    );
    assert.deepEqual(files.map((f) => readFileSync(join(RESEARCH_LEDGER_DIR, f), "utf8")), before);
    assert.deepEqual(readdirSync(out), []); // no ledger or results written to --out
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
