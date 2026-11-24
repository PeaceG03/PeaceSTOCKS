// Daily-bars sidecar v1 (writer side): one object per session that, with that day's grouped-daily Reply
// Dust (when present), rebuilds every permanent/daily-bars/YYYY-MM.jsonl line of the session byte for byte.
// Rows either point at a Dust result (index into reply.results) or are packed (values carried here), so the
// same format is the lossless pack for sessions without Dust.
//   permanent/daily-bars-sidecar/YYYY-MM-DD/sidecar.dbs   byte 0 = 0x21, then one zstd 1.5.7 frame (-19,
//                                                         --no-check, --no-dictID, no dictionary) of the
//                                                         stableJson payload
//   permanent/daily-bars-sidecar/YYYY-MM-DD/manifest.json sha256 of file, payload and lines; seals the day
// The decoder is a separate module (daily-bars-pack-decode.ts) that shares no code with this file.
import { createHash } from "node:crypto";
import { decodeDailyBarsPack } from "./daily-bars-pack-decode";
import type { CanonicalDailyBar, SecurityMasterRecord } from "./contracts";
import { stableJson } from "./identity";
import type { ReplyDustStore } from "./intraday-reply-dust";
import { sameBytes } from "./intraday-reply-dust";
import { type ReplyDustBackend, nodeReplyDustBackend } from "./reply-dust";

export const DAILY_BARS_SIDECAR_VERSION = 0x21;
export const DAILY_BARS_SIDECAR_SCHEMA = "daily-bars-sidecar-v1" as const;
export const DAILY_BARS_SIDECAR_MANIFEST_SCHEMA = "daily-bars-sidecar-manifest-v1" as const;
export const DAILY_BARS_SIDECAR_PREFIX = "permanent/daily-bars-sidecar";
export const DAILY_BARS_SIDECAR_WARNING = "DAILY_BARS_SIDECAR_WARNING" as const;
/** Run-failing codes (the scan FAILS and exits non-zero). Format: <CODE>:<sessionDate>[:<ERROR_CODE>]. */
export const DAILY_BARS_PACK_EXISTS_DIFFERENT = "DAILY_BARS_PACK_EXISTS_DIFFERENT" as const;
export const DAILY_BARS_PACK_WRITE_FAILED = "DAILY_BARS_PACK_WRITE_FAILED" as const;
/** Warning only: the stored pack holds the same market rows; only ingestion stamps (SIDECAR_META) differ. */
export const DAILY_BARS_PACK_EXISTS_EQUIVALENT = "DAILY_BARS_PACK_EXISTS_EQUIVALENT" as const;
/** Warning only: stored rows for a sealed session that its pack does not hold (appended after the seal). */
export const DAILY_BARS_ROWS_OUTSIDE_PACK = "DAILY_BARS_ROWS_OUTSIDE_PACK" as const;
/** Leading upper-case code of an error message only (never values). */
export function errorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return /^[A-Z][A-Z0-9_]*/u.exec(message)?.[0] ?? "UNKNOWN";
}

const sha256Hex = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");

export const SIDECAR_META = [
  "observedAt",
  "ingestedAt",
  "provenance.providerTimestamp",
  "provenance.retrievalId",
] as const;
export const SIDECAR_TEMPLATE = [
  "corporateActionIds",
  "dataQuality",
  "flags",
  "revision",
  "schemaVersion",
  "provenance.dataset",
  "provenance.ingestionVersion",
  "provenance.normalizerVersion",
  "provenance.provider",
] as const;
const MARKET = ["open", "high", "low", "close", "volume", "sourceTimestamp"] as const;
const ABSENT = { $absent: true } as const;
const isAbsent = (value: unknown) => stableJson(value) === stableJson(ABSENT);

export interface DailyBarsSidecarPayload {
  schema: typeof DAILY_BARS_SIDECAR_SCHEMA;
  sessionDate: string;
  dust: null | { replySha256: string; replyByteLength: number; resultsCount: number };
  template: Record<string, unknown>;
  defaults: Record<string, unknown>;
  securityIds: string[];
  resultIndex: number[];
  packed: { open: number[]; high: number[]; low: number[]; close: number[]; volume: number[]; t: (number | null)[] };
  corrections: Record<string, Record<string, unknown>>;
  exceptions: Record<string, Record<string, unknown>>;
}

export interface DailyBarsSidecarManifest {
  schemaVersion: typeof DAILY_BARS_SIDECAR_MANIFEST_SCHEMA;
  sessionDate: string;
  version: number;
  zstd: "1.5.7";
  source: "dust" | "pack" | "dust+pack";
  dustReplySha256: string | null;
  rows: number;
  packedRows: number;
  correctionRows: number;
  exceptionRows: number;
  byteLength: number;
  fileSha256: string;
  payloadSha256: string;
  payloadByteLength: number;
  linesSha256: string;
  checksum: string;
}

type Row = Record<string, unknown> & { securityId: string; sessionDate: string };
type GroupedResult = Record<string, unknown>;

function getPath(row: Record<string, any>, path: string): unknown {
  const [a, b] = path.split(".");
  return b === undefined ? row[a!] : row[a!]?.[b];
}
function setPath(row: Record<string, any>, path: string, value: unknown): void {
  const [a, b] = path.split(".");
  if (b === undefined) {
    if (isAbsent(value)) delete row[a!];
    else row[a!] = value;
    return;
  }
  row[a!] ??= {};
  if (isAbsent(value)) delete row[a!][b];
  else row[a!][b] = value;
}

function marketFromResult(result: GroupedResult): Record<string, unknown> {
  const out: Record<string, unknown> = {
    open: result.o,
    high: result.h,
    low: result.l,
    close: result.c,
    volume: result.v,
  };
  if (typeof result.t === "number" && Number.isFinite(result.t))
    out.sourceTimestamp = new Date(result.t).toISOString();
  return out;
}

/** Writer-side reconstruction, used only to self-check before anything is stored. */
function sidecarLines(payload: DailyBarsSidecarPayload, results: GroupedResult[] | null): string[] {
  let packed = 0;
  return payload.securityIds.map((securityId, i) => {
    const row: Record<string, any> = { securityId, sessionDate: payload.sessionDate };
    for (const f of SIDECAR_TEMPLATE) setPath(row, f, structuredClone(payload.template[f]));
    for (const f of SIDECAR_META) setPath(row, f, payload.defaults[f]);
    const index = payload.resultIndex[i]!;
    let market: Record<string, unknown>;
    if (index >= 0) market = marketFromResult(results![index]!);
    else {
      const t = payload.packed.t[packed];
      market = {
        open: payload.packed.open[packed],
        high: payload.packed.high[packed],
        low: payload.packed.low[packed],
        close: payload.packed.close[packed],
        volume: payload.packed.volume[packed],
        ...(t === null || t === undefined ? {} : { sourceTimestamp: new Date(t).toISOString() }),
      };
      packed += 1;
    }
    Object.assign(row, market);
    for (const [f, v] of Object.entries(payload.corrections[securityId] ?? {})) setPath(row, f, v);
    for (const [f, v] of Object.entries(payload.exceptions[securityId] ?? {})) setPath(row, f, v);
    return stableJson(row);
  });
}

/** symbol -> result indexes, and a security -> result index finder (prefers an exact market match). */
export function groupedResultIndexer(
  results: readonly GroupedResult[],
  symbolsFor: (securityId: string) => readonly string[],
): (row: Row) => number {
  const byT = new Map<string, number[]>();
  results.forEach((result, i) => {
    const t = typeof result.T === "string" ? result.T : "";
    byT.set(t, [...(byT.get(t) ?? []), i]);
  });
  return (row) => {
    let first = -1;
    for (const symbol of symbolsFor(row.securityId))
      for (const i of byT.get(symbol) ?? []) {
        const r = results[i]!;
        if (first < 0) first = i;
        if (r.o === row.open && r.h === row.high && r.l === row.low && r.c === row.close && r.v === row.volume)
          return i;
      }
    return first;
  };
}

/** Symbols to try for a security: current first, then historical ones. */
export function securitySymbols(securities: readonly SecurityMasterRecord[]): (securityId: string) => string[] {
  const map = new Map<string, string[]>();
  for (const s of securities)
    map.set(s.securityId, [
      s.currentSymbol,
      ...(s.historicalSymbols ?? []).map((h) => h.symbol).filter((symbol) => symbol !== s.currentSymbol),
    ]);
  return (id) => map.get(id) ?? [];
}

/**
 * Build a session's payload from its stored rows (in stored line order) and, optionally, the session's
 * grouped-daily reply. Throws unless every line rebuilds byte for byte.
 */
export function buildDailyBarsSidecar(input: {
  sessionDate: string;
  rows: readonly Row[];
  lines: readonly string[];
  dust: null | { replySha256: string; replyByteLength: number; results: GroupedResult[] };
  indexFor?: (row: Row) => number;
}): DailyBarsSidecarPayload {
  const { rows } = input;
  if (rows.length !== input.lines.length) throw new Error("DAILY_BARS_SIDECAR_ROWS_LINES_MISMATCH");
  const mode = (path: string): unknown => {
    const counts = new Map<string, { n: number; value: unknown }>();
    for (const row of rows) {
      const value = getPath(row, path) ?? ABSENT;
      const key = stableJson(value);
      const hit = counts.get(key);
      if (hit) hit.n += 1;
      else counts.set(key, { n: 1, value });
    }
    return [...counts.entries()].sort((a, b) => b[1].n - a[1].n || (a[0] < b[0] ? -1 : 1))[0]?.[1].value ?? ABSENT;
  };
  const payload: DailyBarsSidecarPayload = {
    schema: DAILY_BARS_SIDECAR_SCHEMA,
    sessionDate: input.sessionDate,
    dust: input.dust
      ? { replySha256: input.dust.replySha256, replyByteLength: input.dust.replyByteLength, resultsCount: input.dust.results.length }
      : null,
    template: Object.fromEntries(SIDECAR_TEMPLATE.map((f) => [f, mode(f)])),
    defaults: Object.fromEntries(SIDECAR_META.map((f) => [f, mode(f)])),
    securityIds: [],
    resultIndex: [],
    packed: { open: [], high: [], low: [], close: [], volume: [], t: [] },
    corrections: {},
    exceptions: {},
  };
  const known = new Set<string>(["securityId", "sessionDate", "provenance", ...MARKET]);
  const knownProvenance = new Set<string>();
  for (const f of [...SIDECAR_TEMPLATE, ...SIDECAR_META])
    if (f.startsWith("provenance.")) knownProvenance.add(f.slice(11));
    else known.add(f);
  for (const row of rows) {
    if (row.sessionDate !== input.sessionDate) throw new Error("DAILY_BARS_SIDECAR_SESSION_MISMATCH");
    if (Object.keys(row).some((k) => !known.has(k))) throw new Error(`DAILY_BARS_SIDECAR_UNKNOWN_FIELD:${row.securityId}`);
    const provenance = (row.provenance ?? {}) as Record<string, unknown>;
    if (Object.keys(provenance).some((k) => !knownProvenance.has(k)))
      throw new Error(`DAILY_BARS_SIDECAR_UNKNOWN_FIELD:${row.securityId}`);
    payload.securityIds.push(row.securityId);
    const index = input.dust && input.indexFor ? input.indexFor(row) : -1;
    payload.resultIndex.push(index);
    let market: Record<string, unknown>;
    if (index >= 0) market = marketFromResult(input.dust!.results[index]!);
    else {
      const t = typeof row.sourceTimestamp === "string" ? Date.parse(row.sourceTimestamp) : null;
      payload.packed.open.push(row.open as number);
      payload.packed.high.push(row.high as number);
      payload.packed.low.push(row.low as number);
      payload.packed.close.push(row.close as number);
      payload.packed.volume.push(row.volume as number);
      payload.packed.t.push(t === null || Number.isNaN(t) ? null : t);
      market = { open: row.open, high: row.high, low: row.low, close: row.close, volume: row.volume,
        ...(t === null || Number.isNaN(t) ? {} : { sourceTimestamp: new Date(t).toISOString() }) };
    }
    for (const f of MARKET)
      if (stableJson(market[f] ?? ABSENT) !== stableJson(row[f] ?? ABSENT))
        (payload.corrections[row.securityId] ??= {})[f] = row[f] ?? ABSENT;
    for (const f of [...SIDECAR_TEMPLATE, ...SIDECAR_META]) {
      const want = getPath(row, f) ?? ABSENT;
      const have = (SIDECAR_TEMPLATE as readonly string[]).includes(f) ? payload.template[f] : payload.defaults[f];
      if (stableJson(want) !== stableJson(have)) (payload.exceptions[row.securityId] ??= {})[f] = want;
    }
  }
  const back = sidecarLines(payload, input.dust?.results ?? null);
  back.forEach((line, i) => {
    if (line !== input.lines[i]) throw new Error(`DAILY_BARS_SIDECAR_SELF_CHECK:${input.sessionDate}:${i}`);
  });
  return payload;
}

export function encodeDailyBarsSidecar(
  payload: DailyBarsSidecarPayload,
  backend: ReplyDustBackend = nodeReplyDustBackend,
): Uint8Array {
  const raw = new TextEncoder().encode(stableJson(payload));
  const frame = backend.compress(raw, null);
  const out = new Uint8Array(frame.length + 1);
  out[0] = DAILY_BARS_SIDECAR_VERSION;
  out.set(frame, 1);
  if (!sameBytes(backend.decompress(out.subarray(1), null), raw)) throw new Error("DAILY_BARS_SIDECAR_ENCODE_VERIFY");
  return out;
}

export function dailyBarsSidecarManifest(
  payload: DailyBarsSidecarPayload,
  file: Uint8Array,
  lines: readonly string[],
): DailyBarsSidecarManifest {
  const raw = new TextEncoder().encode(stableJson(payload));
  const body: Omit<DailyBarsSidecarManifest, "checksum"> = {
    schemaVersion: DAILY_BARS_SIDECAR_MANIFEST_SCHEMA,
    sessionDate: payload.sessionDate,
    version: DAILY_BARS_SIDECAR_VERSION,
    zstd: "1.5.7",
    source: payload.dust ? (payload.resultIndex.every((i) => i >= 0) ? "dust" : "dust+pack") : "pack",
    dustReplySha256: payload.dust?.replySha256 ?? null,
    rows: lines.length,
    packedRows: payload.resultIndex.filter((i) => i < 0).length,
    correctionRows: Object.keys(payload.corrections).length,
    exceptionRows: Object.keys(payload.exceptions).length,
    byteLength: file.length,
    fileSha256: sha256Hex(file),
    payloadSha256: sha256Hex(raw),
    payloadByteLength: raw.length,
    linesSha256: sha256Hex(lines.length ? `${lines.join("\n")}\n` : ""),
  };
  return { ...body, checksum: sha256Hex(stableJson(body)) };
}

function dayPrefix(sessionDate: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(sessionDate)) throw new Error("INVALID_SESSION_DATE");
  return `${DAILY_BARS_SIDECAR_PREFIX}/${sessionDate}`;
}
export const dailyBarsSidecarFileKey = (sessionDate: string) => `${dayPrefix(sessionDate)}/sidecar.dbs`;
export const dailyBarsSidecarManifestKey = (sessionDate: string) => `${dayPrefix(sessionDate)}/manifest.json`;

export type DailyBarsSidecarWriteStatus =
  | "stored"
  | "exists-same"
  | "exists-equivalent"
  | "exists-different"
  | "sealed-verified"
  | "no-rows";

/** A row without its ingestion stamps (SIDECAR_META), as canonical JSON. */
function marketContent(line: string): string {
  const row = JSON.parse(line) as Record<string, unknown>;
  for (const path of SIDECAR_META) {
    const [head, leaf] = path.split(".") as [string, string | undefined];
    if (leaf === undefined) delete row[head];
    else if (row[head] && typeof row[head] === "object") {
      const inner = { ...(row[head] as Record<string, unknown>) };
      delete inner[leaf];
      row[head] = inner;
    }
  }
  return stableJson(row);
}
function sameMarketContent(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const left = a.map(marketContent).sort();
  const right = b.map(marketContent).sort();
  return left.every((line, i) => line === right[i]);
}
export interface DailyBarsSidecarWriteResult {
  status: DailyBarsSidecarWriteStatus;
  sessionDate: string;
  manifest?: DailyBarsSidecarManifest;
  bytesWritten: number;
}

/**
 * Store one session's sidecar: new keys only. The file goes first (put, read back, compare), then the
 * manifest (put, read back, compare), which seals the day. An existing manifest is never replaced:
 * same lines or same file bytes => exists-same; the stored pack decodes to the same market rows with
 * only ingestion stamps differing => exists-equivalent (no-op, caller warns); otherwise exists-different
 * (caller fails the run). A file without a manifest is never overwritten: byte-identical => the manifest
 * is written to seal it (stored); otherwise exists-different.
 */
export async function writeDailyBarsSidecar(options: {
  store: ReplyDustStore;
  sessionDate: string;
  rows: readonly CanonicalDailyBar[];
  dust: null | { replySha256: string; replyByteLength: number; results: GroupedResult[] };
  /** The raw grouped-daily reply behind `dust`; lets an existing Dust-bound pack be decoded and compared. */
  dustReply?: Uint8Array | null;
  symbolsFor?: (securityId: string) => readonly string[];
  backend?: ReplyDustBackend;
}): Promise<DailyBarsSidecarWriteResult> {
  const backend = options.backend ?? nodeReplyDustBackend;
  const { sessionDate } = options;
  const rows = [...options.rows].filter((r) => r.sessionDate === sessionDate) as unknown as Row[];
  if (!rows.length) return { status: "no-rows", sessionDate, bytesWritten: 0 };
  // Stored line order inside a session: securityId|sessionDate|revision, localeCompare (appendUnique).
  rows.sort((a, b) =>
    `${a.securityId}|${a.sessionDate}|${a.revision}`.localeCompare(`${b.securityId}|${b.sessionDate}|${b.revision}`),
  );
  const lines = rows.map((row) => stableJson(row));
  const payload = buildDailyBarsSidecar({
    sessionDate,
    rows,
    lines,
    dust: options.dust,
    ...(options.dust && options.symbolsFor
      ? { indexFor: groupedResultIndexer(options.dust.results, options.symbolsFor) }
      : {}),
  });
  const file = encodeDailyBarsSidecar(payload, backend);
  const manifest = dailyBarsSidecarManifest(payload, file, lines);
  const manifestKey = dailyBarsSidecarManifestKey(sessionDate);
  const fileKey = dailyBarsSidecarFileKey(sessionDate);
  const existing = await options.store.get(manifestKey);
  if (existing) {
    const prior = JSON.parse(new TextDecoder().decode(existing)) as DailyBarsSidecarManifest;
    const done = (status: DailyBarsSidecarWriteStatus): DailyBarsSidecarWriteResult => ({ status, sessionDate, manifest: prior, bytesWritten: 0 });
    if (prior.linesSha256 === manifest.linesSha256 || prior.fileSha256 === manifest.fileSha256) return done("exists-same");
    const storedLines = await decodeStoredLines(options.store, fileKey, existing, prior, options, backend);
    return done(storedLines && sameMarketContent(storedLines, lines) ? "exists-equivalent" : "exists-different");
  }
  const orphan = await options.store.head(fileKey);
  if (orphan) {
    const storedFile = orphan.size === file.length ? await options.store.get(fileKey) : undefined;
    if (!storedFile || !sameBytes(storedFile, file)) return { status: "exists-different", sessionDate, bytesWritten: 0 };
    return { status: "stored", sessionDate, manifest, bytesWritten: await sealManifest(options.store, manifestKey, manifest, sessionDate) };
  }
  await options.store.put(fileKey, file, {
    "dbs-schema": DAILY_BARS_SIDECAR_SCHEMA,
    "dbs-session-date": sessionDate,
    "dbs-file-sha256": manifest.fileSha256,
  });
  const storedFile = await options.store.get(fileKey);
  if (!storedFile || !sameBytes(storedFile, file)) throw new Error(`DAILY_BARS_SIDECAR_READBACK_MISMATCH:${sessionDate}`);
  const manifestBytes = await sealManifest(options.store, manifestKey, manifest, sessionDate);
  return { status: "stored", sessionDate, manifest, bytesWritten: file.length + manifestBytes };
}

/** Put the manifest, read it back, compare. Returns the bytes written. */
async function sealManifest(
  store: ReplyDustStore,
  manifestKey: string,
  manifest: DailyBarsSidecarManifest,
  sessionDate: string,
): Promise<number> {
  const manifestBytes = new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);
  await store.put(manifestKey, manifestBytes);
  const storedManifest = await store.get(manifestKey);
  if (!storedManifest || !sameBytes(storedManifest, manifestBytes))
    throw new Error(`DAILY_BARS_SIDECAR_MANIFEST_READBACK_MISMATCH:${sessionDate}`);
  return manifestBytes.length;
}

/** The stored pack's lines, or undefined when it cannot be decoded here (then it counts as different). */
async function decodeStoredLines(
  store: ReplyDustStore,
  fileKey: string,
  manifestBytes: Uint8Array,
  prior: DailyBarsSidecarManifest,
  options: { dust: null | { replySha256: string }; dustReply?: Uint8Array | null },
  backend: ReplyDustBackend,
): Promise<string[] | undefined> {
  try {
    const storedFile = await store.get(fileKey);
    if (!storedFile) return undefined;
    let dustReply: Uint8Array | null = null;
    if (prior.dustReplySha256) {
      if (prior.dustReplySha256 !== options.dust?.replySha256 || !options.dustReply) return undefined;
      dustReply = options.dustReply;
    }
    return decodeDailyBarsPack({
      file: storedFile,
      manifest: manifestBytes,
      dustReply,
      decompress: (frame) => backend.decompress(frame, null),
    }).lines;
  } catch {
    return undefined;
  }
}

export interface ScanDailyBarsSidecarReport {
  enabled: boolean;
  sessionDate: string;
  status?: DailyBarsSidecarWriteStatus;
  source?: DailyBarsSidecarManifest["source"];
  rows?: number;
  bytesWritten: number;
  warnings: string[];
  /** Set when the run must fail: exists-different or any write error (exists-same/-equivalent/no-rows are fine). */
  failure?: string;
}

/**
 * Scanner step: after the session's daily-bars rows are appended (the JSONL write is unchanged), store the
 * session's sidecar, bound to that day's grouped-daily Reply Dust when it is sealed. Never throws; a
 * different existing pack or any write error is returned as `failure` (codes and the session date only)
 * and the scanner fails the run with it.
 */
export async function maybeWriteScanDailyBarsSidecar(options: {
  enabled: boolean;
  store?: ReplyDustStore;
  sessionDate: string;
  /** The stored daily-bars rows (at least this session's), as storage.loadBars returns them. */
  bars: readonly CanonicalDailyBar[];
  securities: readonly SecurityMasterRecord[];
  backend?: ReplyDustBackend;
  zstdVersionProbe?: import("./reply-dust-pin").ZstdVersionProbe;
}): Promise<ScanDailyBarsSidecarReport> {
  const base = { enabled: options.enabled, sessionDate: options.sessionDate, bytesWritten: 0 };
  if (!options.enabled) return { ...base, warnings: [] };
  if (!options.store) {
    const failure = `${DAILY_BARS_PACK_WRITE_FAILED}:${options.sessionDate}:STORE_UNAVAILABLE`;
    return { ...base, warnings: [failure], failure };
  }
  try {
    const { assertPinnedZstdForWriting } = await import("./reply-dust-pin");
    const { readDailyReplyDustManifest, readDailyReplyDustReply } = await import("./daily-reply-dust");
    assertPinnedZstdForWriting(options.zstdVersionProbe);
    const backend = options.backend ?? nodeReplyDustBackend;
    let dust: { replySha256: string; replyByteLength: number; results: GroupedResult[] } | null = null;
    let dustReply: Uint8Array | null = null;
    const dustManifest = await readDailyReplyDustManifest(options.store, options.sessionDate);
    if (dustManifest) {
      const reply = await readDailyReplyDustReply(options.store, dustManifest, backend);
      dustReply = reply;
      const parsed = JSON.parse(new TextDecoder().decode(reply)) as { results?: unknown };
      dust = {
        replySha256: dustManifest.replySha256,
        replyByteLength: dustManifest.replyByteLength,
        results: Array.isArray(parsed.results) ? (parsed.results as GroupedResult[]) : [],
      };
    }
    const result = await writeDailyBarsSidecar({
      store: options.store,
      sessionDate: options.sessionDate,
      rows: options.bars,
      dust,
      dustReply,
      symbolsFor: securitySymbols(options.securities),
      backend,
    });
    const failure =
      result.status === "exists-different" ? `${DAILY_BARS_PACK_EXISTS_DIFFERENT}:${options.sessionDate}` : undefined;
    const equivalent =
      result.status === "exists-equivalent" ? `${DAILY_BARS_PACK_EXISTS_EQUIVALENT}:${options.sessionDate}` : undefined;
    return {
      ...base,
      status: result.status,
      ...(result.manifest ? { source: result.manifest.source, rows: result.manifest.rows } : {}),
      bytesWritten: result.bytesWritten,
      warnings: failure ? [failure] : equivalent ? [equivalent] : [],
      ...(failure ? { failure } : {}),
    };
  } catch (error) {
    const failure = `${DAILY_BARS_PACK_WRITE_FAILED}:${options.sessionDate}:${errorCode(error)}`;
    return { ...base, warnings: [failure], failure };
  }
}

export type SealedDailyBarsPackCheck =
  | { state: "none" }
  | { state: "verified"; source: DailyBarsSidecarManifest["source"]; rows: number; outsidePack: number }
  | { state: "conflict"; reason: string };

/**
 * Before any write for a session: is its daily-bars pack already sealed, and does it hold the stored rows?
 * - no manifest and no file => "none" (collect and pack as usual);
 * - a manifest whose pack decodes (with the day's canonical grouped-daily Dust when bound to it) and every
 *   packed line is a stored row of the session, byte for byte => "verified": the stored evidence is
 *   authoritative and the session is not collected again. Stored rows the pack lacks (appended after the
 *   seal) are counted, never removed or packed;
 * - anything else (file without manifest, unreadable pack, Dust mismatch, a packed line not stored) =>
 *   "conflict": the caller fails the session before writing anything. Never overwrites.
 */
export async function checkSealedDailyBarsPack(options: {
  store: ReplyDustStore;
  sessionDate: string;
  storedRows: readonly CanonicalDailyBar[];
  backend?: ReplyDustBackend;
}): Promise<SealedDailyBarsPackCheck> {
  const backend = options.backend ?? nodeReplyDustBackend;
  const manifestBytes = await options.store.get(dailyBarsSidecarManifestKey(options.sessionDate));
  if (!manifestBytes) {
    return (await options.store.head(dailyBarsSidecarFileKey(options.sessionDate)))
      ? { state: "conflict", reason: "FILE_WITHOUT_MANIFEST" }
      : { state: "none" };
  }
  try {
    const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as DailyBarsSidecarManifest;
    const file = await options.store.get(dailyBarsSidecarFileKey(options.sessionDate));
    if (!file) return { state: "conflict", reason: "MANIFEST_WITHOUT_FILE" };
    let dustReply: Uint8Array | null = null;
    if (manifest.dustReplySha256) {
      const { readDailyReplyDustManifest, readDailyReplyDustReply } = await import("./daily-reply-dust");
      const dust = await readDailyReplyDustManifest(options.store, options.sessionDate);
      if (!dust || dust.replySha256 !== manifest.dustReplySha256) return { state: "conflict", reason: "DUST_MISMATCH" };
      dustReply = await readDailyReplyDustReply(options.store, dust, backend);
    }
    const packed = decodeDailyBarsPack({ file, manifest: manifestBytes, dustReply, decompress: (frame) => backend.decompress(frame, null) }).lines;
    const stored = new Set(options.storedRows.filter((row) => row.sessionDate === options.sessionDate).map((row) => stableJson(row)));
    if (!packed.every((line) => stored.has(line))) return { state: "conflict", reason: "PACKED_ROW_NOT_STORED" };
    return { state: "verified", source: manifest.source, rows: packed.length, outsidePack: stored.size - new Set(packed).size };
  } catch (error) {
    return { state: "conflict", reason: errorCode(error) };
  }
}
