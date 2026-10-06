// Ticker reference index: every record the security-master build's /v3/reference/tickers passes
// (active, then inactive) returned, of every type, in the order returned, BEFORE normalize()
// drops anything that is not CS/ETF. One entry per returned record (reused tickers appear several
// times, each with its own delisted_utc and FIGI). Each entry keeps the record's exact raw JSON
// text as Massive sent it, plus eight convenience fields copied from that same record (present
// only when the record has them; values as sent, null stays null, nothing invented).
//
// Layout: a monthly base snapshot plus daily deltas, all committed by one manifest.
//   permanent/ticker-reference-index.json                          manifest (the commit point)
//   permanent/ticker-reference-index/base-YYYY-MM-DD-<bodySha256>.jsonl.zst
//       full body (one entry per line)
//   permanent/ticker-reference-index/delta-YYYY-MM-DD-NNN-<deltaSha256>.json.zst
//       ordered edit script + new raws (deltaSha256 = sha256 of the uncompressed delta JSON)
// A record's identity is recordHash = sha256(pass + "\n" + raw text): never ticker or position.
// Each delta is computed against the index the CURRENT manifest commits (base + its deltas, read
// back from the store), so a failed or skipped write is covered by the next delta. A new base is
// written when the manifest's base is not from this build's month (YYYY-MM of asOf), so a failed
// first build of a month is followed by a full snapshot on the next successful one. Data keys
// carry their content hash, so no committed object is ever overwritten: an existing key with
// identical bytes is reused, one with different bytes throws. Objects are written and read back
// before the manifest, which is the only mutable object.
//
// Month history: when a build writes a NEW base (any reason), it first archives the OUTGOING live
// manifest bytes as an immutable object and links the new manifest to it:
//   permanent/ticker-reference-index/manifest-YYYY-MM-<sha256 of the bytes>.json   (verified)
//   permanent/ticker-reference-index/manifest-unverified-<sha256>.json              (unreadable)
// YYYY-MM is the outgoing base's month. previousManifest is null (with previousManifestReason)
// when no manifest existed. Deltas carry the link forward unchanged. Walking previousManifest
// from the live manifest reaches every past month.

import { createHash } from "node:crypto";
import { nodeReplyDustBackend, type ReplyDustBackend } from "./reply-dust";

export const TICKER_REFERENCE_INDEX_SCHEMA = "ticker-reference-index-v1" as const;
export const TICKER_REFERENCE_INDEX_MANIFEST_KEY = "permanent/ticker-reference-index.json";

/** Convenience fields copied from the raw record when present. */
export const TICKER_REFERENCE_FIELDS = [
  "ticker",
  "type",
  "active",
  "delisted_utc",
  "composite_figi",
  "share_class_figi",
  "name",
  "primary_exchange",
] as const;
type Field = (typeof TICKER_REFERENCE_FIELDS)[number];

export type TickerReferencePass = "active" | "inactive";

export interface TickerReferenceEntry extends Partial<Record<Field, unknown>> {
  pass: TickerReferencePass;
  /** 1-based page within the pass. */
  page: number;
  /** 0-based position among the page's object records. */
  position: number;
  /** The record's exact JSON text from the reply body. */
  raw: string;
}

export interface TickerReferenceCapture {
  pages: Record<TickerReferencePass, number>;
  entries: TickerReferenceEntry[];
}

interface IndexStore {
  get(key: string): Promise<Uint8Array | undefined>;
  put(key: string, body: Uint8Array): Promise<void>;
}

const sha256Hex = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");
const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((value, i) => value === b[i]);

/**
 * The exact JSON text of each element of the top-level "results" array of one reply body, in
 * order. Throws if the body is not a JSON object or has no such array.
 */
export function rawResultsElements(body: Uint8Array | string): string[] {
  const text = typeof body === "string" ? body : new TextDecoder("utf-8", { fatal: true }).decode(body);
  let depth = 0;
  let i = 0;
  const n = text.length;
  const skipString = (start: number): number => {
    let j = start + 1;
    while (j < n) {
      const c = text[j];
      if (c === "\\") j += 2;
      else if (c === '"') return j + 1;
      else j += 1;
    }
    throw new Error("TICKER_REFERENCE_REPLY_INVALID");
  };
  while (i < n) {
    const c = text[i]!;
    if (c === '"') {
      const end = skipString(i);
      if (depth === 1 && JSON.parse(text.slice(i, end)) === "results") {
        let j = end;
        while (/\s/u.test(text[j] ?? "")) j += 1;
        if (text[j] === ":") {
          j += 1;
          while (/\s/u.test(text[j] ?? "")) j += 1;
          if (text[j] !== "[") return [];
          // Collect each element of the array at its own depth.
          const out: string[] = [];
          let k = j + 1;
          let d = 0;
          let start = -1;
          while (k < n) {
            const ch = text[k]!;
            if (ch === '"') {
              if (d === 0 && start < 0) start = k;
              k = skipString(k);
              continue;
            }
            if (ch === "{" || ch === "[") {
              if (d === 0 && start < 0) start = k;
              d += 1;
            } else if (ch === "}" || ch === "]") {
              if (d === 0) {
                if (start >= 0) out.push(text.slice(start, k).trimEnd());
                return out;
              }
              d -= 1;
            } else if (ch === "," && d === 0) {
              if (start >= 0) out.push(text.slice(start, k).trimEnd());
              start = -1;
            } else if (d === 0 && start < 0 && !/\s/u.test(ch)) start = k;
            k += 1;
          }
          throw new Error("TICKER_REFERENCE_REPLY_INVALID");
        }
      }
      i = end;
      continue;
    }
    if (c === "{" || c === "[") depth += 1;
    else if (c === "}" || c === "]") depth -= 1;
    i += 1;
  }
  return [];
}

/** One entry from a record's exact raw JSON text. */
export function tickerReferenceEntry(
  pass: TickerReferencePass,
  page: number,
  position: number,
  raw: string,
): TickerReferenceEntry {
  const record = JSON.parse(raw) as Record<string, unknown>;
  if (!record || typeof record !== "object" || Array.isArray(record))
    throw new Error("TICKER_REFERENCE_RECORD_NOT_OBJECT");
  const entry: TickerReferenceEntry = { pass, page, position, raw };
  for (const field of TICKER_REFERENCE_FIELDS)
    if (Object.hasOwn(record, field)) entry[field] = record[field];
  return entry;
}

/** All entries of one reply page (only object elements; same rule as the provider's parser). */
export function tickerReferenceEntriesFromPage(
  pass: TickerReferencePass,
  page: number,
  body: Uint8Array,
): TickerReferenceEntry[] {
  const out: TickerReferenceEntry[] = [];
  for (const raw of rawResultsElements(body))
    if (raw.startsWith("{")) out.push(tickerReferenceEntry(pass, page, out.length, raw));
  return out;
}

export const TICKER_REFERENCE_INDEX_PREFIX = "permanent/ticker-reference-index/";
export const tickerReferenceBaseKey = (asOf: string, bodySha256: string) =>
  `${TICKER_REFERENCE_INDEX_PREFIX}base-${asOf}-${bodySha256}.jsonl.zst`;
export const tickerReferenceDeltaKey = (asOf: string, seq: number, deltaSha256: string) =>
  `${TICKER_REFERENCE_INDEX_PREFIX}delta-${asOf}-${String(seq).padStart(3, "0")}-${deltaSha256}.json.zst`;

export interface TickerReferenceObjectRef {
  asOf: string;
  key: string;
  fileSha256: string;
  fileByteLength: number;
  /** Body sha256 of the full index after this object is applied. */
  bodySha256: string;
}

/** Optional provenance for point-in-time dated-list builds (absent on live security-master captures). */
export interface TickerReferenceIndexFingerprints {
  source: "dated-list";
  requestedDate: string;
  pages: Array<{ key: string; sha256: string }>;
  /** Names listing mid-month appear only in the next month's dated index. */
  knownGap: "mid-month-listings-appear-in-next-month-index";
}

export interface TickerReferenceIndexManifest {
  schemaVersion: typeof TICKER_REFERENCE_INDEX_SCHEMA;
  provider: string;
  /** Build that wrote the latest state. */
  asOf: string;
  pages: Record<TickerReferencePass, number>;
  records: Record<TickerReferencePass, number>;
  /** sha256 / length of the latest full body (base + every delta). */
  bodySha256: string;
  bodyByteLength: number;
  base: TickerReferenceObjectRef;
  deltas: TickerReferenceObjectRef[];
  /**
   * The archived live manifest this one's base replaced. verified: false means the archived bytes
   * did not parse or checksum as a manifest (kept as evidence only). null: there was none. Absent
   * in manifests written before this field existed (treated as the end of history).
   */
  previousManifest?: TickerReferenceManifestLink | null;
  previousManifestReason?: string;
  /** Present when this commit was built from a dated Massive ticker list. */
  fingerprints?: TickerReferenceIndexFingerprints;
  checksum: string;
}

export interface TickerReferenceManifestLink {
  key: string;
  sha256: string;
  verified: boolean;
  /** Outgoing base month (YYYY-MM); absent when unverified. */
  month?: string;
}

/** Ordered edit script from one state to the next, plus raw text of only the new records. */
export interface TickerReferenceDelta {
  schemaVersion: "ticker-reference-delta-v1";
  fromBodySha256: string;
  toBodySha256: string;
  /** Records per page, per pass, of the new state (pages, positions rebuild from these). */
  pageSizes: Record<TickerReferencePass, number[]>;
  /** n > 0: keep n from the old order; n < 0: drop -n; "hash": insert that record here. */
  ops: Array<number | string>;
  /** [recordHash, pass, raw] for records the old state does not contain. */
  records: Array<[string, TickerReferencePass, string]>;
}

interface StateRecord {
  hash: string;
  pass: TickerReferencePass;
  raw: string;
}
interface IndexState {
  records: StateRecord[];
  pageSizes: Record<TickerReferencePass, number[]>;
}

export function tickerReferenceRecordHash(pass: TickerReferencePass, raw: string): string {
  return sha256Hex(`${pass}\n${raw}`);
}

function checksumOf(body: Omit<TickerReferenceIndexManifest, "checksum">): string {
  return sha256Hex(JSON.stringify(body));
}

function stateFromCapture(capture: TickerReferenceCapture): IndexState {
  const pageSizes: Record<TickerReferencePass, number[]> = {
    active: Array.from({ length: capture.pages.active }, () => 0),
    inactive: Array.from({ length: capture.pages.inactive }, () => 0),
  };
  const ordered = [
    ...capture.entries.filter((e) => e.pass === "active"),
    ...capture.entries.filter((e) => e.pass === "inactive"),
  ];
  for (const entry of ordered) {
    const sizes = pageSizes[entry.pass];
    while (sizes.length < entry.page) sizes.push(0);
    sizes[entry.page - 1] = (sizes[entry.page - 1] ?? 0) + 1;
  }
  return {
    records: ordered.map((e) => ({ hash: tickerReferenceRecordHash(e.pass, e.raw), pass: e.pass, raw: e.raw })),
    pageSizes,
  };
}

/** Entries (pass, page, position from pageSizes) of a state, in order. */
function entriesOfState(state: IndexState): TickerReferenceEntry[] {
  const out: TickerReferenceEntry[] = [];
  let i = 0;
  for (const pass of ["active", "inactive"] as const) {
    state.pageSizes[pass].forEach((size, pageIndex) => {
      for (let position = 0; position < size; position += 1) {
        const record = state.records[i++];
        if (!record || record.pass !== pass) throw new Error("TICKER_REFERENCE_INDEX_STATE_INVALID");
        out.push(tickerReferenceEntry(pass, pageIndex + 1, position, record.raw));
      }
    });
  }
  if (i !== state.records.length) throw new Error("TICKER_REFERENCE_INDEX_STATE_INVALID");
  return out;
}

function bodyOfState(state: IndexState): Uint8Array {
  const entries = entriesOfState(state);
  return new TextEncoder().encode(entries.map((entry) => JSON.stringify(entry)).join("\n") + (entries.length ? "\n" : ""));
}

const PASSES = new Set(["active", "inactive"]);

/** Parse and validate a full body: every line is an entry consistent with its raw record. */
export function parseTickerReferenceBody(body: Uint8Array): TickerReferenceEntry[] {
  const entries: TickerReferenceEntry[] = [];
  const lines = new TextDecoder().decode(body).split("\n").filter(Boolean);
  lines.forEach((line, i) => {
    const entry = JSON.parse(line) as TickerReferenceEntry;
    if (
      !entry ||
      !PASSES.has(entry.pass) ||
      !Number.isSafeInteger(entry.page) ||
      entry.page < 1 ||
      !Number.isSafeInteger(entry.position) ||
      entry.position < 0 ||
      typeof entry.raw !== "string"
    )
      throw new Error(`TICKER_REFERENCE_INDEX_ENTRY_INVALID:${i + 1}`);
    const derived = tickerReferenceEntry(entry.pass, entry.page, entry.position, entry.raw);
    if (JSON.stringify(derived) !== line) throw new Error(`TICKER_REFERENCE_INDEX_ENTRY_INVALID:${i + 1}`);
    entries.push(entry);
  });
  return entries;
}

function stateFromBody(body: Uint8Array): IndexState {
  const entries = parseTickerReferenceBody(body);
  const pageSizes: Record<TickerReferencePass, number[]> = { active: [], inactive: [] };
  for (const e of entries) {
    const sizes = pageSizes[e.pass];
    if (e.position !== (sizes[e.page - 1] ?? 0)) throw new Error("TICKER_REFERENCE_INDEX_ORDER_INVALID");
    while (sizes.length < e.page) sizes.push(0);
    sizes[e.page - 1]! += 1;
  }
  return {
    records: entries.map((e) => ({ hash: tickerReferenceRecordHash(e.pass, e.raw), pass: e.pass, raw: e.raw })),
    pageSizes,
  };
}

const LOOKAHEAD = 4096;

/**
 * Ordered edit script old -> new on record hashes (duplicates are separate occurrences). Any
 * script is correct as long as applying it gives the new order; this greedy one keeps runs,
 * drops short skipped runs, and inserts everything else by hash.
 */
export function diffTickerReferenceStates(from: IndexState, to: IndexState): TickerReferenceDelta {
  const queues = new Map<string, number[]>();
  from.records.forEach((r, i) => {
    const q = queues.get(r.hash);
    if (q) q.push(i);
    else queues.set(r.hash, [i]);
  });
  const heads = new Map<string, number>();
  const ops: Array<number | string> = [];
  const push = (op: number | string) => {
    const last = ops.at(-1);
    if (typeof op === "number" && typeof last === "number" && Math.sign(op) === Math.sign(last))
      ops[ops.length - 1] = last + op;
    else ops.push(op);
  };
  let i = 0;
  for (const record of to.records) {
    const q = queues.get(record.hash);
    let h = heads.get(record.hash) ?? 0;
    while (q && h < q.length && q[h]! < i) h += 1;
    heads.set(record.hash, h);
    const at = q?.[h];
    if (at !== undefined && at - i <= LOOKAHEAD) {
      if (at > i) push(-(at - i));
      push(1);
      i = at + 1;
      heads.set(record.hash, h + 1);
    } else push(record.hash);
  }
  if (i < from.records.length) push(-(from.records.length - i));
  const known = new Set(from.records.map((r) => r.hash));
  const added = new Map<string, [string, TickerReferencePass, string]>();
  for (const r of to.records) if (!known.has(r.hash) && !added.has(r.hash)) added.set(r.hash, [r.hash, r.pass, r.raw]);
  return {
    schemaVersion: "ticker-reference-delta-v1",
    fromBodySha256: sha256Hex(bodyOfState(from)),
    toBodySha256: sha256Hex(bodyOfState(to)),
    pageSizes: { active: [...to.pageSizes.active], inactive: [...to.pageSizes.inactive] },
    ops,
    records: [...added.values()],
  };
}

export function applyTickerReferenceDelta(from: IndexState, delta: TickerReferenceDelta): IndexState {
  if (delta.schemaVersion !== "ticker-reference-delta-v1") throw new Error("TICKER_REFERENCE_DELTA_INVALID");
  const pool = new Map<string, StateRecord>();
  for (const r of from.records) pool.set(r.hash, r);
  for (const [hash, pass, raw] of delta.records) {
    if (!PASSES.has(pass) || typeof raw !== "string" || tickerReferenceRecordHash(pass, raw) !== hash)
      throw new Error("TICKER_REFERENCE_DELTA_RECORD_INVALID");
    pool.set(hash, { hash, pass, raw });
  }
  const out: StateRecord[] = [];
  let i = 0;
  for (const op of delta.ops) {
    if (typeof op === "string") {
      const record = pool.get(op);
      if (!record) throw new Error("TICKER_REFERENCE_DELTA_UNKNOWN_RECORD");
      out.push(record);
    } else if (Number.isSafeInteger(op) && op > 0) {
      if (i + op > from.records.length) throw new Error("TICKER_REFERENCE_DELTA_INVALID");
      out.push(...from.records.slice(i, i + op));
      i += op;
    } else if (Number.isSafeInteger(op) && op < 0) {
      i += -op;
      if (i > from.records.length) throw new Error("TICKER_REFERENCE_DELTA_INVALID");
    } else throw new Error("TICKER_REFERENCE_DELTA_INVALID");
  }
  if (i !== from.records.length) throw new Error("TICKER_REFERENCE_DELTA_INVALID");
  return { records: out, pageSizes: { active: [...delta.pageSizes.active], inactive: [...delta.pageSizes.inactive] } };
}

async function getVerified(store: Pick<IndexStore, "get">, ref: TickerReferenceObjectRef, backend: ReplyDustBackend) {
  const file = await store.get(ref.key);
  if (!file || file.length !== ref.fileByteLength || sha256Hex(file) !== ref.fileSha256)
    throw new Error(`TICKER_REFERENCE_INDEX_FILE_MISMATCH:${ref.key}`);
  return backend.decompress(file, null);
}

async function readManifest(store: Pick<IndexStore, "get">): Promise<TickerReferenceIndexManifest | undefined> {
  const bytes = await store.get(TICKER_REFERENCE_INDEX_MANIFEST_KEY);
  if (!bytes) return undefined;
  return parseManifest(bytes);
}

function parseManifest(bytes: Uint8Array): TickerReferenceIndexManifest {
  let manifest: TickerReferenceIndexManifest;
  try {
    manifest = JSON.parse(new TextDecoder().decode(bytes)) as TickerReferenceIndexManifest;
  } catch {
    throw new Error("TICKER_REFERENCE_INDEX_MANIFEST_INVALID");
  }
  if (!manifest || typeof manifest !== "object") throw new Error("TICKER_REFERENCE_INDEX_MANIFEST_INVALID");
  const { checksum, ...rest } = manifest;
  if (
    manifest.schemaVersion !== TICKER_REFERENCE_INDEX_SCHEMA ||
    !manifest.base ||
    !Array.isArray(manifest.deltas) ||
    checksumOf(rest) !== checksum
  )
    throw new Error("TICKER_REFERENCE_INDEX_MANIFEST_INVALID");
  return manifest;
}

/** Rebuild the state a manifest commits: base, then each delta, each step checked by sha256. */
async function rebuildCommitted(
  store: Pick<IndexStore, "get">,
  manifest: TickerReferenceIndexManifest,
  backend: ReplyDustBackend,
): Promise<{ state: IndexState; body: Uint8Array }> {
  let body = await getVerified(store, manifest.base, backend);
  if (sha256Hex(body) !== manifest.base.bodySha256) throw new Error("TICKER_REFERENCE_INDEX_BODY_MISMATCH:base");
  let state = stateFromBody(body);
  for (const ref of manifest.deltas) {
    const delta = JSON.parse(new TextDecoder().decode(await getVerified(store, ref, backend))) as TickerReferenceDelta;
    if (delta.fromBodySha256 !== sha256Hex(body)) throw new Error(`TICKER_REFERENCE_DELTA_BASE_MISMATCH:${ref.key}`);
    state = applyTickerReferenceDelta(state, delta);
    body = bodyOfState(state);
    if (sha256Hex(body) !== ref.bodySha256 || delta.toBodySha256 !== ref.bodySha256)
      throw new Error(`TICKER_REFERENCE_INDEX_BODY_MISMATCH:${ref.key}`);
  }
  if (body.length !== manifest.bodyByteLength || sha256Hex(body) !== manifest.bodySha256)
    throw new Error("TICKER_REFERENCE_INDEX_BODY_MISMATCH");
  return { state, body };
}

/**
 * Rebuild one committed manifest (live or archived) to entries + body.
 * Callers that need point-in-time (asOf ≤ D) pick the manifest first via history.
 */
export async function loadTickerReferenceIndexFromManifest(
  store: Pick<IndexStore, "get">,
  manifest: TickerReferenceIndexManifest,
  backend: ReplyDustBackend = nodeReplyDustBackend,
): Promise<{ manifest: TickerReferenceIndexManifest; entries: TickerReferenceEntry[]; body: Uint8Array }> {
  const { body } = await rebuildCommitted(store, manifest, backend);
  const entries = parseTickerReferenceBody(body);
  const count = (pass: TickerReferencePass) => entries.filter((e) => e.pass === pass).length;
  if (count("active") !== manifest.records.active || count("inactive") !== manifest.records.inactive)
    throw new Error("TICKER_REFERENCE_INDEX_COUNT_MISMATCH");
  return { manifest, entries, body };
}

/** Immutable plain object: identical bytes reused, different bytes throw, else put + read back. */
async function putImmutable(store: IndexStore, key: string, bytes: Uint8Array): Promise<void> {
  const existing = await store.get(key);
  if (existing) {
    if (!sameBytes(existing, bytes)) throw new Error(`TICKER_REFERENCE_INDEX_OBJECT_CONFLICT:${key}`);
    return;
  }
  await store.put(key, bytes);
  const stored = await store.get(key);
  if (!stored || !sameBytes(stored, bytes)) throw new Error("TICKER_REFERENCE_INDEX_READBACK_MISMATCH");
}

export const tickerReferenceManifestArchiveKey = (month: string, sha256: string) =>
  `${TICKER_REFERENCE_INDEX_PREFIX}manifest-${month}-${sha256}.json`;
export const tickerReferenceUnverifiedManifestArchiveKey = (sha256: string) =>
  `${TICKER_REFERENCE_INDEX_PREFIX}manifest-unverified-${sha256}.json`;

async function putVerified(
  store: IndexStore,
  key: string,
  raw: Uint8Array,
  asOf: string,
  bodySha256: string,
  backend: ReplyDustBackend,
): Promise<TickerReferenceObjectRef> {
  const file = backend.compress(raw, null);
  if (!sameBytes(backend.decompress(file, null), raw)) throw new Error("TICKER_REFERENCE_INDEX_VERIFY_FAILED");
  // Content-addressed keys: never overwrite. Identical bytes are reused as they are.
  const existing = await store.get(key);
  if (existing) {
    if (!sameBytes(existing, file)) throw new Error(`TICKER_REFERENCE_INDEX_OBJECT_CONFLICT:${key}`);
    return { asOf, key, fileSha256: sha256Hex(file), fileByteLength: file.length, bodySha256 };
  }
  await store.put(key, file);
  const stored = await store.get(key);
  if (!stored || !sameBytes(stored, file)) throw new Error("TICKER_REFERENCE_INDEX_READBACK_MISMATCH");
  return { asOf, key, fileSha256: sha256Hex(file), fileByteLength: file.length, bodySha256 };
}

/**
 * Commit this build's index: a delta against the index the current manifest commits, or a full
 * base snapshot when there is no usable manifest or its base is not from asOf's month. Objects
 * are written and read back first; the manifest last. Throws on any mismatch.
 * A new base first archives the outgoing live manifest bytes (hash-named, immutable, read back),
 * then writes the base, then the live manifest linking to the archive via previousManifest; a
 * failure at any step leaves the previous live manifest in place.
 */
export async function writeTickerReferenceIndex(
  store: IndexStore,
  capture: TickerReferenceCapture,
  options: { provider: string; asOf: string; fingerprints?: TickerReferenceIndexFingerprints },
  backend: ReplyDustBackend = nodeReplyDustBackend,
): Promise<TickerReferenceIndexManifest & { wrote: "BASE" | "DELTA"; baseReason?: string }> {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(options.asOf)) throw new Error("TICKER_REFERENCE_INDEX_ASOF_INVALID");
  const next = stateFromCapture(capture);
  const body = bodyOfState(next);
  const bodySha256 = sha256Hex(body);
  let current: TickerReferenceIndexManifest | undefined;
  let committed: { state: IndexState; body: Uint8Array } | undefined;
  let baseReason: string | undefined;
  // Raw live manifest bytes, kept to archive them if this build writes a new base.
  const outgoingBytes = await store.get(TICKER_REFERENCE_INDEX_MANIFEST_KEY);
  try {
    current = await readManifest(store);
    if (!current) baseReason = "NO_MANIFEST";
    else if (current.base.asOf.slice(0, 7) !== options.asOf.slice(0, 7)) baseReason = "BASE_NOT_THIS_MONTH";
    else committed = await rebuildCommitted(store, current, backend);
  } catch (error) {
    baseReason = `COMMITTED_INDEX_UNREADABLE:${error instanceof Error ? error.message : String(error)}`;
    committed = undefined;
  }
  let base: TickerReferenceObjectRef;
  let deltas: TickerReferenceObjectRef[];
  let history: Pick<TickerReferenceIndexManifest, "previousManifest" | "previousManifestReason">;
  if (!committed || !current) {
    // 1. Archive the outgoing live manifest (immutable, hash-named) before anything else.
    if (!outgoingBytes) history = { previousManifest: null, previousManifestReason: "NO_MANIFEST" };
    else {
      const sha256 = sha256Hex(outgoingBytes);
      let month: string | undefined;
      try {
        const parsed = parseManifest(outgoingBytes);
        if (/^\d{4}-\d{2}-\d{2}$/u.test(parsed.base.asOf)) month = parsed.base.asOf.slice(0, 7);
      } catch {
        month = undefined;
      }
      const key = month
        ? tickerReferenceManifestArchiveKey(month, sha256)
        : tickerReferenceUnverifiedManifestArchiveKey(sha256);
      await putImmutable(store, key, outgoingBytes);
      history = {
        previousManifest: { key, sha256, verified: month !== undefined, ...(month ? { month } : {}) },
        ...(month ? {} : { previousManifestReason: "OUTGOING_MANIFEST_UNVERIFIED" }),
      };
    }
    // 2. The new base.
    base = await putVerified(store, tickerReferenceBaseKey(options.asOf, bodySha256), body, options.asOf, bodySha256, backend);
    deltas = [];
  } else {
    const delta = diffTickerReferenceStates(committed.state, next);
    // The delta must rebuild this build's body exactly before it is stored.
    if (sha256Hex(bodyOfState(applyTickerReferenceDelta(committed.state, delta))) !== bodySha256)
      throw new Error("TICKER_REFERENCE_DELTA_VERIFY_FAILED");
    const raw = new TextEncoder().encode(JSON.stringify(delta));
    base = current.base;
    // Deltas carry the month link forward unchanged.
    history = {
      ...(current.previousManifest !== undefined ? { previousManifest: current.previousManifest } : {}),
      ...(current.previousManifestReason !== undefined ? { previousManifestReason: current.previousManifestReason } : {}),
    };
    deltas = [
      ...current.deltas,
      await putVerified(
        store,
        tickerReferenceDeltaKey(options.asOf, current.deltas.length + 1, sha256Hex(raw)),
        raw,
        options.asOf,
        bodySha256,
        backend,
      ),
    ];
  }
  const count = (pass: TickerReferencePass) => next.records.filter((r) => r.pass === pass).length;
  const manifestBody: Omit<TickerReferenceIndexManifest, "checksum"> = {
    schemaVersion: TICKER_REFERENCE_INDEX_SCHEMA,
    provider: options.provider,
    asOf: options.asOf,
    pages: { active: next.pageSizes.active.length, inactive: next.pageSizes.inactive.length },
    records: { active: count("active"), inactive: count("inactive") },
    bodySha256,
    bodyByteLength: body.length,
    base,
    deltas,
    ...history,
    ...(options.fingerprints ? { fingerprints: options.fingerprints } : {}),
  };
  // 3. The live manifest, last.
  const manifest: TickerReferenceIndexManifest = { ...manifestBody, checksum: checksumOf(manifestBody) };
  const manifestBytes = new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);
  await store.put(TICKER_REFERENCE_INDEX_MANIFEST_KEY, manifestBytes);
  const storedManifest = await store.get(TICKER_REFERENCE_INDEX_MANIFEST_KEY);
  if (!storedManifest || !sameBytes(storedManifest, manifestBytes))
    throw new Error("TICKER_REFERENCE_INDEX_MANIFEST_READBACK_MISMATCH");
  return { ...manifest, wrote: deltas.length && committed ? "DELTA" : "BASE", ...(baseReason && !committed ? { baseReason } : {}) };
}

/**
 * Read and validate the committed index (base + deltas, each checked). Undefined when none is
 * stored. Throws on any checksum, order or shape mismatch.
 */
export async function loadTickerReferenceIndex(
  store: Pick<IndexStore, "get">,
  backend: ReplyDustBackend = nodeReplyDustBackend,
): Promise<{ manifest: TickerReferenceIndexManifest; entries: TickerReferenceEntry[]; body: Uint8Array } | undefined> {
  const manifest = await readManifest(store);
  if (!manifest) return undefined;
  const { body } = await rebuildCommitted(store, manifest, backend);
  const entries = parseTickerReferenceBody(body);
  const count = (pass: TickerReferencePass) => entries.filter((e) => e.pass === pass).length;
  if (count("active") !== manifest.records.active || count("inactive") !== manifest.records.inactive)
    throw new Error("TICKER_REFERENCE_INDEX_COUNT_MISMATCH");
  return { manifest, entries, body };
}

export interface TickerReferenceHistoryEntry {
  /** TICKER_REFERENCE_INDEX_MANIFEST_KEY for the live manifest, else the archive key. */
  key: string;
  sha256: string;
  verified: boolean;
  /** Base month (YYYY-MM) of this manifest; absent when unverified. */
  month?: string;
  manifest?: TickerReferenceIndexManifest;
}

/**
 * Walk previousManifest links from the live manifest, newest first, checking each archived
 * object's sha256. Stops cleanly at the first manifest with no link (null or absent) or at an
 * unverified archive (its bytes are listed but not followed). Throws on a sha mismatch, a missing
 * archive, or a loop.
 */
export async function listTickerReferenceIndexHistory(
  store: Pick<IndexStore, "get">,
): Promise<TickerReferenceHistoryEntry[]> {
  const liveBytes = await store.get(TICKER_REFERENCE_INDEX_MANIFEST_KEY);
  if (!liveBytes) return [];
  const live = parseManifest(liveBytes);
  const out: TickerReferenceHistoryEntry[] = [
    { key: TICKER_REFERENCE_INDEX_MANIFEST_KEY, sha256: sha256Hex(liveBytes), verified: true, month: live.base.asOf.slice(0, 7), manifest: live },
  ];
  const seen = new Set<string>();
  let link = live.previousManifest;
  while (link) {
    if (seen.has(link.key) || seen.size > 1000) throw new Error(`TICKER_REFERENCE_INDEX_HISTORY_LOOP:${link.key}`);
    seen.add(link.key);
    const bytes = await store.get(link.key);
    if (!bytes) throw new Error(`TICKER_REFERENCE_INDEX_ARCHIVE_MISSING:${link.key}`);
    if (sha256Hex(bytes) !== link.sha256) throw new Error(`TICKER_REFERENCE_INDEX_ARCHIVE_SHA_MISMATCH:${link.key}`);
    if (!link.verified) {
      out.push({ key: link.key, sha256: link.sha256, verified: false });
      break;
    }
    const manifest = parseManifest(bytes);
    const month = manifest.base.asOf.slice(0, 7);
    if (link.month !== undefined && link.month !== month)
      throw new Error(`TICKER_REFERENCE_INDEX_ARCHIVE_MONTH_MISMATCH:${link.key}`);
    out.push({ key: link.key, sha256: link.sha256, verified: true, month, manifest });
    link = manifest.previousManifest;
  }
  return out;
}

/**
 * The final committed state of one month (YYYY-MM): the newest manifest in the history whose base
 * is from that month, rebuilt from its base and deltas and checked like the live index.
 * Undefined when the history has no manifest for that month.
 */
export async function loadTickerReferenceIndexAt(
  store: Pick<IndexStore, "get">,
  month: string,
  backend: ReplyDustBackend = nodeReplyDustBackend,
): Promise<{ manifest: TickerReferenceIndexManifest; entries: TickerReferenceEntry[]; body: Uint8Array; key: string } | undefined> {
  if (!/^\d{4}-\d{2}$/u.test(month)) throw new Error("TICKER_REFERENCE_INDEX_MONTH_INVALID");
  const found = (await listTickerReferenceIndexHistory(store)).find((entry) => entry.manifest && entry.month === month);
  if (!found?.manifest) return undefined;
  const { body } = await rebuildCommitted(store, found.manifest, backend);
  const entries = parseTickerReferenceBody(body);
  return { manifest: found.manifest, entries, body, key: found.key };
}
