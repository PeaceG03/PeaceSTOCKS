import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AppendOnlyLog, LOG_TAMPERED, configHash, gitCommittedHead, headPath, stableJson } from "./append-only-log";

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
  writeFileSync(path, good);
  assert.equal(log.read().length, 3);
});

test("configHash is key-order independent and value sensitive", () => {
  assert.equal(configHash({ a: 1, b: { c: [1, 2], d: "x" } }), configHash({ b: { d: "x", c: [1, 2] }, a: 1 }));
  assert.notEqual(configHash({ a: 1 }), configHash({ a: 2 }));
  assert.equal(stableJson({ b: 1, a: undefined, c: null }), '{"b":1,"c":null}');
});

type Line = { seq: number; prev: string; at: string; entry: { p: number }; hash: string };
const rechain = (entries: Line[]): string => {
  let prev = "";
  return entries.map((l, seq) => {
    const hash = createHash("sha256").update(`${seq}|${prev}|${l.at}|${stableJson(l.entry)}`).digest("hex");
    const out = JSON.stringify({ seq, prev, at: l.at, entry: l.entry, hash });
    prev = hash;
    return `${out}\n`;
  }).join("");
};

test("the head file outside the log catches a truncated tail and a deleted middle line, even with the chain recomputed", () => {
  const path = fresh();
  const log = new AppendOnlyLog<{ p: number }>(path);
  for (const p of [0.5, 0.01, 0.2]) log.append({ p });
  assert.ok(existsSync(headPath(path)), "head file written beside the log");
  const good = readFileSync(path, "utf8");
  const lines = good.trimEnd().split("\n").map((l) => JSON.parse(l) as Line);
  // 1. Truncate the last line (a clean cut at a line boundary; the chain itself is still valid).
  writeFileSync(path, good.split("\n").slice(0, 2).join("\n") + "\n");
  assert.throws(() => log.read(), new RegExp(`${LOG_TAMPERED}.*head`));
  // 2. Delete the middle line and recompute every later hash and seq.
  writeFileSync(path, rechain([lines[0]!, lines[2]!]));
  assert.throws(() => log.read(), new RegExp(`${LOG_TAMPERED}.*head`));
  // 3. Delete the log (or empty it) while its head remains.
  writeFileSync(path, "");
  assert.throws(() => log.read(), new RegExp(`${LOG_TAMPERED}.*head`));
  // 4. Remove the head file next to a non-empty log.
  writeFileSync(path, good);
  rmSync(headPath(path));
  assert.throws(() => log.read(), new RegExp(`${LOG_TAMPERED}.*head`));
});

test("a crash between the line and the head write leaves the log readable (head one line behind) and the next append repairs it", () => {
  const path = fresh();
  const log = new AppendOnlyLog<{ p: number }>(path);
  log.append({ p: 0.5 });
  const head = readFileSync(headPath(path), "utf8");
  log.append({ p: 0.4 });
  writeFileSync(headPath(path), head); // as if the process died after appending line 1
  assert.equal(log.read().length, 2);
  log.append({ p: 0.3 });
  assert.equal((JSON.parse(readFileSync(headPath(path), "utf8")) as { seq: number }).seq, 2);
  // Two lines behind is not a crash window.
  writeFileSync(headPath(path), head);
  assert.throws(() => log.read(), new RegExp(`${LOG_TAMPERED}.*head`));
});

test("the committed head (git) anchors the log: rewriting both the log and its head file is still detected", () => {
  const repo = mkdtempSync(join(tmpdir(), "aol-git-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" });
  git("init", "-q");
  const path = join(repo, "ledger.jsonl");
  const anchored = () => new AppendOnlyLog<{ p: number }>(path, undefined, { anchor: () => gitCommittedHead(path) });
  for (const p of [0.5, 0.01, 0.2]) anchored().append({ p });
  git("add", "ledger.jsonl", "ledger.jsonl.head");
  git("commit", "-q", "-m", "ledger");
  assert.deepEqual(gitCommittedHead(path), JSON.parse(readFileSync(headPath(path), "utf8")));
  const good = readFileSync(path, "utf8");
  const lines = good.trimEnd().split("\n").map((l) => JSON.parse(l) as Line);
  // Legitimate growth after the commit is fine.
  anchored().append({ p: 0.3 });
  assert.equal(anchored().read().length, 4);
  // A forger drops the committed tip line, recomputes the chain and writes a matching head file.
  const forged = rechain([lines[0]!, lines[1]!]);
  writeFileSync(path, forged);
  const tip = JSON.parse(forged.trimEnd().split("\n").at(-1)!) as Line;
  writeFileSync(headPath(path), `${JSON.stringify({ seq: tip.seq, hash: tip.hash })}\n`);
  assert.equal(new AppendOnlyLog<{ p: number }>(path).read().length, 2, "without the anchor the forgery reads back");
  assert.throws(() => anchored().read(), new RegExp(`${LOG_TAMPERED}.*anchor`));
  // Deleting a middle line and re-chaining is caught the same way.
  const middleGone = rechain([lines[0]!, lines[2]!]);
  writeFileSync(path, middleGone);
  const tip2 = JSON.parse(middleGone.trimEnd().split("\n").at(-1)!) as Line;
  writeFileSync(headPath(path), `${JSON.stringify({ seq: tip2.seq, hash: tip2.hash })}\n`);
  assert.throws(() => anchored().read(), new RegExp(`${LOG_TAMPERED}.*anchor`));
  // Outside a git repo (or untracked) there is no committed head.
  assert.equal(gitCommittedHead(fresh()), undefined);
  rmSync(repo, { recursive: true, force: true });
});
