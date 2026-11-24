// CI check: the branch's research ledger still contains main's committed head (append-only against
// the base). The local anchor (gitCommittedHead) only compares with the head committed at HEAD, so a
// rewrite of the log and its head file committed as a NEW commit passed it. This check compares with
// the base branch instead.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AppendOnlyLog } from "./append-only-log";
import { ledgerCheckBase, ledgerProblemsAgainstBase } from "./research-ledger-check";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** A repo whose "main" commit has a 3-line variants log, a 1-line seal log and one marker. */
function repo(): { dir: string; ledger: string; variants: string } {
  const dir = mkdtempSync(join(tmpdir(), "ledger-check-"));
  git(dir, "init", "-q", "-b", "main");
  const ledger = join(dir, "research-ledger");
  mkdirSync(join(ledger, "heldout-markers"), { recursive: true });
  const variants = join(ledger, "variants.jsonl");
  const v = new AppendOnlyLog<{ n: number }>(variants, () => "2026-01-01T00:00:00.000Z");
  for (const n of [0, 1, 2]) v.append({ n });
  new AppendOnlyLog<{ r: number }>(join(ledger, "heldout.jsonl"), () => "2026-01-01T00:00:00.000Z").append({ r: 0 });
  writeFileSync(join(ledger, "heldout-markers", "h.0.json"), "{\"look\":0}\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  git(dir, "branch", "base");
  return { dir, ledger, variants };
}

/** Rewrites the variants log to the given entries (fresh chain + head), as a forger would. */
function rewrite(variants: string, entries: number[]): void {
  rmSync(variants);
  rmSync(`${variants}.head`);
  const v = new AppendOnlyLog<{ n: number }>(variants, () => "2026-01-02T00:00:00.000Z");
  for (const n of entries) v.append({ n });
}

test("ledger check: appending on the branch passes", () => {
  const { dir, variants } = repo();
  try {
    new AppendOnlyLog<{ n: number }>(variants).append({ n: 3 });
    git(dir, "commit", "-qam", "append");
    assert.deepEqual(ledgerProblemsAgainstBase(dir, "base"), []);
    assert.deepEqual(ledgerProblemsAgainstBase(dir, "HEAD"), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("ledger check: a rewrite of log + head committed as a new commit is refused (truncation, re-chain)", () => {
  for (const entries of [[0, 1], [0, 2], [0, 1, 2, 3].map((n) => n * 10)]) {
    const { dir, variants } = repo();
    try {
      rewrite(variants, entries);
      git(dir, "commit", "-qam", "plain new commit");
      const problems = ledgerProblemsAgainstBase(dir, "base");
      assert.equal(problems.length, 1, JSON.stringify(problems));
      assert.match(problems[0]!, /^variants\.jsonl:base-head-not-in-chain/u);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test("ledger check: a deleted log, a tampered line, or a deleted / edited held-out marker is refused", () => {
  const cases: Array<[string, (r: ReturnType<typeof repo>) => void, RegExp]> = [
    ["log deleted", (r) => { unlinkSync(r.variants); unlinkSync(`${r.variants}.head`); }, /^variants\.jsonl:missing/u],
    ["line edited", (r) => writeFileSync(r.variants, readFileSync(r.variants, "utf8").replace("\"n\":1", "\"n\":9")), /^variants\.jsonl:unreadable:LOG_TAMPERED/u],
    ["marker deleted", (r) => unlinkSync(join(r.ledger, "heldout-markers", "h.0.json")), /^heldout-markers\/h\.0\.json:missing/u],
    ["marker edited", (r) => writeFileSync(join(r.ledger, "heldout-markers", "h.0.json"), "{}\n"), /^heldout-markers\/h\.0\.json:changed/u],
  ];
  for (const [name, mutate, want] of cases) {
    const r = repo();
    try {
      mutate(r);
      const problems = ledgerProblemsAgainstBase(r.dir, "base");
      assert.ok(problems.some((p) => want.test(p)), `${name}: ${JSON.stringify(problems)}`);
    } finally { rmSync(r.dir, { recursive: true, force: true }); }
  }
});

test("ledger check: a base without a ledger passes; a missing base ref fails closed", () => {
  const dir = mkdtempSync(join(tmpdir(), "ledger-check-"));
  try {
    git(dir, "init", "-q", "-b", "main");
    writeFileSync(join(dir, "x"), "x\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "no ledger");
    assert.deepEqual(ledgerProblemsAgainstBase(dir, "main"), []);
    assert.throws(() => ledgerProblemsAgainstBase(dir, "origin/main"), /LEDGER_BASE_REF_MISSING/u);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("this repository's ledger is append-only against its own HEAD", () => {
  const top = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  assert.deepEqual(ledgerProblemsAgainstBase(top, "HEAD"), []);
});

test("CI (tests.yml) checks out full history and runs the ledger check against main, read-only", () => {
  const yml = readFileSync(new URL("../.github/workflows/tests.yml", import.meta.url), "utf8");
  assert.match(yml, /- uses: actions\/checkout@v4\n {8}with:\n {10}fetch-depth: 0\n/u);
  assert.match(yml, /run: pnpm -s exec tsx src\/research-ledger-check\.ts origin\/main\n/u);
  assert.match(yml, /permissions:\n {2}contents: read\n/u);
  assert.doesNotMatch(yml, /secrets\./u);
});

test("CLI: compares with the merge base of HEAD and the base branch (a branch behind main is not flagged)", () => {
  const { dir, variants } = repo();
  try {
    git(dir, "checkout", "-q", "-b", "feature");
    git(dir, "checkout", "-q", "main");
    new AppendOnlyLog<{ n: number }>(variants).append({ n: 3 }); // main moves on
    git(dir, "commit", "-qam", "main append");
    git(dir, "checkout", "-q", "feature");
    assert.equal(ledgerCheckBase(dir, "main"), git(dir, "rev-parse", "base").trim());
    assert.deepEqual(ledgerProblemsAgainstBase(dir, ledgerCheckBase(dir, "main")), []);
    // A forged rewrite on the feature branch is still refused against that merge base.
    rewrite(variants, [0, 1]);
    git(dir, "commit", "-qam", "rewrite");
    assert.equal(ledgerProblemsAgainstBase(dir, ledgerCheckBase(dir, "main")).length, 1);
    assert.throws(() => ledgerCheckBase(dir, "nope"), /LEDGER_BASE_REF_MISSING/u);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("ledger check: a log not yet on the base is skipped without skipping the other log", () => {
  const { dir, ledger } = repo();
  try {
    git(dir, "rm", "-q", "research-ledger/variants.jsonl", "research-ledger/variants.jsonl.head");
    git(dir, "commit", "-qm", "base without variants");
    git(dir, "branch", "-f", "base");
    const seal = join(ledger, "heldout.jsonl");
    rmSync(seal);
    rmSync(`${seal}.head`);
    new AppendOnlyLog<{ r: number }>(seal, () => "2026-01-02T00:00:00.000Z").append({ r: 9 });
    git(dir, "commit", "-qam", "rewrite the seal");
    assert.deepEqual(ledgerProblemsAgainstBase(dir, "base"), ["heldout.jsonl:base-head-not-in-chain:seq-0"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("ledger check CLI: exit 0 when append-only, exit 1 with the problems when not", () => {
  const tsx = new URL("../node_modules/.bin/tsx", import.meta.url).pathname;
  const cli = new URL("./research-ledger-check.ts", import.meta.url).pathname;
  const { dir, variants } = repo();
  try {
    const ok = execFileSync(tsx, [cli, "base"], { cwd: dir, encoding: "utf8" });
    assert.match(ok, /append-only against base/u);
    rewrite(variants, [0, 1]);
    git(dir, "commit", "-qam", "rewrite");
    let status = 0;
    let stdout = "";
    try {
      execFileSync(tsx, [cli, "base"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      ({ status, stdout } = error as { status: number; stdout: string });
    }
    assert.equal(status, 1);
    assert.match(stdout, /LEDGER_NOT_APPEND_ONLY:variants\.jsonl:base-head-not-in-chain/u);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("ledger check: preregistration config, doc, and preregistration.jsonl are immutable against base", async () => {
  const { createHash } = await import("node:crypto");
  const r = repo();
  try {
    mkdirSync(join(r.dir, "config"), { recursive: true });
    mkdirSync(join(r.dir, "docs"), { recursive: true });
    const cfg = join(r.dir, "config", "research-preregistration-v1.json");
    const doc = join(r.dir, "docs", "RESEARCH_PREREGISTRATION.md");
    writeFileSync(cfg, "{\"version\":\"research-preregistration-v1\",\"candidates\":[{\"id\":\"a\"}]}\n");
    writeFileSync(doc, "# Prereg\n");
    const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
    const preregLog = new AppendOnlyLog<Record<string, unknown>>(join(r.ledger, "preregistration.jsonl"), () => "2026-01-01T00:00:00.000Z");
    preregLog.append({ type: "PEEK_DISCLOSURE", window: { from: "2026-08-27", to: "2026-11-20" } });
    preregLog.append({
      type: "PREREGISTER",
      version: "research-preregistration-v1",
      configPath: "config/research-preregistration-v1.json",
      configSha256: sha(cfg),
      docPath: "docs/RESEARCH_PREREGISTRATION.md",
      docSha256: sha(doc),
      candidateCount: 1,
    });
    git(r.dir, "add", "-A");
    git(r.dir, "commit", "-q", "-m", "with prereg");
    git(r.dir, "branch", "-f", "base");

    assert.deepEqual(ledgerProblemsAgainstBase(r.dir, "base"), []);

    // Editing config fails check
    writeFileSync(cfg, "{\"version\":\"research-preregistration-v1\",\"candidates\":[{\"id\":\"b\"}]}\n");
    assert.ok(ledgerProblemsAgainstBase(r.dir, "base").some((p) => /preregistration:config-changed/u.test(p)));
    git(r.dir, "checkout", "--", "config/research-preregistration-v1.json");

    // Editing doc fails check
    writeFileSync(doc, "# Tampered\n");
    assert.ok(ledgerProblemsAgainstBase(r.dir, "base").some((p) => /preregistration:doc-changed/u.test(p)));
    git(r.dir, "checkout", "--", "docs/RESEARCH_PREREGISTRATION.md");

    // Rewriting preregistration.jsonl fails check
    rmSync(join(r.ledger, "preregistration.jsonl"));
    rmSync(join(r.ledger, "preregistration.jsonl.head"));
    new AppendOnlyLog<Record<string, unknown>>(join(r.ledger, "preregistration.jsonl")).append({ type: "PEEK_DISCLOSURE" });
    assert.ok(ledgerProblemsAgainstBase(r.dir, "base").some((p) => /preregistration\.jsonl:base-head-not-in-chain/u.test(p)));
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
  }
});
