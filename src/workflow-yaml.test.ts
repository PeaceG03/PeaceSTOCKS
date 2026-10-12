import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

// Guard for the c1ae8cb class of bug: a plain (unquoted) YAML scalar containing ": " makes GitHub reject the whole
// workflow file. Checks every `key: value` line outside block scalars (run: | ...) and comments.
const dir = new URL("../.github/workflows/", import.meta.url);
test("every workflow: no unquoted scalar value contains ': ', no tabs", () => {
  const bad: string[] = [];
  for (const f of readdirSync(dir).filter((n) => /\.ya?ml$/u.test(n))) {
    const lines = readFileSync(new URL(f, dir), "utf8").split("\n");
    let blockIndent = -1;
    lines.forEach((line, i) => {
      if (/\t/u.test(line)) bad.push(`${f}:${i + 1} tab`);
      const indent = line.search(/\S/u);
      if (blockIndent >= 0) { if (indent === -1 || indent > blockIndent) return; blockIndent = -1; }
      const m = /^(\s*)(?:- )?([A-Za-z0-9_.-]+):\s+(.*)$/u.exec(line);
      if (!m) return;
      const value = m[3]!.replace(/\s+#.*$/u, "");
      if (/^[|>]/u.test(value)) { blockIndent = m[1]!.length; return; }
      if (/^["'[{]/u.test(value)) return;
      if (/: /u.test(value)) bad.push(`${f}:${i + 1}`);
    });
  }
  assert.deepEqual(bad, []);
});
