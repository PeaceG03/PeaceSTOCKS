/**
 * CI check: the research ledger is append-only against the base branch. The read-time anchor
 * (gitCommittedHead) compares with the head committed at HEAD, so a rewrite of a log and its head
 * file committed as a plain NEW commit passes it. This compares with the base instead: every log
 * whose head is committed on the base must still contain that head at the same seq (and verify as a
 * chain), every held-out marker committed on the base must still exist unchanged, and every
 * pre-registered config/doc committed in preregistration.jsonl on the base must remain unchanged.
 * Read-only git (show, ls-tree, merge-base, rev-parse) with an argv array, no shell, no network.
 * Usage (tests.yml): tsx src/research-ledger-check.ts origin/main
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { AppendOnlyLog, parseHead } from "./append-only-log";

export const LEDGER_REL = "research-ledger";
export const LEDGER_LOGS = ["variants.jsonl", "heldout.jsonl", "preregistration.jsonl"] as const;
export const LEDGER_BASE_REF_MISSING = "LEDGER_BASE_REF_MISSING";

const git = (top: string, args: string[]): string =>
  execFileSync("git", ["-C", top, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
const gitOr = (top: string, args: string[]): string | undefined => {
  try {
    return git(top, args);
  } catch {
    return undefined;
  }
};
const fileSha256 = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

function resolveCommit(top: string, ref: string): string {
  const sha = gitOr(top, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`])?.trim();
  if (!sha) throw new Error(`${LEDGER_BASE_REF_MISSING}:${ref}`);
  return sha;
}

/** The commit to compare with: the merge base of HEAD and the base branch (fails closed). */
export function ledgerCheckBase(top: string, baseRef: string): string {
  resolveCommit(top, baseRef);
  const base = gitOr(top, ["merge-base", "HEAD", baseRef])?.trim();
  if (!base) throw new Error(`${LEDGER_BASE_REF_MISSING}:no-merge-base:${baseRef}`);
  return base;
}

interface PreregisterEntry {
  type?: string;
  configPath?: string;
  configSha256?: string;
  docPath?: string;
  docSha256?: string;
}

/** Problems with the work tree's ledger against `baseRef` (empty = append-only). */
export function ledgerProblemsAgainstBase(top: string, baseRef: string): string[] {
  const base = resolveCommit(top, baseRef);
  const problems: string[] = [];
  for (const log of LEDGER_LOGS) {
    const committed = gitOr(top, ["show", `${base}:${LEDGER_REL}/${log}.head`]);
    if (committed === undefined) continue; // not on the base yet
    const head = parseHead(committed, `${log}.head@base`);
    const path = join(top, LEDGER_REL, log);
    if (!existsSync(path)) {
      problems.push(`${log}:missing`);
      continue;
    }
    let hashes: string[];
    try {
      hashes = new AppendOnlyLog<unknown>(path).read().map((line) => line.hash);
    } catch (error) {
      problems.push(`${log}:unreadable:${error instanceof Error ? error.message.split(":")[0] : "error"}`);
      continue;
    }
    if (hashes[head.seq] !== head.hash) problems.push(`${log}:base-head-not-in-chain:seq-${head.seq}`);
  }
  const basePreregRaw = gitOr(top, ["show", `${base}:${LEDGER_REL}/preregistration.jsonl`]);
  if (basePreregRaw !== undefined) {
    for (const line of basePreregRaw.split("\n").filter(Boolean)) {
      let parsed: { entry?: PreregisterEntry };
      try {
        parsed = JSON.parse(line) as { entry?: PreregisterEntry };
      } catch {
        continue;
      }
      const entry = parsed.entry;
      if (!entry || entry.type !== "PREREGISTER") continue;
      if (entry.configPath && entry.configSha256) {
        const cfgPath = join(top, entry.configPath);
        if (!existsSync(cfgPath) || fileSha256(cfgPath) !== entry.configSha256)
          problems.push(`preregistration:config-changed:${entry.configPath}`);
      }
      if (entry.docPath && entry.docSha256) {
        const docPath = join(top, entry.docPath);
        if (!existsSync(docPath) || fileSha256(docPath) !== entry.docSha256)
          problems.push(`preregistration:doc-changed:${entry.docPath}`);
      }
    }
  }
  const markers = (gitOr(top, ["ls-tree", "-r", "--name-only", base, "--", `${LEDGER_REL}/heldout-markers`]) ?? "")
    .split("\n")
    .filter(Boolean);
  for (const marker of markers) {
    const name = marker.slice(LEDGER_REL.length + 1);
    const path = join(top, marker);
    if (!existsSync(path)) problems.push(`${name}:missing`);
    else if (readFileSync(path, "utf8") !== git(top, ["show", `${base}:${marker}`])) problems.push(`${name}:changed`);
  }
  return problems;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const baseRef = process.argv[2] ?? "origin/main";
  const top = git(process.cwd(), ["rev-parse", "--show-toplevel"]).trim();
  const base = ledgerCheckBase(top, baseRef);
  const problems = ledgerProblemsAgainstBase(top, base);
  if (problems.length) {
    for (const problem of problems) console.log(`LEDGER_NOT_APPEND_ONLY:${problem}`);
    console.log(`::error title=Research ledger rewritten::the ledger no longer contains what ${baseRef} (merge base ${base.slice(0, 12)}) committed`);
    process.exitCode = 1;
  } else console.log(`research ledger: append-only against ${baseRef} (merge base ${base.slice(0, 12)})`);
}
