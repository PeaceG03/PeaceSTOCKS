import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  REPLY_DUST_FALLBACK_VERSION,
  REPLY_DUST_VERSION,
  decodeReplyDust,
  encodeReplyDust,
  nodeReplyDustBackend,
  replyDustV1Dictionary,
  type ReplyDustBackend,
} from "./reply-dust";
import { REPLY_DUST_V1_DICTIONARY_SHA256 } from "./reply-dust-dictionary";

const FIXTURES = join(import.meta.dirname, "fixtures");
const sha256 = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
const index = JSON.parse(readFileSync(join(FIXTURES, "massive-10m-replies", "index.json"), "utf8")) as {
  replies: Array<{ symbol: string; file: string; sha256: string }>;
};
const real = index.replies.map((r) => ({ ...r, body: new Uint8Array(readFileSync(join(FIXTURES, "massive-10m-replies", r.file))) }));
const edge = Object.entries(
  (JSON.parse(readFileSync(join(FIXTURES, "reply-dust-edge-cases.json"), "utf8")) as { cases: Record<string, string> }).cases,
).map(([name, b64]) => ({ name, body: new Uint8Array(Buffer.from(b64, "base64")) }));

const auditor = Object.entries(
  (JSON.parse(readFileSync(join(FIXTURES, "reply-dust-auditor-cases.json"), "utf8")) as { cases: Record<string, string> }).cases,
).map(([name, b64]) => ({ name, body: new Uint8Array(Buffer.from(b64, "base64")) }));

test("fixtures are the frozen Massive replies and the full synthetic edge set", () => {
  assert.equal(real.length, 32);
  assert.equal(edge.length, 32);
  assert.equal(auditor.length, 25);
  for (const r of real) assert.equal(sha256(r.body), r.sha256, r.symbol);
});

test("the embedded v1 dictionary matches its recorded sha256", () => {
  assert.equal(sha256(replyDustV1Dictionary(nodeReplyDustBackend)), REPLY_DUST_V1_DICTIONARY_SHA256);
});

test("all 32 real replies round-trip byte-exact through the column transform", () => {
  let total = 0;
  for (const r of real) {
    const encoded = encodeReplyDust(r.body);
    assert.equal(encoded[0], REPLY_DUST_VERSION, r.symbol);
    assert.deepEqual(decodeReplyDust(encoded), r.body, r.symbol);
    assert.deepEqual(encodeReplyDust(r.body), encoded, `${r.symbol} deterministic`);
    total += encoded.length;
  }
  // In-sample mean is 445.3 bytes per reply with zstd 1.5.7; guard against silent size regressions.
  assert.ok(total / real.length < 460, `mean ${total / real.length}`);
});

test("all 32 synthetic edge cases round-trip byte-exact, including non-JSON and unusual replies", () => {
  for (const x of edge) {
    const encoded = encodeReplyDust(x.body);
    assert.equal(encoded[0], REPLY_DUST_VERSION, x.name);
    assert.deepEqual(decodeReplyDust(encoded), x.body, x.name);
  }
});

test("all 25 Auditor adversarial cases round-trip byte-exact and deterministically", () => {
  for (const x of auditor) {
    const encoded = encodeReplyDust(x.body);
    assert.ok(encoded[0] === REPLY_DUST_VERSION || encoded[0] === REPLY_DUST_FALLBACK_VERSION, x.name);
    assert.deepEqual(decodeReplyDust(encoded), x.body, x.name);
    assert.deepEqual(encodeReplyDust(x.body), encoded, `${x.name} deterministic`);
  }
});

test("empty reply bytes round-trip", () => {
  assert.deepEqual(decodeReplyDust(encodeReplyDust(new Uint8Array())), new Uint8Array());
});

test("corruption, truncation and unknown versions fail closed", () => {
  const encoded = encodeReplyDust(real[0]!.body);
  const flipped = (at: number): Uint8Array => {
    const copy = Uint8Array.from(encoded);
    copy[at]! ^= 0x01;
    return copy;
  };
  assert.throws(() => decodeReplyDust(flipped(1)), /REPLY_DUST_HASH_MISMATCH/);
  assert.throws(() => decodeReplyDust(flipped(16)), /REPLY_DUST_HASH_MISMATCH/);
  for (let at = 17; at < encoded.length; at += 7) assert.throws(() => decodeReplyDust(flipped(at)), `payload byte ${at}`);
  assert.throws(() => decodeReplyDust(encoded.subarray(0, encoded.length - 1)));
  assert.throws(() => decodeReplyDust(encoded.subarray(0, 10)), /REPLY_DUST_TRUNCATED/);
  const v2 = Uint8Array.from(encoded);
  v2[0] = 2;
  assert.throws(() => decodeReplyDust(v2), /REPLY_DUST_VERSION_UNSUPPORTED:2/);
});

test("a transformed file that fails verification falls back to verified raw zstd", () => {
  const broken: ReplyDustBackend = {
    ...nodeReplyDustBackend,
    decompress: (frame, dictionary) =>
      dictionary ? new Uint8Array([0]) : nodeReplyDustBackend.decompress(frame, dictionary),
  };
  const body = real[1]!.body;
  const encoded = encodeReplyDust(body, broken);
  assert.equal(encoded[0], REPLY_DUST_FALLBACK_VERSION);
  assert.deepEqual(decodeReplyDust(encoded), body);
  assert.deepEqual(decodeReplyDust(encoded, broken), body);
});
