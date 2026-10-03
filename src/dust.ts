import { createHash } from "node:crypto";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import type {
  CanonicalTenMinuteBar,
  DataQuality,
  DustArchiveManifest,
  IntradayIntervalState,
} from "./contracts";
import { DUST_SCHEMA_VERSION, INTRADAY_SCHEMA_VERSION } from "./contracts";

const MAGIC = Buffer.from([0x44, 0x55, 0x53, 0x54, 0x56, 0x31, 0x00, 0x00]);
const PRICE_SCALE = 100_000_000n;
const VOLUME_SCALE = 1_000_000n;
const STATES: IntradayIntervalState[] = [
  "VALID_TRADED",
  "NO_TRADE",
  "HALTED",
  "NOT_LISTED",
  "INACTIVE",
  "PROVIDER_MISSING",
  "SOURCE_FAILURE",
  "PARTIAL",
];
const QUALITIES: DataQuality[] = [
  "GOOD",
  "MISSING",
  "STALE",
  "SUSPECT",
  "INSUFFICIENT_HISTORY",
  "CORPORATE_ACTION_AFFECTED",
  "HALTED",
  "PROVIDER_ERROR",
  "PARTIAL_RUN",
];

type DustHeader = {
  archiveId: string;
  schemaVersion: typeof DUST_SCHEMA_VERSION;
  logicalSchemaVersion: typeof INTRADAY_SCHEMA_VERSION;
  provider: string;
  sessionDate: string;
  securityId: string;
  intervalMinutes: 10;
  expectedIntervals: number;
  priceScale: string;
  volumeScale: string;
  compression: "deflate-raw-v1";
  uncompressedBytes: number;
  bodyChecksum: string;
  payloadChecksum: string;
  dictionaries: {
    providers: string[];
    datasets: string[];
    retrievals: string[];
    ingestionVersions: string[];
    normalizers: string[];
    providerTimestamps?: string[];
    actions: string[];
    flags: string[];
  };
  recordCount: number;
};

export interface DustEncodedArchive {
  bytes: Buffer;
  header: DustHeader;
  checksum: string;
}

export interface DustDecodedArchive {
  header: DustHeader;
  records: CanonicalTenMinuteBar[];
  checksum: string;
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function varint(value: bigint): Buffer {
  if (value < 0n) throw new Error("DUST_UNSIGNED_VARINT_NEGATIVE");
  const output: number[] = [];
  let current = value;
  do {
    let byte = Number(current & 0x7fn);
    current >>= 7n;
    if (current) byte |= 0x80;
    output.push(byte);
  } while (current);
  return Buffer.from(output);
}

function readVarint(bytes: Buffer, offset: number): { value: bigint; next: number } {
  let value = 0n;
  let shift = 0n;
  let cursor = offset;
  for (let count = 0; count < 10; count += 1) {
    const byte = bytes[cursor++];
    if (byte === undefined) throw new Error("DUST_TRUNCATED_VARINT");
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value, next: cursor };
    shift += 7n;
  }
  throw new Error("DUST_VARINT_TOO_LONG");
}

function zigzag(value: bigint): bigint {
  return value >= 0n ? value * 2n : -value * 2n - 1n;
}
function unzigzag(value: bigint): bigint {
  return value % 2n === 0n ? value / 2n : -(value / 2n) - 1n;
}
function signedVarint(value: bigint): Buffer {
  return varint(zigzag(value));
}
function readSigned(bytes: Buffer, offset: number): { value: bigint; next: number } {
  const result = readVarint(bytes, offset);
  return { value: unzigzag(result.value), next: result.next };
}
function numberCode<T extends string>(values: readonly T[], value: T): number {
  const code = values.indexOf(value);
  if (code < 0) throw new Error(`DUST_UNKNOWN_ENUM:${value}`);
  return code;
}
function numberValue<T extends string>(values: readonly T[], code: number): T {
  const value = values[code];
  if (value === undefined) throw new Error("DUST_UNKNOWN_ENUM_CODE");
  return value;
}
function dictionary(values: readonly string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}
function indexOf(values: readonly string[], value: string): number {
  const index = values.indexOf(value);
  if (index < 0) throw new Error(`DUST_UNKNOWN_DICTIONARY_VALUE:${value}`);
  return index;
}
function timestamp(value: string | undefined): bigint {
  const parsed = value ? Date.parse(value) : 0;
  return Number.isFinite(parsed) ? BigInt(parsed) : 0n;
}
function iso(value: bigint): string {
  return new Date(Number(value)).toISOString();
}
function scaled(value: number): bigint {
  if (!Number.isFinite(value)) throw new Error("DUST_NONFINITE_PRICE");
  return BigInt(Math.round(value * Number(PRICE_SCALE)));
}
function unscaled(value: bigint): number {
  return Number(value) / Number(PRICE_SCALE);
}
function volumeScaled(value: number): bigint {
  if (!Number.isFinite(value) || value < 0) throw new Error("DUST_INVALID_VOLUME");
  return BigInt(Math.round(value * Number(VOLUME_SCALE)));
}
function integer(value: number): bigint {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0)
    throw new Error("DUST_INVALID_INTEGER");
  return BigInt(value);
}
function buildHeader(
  records: readonly CanonicalTenMinuteBar[],
  bodyChecksum: string,
  payloadChecksum: string,
  uncompressedBytes: number,
): DustHeader {
  const first = records[0];
  if (!first) throw new Error("DUST_EMPTY_BLOCK");
  return {
    archiveId: `dust_${first.sessionDate}_${first.securityId}`,
    schemaVersion: DUST_SCHEMA_VERSION,
    logicalSchemaVersion: INTRADAY_SCHEMA_VERSION,
    provider: first.provenance.provider,
    sessionDate: first.sessionDate,
    securityId: first.securityId,
    intervalMinutes: 10,
    expectedIntervals: records.length,
    priceScale: PRICE_SCALE.toString(),
    volumeScale: VOLUME_SCALE.toString(),
    compression: "deflate-raw-v1",
    uncompressedBytes,
    bodyChecksum,
    payloadChecksum,
    dictionaries: {
      providers: dictionary(records.map((record) => record.provenance.provider)),
      datasets: dictionary(records.map((record) => record.provenance.dataset)),
      retrievals: dictionary(records.map((record) => record.provenance.retrievalId)),
      ingestionVersions: dictionary(records.map((record) => record.provenance.ingestionVersion)),
      normalizers: dictionary(records.map((record) => record.provenance.normalizerVersion)),
      ...(records.some((record) => record.provenance.providerTimestamp !== undefined)
        ? {
            providerTimestamps: dictionary(
              records.map((record) => record.provenance.providerTimestamp ?? ""),
            ),
          }
        : {}),
      actions: dictionary(records.flatMap((record) => record.corporateActionIds)),
      flags: dictionary(records.flatMap((record) => record.flags)),
    },
    recordCount: records.length,
  };
}

function encodeBody(
  records: readonly CanonicalTenMinuteBar[],
  headerDictionaries: DustHeader["dictionaries"],
): Buffer {
  const output: Buffer[] = [];
  let previousClose = 0n;
  let previousVolume = 0n;
  let previousCount = 0n;
  const ordered = [...records].sort(
    (a, b) => a.intervalIndex - b.intervalIndex || a.revision - b.revision,
  );
  for (const record of ordered) {
    output.push(varint(BigInt(record.intervalIndex)));
    output.push(Buffer.from([numberCode(STATES, record.state)]));
    const hasPrices =
      record.open !== undefined &&
      record.high !== undefined &&
      record.low !== undefined &&
      record.close !== undefined;
    const hasVolume = record.volume !== undefined;
    const hasVwap = record.vwap !== undefined;
    const hasCount = record.transactionCount !== undefined;
    const hasSourceTimestamp = record.sourceTimestamp !== undefined;
    const fields =
      (hasPrices ? 1 : 0) |
      (hasVolume ? 2 : 0) |
      (hasVwap ? 4 : 0) |
      (hasCount ? 8 : 0) |
      (hasSourceTimestamp ? 16 : 0);
    output.push(Buffer.from([fields, numberCode(QUALITIES, record.dataQuality)]));
    output.push(varint(BigInt(record.revision)));
    if (hasPrices) {
      const open = scaled(record.open!);
      const high = scaled(record.high!);
      const low = scaled(record.low!);
      const close = scaled(record.close!);
      output.push(
        signedVarint(open - previousClose),
        signedVarint(high - open),
        signedVarint(low - open),
        signedVarint(close - open),
      );
      previousClose = close;
    }
    if (hasVolume) {
      const volume = volumeScaled(record.volume!);
      output.push(signedVarint(volume - previousVolume));
      previousVolume = volume;
    }
    if (hasVwap)
      output.push(
        signedVarint(scaled(record.vwap!) - (hasPrices ? scaled(record.close!) : previousClose)),
      );
    if (hasCount) {
      const count = integer(record.transactionCount!);
      output.push(signedVarint(count - previousCount));
      previousCount = count;
    }
    if (hasSourceTimestamp) output.push(signedVarint(timestamp(record.sourceTimestamp)));
    output.push(
      signedVarint(timestamp(record.observedAt)),
      signedVarint(timestamp(record.ingestedAt)),
    );
    output.push(varint(BigInt(indexOf(headerDictionaries.providers, record.provenance.provider))));
    output.push(varint(BigInt(indexOf(headerDictionaries.datasets, record.provenance.dataset))));
    output.push(
      varint(BigInt(indexOf(headerDictionaries.retrievals, record.provenance.retrievalId))),
    );
    output.push(
      varint(
        BigInt(indexOf(headerDictionaries.ingestionVersions, record.provenance.ingestionVersion)),
      ),
    );
    output.push(
      varint(BigInt(indexOf(headerDictionaries.normalizers, record.provenance.normalizerVersion))),
    );
    if (headerDictionaries.providerTimestamps)
      output.push(
        varint(
          BigInt(
            indexOf(
              headerDictionaries.providerTimestamps,
              record.provenance.providerTimestamp ?? "",
            ),
          ),
        ),
      );
    const actions = [...new Set(record.corporateActionIds)].sort();
    output.push(varint(BigInt(actions.length)));
    for (const action of actions)
      output.push(varint(BigInt(indexOf(headerDictionaries.actions, action))));
    const flags = [...new Set(record.flags)].sort();
    output.push(varint(BigInt(flags.length)));
    for (const flag of flags) output.push(varint(BigInt(indexOf(headerDictionaries.flags, flag))));
  }
  return Buffer.concat(output);
}

export function encodeDust(records: readonly CanonicalTenMinuteBar[]): DustEncodedArchive {
  if (!records.length) throw new Error("DUST_EMPTY_BLOCK");
  const ordered = [...records].sort(
    (a, b) => a.intervalIndex - b.intervalIndex || a.revision - b.revision,
  );
  const provisional = buildHeader(ordered, "", "", 0);
  const body = encodeBody(ordered, provisional.dictionaries);
  const bodyChecksum = sha256(body);
  const payload = deflateRawSync(body, { level: 9 });
  const payloadChecksum = sha256(payload);
  const header = buildHeader(ordered, bodyChecksum, payloadChecksum, body.length);
  const headerBytes = Buffer.from(JSON.stringify(header), "utf8");
  const bytes = Buffer.concat([
    MAGIC,
    Buffer.from([1]),
    Buffer.alloc(4),
    Buffer.alloc(4),
    headerBytes,
    payload,
  ]);
  bytes.writeUInt32LE(headerBytes.length, MAGIC.length + 1);
  bytes.writeUInt32LE(payload.length, MAGIC.length + 1 + 4);
  return { bytes, header, checksum: sha256(bytes) };
}

export function decodeDust(bytes: Uint8Array): DustDecodedArchive {
  const buffer = Buffer.from(bytes);
  if (buffer.length < MAGIC.length + 9 || !buffer.subarray(0, MAGIC.length).equals(MAGIC))
    throw new Error("DUST_MAGIC_INVALID");
  const version = buffer[MAGIC.length];
  if (version !== 1) throw new Error("DUST_VERSION_UNSUPPORTED");
  const headerLength = buffer.readUInt32LE(MAGIC.length + 1);
  const payloadLength = buffer.readUInt32LE(MAGIC.length + 1 + 4);
  const headerStart = MAGIC.length + 1 + 4 + 4;
  const payloadStart = headerStart + headerLength;
  if (payloadStart + payloadLength !== buffer.length) throw new Error("DUST_LENGTH_INVALID");
  const header = JSON.parse(
    buffer.subarray(headerStart, payloadStart).toString("utf8"),
  ) as DustHeader;
  if (
    header.schemaVersion !== DUST_SCHEMA_VERSION ||
    header.logicalSchemaVersion !== INTRADAY_SCHEMA_VERSION
  )
    throw new Error("DUST_SCHEMA_MISMATCH");
  const payload = buffer.subarray(payloadStart);
  if (sha256(payload) !== header.payloadChecksum) throw new Error("DUST_PAYLOAD_CHECKSUM_MISMATCH");
  const body = inflateRawSync(payload);
  if (body.length !== header.uncompressedBytes || sha256(body) !== header.bodyChecksum)
    throw new Error("DUST_BODY_CHECKSUM_MISMATCH");
  const records: CanonicalTenMinuteBar[] = [];
  let cursor = 0;
  let previousClose = 0n;
  let previousVolume = 0n;
  let previousCount = 0n;
  for (let index = 0; index < header.recordCount; index += 1) {
    const interval = readVarint(body, cursor);
    cursor = interval.next;
    const stateCode = body[cursor++];
    const fields = body[cursor++];
    const qualityCode = body[cursor++];
    if (stateCode === undefined || fields === undefined || qualityCode === undefined)
      throw new Error("DUST_RECORD_TRUNCATED");
    const revision = readVarint(body, cursor);
    cursor = revision.next;
    let open: number | undefined,
      high: number | undefined,
      low: number | undefined,
      close: number | undefined;
    if (fields & 1) {
      const openDelta = readSigned(body, cursor);
      cursor = openDelta.next;
      const highDelta = readSigned(body, cursor);
      cursor = highDelta.next;
      const lowDelta = readSigned(body, cursor);
      cursor = lowDelta.next;
      const closeDelta = readSigned(body, cursor);
      cursor = closeDelta.next;
      const openValue = previousClose + openDelta.value;
      const highValue = openValue + highDelta.value;
      const lowValue = openValue + lowDelta.value;
      const closeValue = openValue + closeDelta.value;
      open = unscaled(openValue);
      high = unscaled(highValue);
      low = unscaled(lowValue);
      close = unscaled(closeValue);
      previousClose = closeValue;
    }
    let volume: number | undefined;
    if (fields & 2) {
      const delta = readSigned(body, cursor);
      cursor = delta.next;
      previousVolume += delta.value;
      volume = Number(previousVolume) / Number(VOLUME_SCALE);
    }
    let vwap: number | undefined;
    if (fields & 4) {
      const delta = readSigned(body, cursor);
      cursor = delta.next;
      const base = close === undefined ? previousClose : scaled(close);
      vwap = unscaled(base + delta.value);
    }
    let transactionCount: number | undefined;
    if (fields & 8) {
      const delta = readSigned(body, cursor);
      cursor = delta.next;
      previousCount += delta.value;
      transactionCount = Number(previousCount);
    }
    let sourceTimestamp: string | undefined;
    if (fields & 16) {
      const value = readSigned(body, cursor);
      cursor = value.next;
      sourceTimestamp = iso(value.value);
    }
    const observed = readSigned(body, cursor);
    cursor = observed.next;
    const ingested = readSigned(body, cursor);
    cursor = ingested.next;
    const provider = readVarint(body, cursor);
    cursor = provider.next;
    const dataset = readVarint(body, cursor);
    cursor = dataset.next;
    const retrieval = readVarint(body, cursor);
    cursor = retrieval.next;
    const ingestion = readVarint(body, cursor);
    cursor = ingestion.next;
    const normalizer = readVarint(body, cursor);
    cursor = normalizer.next;
    let providerTimestampValue: string | undefined;
    if (header.dictionaries.providerTimestamps) {
      const providerTimestamp = readVarint(body, cursor);
      cursor = providerTimestamp.next;
      const value = header.dictionaries.providerTimestamps[Number(providerTimestamp.value)];
      if (value === undefined) throw new Error("DUST_PROVIDER_TIMESTAMP_DICTIONARY_INVALID");
      if (value) providerTimestampValue = value;
    }
    const actionCount = readVarint(body, cursor);
    cursor = actionCount.next;
    const corporateActionIds: string[] = [];
    for (let actionIndex = 0; actionIndex < Number(actionCount.value); actionIndex += 1) {
      const item = readVarint(body, cursor);
      cursor = item.next;
      const value = header.dictionaries.actions[Number(item.value)];
      if (value === undefined) throw new Error("DUST_ACTION_DICTIONARY_INVALID");
      corporateActionIds.push(value);
    }
    const flagCount = readVarint(body, cursor);
    cursor = flagCount.next;
    const flags: string[] = [];
    for (let flagIndex = 0; flagIndex < Number(flagCount.value); flagIndex += 1) {
      const item = readVarint(body, cursor);
      cursor = item.next;
      const value = header.dictionaries.flags[Number(item.value)];
      if (value === undefined) throw new Error("DUST_FLAG_DICTIONARY_INVALID");
      flags.push(value);
    }
    const providerValue = header.dictionaries.providers[Number(provider.value)],
      datasetValue = header.dictionaries.datasets[Number(dataset.value)],
      retrievalValue = header.dictionaries.retrievals[Number(retrieval.value)],
      ingestionValue = header.dictionaries.ingestionVersions[Number(ingestion.value)],
      normalizerValue = header.dictionaries.normalizers[Number(normalizer.value)];
    if (!providerValue || !datasetValue || !retrievalValue || !ingestionValue || !normalizerValue)
      throw new Error("DUST_PROVENANCE_DICTIONARY_INVALID");
    records.push({
      securityId: header.securityId,
      sessionDate: header.sessionDate,
      intervalIndex: Number(interval.value),
      state: numberValue(STATES, stateCode),
      ...(open === undefined ? {} : { open, high: high!, low: low!, close: close! }),
      ...(volume === undefined ? {} : { volume }),
      ...(vwap === undefined ? {} : { vwap }),
      ...(transactionCount === undefined ? {} : { transactionCount }),
      ...(sourceTimestamp === undefined ? {} : { sourceTimestamp }),
      observedAt: iso(observed.value),
      ingestedAt: iso(ingested.value),
      dataQuality: numberValue(QUALITIES, qualityCode),
      corporateActionIds,
      flags,
      schemaVersion: INTRADAY_SCHEMA_VERSION,
      revision: Number(revision.value),
      provenance: {
        provider: providerValue,
        dataset: datasetValue,
        retrievalId: retrievalValue,
        ...(providerTimestampValue === undefined
          ? {}
          : { providerTimestamp: providerTimestampValue }),
        ingestionVersion: ingestionValue,
        normalizerVersion: normalizerValue,
      },
    });
  }
  if (cursor !== body.length) throw new Error("DUST_TRAILING_BODY_BYTES");
  return { header, records, checksum: sha256(buffer) };
}

export function dustManifestChecksum(manifest: DustArchiveManifest): string {
  const canonical = JSON.stringify({ ...manifest, checksum: "" });
  return sha256(Buffer.from(canonical, "utf8"));
}
