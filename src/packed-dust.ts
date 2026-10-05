import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { rename, writeFile } from "node:fs/promises";
import type { CanonicalTenMinuteBar, DataQuality, IntradayIntervalState } from "./contracts";
import { INTRADAY_SCHEMA_VERSION } from "./contracts";
import { stableJson } from "./identity";

export const PACKED_DUST_FORMAT = "PACKED_BLOCKS_FOR_DELTA_STATES_ZSTD7" as const;
export const FROZEN_PACKED_FIXTURE_HASH =
  "7d70c208667c51c5f7156d90cbefb4c9a557703d599e26773706d1a228661ecd";
const MAGIC = [0x50, 0x53, 0x44, 0x5a];
const VERSION = 1;
const LEVEL = 7;
const PRICE_SCALE = 1_000_000;
const STATES: readonly IntradayIntervalState[] = [
  "VALID_TRADED",
  "NO_TRADE",
  "HALTED",
  "NOT_LISTED",
  "INACTIVE",
  "PROVIDER_MISSING",
  "SOURCE_FAILURE",
  "PARTIAL",
];
const QUALITIES: readonly DataQuality[] = [
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

class Writer {
  private readonly bytes: number[] = [];
  push(value: number): void {
    this.bytes.push(value);
  }
  varint(value: number): void {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("PACKED_VARINT_INVALID");
    let rest = value;
    while (rest > 127) {
      this.push((rest & 127) | 128);
      rest = Math.floor(rest / 128);
    }
    this.push(rest);
  }
  text(value: string): void {
    const encoded = new TextEncoder().encode(value);
    this.varint(encoded.length);
    for (const byte of encoded) this.push(byte);
  }
  toBytes(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
}

class ByteReader {
  private offset = 0;
  constructor(private readonly bytes: Uint8Array) {}
  private take(): number {
    const value = this.bytes[this.offset];
    if (value === undefined) throw new Error("PACKED_TRUNCATED");
    this.offset += 1;
    return value;
  }
  varint(): number {
    let value = 0;
    let shift = 1;
    for (let i = 0; i < 10; i += 1) {
      const byte = this.take();
      value += (byte & 127) * shift;
      if ((byte & 128) === 0) return value;
      shift *= 128;
    }
    throw new Error("PACKED_VARINT_INVALID");
  }
  text(): string {
    const length = this.varint();
    const slice = this.bytes.slice(this.offset, this.offset + length);
    if (slice.length !== length) throw new Error("PACKED_TRUNCATED");
    this.offset += length;
    return new TextDecoder().decode(slice);
  }
  done(): void {
    if (this.offset !== this.bytes.length) throw new Error("PACKED_TRAILING_BYTES");
  }
}

function scaled(value: number): number {
  const scaledValue = Math.round(value * PRICE_SCALE);
  if (!Number.isSafeInteger(scaledValue) || Math.abs(scaledValue / PRICE_SCALE - value) > 1e-9)
    throw new Error("PACKED_PRICE_SCALE");
  return scaledValue;
}

function zigzag(value: number): number {
  return value >= 0 ? value * 2 : -value * 2 - 1;
}

function unzigzag(value: number): number {
  return value % 2 === 0 ? value / 2 : -(value + 1) / 2;
}

// Node's spawnSync default maxBuffer is 1 MiB, which made month-sized blocks fail with ZSTD_FAILED.
const ZSTD_MAX_OUTPUT_BYTES = 1024 * 1024 * 1024;

function zstd(mode: "compress" | "decompress", input: Uint8Array): Uint8Array {
  const result = spawnSync("zstd", mode === "compress" ? ["-7", "-c"] : ["-d", "-c"], {
    input: Buffer.from(input),
    maxBuffer: ZSTD_MAX_OUTPUT_BYTES,
  });
  if (result.error || result.status !== 0) throw new Error("ZSTD_FAILED");
  return new Uint8Array(result.stdout);
}

export function logicalFixtureHash(bars: readonly CanonicalTenMinuteBar[]): string {
  return createHash("sha256").update(stableJson(bars)).digest("hex");
}

export function encodePackedBars(bars: readonly CanonicalTenMinuteBar[]): Uint8Array {
  const ordered = [...bars].sort(
    (left, right) =>
      left.securityId.localeCompare(right.securityId) ||
      left.sessionDate.localeCompare(right.sessionDate) ||
      left.intervalIndex - right.intervalIndex ||
      left.revision - right.revision,
  );
  const strings: string[] = [];
  const indexOf = (value: string): number => {
    let index = strings.indexOf(value);
    if (index < 0) {
      index = strings.length;
      strings.push(value);
    }
    return index;
  };
  const payload = new Writer();
  const previous = new Map<string, number>();
  const delta = (key: string, value: number): number => {
    const next = value - (previous.get(key) ?? 0);
    previous.set(key, value);
    return zigzag(next);
  };
  payload.varint(ordered.length);
  for (const bar of ordered) {
    if (bar.schemaVersion !== INTRADAY_SCHEMA_VERSION) throw new Error("PACKED_SCHEMA_MISMATCH");
    const security = indexOf(bar.securityId);
    const presence =
      (bar.open === undefined ? 0 : 1) |
      (bar.high === undefined ? 0 : 2) |
      (bar.low === undefined ? 0 : 4) |
      (bar.close === undefined ? 0 : 8) |
      (bar.volume === undefined ? 0 : 16) |
      (bar.vwap === undefined ? 0 : 32) |
      (bar.transactionCount === undefined ? 0 : 64) |
      (bar.sourceTimestamp === undefined ? 0 : 128);
    const state = STATES.indexOf(bar.state);
    const quality = QUALITIES.indexOf(bar.dataQuality);
    if (state < 0 || quality < 0) throw new Error("PACKED_STATE_INVALID");
    payload.varint(security);
    payload.varint(indexOf(bar.sessionDate));
    payload.varint(bar.intervalIndex);
    payload.varint(state);
    payload.varint(quality);
    payload.varint(presence);
    const numeric = (name: string, value: number | undefined, bit: number): void => {
      if ((presence & bit) === 0 || value === undefined) return;
      payload.varint(delta(`${security}:${name}`, scaled(value)));
    };
    numeric("open", bar.open, 1);
    numeric("high", bar.high, 2);
    numeric("low", bar.low, 4);
    numeric("close", bar.close, 8);
    numeric("volume", bar.volume, 16);
    numeric("vwap", bar.vwap, 32);
    if (bar.transactionCount !== undefined)
      payload.varint(delta(`${security}:transactions`, bar.transactionCount));
    if (bar.sourceTimestamp !== undefined) payload.varint(indexOf(bar.sourceTimestamp));
    payload.varint(indexOf(bar.observedAt));
    payload.varint(indexOf(bar.ingestedAt));
    payload.varint(bar.corporateActionIds.length);
    for (const id of bar.corporateActionIds) payload.varint(indexOf(id));
    payload.varint(bar.flags.length);
    for (const flag of bar.flags) payload.varint(indexOf(flag));
    payload.varint(bar.revision);
    payload.varint(indexOf(bar.provenance.provider));
    payload.varint(indexOf(bar.provenance.dataset));
    payload.varint(indexOf(bar.provenance.retrievalId));
    payload.varint(bar.provenance.providerTimestamp === undefined ? 0 : 1);
    if (bar.provenance.providerTimestamp !== undefined)
      payload.varint(indexOf(bar.provenance.providerTimestamp));
    payload.varint(indexOf(bar.provenance.ingestionVersion));
    payload.varint(indexOf(bar.provenance.normalizerVersion));
  }
  payload.varint(strings.length);
  for (const value of strings) payload.text(value);
  const raw = payload.toBytes();
  const checksum = createHash("sha256").update(raw).digest();
  const compressed = zstd("compress", raw);
  const header = new Uint8Array(42 + compressed.length);
  header.set(MAGIC, 0);
  header[4] = VERSION;
  header[5] = LEVEL;
  header.set(checksum, 6);
  new DataView(header.buffer).setUint32(38, compressed.length);
  header.set(compressed, 42);
  return header;
}

export function decodePackedBars(bytes: Uint8Array): CanonicalTenMinuteBar[] {
  if (bytes.length < 42) throw new Error("PACKED_TRUNCATED");
  if (MAGIC.some((byte, index) => bytes[index] !== byte)) throw new Error("PACKED_MAGIC_MISMATCH");
  if (bytes[4] !== VERSION) throw new Error("PACKED_VERSION_MISMATCH");
  if (bytes[5] !== LEVEL) throw new Error("PACKED_LEVEL_MISMATCH");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const compressedLength = view.getUint32(38);
  if (bytes.length !== 42 + compressedLength) throw new Error("PACKED_TRUNCATED");
  const raw = zstd("decompress", bytes.slice(42));
  const checksum = createHash("sha256").update(raw).digest();
  if (!checksum.every((byte, index) => byte === bytes[6 + index]))
    throw new Error("PACKED_CHECKSUM_MISMATCH");
  const reader = new ByteReader(raw);
  const count = reader.varint();
  const drafts: Array<{
    security: number;
    session: number;
    intervalIndex: number;
    state: IntradayIntervalState;
    quality: DataQuality;
    open?: number;
    high?: number;
    low?: number;
    close?: number;
    volume?: number;
    vwap?: number;
    transactionCount?: number;
    source?: number;
    observed: number;
    ingested: number;
    actions: number[];
    flags: number[];
    revision: number;
    provider: number;
    dataset: number;
    retrieval: number;
    providerTimestamp?: number;
    ingestion: number;
    normalizer: number;
  }> = [];
  const previous = new Map<string, number>();
  const undelta = (key: string, encoded: number, scale: number): number => {
    const value = (previous.get(key) ?? 0) + unzigzag(encoded);
    previous.set(key, value);
    return value / scale;
  };
  for (let i = 0; i < count; i += 1) {
    const security = reader.varint();
    const session = reader.varint();
    const intervalIndex = reader.varint();
    const state = STATES[reader.varint()];
    const quality = QUALITIES[reader.varint()];
    if (!state || !quality) throw new Error("PACKED_STATE_INVALID");
    const presence = reader.varint();
    const numberAt = (name: string, bit: number): number | undefined =>
      (presence & bit) === 0 ? undefined : undelta(`${security}:${name}`, reader.varint(), PRICE_SCALE);
    const open = numberAt("open", 1);
    const high = numberAt("high", 2);
    const low = numberAt("low", 4);
    const close = numberAt("close", 8);
    const volume = numberAt("volume", 16);
    const vwap = numberAt("vwap", 32);
    const transactionCount =
      (presence & 64) === 0
        ? undefined
        : undelta(`${security}:transactions`, reader.varint(), 1);
    const source = (presence & 128) === 0 ? undefined : reader.varint();
    const observed = reader.varint();
    const ingested = reader.varint();
    const actionCount = reader.varint();
    const actions = Array.from({ length: actionCount }, () => reader.varint());
    const flagCount = reader.varint();
    const flags = Array.from({ length: flagCount }, () => reader.varint());
    const revision = reader.varint();
    const provider = reader.varint();
    const dataset = reader.varint();
    const retrieval = reader.varint();
    const hasProviderTimestamp = reader.varint() === 1;
    const providerTimestamp = hasProviderTimestamp ? reader.varint() : undefined;
    const ingestion = reader.varint();
    const normalizer = reader.varint();
    drafts.push({
      security,
      session,
      intervalIndex,
      state,
      quality,
      ...(open === undefined ? {} : { open }),
      ...(high === undefined ? {} : { high }),
      ...(low === undefined ? {} : { low }),
      ...(close === undefined ? {} : { close }),
      ...(volume === undefined ? {} : { volume }),
      ...(vwap === undefined ? {} : { vwap }),
      ...(transactionCount === undefined ? {} : { transactionCount }),
      ...(source === undefined ? {} : { source }),
      observed,
      ingested,
      actions,
      flags,
      revision,
      provider,
      dataset,
      retrieval,
      ...(providerTimestamp === undefined ? {} : { providerTimestamp }),
      ingestion,
      normalizer,
    });
  }
  const strings = Array.from({ length: reader.varint() }, () => reader.text());
  reader.done();
  const at = (index: number): string => {
    const value = strings[index];
    if (value === undefined) throw new Error("PACKED_DICTIONARY_MISS");
    return value;
  };
  return drafts.map((draft) => ({
    securityId: at(draft.security),
    sessionDate: at(draft.session),
    intervalIndex: draft.intervalIndex,
    state: draft.state,
    ...(draft.open === undefined ? {} : { open: draft.open }),
    ...(draft.high === undefined ? {} : { high: draft.high }),
    ...(draft.low === undefined ? {} : { low: draft.low }),
    ...(draft.close === undefined ? {} : { close: draft.close }),
    ...(draft.volume === undefined ? {} : { volume: draft.volume }),
    ...(draft.vwap === undefined ? {} : { vwap: draft.vwap }),
    ...(draft.transactionCount === undefined ? {} : { transactionCount: draft.transactionCount }),
    ...(draft.source === undefined ? {} : { sourceTimestamp: at(draft.source) }),
    observedAt: at(draft.observed),
    ingestedAt: at(draft.ingested),
    dataQuality: draft.quality,
    corporateActionIds: draft.actions.map(at),
    flags: draft.flags.map(at),
    schemaVersion: INTRADAY_SCHEMA_VERSION,
    revision: draft.revision,
    provenance: {
      provider: at(draft.provider),
      dataset: at(draft.dataset),
      retrievalId: at(draft.retrieval),
      ...(draft.providerTimestamp === undefined
        ? {}
        : { providerTimestamp: at(draft.providerTimestamp) }),
      ingestionVersion: at(draft.ingestion),
      normalizerVersion: at(draft.normalizer),
    },
  }));
}

export async function sealPackedArchive(path: string, bars: readonly CanonicalTenMinuteBar[]): Promise<void> {
  const encoded = encodePackedBars(bars);
  decodePackedBars(encoded);
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, encoded);
  await rename(temporary, path);
}
