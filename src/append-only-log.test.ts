import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AppendOnlyLog, LOG_TAMPERED, configHash, stableJson } from "./append-only-log";

const fresh = () => join(mkdtempSync(join(tmpdir(), "aol-")), "log.jsonl");

test("append keeps every earlier record and chains them", () => {
  const path = fresh();
  const log = new AppendOnlyLog<{ n: number }>(path, () => "2026-11-24T00:00:00.000Z");
  log.append({ n: 1 });
  log.append({ n: 2 });
  // A second writer on the same file appends after both, never over them.
  new AppendOnlyLog<{ n: number }>(path).append({ n: 3 });
  assert.deepEqual(log.entries(), [{ n: 1 }, { n: 2 }, { n: 3 }]);
  const lines = log.read();
  assert.deepEqual(lines.map((l) => l.seq), [0, 1, 2]);
  assert.equal(lines[0]!.prev, "");
  assert.equal(lines[1]!.prev, lines[0]!.hash);
  assert.equal(lines[2]!.prev, lines[1]!.hash);
});

test("an edited, deleted or reordered record is refused, and so is appending to a tampered log", () => {
  const path = fresh();
  const log = new AppendOnlyLog<{ p: number }>(path);
  log.append({ p: 0.5 });
  log.append({ p: 0.01 });
  log.append({ p: 0.2 });
  const good = readFileSync(path, "utf8");
  const rows = good.trimEnd().split("\n");
  writeFileSync(path, good.replace('"p":0.5', '"p":0.04'));
  assert.throws(() => log.read(), new RegExp(LOG_TAMPERED));
  assert.throws(() => log.append({ p: 0.3 }), new RegExp(LOG_TAMPERED));
  writeFileSync(path, `${rows[0]}\n${rows[2]}\n`);
  assert.throws(() => log.read(), new RegExp(LOG_TAMPERED));
  writeFileSync(path, `${rows[1]}\n${rows[0]}\n${rows[2]}\n`);
  assert.throws(() => log.read(), new RegExp(LOG_TAMPERED));
  // A forger who knows the scheme rewrites the middle record and recomputes its own hash: the next
  // record's link (prev) no longer matches, so the chain refuses it.
  const middle = JSON.parse(rows[1]!) as { seq: number; prev: string; at: string; entry: { p: number }; hash: string };
  middle.entry = { p: 0.0001 };
  middle.hash = createHash("sha256").update(`${middle.seq}|${middle.prev}|${middle.at}|${stableJson(middle.entry)}`).digest("hex");
  writeFileSync(path, `${rows[0]}\n${JSON.stringify(middle)}\n${rows[2]}\n`);
  assert.throws(() => log.read(), new RegExp(`${LOG_TAMPERED}.*line-2`));
  writeFileSync(path, good.slice(0, -5));
  assert.throws(() => log.read(), new RegExp(LOG_TAMPERED));
  // Dropping whole lines from the end is detectable only against a known count; the variant
  // log reports its count in every result, and the seal log refuses on a missing REGISTER.
  writeFileSync(path, good);
  assert.equal(log.read().length, 3);
});

test("configHash is key-order independent and value sensitive", () => {
  assert.equal(configHash({ a: 1, b: { c: [1, 2], d: "x" } }), configHash({ b: { d: "x", c: [1, 2] }, a: 1 }));
  assert.notEqual(configHash({ a: 1 }), configHash({ a: 2 }));
  assert.equal(stableJson({ b: 1, a: undefined, c: null }), '{"b":1,"c":null}');
});
