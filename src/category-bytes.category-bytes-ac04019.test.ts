import assert from "node:assert/strict";
import test from "node:test";
import { categoryBytes } from "./category-bytes";

test("categoryBytes: the examples from the issue", () => {
  assert.equal(categoryBytes([], "permanent"), 0);
  assert.equal(categoryBytes([{ category: "permanent", size: 10 }], "permanent"), 10);
  assert.equal(categoryBytes([{ category: "cache", size: 10 }], "permanent"), 0);
  assert.equal(categoryBytes([{ category: "permanent", size: 10 }, { category: "cache", size: 5 }, { category: "permanent", size: 7 }], "permanent"), 17);
  assert.equal(categoryBytes([{ category: "permanent", size: 10 }, { category: "cache", size: 5 }, { category: "permanent", size: 7 }], "cache"), 5);
  assert.equal(categoryBytes([{ category: "transient", size: 300 }, { category: "transient", size: 200 }, { category: "cache", size: 1 }], "transient"), 500);
  assert.equal(categoryBytes([{ category: "a", size: 0 }, { category: "a", size: 0 }, { category: "b", size: 9 }], "a"), 0);
  assert.equal(categoryBytes([{ category: "x", size: -150 }, { category: "x", size: 20 }, { category: "y", size: 4 }], "x"), -130);
});
