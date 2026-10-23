import assert from "node:assert/strict";
import test from "node:test";
import { stableJson } from "./identity";

test("key order and nesting", () => {
  assert.equal(stableJson({ symbol: "AAA", id: 7, tags: ["b", "a"] }), '{"id":7,"symbol":"AAA","tags":["b","a"]}');
  assert.equal(stableJson([1, [2, { k: false }]]), '[1,[2,{"k":false}]]');
  assert.equal(stableJson(3.5), "3.5");
  assert.equal(stableJson({ nested: { y: null, x: "" } }), '{"nested":{"x":"","y":null}}');
  assert.equal(stableJson(true), "true");
  assert.equal(stableJson({ "b-key": 2, "a key": 1 }), '{"a key":1,"b-key":2}');
});
