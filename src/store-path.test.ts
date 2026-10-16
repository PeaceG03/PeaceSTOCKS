import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertSafeStoreFile } from "./store-path";

const base = () => mkdtempSync(join(tmpdir(), "store-path-"));

test("assertSafeStoreFile: plain new and existing files under real directories pass", () => {
  const dir = base();
  assertSafeStoreFile(join(dir, "a", "b", "new.json"), "BAD");
  writeFileSync(join(dir, "f.json"), "{}");
  assertSafeStoreFile(join(dir, "f.json"), "BAD");
});

test("assertSafeStoreFile: a symlinked ancestor is refused", () => {
  const dir = base();
  mkdirSync(join(dir, "real"));
  symlinkSync(join(dir, "real"), join(dir, "link"));
  assert.throws(() => assertSafeStoreFile(join(dir, "link", "x.json"), "BAD"), /BAD/u);
});

test("assertSafeStoreFile: a file used as an ancestor directory is refused", () => {
  const dir = base();
  writeFileSync(join(dir, "plain"), "x");
  assert.throws(() => assertSafeStoreFile(join(dir, "plain", "x.json"), "BAD"), /BAD/u);
});

test("assertSafeStoreFile: the ancestor walk is bounded (over 512 levels fails closed)", () => {
  const dir = base();
  const deep = join(dir, ...Array.from({ length: 600 }, () => "d"), "x.json");
  assert.throws(() => assertSafeStoreFile(deep, "BAD"), /BAD/u);
  const ok = join(dir, ...Array.from({ length: 100 }, () => "d"), "x.json");
  assertSafeStoreFile(ok, "BAD");
});
