/**
 * The scanner label stamped into every research variant is DERIVED, never typed: the git commit the
 * harness runs from plus a hash of the scanner configuration it ranks with. A free-text label could be
 * reused for different code (folding two scanners into one Holm family entry) or mistyped; this one
 * changes whenever the code or the config does. Refused on an uncommitted src/ or config/ change,
 * because then the commit would not describe the code that ran. The derived form can never equal the
 * hand-typed label of the harness-v1 baseline ("main@f1605fe7 scanner-config-v0.1"). Read-only git, argv array, no shell.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { stableJson } from "./append-only-log";
import { SCANNER_VERSION } from "./contracts";
import { ELIGIBILITY_FLOOR } from "./eligibility-floor";
import { DEFAULT_SCANNER_CONFIG, STOCK_LIST_ASSET_TYPE } from "./ranking";

export const SCANNER_LABEL_IS_DERIVED = "SCANNER_LABEL_IS_DERIVED";
export const SCANNER_LABEL_NEEDS_GIT = "SCANNER_LABEL_NEEDS_GIT";
export const SCANNER_TREE_DIRTY = "SCANNER_TREE_DIRTY";

const REPO_TOP = fileURLToPath(new URL("..", import.meta.url));

/** Hash of everything the harness's scanner ranking is configured by (not the code: that is the sha). */
export function scannerConfigHash(): string {
  const config = {
    scannerVersion: SCANNER_VERSION,
    scannerConfig: DEFAULT_SCANNER_CONFIG,
    stockListAssetType: STOCK_LIST_ASSET_TYPE,
    eligibilityFloor: ELIGIBILITY_FLOOR,
  };
  return createHash("sha256").update(stableJson(config)).digest("hex").slice(0, 12);
}

/** `<12-char commit> <scanner version> config-<12-char config hash>`, from a clean src/ and config/. */
export function deriveScannerLabel(top: string = REPO_TOP): string {
  const git = (args: string[]) =>
    execFileSync("git", ["-C", top, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  let sha: string;
  let dirty: string;
  try {
    sha = git(["rev-parse", "--verify", "HEAD^{commit}"]).trim();
    dirty = git(["status", "--porcelain", "--untracked-files=all", "--", "src", "config"]).trim();
  } catch {
    throw new Error(SCANNER_LABEL_NEEDS_GIT);
  }
  if (!/^[0-9a-f]{40}$/u.test(sha)) throw new Error(SCANNER_LABEL_NEEDS_GIT);
  if (dirty) throw new Error(`${SCANNER_TREE_DIRTY}:${dirty.split("\n").length}-paths`);
  return `${sha.slice(0, 12)} ${SCANNER_VERSION} config-${scannerConfigHash()}`;
}
