// Independent decoder for daily-bars sidecar v1 (permanent/daily-bars-sidecar/YYYY-MM-DD/). Written from
// the format spec, sharing no code with the writer (daily-bars-sidecar.ts): only the zstd and sha256
// primitives are reused. Given sidecar.dbs + manifest.json (+ the bound grouped-daily reply bytes, when
// the manifest names one), it returns the session's original daily-bars JSONL lines, byte for byte, or
// throws. Every check fails closed.
import { createHash } from "node:crypto";
import { nodeReplyDustBackend } from "./reply-dust";

export const PACK_VERSION_BYTE = 0x21;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Decompress = (frame: Uint8Array) => Uint8Array;
const defaultDecompress: Decompress = (frame) => nodeReplyDustBackend.decompress(frame, null);

function sha(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Canonical JSON: keys sorted (code-unit order) at every level, JSON.stringify for leaves, no spaces. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map((v) => canonicalJson(v)).join(",") + "]";
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts: string[] = [];
  for (const k of keys) parts.push(JSON.stringify(k) + ":" + canonicalJson(obj[k]));
  return "{" + parts.join(",") + "}";
}

function fail(code: string, sessionDate?: string): never {
  throw new Error(sessionDate ? `PACK_DECODE_${code}:${sessionDate}` : `PACK_DECODE_${code}`);
}

function isAbsentMarker(v: unknown): boolean {
  return typeof v === "object" && v !== null && !Array.isArray(v) &&
    Object.keys(v).length === 1 && (v as Record<string, unknown>).$absent === true;
}

function assign(target: Record<string, any>, path: string, value: unknown): void {
  const dot = path.indexOf(".");
  if (dot < 0) {
    if (isAbsentMarker(value)) delete target[path];
    else target[path] = value;
    return;
  }
  const head = path.slice(0, dot), tail = path.slice(dot + 1);
  if (tail.includes(".")) fail("PATH_TOO_DEEP");
  if (typeof target[head] !== "object" || target[head] === null) target[head] = {};
  if (isAbsentMarker(value)) delete target[head][tail];
  else target[head][tail] = value;
}

function deepCopy<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}

const isoFromMs = (ms: number) => new Date(ms).toISOString();

export interface DecodedPack {
  sessionDate: string;
  lines: string[];
  source: string;
}

/**
 * Decode one session. `dustReply` is the raw grouped-daily reply (decoded Reply Dust bytes) and is
 * required exactly when the manifest names dustReplySha256.
 */
export function decodeDailyBarsPack(input: {
  file: Uint8Array;
  manifest: Uint8Array | string;
  dustReply?: Uint8Array | null;
  decompress?: Decompress;
}): DecodedPack {
  const manifestText = typeof input.manifest === "string" ? input.manifest : new TextDecoder().decode(input.manifest);
  const manifest = JSON.parse(manifestText) as Record<string, Json>;
  const session = typeof manifest.sessionDate === "string" ? manifest.sessionDate : fail("MANIFEST_SESSION");
  const { checksum, ...body } = manifest;
  if (manifest.schemaVersion !== "daily-bars-sidecar-manifest-v1") fail("MANIFEST_SCHEMA", session);
  if (sha(canonicalJson(body)) !== checksum) fail("MANIFEST_CHECKSUM", session);
  if (manifest.version !== PACK_VERSION_BYTE) fail("MANIFEST_VERSION", session);
  const file = input.file;
  if (file.length !== manifest.byteLength || sha(file) !== manifest.fileSha256) fail("FILE_CHECKSUM", session);
  if (file[0] !== PACK_VERSION_BYTE) fail("VERSION_BYTE", session);
  const payloadBytes = (input.decompress ?? defaultDecompress)(file.subarray(1));
  if (payloadBytes.length !== manifest.payloadByteLength || sha(payloadBytes) !== manifest.payloadSha256)
    fail("PAYLOAD_CHECKSUM", session);
  const p = JSON.parse(new TextDecoder().decode(payloadBytes)) as Record<string, any>;
  if (p.schema !== "daily-bars-sidecar-v1" || p.sessionDate !== session) fail("PAYLOAD_SCHEMA", session);

  let results: Record<string, unknown>[] | null = null;
  if (p.dust !== null) {
    if (manifest.dustReplySha256 !== p.dust.replySha256) fail("DUST_BINDING", session);
    const reply = input.dustReply;
    if (!reply) fail("DUST_REPLY_REQUIRED", session);
    if (reply.length !== p.dust.replyByteLength || sha(reply) !== p.dust.replySha256) fail("DUST_REPLY_CHECKSUM", session);
    const parsed = JSON.parse(new TextDecoder().decode(reply)) as { results?: unknown };
    if (!Array.isArray(parsed.results) || parsed.results.length !== p.dust.resultsCount) fail("DUST_RESULTS", session);
    results = parsed.results as Record<string, unknown>[];
  } else if (manifest.dustReplySha256 !== null) fail("DUST_BINDING", session);

  const ids: string[] = p.securityIds;
  const idx: number[] = p.resultIndex;
  if (!Array.isArray(ids) || !Array.isArray(idx) || ids.length !== idx.length) fail("ROW_COLUMNS", session);
  const packedCount = idx.filter((i) => i < 0).length;
  for (const col of ["open", "high", "low", "close", "volume", "t"])
    if (!Array.isArray(p.packed?.[col]) || p.packed[col].length !== packedCount) fail("PACKED_COLUMNS", session);

  const lines: string[] = [];
  let k = 0;
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i]!;
    const row: Record<string, any> = { securityId: id, sessionDate: session };
    for (const [path, v] of Object.entries(p.template as Record<string, unknown>)) assign(row, path, deepCopy(v));
    for (const [path, v] of Object.entries(p.defaults as Record<string, unknown>)) assign(row, path, deepCopy(v));
    const ix = idx[i]!;
    if (ix >= 0) {
      const r = results?.[ix];
      if (!r) fail("RESULT_INDEX", session);
      row.open = r.o; row.high = r.h; row.low = r.l; row.close = r.c; row.volume = r.v;
      if (typeof r.t === "number" && Number.isFinite(r.t)) row.sourceTimestamp = isoFromMs(r.t);
    } else {
      row.open = p.packed.open[k]; row.high = p.packed.high[k]; row.low = p.packed.low[k];
      row.close = p.packed.close[k]; row.volume = p.packed.volume[k];
      const t = p.packed.t[k];
      if (typeof t === "number") row.sourceTimestamp = isoFromMs(t);
      k++;
    }
    for (const [path, v] of Object.entries((p.corrections?.[id] ?? {}) as Record<string, unknown>)) assign(row, path, deepCopy(v));
    for (const [path, v] of Object.entries((p.exceptions?.[id] ?? {}) as Record<string, unknown>)) assign(row, path, deepCopy(v));
    lines.push(canonicalJson(row));
  }
  if (lines.length !== manifest.rows) fail("ROW_COUNT", session);
  if (sha(lines.length ? lines.join("\n") + "\n" : "") !== manifest.linesSha256) fail("LINES_CHECKSUM", session);
  return { sessionDate: session, lines, source: String(manifest.source) };
}

/** A whole month file from its sessions' lines: sorted by securityId|sessionDate|revision (localeCompare). */
export function monthFileFromLines(lines: readonly string[]): string {
  const keyed = lines.map((line) => {
    const r = JSON.parse(line) as { securityId: string; sessionDate: string; revision: number };
    return { key: `${r.securityId}|${r.sessionDate}|${r.revision}`, line };
  });
  keyed.sort((a, b) => a.key.localeCompare(b.key));
  return keyed.length ? keyed.map((x) => x.line).join("\n") + "\n" : "";
}
