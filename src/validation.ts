import { appendFile, readFile, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  assertSafeStoreDirectory,
  assertSafeStoreFile,
  prepareSafeStoreDirectory,
  prepareSafeStoreFile,
} from "./store-path";
import type { CanonicalTenMinuteBar, IntradaySessionSpec } from "./contracts";
import { decodeDust, encodeDust } from "./dust";
import { writeSealedDustSession } from "./reader";

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

function stableRecord(value: unknown): string {
  return JSON.stringify(stableValue(value));
}
export interface IntradayValidationReport {
  valid: boolean;
  sessionDate: string;
  expectedIntervals: number;
  securityCount: number;
  barCount: number;
  validTradedIntervals: number;
  missingIntervals: number;
  duplicateKeys: string[];
  invalidKeys: string[];
  roundTripExact: boolean;
  checksumVerified: boolean;
  warnings: string[];
}

export function validateIntradayBars(
  records: readonly CanonicalTenMinuteBar[],
  session: IntradaySessionSpec,
): IntradayValidationReport {
  const keys = records.map(
    (record) =>
      `${record.securityId}|${record.sessionDate}|${record.intervalIndex}|${record.revision}`,
  );
  const seen = new Set<string>();
  const duplicateKeys = keys.filter((key) => seen.has(key));
  for (const key of keys) seen.add(key);
  const invalidKeys = records
    .filter(
      (record) =>
        record.sessionDate !== session.sessionDate ||
        record.intervalIndex < 0 ||
        record.intervalIndex >= session.expectedIntervals ||
        record.schemaVersion !== "foundation-d.1-10m-v1",
    )
    .map((record) => `${record.securityId}|${record.intervalIndex}`);
  const securityIds = new Set(records.map((record) => record.securityId));
  let missingIntervals = 0;
  for (const securityId of securityIds) {
    const indices = new Set(
      records
        .filter((record) => record.securityId === securityId)
        .map((record) => record.intervalIndex),
    );
    missingIntervals += Math.max(0, session.expectedIntervals - indices.size);
  }
  let roundTripExact = true;
  let checksumVerified = true;
  for (const securityId of securityIds) {
    const subset = records.filter((record) => record.securityId === securityId);
    try {
      const encoded = encodeDust(subset);
      const decoded = decodeDust(encoded.bytes).records;
      if (
        stableRecord(decoded) !==
        stableRecord(
          [...subset].sort((a, b) => a.intervalIndex - b.intervalIndex || a.revision - b.revision),
        )
      )
        roundTripExact = false;
    } catch {
      checksumVerified = false;
    }
  }
  const validTradedIntervals = records.filter((record) => record.state === "VALID_TRADED").length;
  const warnings = [
    ...(missingIntervals ? [`MISSING_INTERVALS:${missingIntervals}`] : []),
    ...(records.some((record) => record.state === "PROVIDER_MISSING")
      ? ["PROVIDER_MISSING_INTERVALS"]
      : []),
  ];
  return {
    valid:
      duplicateKeys.length === 0 &&
      invalidKeys.length === 0 &&
      missingIntervals === 0 &&
      roundTripExact &&
      checksumVerified,
    sessionDate: session.sessionDate,
    expectedIntervals: session.expectedIntervals,
    securityCount: securityIds.size,
    barCount: records.length,
    validTradedIntervals,
    missingIntervals,
    duplicateKeys,
    invalidKeys,
    roundTripExact,
    checksumVerified,
    warnings,
  };
}

export const MARKET_VALIDATION_BUFFER_PATH_ERROR = "MARKET_VALIDATION_BUFFER_PATH_INVALID";

export class EphemeralValidationBuffer {
  readonly root: string;
  readonly sessionDate: string;
  readonly retentionDays: number;

  constructor(root: string, sessionDate: string, retentionDays = 7) {
    if (typeof root !== "string" || !root.trim())
      throw new Error(MARKET_VALIDATION_BUFFER_PATH_ERROR);
    if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 7)
      throw new Error("VALIDATION_RETENTION_OUT_OF_RANGE");
    this.root = prepareSafeStoreDirectory(root, MARKET_VALIDATION_BUFFER_PATH_ERROR);
    this.sessionDate = sessionDate;
    this.retentionDays = retentionDays;
  }
  private get path(): string {
    assertSafeStoreDirectory(this.root, MARKET_VALIDATION_BUFFER_PATH_ERROR);
    const target = join(this.root, "transient", "validation", `${this.sessionDate}.jsonl`);
    assertSafeStoreFile(target, MARKET_VALIDATION_BUFFER_PATH_ERROR);
    return target;
  }
  async append(records: readonly CanonicalTenMinuteBar[]): Promise<void> {
    const target = prepareSafeStoreFile(this.path, MARKET_VALIDATION_BUFFER_PATH_ERROR);
    assertSafeStoreFile(target, MARKET_VALIDATION_BUFFER_PATH_ERROR);
    await appendFile(
      target,
      records.map((record) => JSON.stringify(record)).join("\n") + (records.length ? "\n" : ""),
      "utf8",
    );
  }
  async load(): Promise<CanonicalTenMinuteBar[]> {
    const target = this.path;
    try {
      return (await readFile(target, "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as CanonicalTenMinuteBar);
    } catch (error) {
      if (error instanceof Error && error.message === MARKET_VALIDATION_BUFFER_PATH_ERROR)
        throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }
  async purgeAfterSeal(): Promise<void> {
    const target = this.path;
    assertSafeStoreFile(target, MARKET_VALIDATION_BUFFER_PATH_ERROR);
    await rm(target, { force: true });
  }
  async purgeExpired(referenceDate = new Date()): Promise<string[]> {
    assertSafeStoreDirectory(this.root, MARKET_VALIDATION_BUFFER_PATH_ERROR);
    const directory = dirname(this.path);
    const threshold = new Date(referenceDate);
    threshold.setUTCDate(threshold.getUTCDate() - this.retentionDays);
    const removed: string[] = [];
    const names = await readdir(directory).catch((error: unknown) => {
      if (error instanceof Error && error.message === MARKET_VALIDATION_BUFFER_PATH_ERROR)
        throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    });
    for (const name of names) {
      const match = /^(\d{4}-\d{2}-\d{2})\.jsonl$/u.exec(name);
      if (!match) continue;
      const date = new Date(`${match[1]}T00:00:00Z`);
      if (date < threshold) {
        const file = join(directory, name);
        assertSafeStoreFile(file, MARKET_VALIDATION_BUFFER_PATH_ERROR);
        await rm(file, { force: true });
        removed.push(name);
      }
    }
    return removed.sort();
  }
}

export async function sealValidatedDustSession(options: {
  root: string;
  records: readonly CanonicalTenMinuteBar[];
  session: IntradaySessionSpec;
  provider: string;
  validationBuffer?: EphemeralValidationBuffer;
}): Promise<{
  report: IntradayValidationReport;
  manifest?: Awaited<ReturnType<typeof writeSealedDustSession>>;
}> {
  const report = validateIntradayBars(options.records, options.session);
  if (!report.valid) return { report };
  const manifest = await writeSealedDustSession(options.root, options.records, {
    provider: options.provider,
    sessionDate: options.session.sessionDate,
    quality: report.warnings.length ? "PARTIAL_RUN" : "COMPLETE",
  });
  if (options.validationBuffer) await options.validationBuffer.purgeAfterSeal();
  return { report, manifest };
}
