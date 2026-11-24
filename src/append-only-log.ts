/**
 * Append-only, hash-chained JSONL log for research records (variant log, held-out seal log).
 *
 * Every line is {seq, prev, at, entry, hash}: seq counts from 0, prev is the previous line's hash
 * ("" for the first), hash = sha256(seq|prev|at|stableJson(entry)). Reading verifies the whole chain,
 * so an edited, reordered or deleted line (including a truncated tail that cuts a line) is refused
 * as LOG_TAMPERED. Appending re-reads and re-verifies the file first and only ever opens it with
 * the "a" flag, so a record can never be rewritten through this module.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
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

export class AppendOnlyLog<T> {
  constructor(
    readonly path: string,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  /** Every line, verified. A missing file is an empty log. */
  read(): LogLine<T>[] {
    if (!existsSync(this.path)) return [];
    const text = readFileSync(this.path, "utf8");
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
    return line;
  }
}
