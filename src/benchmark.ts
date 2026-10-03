import { performance } from "node:perf_hooks";
import type { CanonicalTenMinuteBar } from "./contracts";
import { decodeDust, encodeDust } from "./dust";

export interface EncodingBenchmarkResult {
  format: "JSONL" | "DUST_V1" | "PARQUET_ZSTD_REFERENCE";
  status: "MEASURED" | "UNAVAILABLE";
  rawBytes: number;
  compressedBytes: number;
  barsEncoded: number;
  bytesPerBar: number;
  encodeMs: number;
  decodeMs: number;
  randomReadMs?: number;
  peakRamBytes?: number;
  notes?: string;
}

export interface IntradayBenchmarkReport {
  sessionDate: string;
  bars: number;
  results: EncodingBenchmarkResult[];
  roundTripFidelity: number;
}

function jsonl(records: readonly CanonicalTenMinuteBar[]): Buffer {
  return Buffer.from(records.map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8");
}

function bySecurity(records: readonly CanonicalTenMinuteBar[]): CanonicalTenMinuteBar[][] {
  const grouped = new Map<string, CanonicalTenMinuteBar[]>();
  for (const record of records)
    grouped.set(record.securityId, [...(grouped.get(record.securityId) ?? []), record]);
  return [...grouped.values()];
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, stableValue(nested)]),
    );
  }
  return value;
}

function stableRecord(record: CanonicalTenMinuteBar): string {
  return JSON.stringify(stableValue(record));
}

export function benchmarkIntradayEncodings(
  records: readonly CanonicalTenMinuteBar[],
  parquetZstdReference?: {
    rawBytes: number;
    compressedBytes: number;
    decodeMs?: number;
    notes?: string;
  },
): IntradayBenchmarkReport {
  if (!records.length) throw new Error("BENCHMARK_EMPTY");
  const rawJson = jsonl(records);
  const jsonStart = performance.now();
  const parsed = rawJson
    .toString("utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as CanonicalTenMinuteBar);
  const jsonDecodeMs = performance.now() - jsonStart;
  const dustStart = performance.now();
  const blocks = bySecurity(records).map((group) => encodeDust(group));
  const dustEncodeMs = performance.now() - dustStart;
  const dustBytes = Buffer.concat(blocks.map((block) => block.bytes));
  const dustDecodeStart = performance.now();
  const decoded = blocks.flatMap((block) => decodeDust(block.bytes).records);
  const dustDecodeMs = performance.now() - dustDecodeStart;
  const randomReadStart = performance.now();
  decodeDust(blocks[0]!.bytes);
  const randomReadMs = performance.now() - randomReadStart;
  const expected = records
    .slice()
    .sort((a, b) => a.securityId.localeCompare(b.securityId) || a.intervalIndex - b.intervalIndex);
  const fidelity =
    decoded.length === expected.length &&
    decoded.every((record, index) => stableRecord(record) === stableRecord(expected[index]!));
  const results: EncodingBenchmarkResult[] = [
    {
      format: "JSONL",
      status: "MEASURED",
      rawBytes: rawJson.byteLength,
      compressedBytes: rawJson.byteLength,
      barsEncoded: parsed.length,
      bytesPerBar: rawJson.byteLength / parsed.length,
      encodeMs: 0,
      decodeMs: jsonDecodeMs,
    },
    {
      format: "DUST_V1",
      status: "MEASURED",
      rawBytes: rawJson.byteLength,
      compressedBytes: dustBytes.byteLength,
      barsEncoded: records.length,
      bytesPerBar: dustBytes.byteLength / records.length,
      encodeMs: dustEncodeMs,
      decodeMs: dustDecodeMs,
      randomReadMs,
    },
  ];
  results.push(
    parquetZstdReference
      ? {
          format: "PARQUET_ZSTD_REFERENCE",
          status: "MEASURED",
          rawBytes: parquetZstdReference.rawBytes,
          compressedBytes: parquetZstdReference.compressedBytes,
          barsEncoded: records.length,
          bytesPerBar: parquetZstdReference.compressedBytes / records.length,
          encodeMs: 0,
          decodeMs: parquetZstdReference.decodeMs ?? 0,
          ...(parquetZstdReference.notes === undefined
            ? {}
            : { notes: parquetZstdReference.notes }),
        }
      : {
          format: "PARQUET_ZSTD_REFERENCE",
          status: "UNAVAILABLE",
          rawBytes: 0,
          compressedBytes: 0,
          barsEncoded: 0,
          bytesPerBar: 0,
          encodeMs: 0,
          decodeMs: 0,
          notes:
            "Supply a real Parquet+Zstd reference artifact; no substitute is silently claimed.",
        },
  );
  return {
    sessionDate: records[0]!.sessionDate,
    bars: records.length,
    results,
    roundTripFidelity: fidelity ? 1 : 0,
  };
}
