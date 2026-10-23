import assert from "node:assert/strict";
import test from "node:test";
import { canonicalJson } from "./daily-bars-pack-decode";

test("key order and nesting", () => {
  assert.equal(canonicalJson({ b: 1, a: [true, null, "x"] }), '{"a":[true,null,"x"],"b":1}');
  assert.equal(canonicalJson([{ z: 0, y: { d: 2, c: 1 } }]), '[{"y":{"c":1,"d":2},"z":0}]');
  assert.equal(canonicalJson("s"), '"s"');
  assert.equal(canonicalJson(null), "null");
  assert.equal(canonicalJson({}), "{}");
  assert.equal(canonicalJson([]), "[]");
  assert.equal(canonicalJson(-0.5), "-0.5");
});
