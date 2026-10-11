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

export type DailyBarsSidecarWriteStatus = "stored" | "exists-same" | "exists-different" | "no-rows";
export interface DailyBarsSidecarWriteResult {
  status: DailyBarsSidecarWriteStatus;
  sessionDate: string;
  manifest?: DailyBarsSidecarManifest;
  bytesWritten: number;
}

/**
 * Store one session's sidecar: new keys only. The file goes first (put, read back, compare), then the
 * manifest (put, read back, compare), which seals the day. An existing manifest is never replaced:
 * same lines => exists-same, otherwise exists-different (caller reports a warning). A file without a
 * manifest is never overwritten either (exists-different).
 */
export async function writeDailyBarsSidecar(options: {
  store: ReplyDustStore;
  sessionDate: string;
  rows: readonly CanonicalDailyBar[];
  dust: null | { replySha256: string; replyByteLength: number; results: GroupedResult[] };
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
    return { status: prior.linesSha256 === manifest.linesSha256 ? "exists-same" : "exists-different", sessionDate, manifest: prior, bytesWritten: 0 };
  }
  if (await options.store.head(fileKey)) return { status: "exists-different", sessionDate, bytesWritten: 0 };
  await options.store.put(fileKey, file, {
    "dbs-schema": DAILY_BARS_SIDECAR_SCHEMA,
    "dbs-session-date": sessionDate,
    "dbs-file-sha256": manifest.fileSha256,
  });
  const storedFile = await options.store.get(fileKey);
  if (!storedFile || !sameBytes(storedFile, file)) throw new Error(`DAILY_BARS_SIDECAR_READBACK_MISMATCH:${sessionDate}`);
  const manifestBytes = new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);
  await options.store.put(manifestKey, manifestBytes);
  const storedManifest = await options.store.get(manifestKey);
  if (!storedManifest || !sameBytes(storedManifest, manifestBytes))
    throw new Error(`DAILY_BARS_SIDECAR_MANIFEST_READBACK_MISMATCH:${sessionDate}`);
  return { status: "stored", sessionDate, manifest, bytesWritten: file.length + manifestBytes.length };
}

export interface ScanDailyBarsSidecarReport {
  enabled: boolean;
  sessionDate: string;
  status?: DailyBarsSidecarWriteStatus;
  source?: DailyBarsSidecarManifest["source"];
  rows?: number;
  bytesWritten: number;
  warnings: string[];
}

/**
 * Scanner step: after the session's daily-bars rows are appended (the JSONL write is unchanged), store the
 * session's sidecar, bound to that day's grouped-daily Reply Dust when it is sealed. Never throws; any
 * failure is a warning and the scan result is otherwise unchanged.
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
  if (!options.store) return { ...base, warnings: [`${DAILY_BARS_SIDECAR_WARNING}:STORE_UNAVAILABLE`] };
  try {
    const { assertPinnedZstdForWriting } = await import("./reply-dust-pin");
    const { readDailyReplyDustManifest, readDailyReplyDustReply } = await import("./daily-reply-dust");
    assertPinnedZstdForWriting(options.zstdVersionProbe);
    const backend = options.backend ?? nodeReplyDustBackend;
    let dust: { replySha256: string; replyByteLength: number; results: GroupedResult[] } | null = null;
    const dustManifest = await readDailyReplyDustManifest(options.store, options.sessionDate);
    if (dustManifest) {
      const reply = await readDailyReplyDustReply(options.store, dustManifest, backend);
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
      symbolsFor: securitySymbols(options.securities),
      backend,
    });
    const warnings =
      result.status === "exists-different" ? [`${DAILY_BARS_SIDECAR_WARNING}:EXISTS_DIFFERENT:${options.sessionDate}`] : [];
    return {
      ...base,
      status: result.status,
      ...(result.manifest ? { source: result.manifest.source, rows: result.manifest.rows } : {}),
      bytesWritten: result.bytesWritten,
      warnings,
    };
  } catch (error) {
    return { ...base, warnings: [`${DAILY_BARS_SIDECAR_WARNING}:${String(error instanceof Error ? error.message : error).slice(0, 160)}`] };
  }
}
