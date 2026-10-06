/**
 * Daily 10-minute picks DAY writer/reader (storage layer only).
 *
 * Layout under permanent/tenmin-day-reply-dust/<D>/:
 *   picks.json          — buildPicksBaseV1 document (written first, immutable)
 *   picks-top50.json    — buildPicksTop50V1 when frozen scan exists (optional)
 *   <b64url(securityId)>.<b64url(symbol)>.rdust — Reply Dust v1 raw Massive 10m reply
 *   manifest.json       — written LAST; seals the day (never rewritten)
 *   manifest-top50.json — ADD-ONLY second seal when top50 arrives later while
 *                         the day was sealed with top50 absent; never rewrites
 *                         manifest.json. Only allowed inside the Massive 2-year
 *                         window (caller passes withinWindow).
 *
 * Resume: every existing picks*.json / .rdust is checked against expected sha256
 * and byte length. Match → reuse. Missing → write. Truncated/wrong bytes on an
 * immutable key → TENMIN_DAY_OBJECT_CORRUPT (no silent overwrite; no repair path).
 *
 * Reader: missing manifest.json → NOT_SEALED (not a throw). When manifest-top50.json
 * exists it wins for top50 presence; merged picks are deterministic.
 */

import type { PredictionStatus } from "./contracts";
import {
  type PickV1Pick,
  type PicksBaseV1,
  type PicksTop50V1,
  PICK_V1_RULE_VERSION,
  mergeDailyTenMinPicksV1,
  serializePicksBaseV1,
  serializePicksTop50V1,
} from "./tenmin-daily-picks";
import {
  type ReplyDustStore,
  sameBytes,
  sha256Hex,
  storeVerifiedReplyDust,
} from "./intraday-reply-dust";
import type { ObjectMetadata } from "./object-store";
import {
  type ReplyDustBackend,
  decodeReplyDust,
  encodeReplyDust,
  nodeReplyDustBackend,
} from "./reply-dust";
import { resolveSessionPredictionStatus } from "./prediction-status";

export const TENMIN_DAY_REPLY_DUST_PREFIX = "permanent/tenmin-day-reply-dust" as const;
export const TENMIN_DAY_MANIFEST_SCHEMA = "tenmin-day-reply-dust-manifest-v1" as const;
export const TENMIN_DAY_TOP50_MANIFEST_SCHEMA =
  "tenmin-day-reply-dust-manifest-top50-v1" as const;
export const TENMIN_DAY_OBJECT_SCHEMA = "tenmin-day-reply-dust-object-v1" as const;

export const TENMIN_DAY_NOT_SEALED = "TENMIN_DAY_NOT_SEALED" as const;
export const TENMIN_DAY_OBJECT_CORRUPT = "TENMIN_DAY_OBJECT_CORRUPT" as const;
export const TENMIN_DAY_SHA_MISMATCH = "TENMIN_DAY_SHA_MISMATCH" as const;
export const TENMIN_DAY_OUTSIDE_WINDOW = "TENMIN_DAY_OUTSIDE_WINDOW" as const;
export const TENMIN_DAY_TOP50_ALREADY_PRESENT = "TENMIN_DAY_TOP50_ALREADY_PRESENT" as const;
export const TENMIN_DAY_NO_FORWARD_SCAN = "TENMIN_DAY_NO_FORWARD_SCAN" as const;

export type TenMinDayObjectStatus = "STORED" | "EMPTY" | "GAP";

/** Why top50 was absent when the day sealed (from resolveSessionPredictionStatus). */
export type TenMinDayTop50AbsentReason = "not_yet_frozen" | "no_forward_scan";

export type TenMinDayTop50State =
  | { state: "present" }
  | {
      state: "absent";
      reason: TenMinDayTop50AbsentReason;
      /** predictionStatusId of the resolved record, when one existed. */
      resolvedStatusId?: string;
      /** reason field of that record (e.g. EVIDENCE_ONLY, FREEZE_AFTER_OPEN). */
      resolvedReason?: PredictionStatus["reason"];
    };

export interface TenMinDaySecurityEntry {
  securityId: string;
  symbol: string;
  reason: PickV1Pick["reason"];
  alsoReasons?: PickV1Pick["alsoReasons"];
  rankInputs: PickV1Pick["rankInputs"];
  /** Object key under the day prefix (basename for EMPTY/GAP with no object). */
  objectKey: string;
  /** sha256 of the stored .rdust file bytes; empty string when EMPTY/GAP. */
  sha256: string;
  byteLength: number;
  status: TenMinDayObjectStatus;
  gapReason?: string;
}

export interface TenMinDayManifest {
  schemaVersion: typeof TENMIN_DAY_MANIFEST_SCHEMA;
  ruleVersion: typeof PICK_V1_RULE_VERSION;
  sessionDate: string;
  picksSha256: string;
  picksTop50Sha256?: string;
  top50: TenMinDayTop50State;
  picks: PickV1Pick[];
  securities: TenMinDaySecurityEntry[];
  observedAt: string;
  checksum: string;
}

/**
 * ADD-ONLY second seal. Written as manifest-top50.json when a day sealed with
 * top50 absent later receives frozen scan data (within the Massive 2-year window).
 * Never rewrites manifest.json.
 */
export interface TenMinDayTop50Manifest {
  schemaVersion: typeof TENMIN_DAY_TOP50_MANIFEST_SCHEMA;
  ruleVersion: typeof PICK_V1_RULE_VERSION;
  sessionDate: string;
  baseManifestKey: string;
  baseManifestSha256: string;
  picksTop50Sha256: string;
  top50: { state: "present" };
  /** Full merged pick list (base ∪ top50), deterministic by securityId. */
  picks: PickV1Pick[];
  /** Securities newly added by top50 (not already in the base day seal). */
  securities: TenMinDaySecurityEntry[];
  observedAt: string;
  checksum: string;
}

export type TenMinDayReadResult =
  | { status: typeof TENMIN_DAY_NOT_SEALED; sessionDate: string }
  | {
      status: "SEALED";
      sessionDate: string;
      manifest: TenMinDayManifest;
      top50Manifest?: TenMinDayTop50Manifest;
      /** Effective top50 state (top50 manifest wins when present). */
      top50: TenMinDayTop50State;
      /** Merged picks: from top50 manifest when present, else day manifest. */
      picks: PickV1Pick[];
      /** Base securities plus any add-only top50 securities, keyed by securityId. */
      securities: TenMinDaySecurityEntry[];
    };

export type TenMinDayBacklogReason = "UNSEALED" | "ABSENT_TOP50";

export interface TenMinDayBacklogEntry {
  sessionDate: string;
  reason: TenMinDayBacklogReason;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const b64 = (value: string): string => Buffer.from(value, "utf8").toString("base64url");

function requireSessionDate(sessionDate: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(sessionDate)) throw new Error("INVALID_SESSION_DATE");
}

export function tenMinDayPrefix(sessionDate: string): string {
  requireSessionDate(sessionDate);
  return `${TENMIN_DAY_REPLY_DUST_PREFIX}/${sessionDate}`;
}

export function tenMinDayPicksKey(sessionDate: string): string {
  return `${tenMinDayPrefix(sessionDate)}/picks.json`;
}

export function tenMinDayPicksTop50Key(sessionDate: string): string {
  return `${tenMinDayPrefix(sessionDate)}/picks-top50.json`;
}

export function tenMinDayManifestKey(sessionDate: string): string {
  return `${tenMinDayPrefix(sessionDate)}/manifest.json`;
}

/** Add-only second seal filename (documented; never rewrites manifest.json). */
export function tenMinDayTop50ManifestKey(sessionDate: string): string {
  return `${tenMinDayPrefix(sessionDate)}/manifest-top50.json`;
}

export function tenMinDayObjectFileName(securityId: string, symbol: string): string {
  return `${b64(securityId)}.${b64(symbol)}.rdust`;
}

export function tenMinDayObjectKey(
  sessionDate: string,
  securityId: string,
  symbol: string,
): string {
  return `${tenMinDayPrefix(sessionDate)}/${tenMinDayObjectFileName(securityId, symbol)}`;
}

export function tenMinDayManifestChecksum(
  body: Omit<TenMinDayManifest, "checksum">,
): string {
  return sha256Hex(JSON.stringify(body));
}

export function tenMinDayTop50ManifestChecksum(
  body: Omit<TenMinDayTop50Manifest, "checksum">,
): string {
  return sha256Hex(JSON.stringify(body));
}

/**
 * Classify resolved prediction status for top50 absence.
 * - FROZEN → should not be absent (caller writes present)
 * - EVIDENCE_ONLY / FREEZE_AFTER_OPEN (and any other terminal non-FROZEN) → no_forward_scan
 * - missing / SOURCE_COLLECTION_FAILED / etc. that may still become FROZEN → not_yet_frozen
 */
export function classifyTop50Absence(
  statuses: readonly PredictionStatus[],
): Extract<TenMinDayTop50State, { state: "absent" }> {
  const resolved = resolveSessionPredictionStatus(statuses);
  if (!resolved) {
    return { state: "absent", reason: "not_yet_frozen" };
  }
  if (resolved.status === "FROZEN") {
    // Caller should treat as present; keep a defensive absent classification unused.
    return {
      state: "absent",
      reason: "not_yet_frozen",
      resolvedStatusId: resolved.predictionStatusId,
      resolvedReason: resolved.reason,
    };
  }
  const terminalNoForward =
    resolved.reason === "EVIDENCE_ONLY" || resolved.reason === "FREEZE_AFTER_OPEN";
  return {
    state: "absent",
    reason: terminalNoForward ? "no_forward_scan" : "not_yet_frozen",
    resolvedStatusId: resolved.predictionStatusId,
    resolvedReason: resolved.reason,
  };
}

function jsonBytes(value: unknown): Uint8Array {
  return textEncoder.encode(`${typeof value === "string" ? value : JSON.stringify(value, null, 2)}\n`);
}

function picksBaseBytes(doc: PicksBaseV1): Uint8Array {
  return textEncoder.encode(`${serializePicksBaseV1(doc)}\n`);
}

function picksTop50Bytes(doc: PicksTop50V1): Uint8Array {
  return textEncoder.encode(`${serializePicksTop50V1(doc)}\n`);
}

/**
 * Immutable put: missing → write; identical bytes → reuse; different/truncated → CORRUPT.
 * No silent overwrite and no repair path (objects are immutable).
 */
export async function putImmutableVerified(
  store: ReplyDustStore,
  key: string,
  expected: Uint8Array,
  metadata?: ObjectMetadata,
): Promise<"written" | "reused"> {
  const existing = await store.get(key);
  if (existing) {
    if (sameBytes(existing, expected)) return "reused";
    throw new Error(`${TENMIN_DAY_OBJECT_CORRUPT}:${key}`);
  }
  await store.put(key, expected, metadata);
  const readBack = await store.get(key);
  if (!readBack || !sameBytes(readBack, expected))
    throw new Error(`${TENMIN_DAY_OBJECT_CORRUPT}:${key}:readback`);
  return "written";
}

/**
 * Resume check for an object that should already match expected sha + length.
 * Missing → undefined (caller writes). Present + match → reuse. Present + mismatch → CORRUPT.
 */
export async function verifyExistingOrMissing(
  store: ReplyDustStore,
  key: string,
  expectedSha256: string,
  expectedByteLength: number,
): Promise<"missing" | "reused"> {
  const existing = await store.get(key);
  if (!existing) return "missing";
  if (existing.length !== expectedByteLength || sha256Hex(existing) !== expectedSha256)
    throw new Error(`${TENMIN_DAY_OBJECT_CORRUPT}:${key}`);
  return "reused";
}

function securityEntryFromPick(
  sessionDate: string,
  pick: PickV1Pick,
  object: {
    status: TenMinDayObjectStatus;
    sha256: string;
    byteLength: number;
    gapReason?: string;
  },
): TenMinDaySecurityEntry {
  const objectKey =
    object.status === "STORED"
      ? tenMinDayObjectFileName(pick.securityId, pick.symbol)
      : "";
  return {
    securityId: pick.securityId,
    symbol: pick.symbol,
    reason: pick.reason,
    ...(pick.alsoReasons?.length ? { alsoReasons: pick.alsoReasons } : {}),
    rankInputs: pick.rankInputs,
    objectKey,
    sha256: object.sha256,
    byteLength: object.byteLength,
    status: object.status,
    ...(object.gapReason !== undefined ? { gapReason: object.gapReason } : {}),
  };
}

export interface TenMinDaySecurityInput {
  securityId: string;
  symbol: string;
  status: TenMinDayObjectStatus;
  /** Raw Massive 10-minute reply body (required when status is STORED). */
  replyBody?: Uint8Array;
  gapReason?: string;
}

export interface WriteTenMinDayPicksInput {
  sessionDate: string;
  picksBase: PicksBaseV1;
  picksTop50?: PicksTop50V1;
  /**
   * Prediction-status records for D (used when picksTop50 is absent to classify
   * not_yet_frozen vs no_forward_scan via resolveSessionPredictionStatus).
   */
  predictionStatuses?: readonly PredictionStatus[];
  securities: readonly TenMinDaySecurityInput[];
  observedAt: string;
  provider?: string;
  backend?: ReplyDustBackend;
}

/**
 * Write picks.json first, optional picks-top50.json, per-security .rdust objects,
 * then manifest.json LAST. Resumable: identical existing objects are reused;
 * corrupted leftovers throw TENMIN_DAY_OBJECT_CORRUPT.
 */
export async function writeTenMinDayPicks(
  store: ReplyDustStore,
  input: WriteTenMinDayPicksInput,
): Promise<TenMinDayManifest> {
  const D = input.sessionDate;
  requireSessionDate(D);
  if (input.picksBase.sessionDate !== D)
    throw new Error(`TENMIN_DAY_SESSION_MISMATCH:base:${input.picksBase.sessionDate}`);
  if (input.picksTop50 && input.picksTop50.sessionDate !== D)
    throw new Error(`TENMIN_DAY_SESSION_MISMATCH:top50:${input.picksTop50.sessionDate}`);

  // Already sealed?
  const existingManifest = await readTenMinDayManifestRaw(store, D);
  if (existingManifest) return existingManifest;

  const picksBytes = picksBaseBytes(input.picksBase);
  const picksSha256 = sha256Hex(picksBytes);
  await putImmutableVerified(store, tenMinDayPicksKey(D), picksBytes, {
    "rd-schema": TENMIN_DAY_OBJECT_SCHEMA,
    "rd-kind": "picks",
    "rd-session-date": D,
    "rd-sha256": picksSha256,
  });

  let picksTop50Sha256: string | undefined;
  let top50State: TenMinDayTop50State;
  if (input.picksTop50) {
    const topBytes = picksTop50Bytes(input.picksTop50);
    picksTop50Sha256 = sha256Hex(topBytes);
    await putImmutableVerified(store, tenMinDayPicksTop50Key(D), topBytes, {
      "rd-schema": TENMIN_DAY_OBJECT_SCHEMA,
      "rd-kind": "picks-top50",
      "rd-session-date": D,
      "rd-sha256": picksTop50Sha256,
    });
    top50State = { state: "present" };
  } else {
    top50State = classifyTop50Absence(input.predictionStatuses ?? []);
  }

  const merged = mergeDailyTenMinPicksV1(input.picksBase, input.picksTop50);
  const byId = new Map(input.securities.map((s) => [s.securityId, s]));
  const backend = input.backend ?? nodeReplyDustBackend;
  const provider = input.provider ?? "massive";

  const securities: TenMinDaySecurityEntry[] = [];
  for (const pick of merged) {
    const sec = byId.get(pick.securityId);
    if (!sec) {
      securities.push(
        securityEntryFromPick(D, pick, {
          status: "GAP",
          sha256: "",
          byteLength: 0,
          gapReason: "MISSING_SECURITY_INPUT",
        }),
      );
      continue;
    }
    if (sec.status === "EMPTY") {
      securities.push(
        securityEntryFromPick(D, pick, { status: "EMPTY", sha256: "", byteLength: 0 }),
      );
      continue;
    }
    if (sec.status === "GAP") {
      securities.push(
        securityEntryFromPick(D, pick, {
          status: "GAP",
          sha256: "",
          byteLength: 0,
          gapReason: sec.gapReason ?? "GAP",
        }),
      );
      continue;
    }
    // STORED
    if (!sec.replyBody)
      throw new Error(`TENMIN_DAY_STORED_WITHOUT_BODY:${pick.securityId}`);
    const key = tenMinDayObjectKey(D, pick.securityId, pick.symbol);
    const encoded = encodeAndVerifyExisting(store, key, sec.replyBody, backend, {
      provider,
      sessionDate: D,
      securityId: pick.securityId,
      symbol: pick.symbol,
    });
    const fileBytes = await encoded;
    securities.push(
      securityEntryFromPick(D, pick, {
        status: "STORED",
        sha256: sha256Hex(fileBytes),
        byteLength: fileBytes.length,
      }),
    );
  }

  const body: Omit<TenMinDayManifest, "checksum"> = {
    schemaVersion: TENMIN_DAY_MANIFEST_SCHEMA,
    ruleVersion: PICK_V1_RULE_VERSION,
    sessionDate: D,
    picksSha256,
    ...(picksTop50Sha256 ? { picksTop50Sha256 } : {}),
    top50: top50State,
    picks: merged,
    securities,
    observedAt: input.observedAt,
  };
  const manifest: TenMinDayManifest = {
    ...body,
    checksum: tenMinDayManifestChecksum(body),
  };
  const manifestBytes = jsonBytes(manifest);
  await putImmutableVerified(store, tenMinDayManifestKey(D), manifestBytes, {
    "rd-manifest-checksum": manifest.checksum,
    "rd-session-date": D,
  });
  return manifest;
}

async function encodeAndVerifyExisting(
  store: ReplyDustStore,
  key: string,
  replyBody: Uint8Array,
  backend: ReplyDustBackend,
  meta: {
    provider: string;
    sessionDate: string;
    securityId: string;
    symbol: string;
  },
): Promise<Uint8Array> {
  // Encode first so we know expected file sha/length for resume verify.
  const encoded = encodeReplyDust(replyBody, backend);
  const expectedSha = sha256Hex(encoded);
  const existing = await verifyExistingOrMissing(store, key, expectedSha, encoded.length);
  if (existing === "reused") return encoded;

  const written = await storeVerifiedReplyDust(
    store,
    key,
    replyBody,
    `${meta.securityId}:${meta.symbol}`,
    backend,
    (bytes) => ({
      "rd-schema": TENMIN_DAY_OBJECT_SCHEMA,
      "rd-provider": meta.provider,
      "rd-session-date": meta.sessionDate,
      "rd-security-id": meta.securityId,
      "rd-symbol": meta.symbol,
      "rd-file-sha256": sha256Hex(bytes),
      "rd-reply-sha256": sha256Hex(replyBody),
      "rd-version": String(bytes[0] ?? 0),
    }),
  );
  return written;
}

async function readTenMinDayManifestRaw(
  store: ReplyDustStore,
  sessionDate: string,
): Promise<TenMinDayManifest | undefined> {
  const bytes = await store.get(tenMinDayManifestKey(sessionDate));
  if (!bytes) return undefined;
  const manifest = JSON.parse(textDecoder.decode(bytes)) as TenMinDayManifest;
  const { checksum, ...body } = manifest;
  if (
    manifest.schemaVersion !== TENMIN_DAY_MANIFEST_SCHEMA ||
    tenMinDayManifestChecksum(body) !== checksum
  )
    throw new Error(`${TENMIN_DAY_SHA_MISMATCH}:manifest:${sessionDate}`);
  return manifest;
}

async function readTenMinDayTop50ManifestRaw(
  store: ReplyDustStore,
  sessionDate: string,
): Promise<TenMinDayTop50Manifest | undefined> {
  const bytes = await store.get(tenMinDayTop50ManifestKey(sessionDate));
  if (!bytes) return undefined;
  const manifest = JSON.parse(textDecoder.decode(bytes)) as TenMinDayTop50Manifest;
  const { checksum, ...body } = manifest;
  if (
    manifest.schemaVersion !== TENMIN_DAY_TOP50_MANIFEST_SCHEMA ||
    tenMinDayTop50ManifestChecksum(body) !== checksum
  )
    throw new Error(`${TENMIN_DAY_SHA_MISMATCH}:manifest-top50:${sessionDate}`);
  return manifest;
}

/**
 * Read sealed day. Missing manifest.json → NOT_SEALED (resumable).
 * When manifest-top50.json exists it wins: top50 is present and picks/securities
 * merge from it; day manifest.json is never rewritten.
 * Verifies sha256 of picks files and each STORED object read.
 */
export async function readTenMinDayPicks(
  store: ReplyDustStore,
  sessionDate: string,
  backend: ReplyDustBackend = nodeReplyDustBackend,
): Promise<TenMinDayReadResult> {
  requireSessionDate(sessionDate);
  const manifest = await readTenMinDayManifestRaw(store, sessionDate);
  if (!manifest) {
    return { status: TENMIN_DAY_NOT_SEALED, sessionDate };
  }

  // Verify picks.json
  const picksBytes = await store.get(tenMinDayPicksKey(sessionDate));
  if (!picksBytes || sha256Hex(picksBytes) !== manifest.picksSha256)
    throw new Error(`${TENMIN_DAY_SHA_MISMATCH}:picks.json:${sessionDate}`);

  const top50Manifest = await readTenMinDayTop50ManifestRaw(store, sessionDate);

  // Effective top50: add-only manifest wins.
  const top50: TenMinDayTop50State = top50Manifest
    ? { state: "present" }
    : manifest.top50;

  if (top50.state === "present") {
    const expectedTopSha = top50Manifest?.picksTop50Sha256 ?? manifest.picksTop50Sha256;
    if (!expectedTopSha)
      throw new Error(`${TENMIN_DAY_SHA_MISMATCH}:picks-top50-missing-sha:${sessionDate}`);
    const topBytes = await store.get(tenMinDayPicksTop50Key(sessionDate));
    if (!topBytes || sha256Hex(topBytes) !== expectedTopSha)
      throw new Error(`${TENMIN_DAY_SHA_MISMATCH}:picks-top50.json:${sessionDate}`);
  }

  const picks = top50Manifest ? top50Manifest.picks : manifest.picks;
  const securityMap = new Map<string, TenMinDaySecurityEntry>();
  for (const s of manifest.securities) securityMap.set(s.securityId, s);
  if (top50Manifest) {
    for (const s of top50Manifest.securities) securityMap.set(s.securityId, s);
  }
  const securities = [...securityMap.values()].sort((a, b) =>
    a.securityId < b.securityId ? -1 : a.securityId > b.securityId ? 1 : 0,
  );

  // Verify each STORED object we would read.
  for (const entry of securities) {
    if (entry.status !== "STORED") continue;
    const key = `${tenMinDayPrefix(sessionDate)}/${entry.objectKey}`;
    const bytes = await store.get(key);
    if (!bytes || bytes.length !== entry.byteLength || sha256Hex(bytes) !== entry.sha256)
      throw new Error(`${TENMIN_DAY_SHA_MISMATCH}:${key}`);
    // Decode to confirm Reply Dust integrity.
    decodeReplyDust(bytes, backend);
  }

  return {
    status: "SEALED",
    sessionDate,
    manifest,
    ...(top50Manifest ? { top50Manifest } : {}),
    top50,
    picks,
    securities,
  };
}

/** Read one security's raw Massive reply bytes from a sealed day (verifies sha). */
export async function readTenMinDaySecurityReply(
  store: ReplyDustStore,
  sessionDate: string,
  securityId: string,
  backend: ReplyDustBackend = nodeReplyDustBackend,
): Promise<Uint8Array> {
  const day = await readTenMinDayPicks(store, sessionDate, backend);
  if (day.status === TENMIN_DAY_NOT_SEALED) throw new Error(TENMIN_DAY_NOT_SEALED);
  const entry = day.securities.find((s) => s.securityId === securityId);
  if (!entry || entry.status !== "STORED")
    throw new Error(`TENMIN_DAY_SECURITY_NOT_STORED:${securityId}`);
  const key = `${tenMinDayPrefix(sessionDate)}/${entry.objectKey}`;
  const bytes = await store.get(key);
  if (!bytes || bytes.length !== entry.byteLength || sha256Hex(bytes) !== entry.sha256)
    throw new Error(`${TENMIN_DAY_SHA_MISMATCH}:${key}`);
  return decodeReplyDust(bytes, backend);
}

export interface WriteTenMinDayTop50AddOnInput {
  sessionDate: string;
  picksBase: PicksBaseV1;
  picksTop50: PicksTop50V1;
  /** New top50-only securities (already in base seal are skipped). */
  securities: readonly TenMinDaySecurityInput[];
  observedAt: string;
  /**
   * Caller-evaluated Massive 2-year window check. When false, the add-on is refused
   * with TENMIN_DAY_OUTSIDE_WINDOW (day stays absent forever for fetch purposes).
   */
  withinWindow: boolean;
  provider?: string;
  backend?: ReplyDustBackend;
}

/**
 * ADD-ONLY top50 seal for a day whose manifest.json has top50 absent.
 * Writes picks-top50.json + new .rdust objects + manifest-top50.json.
 * Never rewrites manifest.json. Refused outside the 2-year window.
 * Refused when base absence reason is no_forward_scan.
 */
export async function writeTenMinDayTop50AddOn(
  store: ReplyDustStore,
  input: WriteTenMinDayTop50AddOnInput,
): Promise<TenMinDayTop50Manifest> {
  const D = input.sessionDate;
  requireSessionDate(D);
  if (!input.withinWindow) throw new Error(`${TENMIN_DAY_OUTSIDE_WINDOW}:${D}`);

  const base = await readTenMinDayManifestRaw(store, D);
  if (!base) throw new Error(TENMIN_DAY_NOT_SEALED);

  const existingTop = await readTenMinDayTop50ManifestRaw(store, D);
  if (existingTop) return existingTop;

  if (base.top50.state === "present")
    throw new Error(`${TENMIN_DAY_TOP50_ALREADY_PRESENT}:${D}`);
  if (base.top50.reason === "no_forward_scan")
    throw new Error(`${TENMIN_DAY_NO_FORWARD_SCAN}:${D}`);

  const topBytes = picksTop50Bytes(input.picksTop50);
  const picksTop50Sha256 = sha256Hex(topBytes);
  await putImmutableVerified(store, tenMinDayPicksTop50Key(D), topBytes, {
    "rd-schema": TENMIN_DAY_OBJECT_SCHEMA,
    "rd-kind": "picks-top50",
    "rd-session-date": D,
    "rd-sha256": picksTop50Sha256,
  });

  const merged = mergeDailyTenMinPicksV1(input.picksBase, input.picksTop50);
  const already = new Set(base.securities.map((s) => s.securityId));
  const byId = new Map(input.securities.map((s) => [s.securityId, s]));
  const backend = input.backend ?? nodeReplyDustBackend;
  const provider = input.provider ?? "massive";

  const newSecurities: TenMinDaySecurityEntry[] = [];
  for (const pick of merged) {
    if (already.has(pick.securityId)) continue;
    const sec = byId.get(pick.securityId);
    if (!sec) {
      newSecurities.push(
        securityEntryFromPick(D, pick, {
          status: "GAP",
          sha256: "",
          byteLength: 0,
          gapReason: "MISSING_SECURITY_INPUT",
        }),
      );
      continue;
    }
    if (sec.status === "EMPTY") {
      newSecurities.push(
        securityEntryFromPick(D, pick, { status: "EMPTY", sha256: "", byteLength: 0 }),
      );
      continue;
    }
    if (sec.status === "GAP") {
      newSecurities.push(
        securityEntryFromPick(D, pick, {
          status: "GAP",
          sha256: "",
          byteLength: 0,
          gapReason: sec.gapReason ?? "GAP",
        }),
      );
      continue;
    }
    if (!sec.replyBody)
      throw new Error(`TENMIN_DAY_STORED_WITHOUT_BODY:${pick.securityId}`);
    const key = tenMinDayObjectKey(D, pick.securityId, pick.symbol);
    const fileBytes = await encodeAndVerifyExisting(store, key, sec.replyBody, backend, {
      provider,
      sessionDate: D,
      securityId: pick.securityId,
      symbol: pick.symbol,
    });
    newSecurities.push(
      securityEntryFromPick(D, pick, {
        status: "STORED",
        sha256: sha256Hex(fileBytes),
        byteLength: fileBytes.length,
      }),
    );
  }

  const baseManifestBytes = await store.get(tenMinDayManifestKey(D));
  if (!baseManifestBytes) throw new Error(TENMIN_DAY_NOT_SEALED);
  const baseManifestSha256 = sha256Hex(baseManifestBytes);

  const body: Omit<TenMinDayTop50Manifest, "checksum"> = {
    schemaVersion: TENMIN_DAY_TOP50_MANIFEST_SCHEMA,
    ruleVersion: PICK_V1_RULE_VERSION,
    sessionDate: D,
    baseManifestKey: tenMinDayManifestKey(D),
    baseManifestSha256,
    picksTop50Sha256,
    top50: { state: "present" },
    picks: merged,
    securities: newSecurities,
    observedAt: input.observedAt,
  };
  const topManifest: TenMinDayTop50Manifest = {
    ...body,
    checksum: tenMinDayTop50ManifestChecksum(body),
  };
  await putImmutableVerified(
    store,
    tenMinDayTop50ManifestKey(D),
    jsonBytes(topManifest),
    {
      "rd-manifest-checksum": topManifest.checksum,
      "rd-session-date": D,
      "rd-kind": "manifest-top50",
    },
  );
  return topManifest;
}

export interface PicksBacklogOptions {
  /** Candidate session dates (any order); result is oldest-first. */
  days: readonly string[];
  /** Max entries to return. */
  limit: number;
  /** Massive 2-year window predicate (only absent-top50 days inside the window qualify). */
  withinWindow: (sessionDate: string) => boolean;
  /**
   * Whether a FROZEN prediction set now exists for D. Used so not_yet_frozen days
   * re-enter the backlog once the scan freezes.
   */
  hasFrozenPredictions: (sessionDate: string) => boolean | Promise<boolean>;
}

/**
 * Unsealed days, or days sealed with top50 absent/not_yet_frozen once a FROZEN
 * set exists (and within window). Days sealed absent/no_forward_scan NEVER return.
 * Oldest first; capped by limit.
 */
export async function picksBacklog(
  store: ReplyDustStore,
  options: PicksBacklogOptions,
): Promise<TenMinDayBacklogEntry[]> {
  const sorted = [...options.days].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const out: TenMinDayBacklogEntry[] = [];
  for (const D of sorted) {
    if (out.length >= options.limit) break;
    const manifest = await readTenMinDayManifestRaw(store, D);
    if (!manifest) {
      // picks.json without manifest still counts as unsealed / resumable.
      out.push({ sessionDate: D, reason: "UNSEALED" });
      continue;
    }
    const top50Add = await readTenMinDayTop50ManifestRaw(store, D);
    if (top50Add || manifest.top50.state === "present") continue;
    if (manifest.top50.reason === "no_forward_scan") continue;
    // not_yet_frozen: only if FROZEN now exists and still in window.
    if (!(await options.hasFrozenPredictions(D))) continue;
    if (!options.withinWindow(D)) continue;
    out.push({ sessionDate: D, reason: "ABSENT_TOP50" });
  }
  return out;
}

/**
 * Whether sessionDate is inside a sliding `years`-year window ending at `asOf`
 * (inclusive of the asOf calendar date, exclusive of the day before window start).
 * Used by callers to supply `withinWindow` for add-on / backlog.
 */
export function sessionWithinMassiveWindow(
  sessionDate: string,
  asOf: Date,
  years = 2,
): boolean {
  requireSessionDate(sessionDate);
  const asOfUtc = new Date(
    Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate()),
  );
  const start = new Date(asOfUtc);
  start.setUTCFullYear(start.getUTCFullYear() - years);
  const startIso = start.toISOString().slice(0, 10);
  const asOfIso = asOfUtc.toISOString().slice(0, 10);
  return sessionDate >= startIso && sessionDate <= asOfIso;
}

/** Test helper: MemoryObjectClient wrapper that rejects differing overwrites. */
export function immutableReplyDustStore(inner: ReplyDustStore): ReplyDustStore {
  return {
    get: (key) => inner.get(key),
    head: (key) => inner.head(key),
    list: (prefix) => inner.list(prefix),
    async put(key, body, metadata) {
      const existing = await inner.get(key);
      if (existing && !sameBytes(existing, body))
        throw new Error(`${TENMIN_DAY_OBJECT_CORRUPT}:${key}`);
      if (existing && sameBytes(existing, body)) return;
      await inner.put(key, body, metadata);
    },
  };
}
