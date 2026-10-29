import assert from "node:assert/strict";
import test from "node:test";
import { storageCategory } from "./storage-category";

test("storageCategory: the examples from the issue", () => {
  assert.equal(storageCategory("permanent/daily-bars/2026-10.jsonl"), "permanent");
  assert.equal(storageCategory("cache/massive/x.json"), "cache");
  assert.equal(storageCategory("transient/run/1"), "transient");
  assert.equal(storageCategory("permanent/universe-membership.jsonl"), "permanent");
  assert.equal(storageCategory("README"), "README");
  assert.equal(storageCategory("cache/"), "cache");
  assert.equal(storageCategory("/x"), "");
  assert.equal(storageCategory(" permanent /a"), " permanent ");
});
