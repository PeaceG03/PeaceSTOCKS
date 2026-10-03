import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { MassiveAggregateBar } from "./contracts";
import { decodeDust, encodeDust } from "./dust";
import {
  aggregateIntradayBars,
  intradaySessionSpec,
  normalizeMassiveTenMinuteBars,
  reconstructDailyBar,
} from "./intraday";
import { DustReader } from "./reader";
import { reconstructDailyBarsFromReader } from "./scanner";
import {
  EphemeralValidationBuffer,
  sealValidatedDustSession,
  validateIntradayBars,
} from "./validation";

const provenance = {
  provider: "fixture-massive",
  dataset: "stocks-aggregates-10m",
  retrievalId: "retrieval-1",
  ingestionVersion: "test-v1",
  normalizerVersion: "test-normalizer-v1",
};
function aggregate(symbol: string, iso: string, close: number, volume = 100): MassiveAggregateBar {
  return {
    symbol,
    timestamp: Date.parse(iso),
    open: close - 1,
    high: close + 1,
    low: close - 2,
    close,
    volume,
    vwap: close - 0.25,
    transactionCount: 3,
  };
}

test("10-minute session specs correctly represent normal days and half-days", () => {
  assert.equal(intradaySessionSpec("2026-01-02").expectedIntervals, 39);
  assert.equal(intradaySessionSpec("2026-11-27").expectedIntervals, 21);
  assert.equal(intradaySessionSpec("2026-01-03").expectedIntervals, 0);
});

test("normalization preserves explicit traded, no-trade, and provider-missing states", () => {
  const bars = normalizeMassiveTenMinuteBars({
    sessionDate: "2026-01-02",
    securityId: "security-1",
    symbol: "AAA",
    aggregates: [
      aggregate("AAA", "2026-01-02T14:30:00.000Z", 100),
      aggregate("AAA", "2026-01-02T14:40:00.000Z", 101, 0),
    ],
    provenance,
    observedAt: "2026-01-02T20:00:00.000Z",
  });
  assert.equal(bars.length, 39);
  assert.equal(bars[0]?.state, "VALID_TRADED");
  assert.equal(bars[1]?.state, "NO_TRADE");
  assert.equal(bars[2]?.state, "PROVIDER_MISSING");
  assert.equal(bars[2]?.open, undefined);
});

test("Dust V1 round-trips precision/provenance and rejects corruption", () => {
  const records = normalizeMassiveTenMinuteBars({
    sessionDate: "2026-01-02",
    securityId: "security-1",
    symbol: "AAA",
    aggregates: [aggregate("AAA", "2026-01-02T14:30:00.000Z", 100.12345678)],
    provenance,
    observedAt: "2026-01-02T20:00:00.000Z",
  });
  const encoded = encodeDust(records);
  const decoded = decodeDust(encoded.bytes).records;
  assert.deepEqual(decoded, records);
  const corrupted = Buffer.from(encoded.bytes);
  corrupted[corrupted.length - 1]! ^= 0x01;
  assert.throws(() => decodeDust(corrupted), /DUST_(PAYLOAD|BODY)_CHECKSUM_MISMATCH/);
});

test("reader supports sealed per-security blocks, random reads, streaming, and daily reconstruction", async () => {
  const root = await mkdtemp(join(tmpdir(), "peaceai-dust-"));
  try {
    const records = normalizeMassiveTenMinuteBars({
      sessionDate: "2026-01-02",
      securityId: "security-1",
      symbol: "AAA",
      aggregates: [
        aggregate("AAA", "2026-01-02T14:30:00.000Z", 100),
        aggregate("AAA", "2026-01-02T14:40:00.000Z", 101),
      ],
      provenance,
      observedAt: "2026-01-02T20:00:00.000Z",
    });
    const buffer = new EphemeralValidationBuffer(root, "2026-01-02");
    await buffer.append(records);
    assert.equal((await buffer.load()).length, 39);
    const sealed = await sealValidatedDustSession({
      root,
      records,
      session: intradaySessionSpec("2026-01-02"),
      provider: provenance.provider,
      validationBuffer: buffer,
    });
    assert.equal(sealed.report.valid, true);
    await assert.rejects(readFile(join(root, "transient", "validation", "2026-01-02.jsonl")));
    const reader = new DustReader(root);
    const read = await reader.readSecurityDay("2026-01-02", "security-1");
    assert.deepEqual(read, records);
    assert.equal((await reader.randomBlockRead("2026-01-02", "security-1")).bars.length, 39);
    let count = 0;
    for await (const item of reader.stream("2026-01-02")) {
      count += 1;
      assert.equal(item.securityId, "security-1");
    }
    assert.equal(count, 39);
    const daily = await reader.reconstructDaily("2026-01-02", "security-1");
    const scannerDaily = await reconstructDailyBarsFromReader(reader, "2026-01-02", [
      "security-1",
      "missing",
    ]);
    assert.equal(scannerDaily.length, 1);
    assert.equal(scannerDaily[0]?.securityId, "security-1");
    assert.equal(daily?.open, 99);
    assert.equal(daily?.close, 101);
    assert.equal(daily?.volume, 200);
    const manifest = await reader.manifest("2026-01-02");
    assert.equal(manifest.validation, "SEALED_CANONICAL");
    const manifestPath = join(root, "permanent", "intraday-dust", "2026-01-02", "manifest.json");
    const originalManifest = await readFile(manifestPath, "utf8");
    await (
      await import("node:fs/promises")
    ).writeFile(manifestPath, originalManifest.replace("dust-session-2026-01-02", "tampered"));
    await assert.rejects(reader.manifest("2026-01-02"), /DUST_MANIFEST_CHECKSUM_MISMATCH/);
    await (await import("node:fs/promises")).writeFile(manifestPath, originalManifest);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("larger intervals are rebuilt from 10-minute evidence without new permanent source", () => {
  const records = normalizeMassiveTenMinuteBars({
    sessionDate: "2026-01-02",
    securityId: "security-1",
    symbol: "AAA",
    aggregates: Array.from({ length: 39 }, (_, index) =>
      aggregate(
        "AAA",
        new Date(Date.parse("2026-01-02T14:30:00.000Z") + index * 600_000).toISOString(),
        100 + index,
        10,
      ),
    ),
    provenance,
    observedAt: "2026-01-02T20:00:00.000Z",
  });
  const hourly = aggregateIntradayBars(records, 60);
  assert.equal(hourly.length, 7);
  assert.equal(hourly[0]?.open, 99);
  assert.equal(hourly[0]?.close, 105);
  assert.equal(validateIntradayBars(records, intradaySessionSpec("2026-01-02")).valid, true);
  assert.equal(reconstructDailyBar(records)?.volume, 390);
});

test("validation buffer retention is bounded and purges only expired sessions", async () => {
  const root = await mkdtemp(join(tmpdir(), "peaceai-validation-retention-"));
  try {
    await new EphemeralValidationBuffer(root, "2026-01-01", 3).append([]);
    await new EphemeralValidationBuffer(root, "2026-01-08", 3).append([]);
    const buffer = new EphemeralValidationBuffer(root, "2026-01-10", 3);
    assert.deepEqual(await buffer.purgeExpired(new Date("2026-01-10T12:00:00.000Z")), [
      "2026-01-01.jsonl",
    ]);
    await assert.rejects(
      Promise.resolve().then(() => new EphemeralValidationBuffer(root, "2026-01-10", 8)),
      /VALIDATION_RETENTION_OUT_OF_RANGE/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
