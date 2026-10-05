import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CanonicalTenMinuteBar } from "./contracts";
import { DUST_SCHEMA_VERSION } from "./contracts";
import {
  FROZEN_PACKED_FIXTURE_HASH,
  PACKED_DUST_FORMAT,
  decodePackedBars,
  encodePackedBars,
  logicalFixtureHash,
  sealPackedArchive,
} from "./packed-dust";

function bar(intervalIndex: number, close: number, state: CanonicalTenMinuteBar["state"] = "VALID_TRADED"): CanonicalTenMinuteBar {
  return {
    securityId: "sec_aaa",
    sessionDate: "2026-01-22",
    intervalIndex,
    state,
    ...(state === "NO_TRADE"
      ? {}
      : { open: close - 1, high: close + 1, low: close - 2, close, volume: 100, vwap: close, transactionCount: 3 }),
    observedAt: "2026-01-22T15:00:00Z",
    ingestedAt: "2026-01-22T15:01:00Z",
    dataQuality: state === "NO_TRADE" ? "MISSING" : "GOOD",
    corporateActionIds: intervalIndex === 0 ? ["split-1"] : [],
    flags: ["REGULAR"],
    schemaVersion: "foundation-d.1-10m-v1",
    revision: 1,
    provenance: {
      provider: "fixture-provider",
      dataset: "ten-minute",
      retrievalId: "retrieval-1",
      providerTimestamp: "2026-01-22T15:00:01Z",
      ingestionVersion: "test",
      normalizerVersion: "test",
    },
  };
}

test("packed zstd7 blocks round-trip and reject corruption", async () => {
  assert.equal(PACKED_DUST_FORMAT, "PACKED_BLOCKS_FOR_DELTA_STATES_ZSTD7");
  assert.notEqual(PACKED_DUST_FORMAT, DUST_SCHEMA_VERSION);
  const bars = [bar(1, 12), bar(0, 10), bar(2, 0, "NO_TRADE")];
  const encoded = encodePackedBars(bars);
  assert.deepEqual(decodePackedBars(encoded), [bar(0, 10), bar(1, 12), bar(2, 0, "NO_TRADE")]);
  const flipped = new Uint8Array(encoded);
  const last = flipped.length - 1;
  const tail = flipped[last] ?? 0;
  flipped[last] = tail ^ 0xff;
  assert.throws(() => decodePackedBars(flipped));
  assert.throws(() => decodePackedBars(encoded.slice(0, encoded.length - 1)));
  const root = await mkdtemp(join(tmpdir(), "peacestocks-packed-"));
  try {
    const path = join(root, "archive.bin");
    await sealPackedArchive(path, bars);
    assert.deepEqual(decodePackedBars(await readFile(path)), [bar(0, 10), bar(1, 12), bar(2, 0, "NO_TRADE")]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the frozen fixture hash is not claimed for a different bar set", () => {
  assert.equal(
    FROZEN_PACKED_FIXTURE_HASH,
    "7d70c208667c51c5f7156d90cbefb4c9a557703d599e26773706d1a228661ecd",
  );
  assert.notEqual(logicalFixtureHash([bar(0, 10)]), FROZEN_PACKED_FIXTURE_HASH);
});

test("packed zstd7 blocks over 1MB round-trip with every field intact", () => {
  // Deterministic noisy prices so the block stays large after compression (month-sized archives are 1.4-4 MB).
  let seed = 0x9e3779b9;
  const next = (): number => {
    seed = (Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0;
    return seed / 0x1_0000_0000;
  };
  const bars: CanonicalTenMinuteBar[] = [];
  for (let security = 0; security < 400; security += 1) {
    for (let intervalIndex = 0; intervalIndex < 390; intervalIndex += 1) {
      const close = Math.round((5 + next() * 900) * 1_000_000) / 1_000_000;
      bars.push({
        securityId: `sec_${String(security).padStart(6, "0")}`,
        sessionDate: "2026-01-22",
        intervalIndex,
        state: "VALID_TRADED",
        open: Math.round((close + next() - 0.5) * 1_000_000) / 1_000_000,
        high: Math.round((close + next()) * 1_000_000) / 1_000_000,
        low: Math.round((close - next()) * 1_000_000) / 1_000_000,
        close,
        volume: Math.floor(next() * 50_000_000),
        vwap: Math.round((close + next() * 0.1) * 1_000_000) / 1_000_000,
        transactionCount: Math.floor(next() * 200_000),
        observedAt: "2026-01-22T21:00:00Z",
        ingestedAt: "2026-01-22T21:01:00Z",
        dataQuality: "GOOD",
        corporateActionIds: [],
        flags: [],
        schemaVersion: "foundation-d.1-10m-v1",
        revision: 1,
        provenance: {
          provider: "fixture-provider",
          dataset: "ten-minute",
          retrievalId: "retrieval-large",
          ingestionVersion: "test",
          normalizerVersion: "test",
        },
      });
    }
  }
  const packed = encodePackedBars(bars);
  assert.ok(packed.byteLength > 1024 * 1024, `packed block is only ${packed.byteLength} bytes`);
  const decoded = decodePackedBars(packed);
  assert.equal(decoded.length, bars.length);
  assert.deepStrictEqual(decoded, bars);
});
