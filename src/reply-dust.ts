import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  REPLY_DUST_V1_DICTIONARY_BASE64,
  REPLY_DUST_V1_DICTIONARY_SHA256,
} from "./reply-dust-dictionary";

// Reply Dust: lossless storage for one raw Massive 10-minute aggregates reply per file.
// Decoding returns the exact original reply bytes. Layout of a stored file:
//   byte 0      format version. 1 = column transform + v1 dictionary. 0x81 = verified raw-zstd
//               fallback (whole reply, no dictionary) used only if the transformed file fails to verify.
//   bytes 1-16  first 16 bytes of sha256(uint64le(reply length) || reply bytes).
//   bytes 17-   zstd frame with the 4-byte magic number stripped, written with --no-check and
//               --no-dictID. The version byte names the exact dictionary, so a new dictionary
//               always needs a new version number.
// Column transform (each step measured lossless on the frozen sample): whole-share/fraction volume
// split, compact reply header with request_id as 16 binary bytes, high/low from the candle body,
// vw from the high/low midpoint, and step-count (ULP) exceptions for prices that are not clean
// 4-decimal values. Anything the transform cannot reproduce exactly is kept as verbatim bytes.

export const REPLY_DUST_FORMAT = "REPLY_DUST_V1_ZSTD19_DICT4K" as const;
export const REPLY_DUST_VERSION = 1;
export const REPLY_DUST_FALLBACK_VERSION = 0x80 | REPLY_DUST_VERSION;
export const REPLY_DUST_HASH_BYTES = 16;
const ZSTD_MAGIC = Uint8Array.from([0x28, 0xb5, 0x2f, 0xfd]);
const ZSTD_LEVEL = "-19";
const PRICE_SCALE = 10_000;
const VOLUME_SCALE = 1_000_000n;
const TEN_MINUTES = 600_000n;
const BAR_KEYS = ["v", "vw", "o", "c", "h", "l", "t", "n"] as const;
const EXCEPTION_KEYS = ["o", "h", "l", "c", "vw", "v", "n"] as const;
const COLUMNS = ["keys", "t", "o", "h", "l", "c", "vw", "v", "n", "exc", "fallback", "vf", "rid"] as const;
type Column = (typeof COLUMNS)[number];
type ExceptionKey = (typeof EXCEPTION_KEYS)[number];
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
const REQUEST_ID = /^[0-9a-f]{32}$/;

/** Compression back end. Node uses the zstd program; the Worker gets its own decoder later. */
export interface ReplyDustBackend {
  compress(raw: Uint8Array, dictionary: Uint8Array | null): Uint8Array;
  decompress(frame: Uint8Array, dictionary: Uint8Array | null): Uint8Array;
  sha256(bytes: Uint8Array): Uint8Array;
}

class Out {
  readonly a: number[] = [];
  u(value: bigint): void {
    if (value < 0n) throw new Error("REPLY_DUST_NEGATIVE_UVARINT");
    let n = value;
    while (n > 127n) {
      this.a.push(Number(n & 127n) | 128);
      n >>= 7n;
    }
    this.a.push(Number(n));
  }
  s(value: bigint): void {
    this.u(value >= 0n ? 2n * value : -2n * value - 1n);
  }
  f64(value: number): void {
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, value, true);
    for (let i = 0; i < 8; i += 1) this.a.push(view.getUint8(i));
  }
  bytes(value: Uint8Array): void {
    this.u(BigInt(value.length));
    for (const byte of value) this.a.push(byte);
  }
}

class In {
  i = 0;
  constructor(readonly b: Uint8Array) {}
  u(): bigint {
    let n = 0n;
    let shift = 0n;
    for (;;) {
      const x = this.b[this.i++];
      if (x === undefined) throw new Error("REPLY_DUST_TRUNCATED");
      n |= BigInt(x & 127) << shift;
      if (!(x & 128)) return n;
      shift += 7n;
    }
  }
  s(): bigint {
    const n = this.u();
    return n % 2n === 0n ? n / 2n : -(n + 1n) / 2n;
  }
  f64(): number {
    if (this.i + 8 > this.b.length) throw new Error("REPLY_DUST_TRUNCATED");
    const value = new DataView(this.b.buffer, this.b.byteOffset + this.i, 8).getFloat64(0, true);
    this.i += 8;
    return value;
  }
  take(length: number): Uint8Array {
    if (this.i + length > this.b.length) throw new Error("REPLY_DUST_TRUNCATED");
    const out = this.b.subarray(this.i, this.i + length);
    this.i += length;
    return out;
  }
  bytes(): Uint8Array {
    return this.take(Number(this.u()));
  }
}

const floatView = new DataView(new ArrayBuffer(8));
function bitsOf(x: number): bigint {
  floatView.setFloat64(0, x);
  return floatView.getBigInt64(0);
}
function fromBits(b: bigint): number {
  floatView.setBigInt64(0, b);
  return floatView.getFloat64(0);
}
const bigMax = (a: bigint, b: bigint): bigint => (a > b ? a : b);
const bigMin = (a: bigint, b: bigint): bigint => (a < b ? a : b);

function toScaled(x: number, scale: number): bigint | null {
  if (!Number.isFinite(x) || Object.is(x, -0)) return null;
  const i = Math.round(x * scale);
  return i / scale === x ? BigInt(i) : null;
}

// Step-count exception: the clean scaled integer goes in the normal column and only the signed
// number of float64 steps from clean/scale to the real value is stored.
function stepForm(x: number, scale: number): { i: bigint; d: bigint } | null {
  if (!Number.isFinite(x) || x === 0) return null;
  const i = Math.round(x * scale);
  if (!Number.isSafeInteger(i) || i === 0) return null;
  const clean = i / scale;
  if (Math.sign(clean) !== Math.sign(x)) return null;
  const d = bitsOf(x) - bitsOf(clean);
  if (d > 1048576n || d < -1048576n || fromBits(bitsOf(clean) + d) !== x) return null;
  return { i: BigInt(i), d };
}

type Streams = Record<Column, Out>;
const newStreams = (): Streams => Object.fromEntries(COLUMNS.map((c) => [c, new Out()])) as Streams;
type ReplyHeader = { order: string[]; meta: Record<string, Json>; count: number };

function encodeTransformed(json: Record<string, Json>, w: Streams, keyTable: string[]): ReplyHeader {
  const { results: rawResults, ...meta } = json;
  const results = (rawResults ?? []) as Json[];
  let prevT: bigint | null = null;
  let prevC = 0n;
  for (const item of results) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) throw new Error("REPLY_DUST_BAR_SHAPE");
    const r = item as Record<string, Json>;
    const keys = Object.keys(r);
    if (keys.some((k) => !(BAR_KEYS as readonly string[]).includes(k) || typeof r[k] !== "number"))
      throw new Error("REPLY_DUST_UNKNOWN_FIELD");
    const num = r as Record<string, number>;
    const signature = keys.join(",");
    let ki = keyTable.indexOf(signature);
    if (ki < 0) {
      ki = keyTable.length;
      keyTable.push(signature);
    }
    w.keys.u(BigInt(ki));
    if ("t" in num) {
      const tv = num.t as number;
      if (!Number.isSafeInteger(tv)) throw new Error("REPLY_DUST_T_NOT_INTEGER");
      const t = BigInt(tv);
      if (prevT === null) w.t.s(t);
      else {
        const d = t - prevT;
        if (d > 0n && d % TEN_MINUTES === 0n) w.t.u((d / TEN_MINUTES) * 2n);
        else {
          w.t.u(1n);
          w.t.s(d);
        }
      }
      prevT = t;
    }
    const P: Partial<Record<ExceptionKey, bigint>> = {};
    const U: Partial<Record<ExceptionKey, bigint>> = {};
    let mask = 0;
    EXCEPTION_KEYS.forEach((k, bit) => {
      if (!(k in num)) return;
      const x = num[k] as number;
      const scale = k === "v" ? Number(VOLUME_SCALE) : PRICE_SCALE;
      const i = k === "n" ? (Number.isSafeInteger(x) && x >= 0 && !Object.is(x, -0) ? BigInt(x) : null) : toScaled(x, scale);
      if (i !== null) {
        P[k] = i;
        return;
      }
      if (k !== "n") {
        const step = stepForm(x, scale);
        if (step) {
          P[k] = step.i;
          U[k] = step.d;
          mask |= 1 << bit;
          return;
        }
      }
      mask |= 1 << (bit + 7);
    });
    w.exc.u(BigInt(mask));
    for (let bit = 0; bit < 7; bit += 1) if (mask & (1 << bit)) w.exc.s(U[EXCEPTION_KEYS[bit] as ExceptionKey] as bigint);
    for (let bit = 0; bit < 7; bit += 1)
      if (mask & (1 << (bit + 7))) w.exc.f64(num[EXCEPTION_KEYS[bit] as ExceptionKey] as number);
    const o = P.o ?? prevC;
    if ("o" in num) w.o.s(o - prevC);
    const c = P.c ?? o;
    if ("c" in num) w.c.s(c - o);
    const hRef = bigMax(o, c);
    const h = P.h ?? hRef;
    if ("h" in num) w.h.s(h - hRef);
    const lRef = bigMin(o, c);
    const l = P.l ?? lRef;
    if ("l" in num) w.l.s(lRef - l);
    const vwRef = (h + l) / 2n;
    if ("vw" in num) w.vw.s((P.vw ?? vwRef) - vwRef);
    if ("v" in num) {
      const pv = P.v ?? 0n;
      w.v.u(pv / VOLUME_SCALE);
      w.vf.u(pv % VOLUME_SCALE);
    }
    if ("n" in num) w.n.u(P.n ?? 0n);
    if (P.c !== undefined) prevC = P.c;
  }
  return { order: Object.keys(json), meta: meta as Record<string, Json>, count: results.length };
}

function decodeTransformed(h: ReplyHeader, rd: Record<Column, In>, keyTable: string[]): Record<string, Json> {
  const results: Json[] = [];
  let prevT: bigint | null = null;
  let prevC = 0n;
  for (let i = 0; i < h.count; i += 1) {
    const signature = keyTable[Number(rd.keys.u())];
    if (signature === undefined) throw new Error("REPLY_DUST_KEY_TABLE_MISS");
    const ks = signature.split(",");
    const has = (k: string): boolean => ks.includes(k);
    let t = 0n;
    if (has("t")) {
      if (prevT === null) t = rd.t.s();
      else {
        const x = rd.t.u();
        t = prevT + (x === 1n ? rd.t.s() : (x / 2n) * TEN_MINUTES);
      }
      prevT = t;
    }
    const mask = Number(rd.exc.u());
    const ex: Partial<Record<string, number>> = {};
    const U: Partial<Record<string, bigint>> = {};
    for (let bit = 0; bit < 7; bit += 1) if (mask & (1 << bit)) U[EXCEPTION_KEYS[bit] as string] = rd.exc.s();
    for (let bit = 0; bit < 7; bit += 1) if (mask & (1 << (bit + 7))) ex[EXCEPTION_KEYS[bit] as string] = rd.exc.f64();
    const o = has("o") ? prevC + rd.o.s() : prevC;
    const c = has("c") ? o + rd.c.s() : o;
    const hRef = bigMax(o, c);
    const hi = has("h") ? hRef + rd.h.s() : hRef;
    const lRef = bigMin(o, c);
    const lo = has("l") ? lRef - rd.l.s() : lRef;
    const vwRef = (hi + lo) / 2n;
    const vw = has("vw") ? vwRef + rd.vw.s() : vwRef;
    let vol = 0n;
    if (has("v")) vol = rd.v.u() * VOLUME_SCALE + rd.vf.u();
    const n = has("n") ? rd.n.u() : 0n;
    const scaled: Record<string, bigint> = { o, c, h: hi, l: lo, vw };
    const rec: Record<string, number> = {};
    for (const k of ks) {
      const exact = ex[k];
      if (exact !== undefined) rec[k] = exact;
      else if (k === "t") rec.t = Number(t);
      else if (k === "n") rec.n = Number(n);
      else if (k === "v") rec.v = Number(vol) / Number(VOLUME_SCALE);
      else rec[k] = Number(scaled[k] as bigint) / PRICE_SCALE;
      const step = U[k];
      if (step !== undefined) rec[k] = fromBits(bitsOf(rec[k] as number) + step);
    }
    results.push(rec);
    if (has("c") && ex.c === undefined) prevC = c;
  }
  const out: Record<string, Json> = {};
  for (const k of h.order) out[k] = k === "results" ? results : (h.meta[k] as Json);
  return out;
}

type HeaderItem = 0 | [number, number, Json[]];
function compactHeader(header: Array<ReplyHeader | null>, w: Streams): { orderTable: string[]; items: HeaderItem[] } {
  const orderTable: string[] = [];
  const prev: Record<string, Json> = {};
  const items = header.map((h): HeaderItem => {
    if (h === null) return 0;
    const signature = h.order.join(",");
    let oi = orderTable.indexOf(signature);
    if (oi < 0) {
      oi = orderTable.length;
      orderTable.push(signature);
    }
    const vals = h.order
      .filter((k) => k !== "results")
      .map((k): Json => {
        const x = h.meta[k] as Json;
        let y: Json;
        if (x === h.count) y = "#";
        else if (k === "request_id" && typeof x === "string" && REQUEST_ID.test(x)) {
          for (let i = 0; i < 32; i += 2) w.rid.a.push(parseInt(x.slice(i, i + 2), 16));
          y = "@";
        } else if (k in prev && JSON.stringify(prev[k]) === JSON.stringify(x)) y = "=";
        else y = typeof x === "string" && /^[#@=\\]/.test(x) ? "\\" + x : x;
        prev[k] = x;
        return y;
      });
    return [oi, h.count, vals];
  });
  return { orderTable, items };
}

function expandHeader(
  { orderTable, items }: { orderTable: string[]; items: HeaderItem[] },
  rid: In,
): Array<ReplyHeader | null> {
  const prev: Record<string, Json> = {};
  return items.map((it) => {
    if (it === 0) return null;
    const [oi, count, vals] = it;
    const signature = orderTable[oi];
    if (signature === undefined) throw new Error("REPLY_DUST_ORDER_TABLE_MISS");
    const order = signature.split(",");
    const meta: Record<string, Json> = {};
    order
      .filter((k) => k !== "results")
      .forEach((k, i) => {
        const y = vals[i] as Json;
        let x: Json;
        if (y === "#") x = count;
        else if (y === "@") x = Array.from(rid.take(16), (b) => b.toString(16).padStart(2, "0")).join("");
        else if (y === "=") x = prev[k] as Json;
        else x = typeof y === "string" && y[0] === "\\" ? y.slice(1) : y;
        prev[k] = x;
        meta[k] = x;
      });
    return { order, meta, count };
  });
}

const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder("utf-8", { fatal: true });

function pack(header: Array<ReplyHeader | null>, w: Streams, keyTable: string[]): Uint8Array {
  w.rid.a.length = 0;
  const hdr = utf8.encode(JSON.stringify({ keyTable, ...compactHeader(header, w) }));
  const lens = new Out();
  lens.u(BigInt(hdr.length));
  for (const c of COLUMNS) lens.u(BigInt(w[c].a.length));
  return Uint8Array.from([...lens.a, ...hdr, ...COLUMNS.flatMap((c) => w[c].a)]);
}

function unpack(raw: Uint8Array): { keyTable: string[]; header: Array<ReplyHeader | null>; rd: Record<Column, In> } {
  const r0 = new In(raw);
  const headerLength = Number(r0.u());
  const lengths = COLUMNS.map(() => Number(r0.u()));
  const H = JSON.parse(fromUtf8.decode(r0.take(headerLength))) as {
    keyTable: string[];
    orderTable: string[];
    items: HeaderItem[];
  };
  const rd = {} as Record<Column, In>;
  COLUMNS.forEach((c, i) => {
    rd[c] = new In(r0.take(lengths[i] as number));
  });
  if (r0.i !== raw.length) throw new Error("REPLY_DUST_TRAILING_BYTES");
  return { keyTable: H.keyTable, header: expandHeader(H, rd.rid), rd };
}

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);

function transformReply(body: Uint8Array): Uint8Array {
  const fallback = (): Uint8Array => {
    const w = newStreams();
    w.fallback.bytes(body);
    return pack([null], w, []);
  };
  try {
    const parsed = JSON.parse(fromUtf8.decode(body)) as Json;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return fallback();
    if (parsed.results !== undefined && !Array.isArray(parsed.results)) return fallback();
    if (!sameBytes(utf8.encode(JSON.stringify(parsed)), body)) return fallback();
    const w = newStreams();
    const keyTable: string[] = [];
    const h = encodeTransformed(parsed, w, keyTable);
    const raw = pack([h], w, keyTable);
    return sameBytes(untransform(raw), body) ? raw : fallback();
  } catch {
    return fallback();
  }
}

function untransform(raw: Uint8Array): Uint8Array {
  const { keyTable, header, rd } = unpack(raw);
  if (header.length !== 1) throw new Error("REPLY_DUST_REPLY_COUNT");
  const h = header[0] as ReplyHeader | null;
  return h === null ? rd.fallback.bytes() : utf8.encode(JSON.stringify(decodeTransformed(h, rd, keyTable)));
}

function replyHash(backend: ReplyDustBackend, body: Uint8Array): Uint8Array {
  const prefixed = new Uint8Array(8 + body.length);
  new DataView(prefixed.buffer).setBigUint64(0, BigInt(body.length), true);
  prefixed.set(body, 8);
  return backend.sha256(prefixed).subarray(0, REPLY_DUST_HASH_BYTES);
}

let v1Dictionary: Uint8Array | null = null;
export function replyDustV1Dictionary(backend: ReplyDustBackend): Uint8Array {
  if (v1Dictionary) return v1Dictionary;
  const bytes = Uint8Array.from(atob(REPLY_DUST_V1_DICTIONARY_BASE64), (ch) => ch.charCodeAt(0));
  const hex = Array.from(backend.sha256(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
  if (hex !== REPLY_DUST_V1_DICTIONARY_SHA256) throw new Error("REPLY_DUST_DICTIONARY_HASH_MISMATCH");
  v1Dictionary = bytes;
  return bytes;
}

function stripMagic(frame: Uint8Array): Uint8Array {
  if (!sameBytes(frame.subarray(0, 4), ZSTD_MAGIC)) throw new Error("REPLY_DUST_ZSTD_MAGIC");
  return frame.subarray(4);
}
function withMagic(body: Uint8Array): Uint8Array {
  const frame = new Uint8Array(4 + body.length);
  frame.set(ZSTD_MAGIC, 0);
  frame.set(body, 4);
  return frame;
}
function assemble(version: number, hash: Uint8Array, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(1 + hash.length + payload.length);
  out[0] = version;
  out.set(hash, 1);
  out.set(payload, 1 + hash.length);
  return out;
}

/** Encode one raw reply. The result is decoded and compared before it is returned. */
export function encodeReplyDust(body: Uint8Array, backend: ReplyDustBackend = nodeReplyDustBackend): Uint8Array {
  const hash = replyHash(backend, body);
  try {
    const dictionary = replyDustV1Dictionary(backend);
    const encoded = assemble(REPLY_DUST_VERSION, hash, stripMagic(backend.compress(transformReply(body), dictionary)));
    if (sameBytes(decodeReplyDust(encoded, backend), body)) return encoded;
  } catch {
    // fall through to the raw-zstd fallback
  }
  const encoded = assemble(REPLY_DUST_FALLBACK_VERSION, hash, stripMagic(backend.compress(body, null)));
  if (!sameBytes(decodeReplyDust(encoded, backend), body)) throw new Error("REPLY_DUST_VERIFY_FAILED");
  return encoded;
}

/** Decode a stored file back to the exact original reply bytes. */
export function decodeReplyDust(bytes: Uint8Array, backend: ReplyDustBackend = nodeReplyDustBackend): Uint8Array {
  if (bytes.length < 1 + REPLY_DUST_HASH_BYTES) throw new Error("REPLY_DUST_TRUNCATED");
  const version = bytes[0];
  const want = bytes.subarray(1, 1 + REPLY_DUST_HASH_BYTES);
  const payload = withMagic(bytes.subarray(1 + REPLY_DUST_HASH_BYTES));
  let body: Uint8Array;
  if (version === REPLY_DUST_VERSION) body = untransform(backend.decompress(payload, replyDustV1Dictionary(backend)));
  else if (version === REPLY_DUST_FALLBACK_VERSION) body = backend.decompress(payload, null);
  else throw new Error(`REPLY_DUST_VERSION_UNSUPPORTED:${version}`);
  if (!sameBytes(replyHash(backend, body), want)) throw new Error("REPLY_DUST_HASH_MISMATCH");
  return body;
}

const ZSTD_MAX_OUTPUT_BYTES = 1024 * 1024 * 1024;
const dictionaryFiles = new Map<string, string>();
function dictionaryFile(dictionary: Uint8Array): string {
  const key = createHash("sha256").update(dictionary).digest("hex");
  const known = dictionaryFiles.get(key);
  if (known) return known;
  const dir = join(tmpdir(), "peacestocks-reply-dust");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${key}.zdict`);
  if (!existsSync(path)) {
    const temporary = `${path}.tmp-${process.pid}`;
    writeFileSync(temporary, dictionary);
    renameSync(temporary, path);
  }
  dictionaryFiles.set(key, path);
  return path;
}
function runZstd(args: string[], input: Uint8Array): Uint8Array {
  const result = spawnSync("zstd", args, { input, maxBuffer: ZSTD_MAX_OUTPUT_BYTES });
  if (result.error || result.status !== 0) throw new Error("REPLY_DUST_ZSTD_FAILED");
  return new Uint8Array(result.stdout);
}

/** Node back end: the zstd program for compression, node:crypto for sha256. */
export const nodeReplyDustBackend: ReplyDustBackend = {
  compress: (raw, dictionary) =>
    runZstd([ZSTD_LEVEL, "--no-check", "--no-dictID", ...(dictionary ? ["-D", dictionaryFile(dictionary)] : []), "-c"], raw),
  decompress: (frame, dictionary) => runZstd(["-d", ...(dictionary ? ["-D", dictionaryFile(dictionary)] : []), "-c"], frame),
  sha256: (bytes) => new Uint8Array(createHash("sha256").update(bytes).digest()),
};
