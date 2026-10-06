// Daily scan: when SCAN_GROUPED_REPLY_DUST=true, store the already-fetched grouped-daily reply as
// Reply Dust (zero extra Massive requests). First verified copy is always
// permanent/daily-reply-dust/YYYY-MM-DD/grouped-daily.rdust; later replies with different raw bytes
// are stored beside it as grouped-daily-<sha256>.rdust. Never overwrite or delete. Failures are
// warnings only — the scan's normal result is unchanged.

import type { ProviderRawReply } from "./contracts";
import {
  DAILY_REPLY_DUST_FILE_NAME,
  DAILY_REPLY_DUST_OBJECT_SCHEMA,
  type DailyReplyDustCopyEntry,
  type DailyReplyDustManifest,
  dailyReplyDustFileKey,
  dailyReplyDustHashedFileKey,
  dailyReplyDustHashedFileName,
  dailyReplyDustManifestChecksum,
  dailyReplyDustManifestKey,
  readDailyReplyDustManifest,
  readDailyReplyDustReply,
  writeDailyReplyDust,
} from "./daily-reply-dust";
import {
  type ReplyDustStore,
  sameBytes,
  sha256Hex,
  storeVerifiedReplyDust,
} from "./intraday-reply-dust";
import { type ReplyDustBackend, decodeReplyDust, nodeReplyDustBackend } from "./reply-dust";
import { type ZstdVersionProbe, assertPinnedZstdForWriting } from "./reply-dust-pin";

export const SCAN_GROUPED_REPLY_DUST_ENV = "SCAN_GROUPED_REPLY_DUST" as const;
export const SCAN_GROUPED_REPLY_DUST_WRITE_FAILED = "SCAN_GROUPED_REPLY_DUST_WRITE_FAILED" as const;
export const SCAN_GROUPED_REPLY_DUST_COMPARE_FAILED = "SCAN_GROUPED_REPLY_DUST_COMPARE_FAILED" as const;
export const SCAN_GROUPED_REPLY_DUST_DECODE_FAILED = "SCAN_GROUPED_REPLY_DUST_DECODE_FAILED" as const;
export const SCAN_GROUPED_REPLY_DUST_HASH_CONFLICT = "SCAN_GROUPED_REPLY_DUST_HASH_CONFLICT" as const;

export type ScanGroupedReplyDustCopyStatus = "stored" | "reused" | "warning";

export interface ScanGroupedReplyDustCopyReport {
  key: string;
  sha256: string;
  status: ScanGroupedReplyDustCopyStatus;
  /** Present on every copy after the first (canonical). */
  resultsMatchFirst?: boolean;
  resultsDiffSummary?: string;
  warning?: string;
}

export interface ScanGroupedReplyDustReport {
  enabled: boolean;
  reason?: string;
  sessionDate?: string;
  /** Always 0 when this path runs: the scan reuses getDailyBars' reply bytes. */
  extraMassiveRequests: 0;
  copies: ScanGroupedReplyDustCopyReport[];
  warnings: string[];
}

export function scanGroupedReplyDustEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[SCAN_GROUPED_REPLY_DUST_ENV] === "true";
}

export function disabledScanGroupedReplyDustReport(reason: string): ScanGroupedReplyDustReport {
  return { enabled: false, reason, extraMassiveRequests: 0, copies: [], warnings: [] };
}

function parseJsonObject(bytes: Uint8Array): Record<string, unknown> {
  const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("MASSIVE_INVALID_RESPONSE");
  return parsed as Record<string, unknown>;
}

function retrievalIdOf(reply: ProviderRawReply): string {
  const requestId = parseJsonObject(reply.body).request_id;
  return typeof requestId === "string" && requestId.length > 0
    ? requestId
    : `grouped-${reply.sessionDate}`;
}

function copyKey(sessionDate: string, relativePath: string): string {
  return dailyReplyDustFileKey(sessionDate).replace(DAILY_REPLY_DUST_FILE_NAME, relativePath);
}

/**
 * Pure: compare two grouped-daily reply bodies with request_id removed. Summarises result-count
 * and ticker-set differences when they do not match.
 */
export function compareGroupedResultsIgnoringRequestId(
  first: Uint8Array,
  other: Uint8Array,
): { match: boolean; summary?: string } {
  try {
    const a = parseJsonObject(first);
    const b = parseJsonObject(other);
    delete a.request_id;
    delete b.request_id;
    if (JSON.stringify(a) === JSON.stringify(b)) return { match: true };
    const aResults = Array.isArray(a.results) ? a.results : [];
    const bResults = Array.isArray(b.results) ? b.results : [];
    if (aResults.length !== bResults.length)
      return { match: false, summary: `counts differ:${aResults.length}->${bResults.length}` };
    const ticker = (row: unknown): string =>
      row && typeof row === "object" && !Array.isArray(row) && typeof (row as { T?: unknown }).T === "string"
        ? (row as { T: string }).T
        : "";
    const aMap = new Map(aResults.map((row) => [ticker(row), JSON.stringify(row)]));
    const bMap = new Map(bResults.map((row) => [ticker(row), JSON.stringify(row)]));
    let changed = 0;
    for (const [sym, body] of bMap) if (aMap.get(sym) !== body) changed += 1;
    for (const sym of aMap.keys()) if (!bMap.has(sym)) changed += 1;
    return { match: false, summary: `${changed} tickers changed` };
  } catch (error) {
    return {
      match: false,
      summary: `${SCAN_GROUPED_REPLY_DUST_COMPARE_FAILED}:${String(error).slice(0, 80)}`,
    };
  }
}

async function putManifest(store: ReplyDustStore, body: Omit<DailyReplyDustManifest, "checksum">): Promise<void> {
  const manifest: DailyReplyDustManifest = {
    ...body,
    checksum: dailyReplyDustManifestChecksum(body),
  };
  const bytes = new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);
  const key = dailyReplyDustManifestKey(manifest.sessionDate);
  await store.put(key, bytes);
  const stored = await store.get(key);
  if (!stored || !sameBytes(stored, bytes)) throw new Error("REPLY_DUST_MANIFEST_READBACK_MISMATCH");
}

async function writeHashedCopy(
  store: ReplyDustStore,
  reply: ProviderRawReply,
  options: { provider: string; observedAt: string },
  backend: ReplyDustBackend,
): Promise<{ key: string; entry: DailyReplyDustCopyEntry }> {
  const replySha256 = sha256Hex(reply.body);
  const key = dailyReplyDustHashedFileKey(reply.sessionDate, replySha256);
  const retrievalId = retrievalIdOf(reply);
  const encoded = await storeVerifiedReplyDust(
    store,
    key,
    reply.body,
    `grouped-daily-hash:${reply.sessionDate}:${replySha256.slice(0, 12)}`,
    backend,
    (bytes) => ({
      "rd-schema": DAILY_REPLY_DUST_OBJECT_SCHEMA,
      "rd-provider": options.provider,
      "rd-session-date": reply.sessionDate,
      "rd-dataset": "stocks-grouped-daily",
      "rd-request": reply.request,
      "rd-fetched-at": reply.fetchedAt,
      "rd-observed-at": options.observedAt,
      "rd-retrieval-id": retrievalId,
      "rd-version": String(bytes[0]),
      "rd-reply-sha256": replySha256,
      "rd-reply-length": String(reply.body.length),
    }),
  );
  return {
    key,
    entry: {
      relativePath: dailyReplyDustHashedFileName(replySha256),
      request: reply.request,
      fetchedAt: reply.fetchedAt,
      retrievalId,
      version: encoded[0]!,
      byteLength: encoded.length,
      fileSha256: sha256Hex(encoded),
      replySha256,
      replyByteLength: reply.body.length,
    },
  };
}

/**
 * List every copy for the day. Every non-first copy always gets resultsMatchFirst (and
 * resultsDiffSummary when false) by decoding its stored bytes against the canonical reply.
 * Decode failures become warnings and do not fail the scan.
 */
async function listCopies(
  store: ReplyDustStore,
  sessionDate: string,
  manifest: DailyReplyDustManifest,
  highlight: ScanGroupedReplyDustCopyReport | undefined,
  firstReply: Uint8Array | undefined,
  backend: ReplyDustBackend,
  warnings: string[],
  knownReplies: Map<string, Uint8Array>,
): Promise<ScanGroupedReplyDustCopyReport[]> {
  const copies: ScanGroupedReplyDustCopyReport[] = [];
  const canonicalKey = dailyReplyDustFileKey(sessionDate);
  copies.push(
    highlight?.key === canonicalKey
      ? highlight
      : { key: canonicalKey, sha256: manifest.replySha256, status: "reused" },
  );
  for (const entry of manifest.copies ?? []) {
    const key = copyKey(sessionDate, entry.relativePath);
    if (highlight?.key === key) {
      // Highlight already carries resultsMatchFirst from the store path; still ensure it is set.
      const h = { ...highlight };
      if (h.resultsMatchFirst === undefined && firstReply) {
        const other = knownReplies.get(key);
        if (other) {
          const cmp = compareGroupedResultsIgnoringRequestId(firstReply, other);
          h.resultsMatchFirst = cmp.match;
          if (!cmp.match && cmp.summary) h.resultsDiffSummary = cmp.summary;
        }
      }
      copies.push(h);
      continue;
    }
    const report: ScanGroupedReplyDustCopyReport = {
      key,
      sha256: entry.replySha256,
      status: "reused",
    };
    let other = knownReplies.get(key);
    if (!other) {
      try {
        const encoded = await store.get(key);
        if (!encoded) throw new Error("FILE_MISSING");
        other = decodeReplyDust(encoded, backend);
        knownReplies.set(key, other);
      } catch (error) {
        const warning = `${SCAN_GROUPED_REPLY_DUST_DECODE_FAILED}:${key}:${String(error).slice(0, 80)}`;
        warnings.push(warning);
        report.resultsMatchFirst = false;
        report.resultsDiffSummary = `decode-failed`;
        report.warning = warning;
        report.status = "warning";
        copies.push(report);
        continue;
      }
    }
    if (firstReply) {
      const cmp = compareGroupedResultsIgnoringRequestId(firstReply, other);
      report.resultsMatchFirst = cmp.match;
      if (!cmp.match && cmp.summary) report.resultsDiffSummary = cmp.summary;
    } else {
      report.resultsMatchFirst = false;
      report.resultsDiffSummary = "first-reply-unavailable";
    }
    copies.push(report);
  }
  if (highlight && !copies.some((c) => c.key === highlight.key)) {
    const h = { ...highlight };
    if (h.resultsMatchFirst === undefined) {
      h.resultsMatchFirst = false;
      h.resultsDiffSummary = h.resultsDiffSummary ?? "first-reply-unavailable";
    }
    copies.push(h);
  }
  return copies;
}

/**
 * Store (or reuse) the scan's already-fetched grouped-daily reply. Never fetches Massive.
 */
export async function storeScanGroupedReplyDust(options: {
  store: ReplyDustStore;
  reply: ProviderRawReply;
  provider: string;
  observedAt?: string;
  backend?: ReplyDustBackend;
  zstdVersionProbe?: ZstdVersionProbe;
}): Promise<ScanGroupedReplyDustReport> {
  const warnings: string[] = [];
  const backend = options.backend ?? nodeReplyDustBackend;
  const reply = options.reply;
  if (reply.dataset !== "stocks-grouped-daily") {
    return {
      enabled: true,
      reason: "NOT_GROUPED_DAILY_REPLY",
      sessionDate: reply.sessionDate,
      extraMassiveRequests: 0,
      copies: [],
      warnings: [`${SCAN_GROUPED_REPLY_DUST_WRITE_FAILED}:NOT_GROUPED_DAILY_REPLY`],
    };
  }
  assertPinnedZstdForWriting(options.zstdVersionProbe);
  const observedAt = options.observedAt ?? reply.fetchedAt;
  const replySha256 = sha256Hex(reply.body);
  const canonicalKey = dailyReplyDustFileKey(reply.sessionDate);
  let manifest = await readDailyReplyDustManifest(options.store, reply.sessionDate);

  if (!manifest) {
    await writeDailyReplyDust(
      options.store,
      reply,
      { provider: options.provider, observedAt },
      backend,
    );
    return {
      enabled: true,
      sessionDate: reply.sessionDate,
      extraMassiveRequests: 0,
      copies: [{ key: canonicalKey, sha256: replySha256, status: "stored" }],
      warnings,
    };
  }

  let firstReply: Uint8Array | undefined;
  try {
    firstReply = await readDailyReplyDustReply(options.store, manifest, backend);
  } catch (error) {
    warnings.push(
      `${SCAN_GROUPED_REPLY_DUST_DECODE_FAILED}:${canonicalKey}:${String(error).slice(0, 120)}`,
    );
  }

  if (manifest.replySha256 === replySha256 || (firstReply !== undefined && sameBytes(firstReply, reply.body))) {
    return {
      enabled: true,
      sessionDate: reply.sessionDate,
      extraMassiveRequests: 0,
      copies: await listCopies(
        options.store,
        reply.sessionDate,
        manifest,
        undefined,
        firstReply,
        backend,
        warnings,
        new Map(firstReply ? [[canonicalKey, firstReply]] : []),
      ),
      warnings,
    };
  }

  const hashedKey = dailyReplyDustHashedFileKey(reply.sessionDate, replySha256);
  const cmpToFirst = firstReply
    ? compareGroupedResultsIgnoringRequestId(firstReply, reply.body)
    : { match: false as boolean, summary: "first-reply-unavailable" };
  const matchFields = {
    resultsMatchFirst: cmpToFirst.match,
    ...(cmpToFirst.match || !cmpToFirst.summary ? {} : { resultsDiffSummary: cmpToFirst.summary }),
  };
  const replyByKey = new Map<string, Uint8Array>();
  if (firstReply) replyByKey.set(canonicalKey, firstReply);

  let highlight: ScanGroupedReplyDustCopyReport;
  try {
    const existingEncoded = await options.store.get(hashedKey);
    if (existingEncoded) {
      let decoded: Uint8Array;
      try {
        decoded = decodeReplyDust(existingEncoded, backend);
      } catch (error) {
        const warning = `${SCAN_GROUPED_REPLY_DUST_DECODE_FAILED}:${hashedKey}:${String(error).slice(0, 80)}`;
        warnings.push(warning);
        highlight = { key: hashedKey, sha256: replySha256, status: "warning", ...matchFields, warning };
        return {
          enabled: true,
          sessionDate: reply.sessionDate,
          extraMassiveRequests: 0,
          copies: await listCopies(
            options.store,
            reply.sessionDate,
            manifest,
            highlight,
            firstReply,
            backend,
            warnings,
            replyByKey,
          ),
          warnings,
        };
      }
      if (sameBytes(decoded, reply.body)) {
        highlight = { key: hashedKey, sha256: replySha256, status: "reused", ...matchFields };
        replyByKey.set(hashedKey, decoded);
        if (!(manifest.copies ?? []).some((c) => c.replySha256 === replySha256)) {
          const entry: DailyReplyDustCopyEntry = {
            relativePath: dailyReplyDustHashedFileName(replySha256),
            request: reply.request,
            fetchedAt: reply.fetchedAt,
            retrievalId: retrievalIdOf(reply),
            version: existingEncoded[0]!,
            byteLength: existingEncoded.length,
            fileSha256: sha256Hex(existingEncoded),
            replySha256,
            replyByteLength: reply.body.length,
          };
          const { checksum: _c, ...body } = manifest;
          const next = { ...body, copies: [...(manifest.copies ?? []), entry] };
          await putManifest(options.store, next);
          manifest = { ...next, checksum: dailyReplyDustManifestChecksum(next) };
        }
      } else {
        const warning = `${SCAN_GROUPED_REPLY_DUST_HASH_CONFLICT}:${hashedKey}`;
        warnings.push(warning);
        highlight = { key: hashedKey, sha256: replySha256, status: "warning", ...matchFields, warning };
      }
    } else {
      const written = await writeHashedCopy(
        options.store,
        reply,
        { provider: options.provider, observedAt },
        backend,
      );
      highlight = { key: written.key, sha256: replySha256, status: "stored", ...matchFields };
      replyByKey.set(written.key, reply.body);
      if (!(manifest.copies ?? []).some((c) => c.replySha256 === replySha256)) {
        const { checksum: _c, ...body } = manifest;
        const next = { ...body, copies: [...(manifest.copies ?? []), written.entry] };
        await putManifest(options.store, next);
        manifest = { ...next, checksum: dailyReplyDustManifestChecksum(next) };
      }
    }
  } catch (error) {
    const warning = `${SCAN_GROUPED_REPLY_DUST_WRITE_FAILED}:${String(error).slice(0, 160)}`;
    warnings.push(warning);
    highlight = { key: hashedKey, sha256: replySha256, status: "warning", ...matchFields, warning };
  }

  return {
    enabled: true,
    sessionDate: reply.sessionDate,
    extraMassiveRequests: 0,
    copies: await listCopies(
      options.store,
      reply.sessionDate,
      manifest,
      highlight,
      firstReply,
      backend,
      warnings,
      replyByKey,
    ),
    warnings,
  };
}

/**
 * After getDailyBars: take the held grouped-daily reply (if any) and store/reuse it. Never throws
 * into the scan — failures become warnings on the returned report.
 */
export async function maybeStoreScanGroupedReplyDust(options: {
  enabled: boolean;
  store?: ReplyDustStore;
  provider: { providerName: string; takeRawReplies?: () => ProviderRawReply[] };
  sessionDate: string;
  backend?: ReplyDustBackend;
  zstdVersionProbe?: ZstdVersionProbe;
}): Promise<ScanGroupedReplyDustReport> {
  if (!options.enabled) return disabledScanGroupedReplyDustReport("SCAN_GROUPED_REPLY_DUST_OFF");
  if (!options.store) {
    return {
      enabled: true,
      reason: "STORE_UNAVAILABLE",
      sessionDate: options.sessionDate,
      extraMassiveRequests: 0,
      copies: [],
      warnings: [`${SCAN_GROUPED_REPLY_DUST_WRITE_FAILED}:STORE_UNAVAILABLE`],
    };
  }
  // Independent of corporate-actions (or other Promise.all siblings): store whenever the provider
  // still holds a verified grouped-daily reply for this session.
  if (!options.provider.takeRawReplies) {
    return {
      enabled: true,
      reason: "PROVIDER_KEEPS_NO_REPLIES",
      sessionDate: options.sessionDate,
      extraMassiveRequests: 0,
      copies: [],
      warnings: [`${SCAN_GROUPED_REPLY_DUST_WRITE_FAILED}:PROVIDER_KEEPS_NO_REPLIES`],
    };
  }
  try {
    const replies = options.provider.takeRawReplies();
    const reply = replies.find(
      (r) => r.dataset === "stocks-grouped-daily" && r.sessionDate === options.sessionDate,
    );
    if (!reply) {
      return {
        enabled: true,
        reason: "NO_GROUPED_REPLY_HELD",
        sessionDate: options.sessionDate,
        extraMassiveRequests: 0,
        copies: [],
        warnings: [],
      };
    }
    return await storeScanGroupedReplyDust({
      store: options.store,
      reply,
      provider: options.provider.providerName,
      ...(options.backend ? { backend: options.backend } : {}),
      ...(options.zstdVersionProbe ? { zstdVersionProbe: options.zstdVersionProbe } : {}),
    });
  } catch (error) {
    return {
      enabled: true,
      reason: "STORE_FAILED",
      sessionDate: options.sessionDate,
      extraMassiveRequests: 0,
      copies: [],
      warnings: [`${SCAN_GROUPED_REPLY_DUST_WRITE_FAILED}:${String(error).slice(0, 160)}`],
    };
  }
}
