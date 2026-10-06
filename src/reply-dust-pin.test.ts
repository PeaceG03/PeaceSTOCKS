import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { REPLY_DUST_VERSION, decodeReplyDust, encodeReplyDust, nodeReplyDustBackend } from "./reply-dust";
import {
  REPLY_DUST_PINNED_ZSTD_VERSION,
  assertPinnedZstdForWriting,
  replyDustRunReport,
} from "./reply-dust-pin";

const FIXTURE = join(import.meta.dirname, "fixtures", "massive-10m-replies", "ABSI.json");
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

// Recorded with zstd 1.5.7 (the pinned writer). If this changes, the encoder or zstd changed and
// stored bytes would differ; do not just update the constant without checking why.
const FROZEN_ABSI_REPLY_SHA256 = "7dbc40ff482d42edfddba13bbd56ef15c91e20c1e4aaa3006a39e3d51623499c";
const FROZEN_ABSI_REPLY_DUST_SHA256 = "8682ecefa46f41b640fdddbe1438f375801937f1a2071693550771cfc6fe3277";

test("the pinned zstd version is exactly 1.5.7 and is parsed from zstd --version", () => {
  assert.equal(REPLY_DUST_PINNED_ZSTD_VERSION, "1.5.7");
  assert.equal(assertPinnedZstdForWriting(() => "*** Zstandard CLI (64-bit) v1.5.7, by Yann Collet ***\n"), "1.5.7");
  assert.throws(() => assertPinnedZstdForWriting(() => undefined), /^Error: REPLY_DUST_ZSTD_MISSING$/u);
  assert.throws(
    () => assertPinnedZstdForWriting(() => "*** Zstandard CLI (64-bit) v1.5.5, by Yann Collet ***"),
    /^Error: REPLY_DUST_ZSTD_VERSION:1\.5\.5$/u,
  );
  assert.throws(() => assertPinnedZstdForWriting(() => "*** Zstandard CLI (64-bit) v1.5.70 ***"), /REPLY_DUST_ZSTD_VERSION:1\.5\.70/u);
  assert.throws(() => assertPinnedZstdForWriting(() => "garbage"), /REPLY_DUST_ZSTD_VERSION:garbage/u);
});

test("a frozen 10-minute reply encodes to the recorded Reply Dust bytes", () => {
  const body = new Uint8Array(readFileSync(FIXTURE));
  assert.equal(sha256(body), FROZEN_ABSI_REPLY_SHA256);
  const encoded = encodeReplyDust(body, nodeReplyDustBackend);
  assert.equal(encoded[0], REPLY_DUST_VERSION);
  assert.equal(encoded.length, 826);
  assert.equal(sha256(encoded), FROZEN_ABSI_REPLY_DUST_SHA256);
});

test("decoding needs no zstd version check", () => {
  // The decode path takes no probe at all; prove it still decodes while a probe would refuse.
  assert.throws(() => assertPinnedZstdForWriting(() => "*** Zstandard CLI (64-bit) v9.9.9 ***"));
  const body = new Uint8Array(readFileSync(FIXTURE));
  assert.deepEqual(decodeReplyDust(encodeReplyDust(body)), body);
});

test("run report: fallback files are a warning, zero fallbacks add no warning", () => {
  assert.deepEqual(replyDustRunReport(5, 0, "1.5.7"), {
    replyDustFilesWritten: 5,
    replyDustFallbackFiles: 0,
    replyDustZstdVersion: "1.5.7",
  });
  assert.deepEqual(replyDustRunReport(5, 2, "1.5.7"), {
    replyDustFilesWritten: 5,
    replyDustFallbackFiles: 2,
    replyDustZstdVersion: "1.5.7",
    warnings: ["REPLY_DUST_FALLBACK_FILES:2"],
  });
});
