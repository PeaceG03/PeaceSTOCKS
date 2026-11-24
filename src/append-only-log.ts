/**
 * Append-only, hash-chained JSONL log for research records (variant log, held-out seal log).
 *
 * Every line is {seq, prev, at, entry, hash}: seq counts from 0, prev is the previous line's hash
 * ("" for the first), hash = sha256(seq|prev|at|stableJson(entry)). Reading verifies the whole chain,
 * so an edited or reordered line, or a cut through a line, is refused as LOG_TAMPERED.
 *
 * The chain alone cannot see whole lines dropped from the end, or a deleted line with every later
 * hash recomputed (nothing in it is secret). So the log is anchored outside itself:
 *  - a head file `<log>.head` ({seq, hash} of the tip) is rewritten after every append. Reading
 *    requires the head's line to be in the chain with that hash, and the head to be the tip or one
 *    line behind it (a crash between the two writes; the next append repairs it). A truncated tail,
 *    a deleted-and-rechained middle line, an emptied log or a missing head file is LOG_TAMPERED.
 *  - the head file is meant to be committed. With an `anchor` (gitCommittedHead), reading also
 *    requires the committed head's line to be in the chain with that hash, so rewriting the log AND
 *    its head file together is still caught against git. Git history is the trust root: a forger
 *    who can also rewrite and commit git history is out of scope.
 * Appending re-reads and re-verifies first and only opens the log with the "a" flag.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, relative } from "node:path";
import { sha256 } from "./identity";

export const LOG_TAMPERED = "LOG_TAMPERED";

export interface LogLine<T> {
  seq: number;
  prev: string;
  at: string;
  entry: T;
  hash: string;
}

/** Key-sorted JSON (same object -> same text), used for hashing configs and entries. */
export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
}

export const configHash = (config: unknown): string => sha256(stableJson(config));

const lineHash = (seq: number, prev: string, at: string, entry: unknown): string =>
  sha256(`${seq}|${prev}|${at}|${stableJson(entry)}`);

export interface LogHead {
  seq: number;
  hash: string;
}

export const headPath = (path: string): string => `${path}.head`;

function parseHead(text: string, where: string): LogHead {
  try {
    const head = JSON.parse(text) as LogHead;
    if (Number.isInteger(head.seq) && head.seq >= 0 && typeof head.hash === "string" && /^[0-9a-f]{64}$/u.test(head.hash)) return head;
  } catch {
    // fall through
  }
  throw new Error(`${LOG_TAMPERED}:${where}:head-unreadable`);
}

/**
 * The head file as committed at git HEAD, or undefined when the log is not in a git work tree or
 * its head file is not committed. Read-only (`git show`), no network.
 */
export function gitCommittedHead(path: string): LogHead | undefined {
  const head = headPath(path);
  let top: string;
  try {
    top = execFileSync("git", ["-C", dirname(head), "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
  let text: string;
  try {
    text = execFileSync("git", ["-C", top, "show", `HEAD:${relative(top, head).split("\\").join("/")}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return undefined; // not committed yet
  }
  return parseHead(text, `${basename(head)}@git`);
}

export interface AppendOnlyLogOptions {
  /** A head recorded outside this machine's control (e.g. gitCommittedHead); must be in the chain. */
  anchor?: () => LogHead | undefined;
}

export class AppendOnlyLog<T> {
  constructor(
    readonly path: string,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly options: AppendOnlyLogOptions = {},
  ) {}

  private checkHeads(lines: readonly LogLine<T>[]): void {
    const at = (head: LogHead) => lines[head.seq]?.hash === head.hash;
    const hp = headPath(this.path);
    const head = existsSync(hp) ? parseHead(readFileSync(hp, "utf8"), this.path) : undefined;
    if (!head && lines.length) throw new Error(`${LOG_TAMPERED}:${this.path}:head-missing`);
    if (head && !at(head)) throw new Error(`${LOG_TAMPERED}:${this.path}:head-not-in-chain`);
    if (head && head.seq < lines.length - 2) throw new Error(`${LOG_TAMPERED}:${this.path}:head-behind`);
    const anchor = this.options.anchor?.();
    if (anchor && !at(anchor)) throw new Error(`${LOG_TAMPERED}:${this.path}:anchor-not-in-chain`);
  }

  /** Every line, verified. A missing file is an empty log. */
  read(): LogLine<T>[] {
    const text = existsSync(this.path) ? readFileSync(this.path, "utf8") : "";
    if (text.length && !text.endsWith("\n")) throw new Error(`${LOG_TAMPERED}:${this.path}:partial-last-line`);
    const lines = text.split("\n").filter((line) => line.length > 0);
    const out: LogLine<T>[] = [];
    let prev = "";
    for (const [k, raw] of lines.entries()) {
      let line: LogLine<T>;
      try {
        line = JSON.parse(raw) as LogLine<T>;
      } catch {
        throw new Error(`${LOG_TAMPERED}:${this.path}:line-${k}-not-json`);
      }
      if (line.seq !== k || line.prev !== prev || line.hash !== lineHash(line.seq, line.prev, line.at, line.entry))
        throw new Error(`${LOG_TAMPERED}:${this.path}:line-${k}`);
      prev = line.hash;
      out.push(line);
    }
    this.checkHeads(out);
    return out;
  }

  entries(): T[] {
    return this.read().map((line) => line.entry);
  }

  append(entry: T): LogLine<T> {
    const lines = this.read();
    const seq = lines.length;
    const prev = lines.at(-1)?.hash ?? "";
    const at = this.now();
    const line: LogLine<T> = { seq, prev, at, entry, hash: lineHash(seq, prev, at, entry) };
    appendFileSync(this.path, `${JSON.stringify(line)}\n`, { flag: "a" });
    const hp = headPath(this.path);
    writeFileSync(`${hp}.tmp`, `${JSON.stringify({ seq, hash: line.hash } satisfies LogHead)}\n`);
    renameSync(`${hp}.tmp`, hp);
    return line;
  }
}
