/**
 * Point-in-time (dated) ticker reference lists for history days.
 *
 * Fetches Massive GET /v3/reference/tickers?date=YYYY-MM-DD (active=true + same params as the
 * security-master pass aside from date), stores every raw page as Reply Dust, then builds the
 * existing ticker-reference-index with asOf = requested date so loadTickerReferenceIndexAsOf
 * can find an index ≤ D.
 *
 * Probe gate (default): only page 1 of 2024-11-01 unless TICKER_INDEX_DATED_FULL === "true".
 * Phase switch: off unless TICKER_INDEX_DATED === "true" (history/host only).
 */

import type { ReplyDustStore } from "./intraday-reply-dust";
import {
  sameBytes,
  sha256Hex,
  storeVerifiedReplyDust,
} from "./intraday-reply-dust";
import {
  MASSIVE_TICKER_PAGE_LIMIT,
  type MassiveMarketProvider,
} from "./massive-provider";
import { inScanGuardWindow } from "./scan-yield";
import {
  REPLY_DUST_FORMAT,
  type ReplyDustBackend,
  decodeReplyDust,
  nodeReplyDustBackend,
} from "./reply-dust";
import {
  type TickerReferenceCapture,
  type TickerReferenceIndexFingerprints,
  tickerReferenceEntriesFromPage,
  writeTickerReferenceIndex,
} from "./ticker-reference-index";

function addCalendarYears(date: string, years: number): string {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) throw new Error("INVALID_SESSION_DATE");
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  const targetYear = year + years;
  const lastDay = new Date(Date.UTC(targetYear, month, 0)).getUTCDate();
  const clampedDay = Math.min(day, lastDay);
  return `${targetYear}-${String(month).padStart(2, "0")}-${String(clampedDay).padStart(2, "0")}`;
}

export const TICKER_REFERENCE_DATED_PREFIX = "permanent/ticker-reference-dated";
export const TICKER_REFERENCE_DATED_MANIFEST_SCHEMA = "ticker-reference-dated-manifest-v1" as const;
export const TICKER_REFERENCE_DATED_OBJECT_CORRUPT = "TICKER_REFERENCE_DATED_OBJECT_CORRUPT" as const;
export const TICKER_INDEX_DATED_PROBE_DATE = "2024-11-01";
export const TICKER_INDEX_DATED_FIRST_MONTH = "2024-11-01";

export function tickerIndexDatedEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.TICKER_INDEX_DATED === "true";
}

/** Full pagination across month starts; anything else is probe-only. */
export function tickerIndexDatedFullEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.TICKER_INDEX_DATED_FULL === "true";
}

export function datedTickerPageFileName(page: number): string {
  if (!Number.isInteger(page) || page < 1) throw new Error("INVALID_DATED_TICKER_PAGE");
  return `page-${String(page).padStart(3, "0")}.rdust`;
}

export function datedTickerDatePrefix(date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) throw new Error("INVALID_SESSION_DATE");
  return `${TICKER_REFERENCE_DATED_PREFIX}/${date}`;
}

export function datedTickerPageKey(date: string, page: number): string {
  return `${datedTickerDatePrefix(date)}/${datedTickerPageFileName(page)}`;
}

export function datedTickerManifestKey(date: string): string {
  return `${datedTickerDatePrefix(date)}/manifest.json`;
}

/** Strip apiKey from a Massive next_url (absolute or path+query). */
export function stripApiKeyFromUrl(urlOrPath: string, baseUrl = "https://api.massive.com"): string {
  const u = new URL(urlOrPath, baseUrl);
  u.searchParams.delete("apiKey");
  // Prefer path+query so stored cursors never embed host secrets; getWithBody accepts this.
  return `${u.pathname}${u.search}`;
}

export function requestContainsApiKey(request: string): boolean {
  return /(?:^|[?&])apiKey=/i.test(request);
}

/** First-of-month dates from firstMonth through the current month, dropping starts older than 2y. */
export function datedTickerMonthStarts(
  now: Date,
  options: { firstMonth?: string } = {},
): string[] {
  const first = options.firstMonth ?? TICKER_INDEX_DATED_FIRST_MONTH;
  if (!/^\d{4}-\d{2}-01$/u.test(first)) throw new Error("INVALID_FIRST_MONTH");
  const today = now.toISOString().slice(0, 10);
  const windowFloor = addCalendarYears(today, -2);
  const currentMonthStart = `${today.slice(0, 7)}-01`;
  const out: string[] = [];
  let y = Number(first.slice(0, 4));
  let m = Number(first.slice(5, 7));
  for (;;) {
    const cursor = `${y}-${String(m).padStart(2, "0")}-01`;
    if (cursor > currentMonthStart) break;
    if (cursor >= windowFloor) out.push(cursor);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

export interface DatedTickerPageEntry {
  page: number;
  relativePath: string;
  key: string;
  request: string;
  fetchedAt: string;
  /** next_url cursor after this page (path+query, no apiKey); absent when last page. */
  nextUrl?: string;
  version: number;
  byteLength: number;
  fileSha256: string;
  replySha256: string;
  replyByteLength: number;
  resultCount: number;
}

export interface DatedTickerDateManifest {
  schemaVersion: typeof TICKER_REFERENCE_DATED_MANIFEST_SCHEMA;
  format: typeof REPLY_DUST_FORMAT;
  provider: string;
  date: string;
  pages: DatedTickerPageEntry[];
  /** True when the last stored page had no next_url. */
  complete: boolean;
  /** Cursor to fetch the next page when !complete (path+query, no apiKey). */
  resumeCursor?: string;
  checksum: string;
}

export const datedTickerManifestChecksum = (
  body: Omit<DatedTickerDateManifest, "checksum">,
): string => sha256Hex(JSON.stringify(body));

export interface DatedTickerFetchResult {
  status: number;
  body: Uint8Array;
  request: string;
  nextUrl?: string;
  fetchedAt: string;
}

export type DatedTickerFetchPage = (options: {
  date: string;
  nextUrl?: string;
}) => Promise<DatedTickerFetchResult>;

export const TICKER_INDEX_DATED_PROBE_TICKER_SAMPLE = 20;

export type MissingFromCurrentMasterReport =
  | { status: "unavailable"; reason: "absent" | "empty" | "unparseable" }
  | { status: "ok"; count: number; sample: string[] };

export type CurrentMasterTickerLoad =
  | { status: "unavailable"; reason: "absent" | "empty" | "unparseable" }
  | { status: "ok"; tickers: Set<string> };

export interface DatedTickerProbeSummary {
  date: string;
  httpStatus: number;
  resultCount: number;
  nextUrlPresent: boolean;
  countsByType: Record<string, number>;
  /** All page-1 tickers (order preserved) for offline compare vs security-master. */
  page1TickerCount: number;
  /** First ~20 tickers from page 1. */
  page1TickersSample: string[];
  /**
   * Offline compare of page-1 tickers vs permanent/security-master.json (no Massive calls).
   * Always present on a probe summary.
   */
  missingFromCurrentMaster: MissingFromCurrentMasterReport;
  /** Heuristic pages/month from page-1 size when incomplete. */
  estimatedPagesPerMonth: number;
  pageKey: string;
  replySha256: string;
  complete: boolean;
}

export interface DatedTickerDateReport {
  date: string;
  status:
    | "PROBE"
    | "SEALED"
    | "ALREADY_SEALED"
    | "PARTIAL"
    | "SKIPPED_WINDOW"
    | "CORRUPT"
    | "FAILED"
    | "SKIPPED_GUARD";
  requests: number;
  pagesStored: number;
  pagesAdopted: number;
  complete: boolean;
  indexAsOf?: string;
  indexSealed?: boolean;
  corruptKey?: string;
  error?: string;
  probe?: DatedTickerProbeSummary;
  fingerprints?: TickerReferenceIndexFingerprints;
}

export interface DatedTickerRunReport {
  schemaVersion: "ticker-reference-dated-run-v1";
  mode: "probe" | "full";
  enabled: boolean;
  datesPlanned: string[];
  dates: DatedTickerDateReport[];
  requests: number;
  yieldedForScan?: string;
  probe?: DatedTickerProbeSummary;
}

/** Concise dated-index section for history R2 report / tenMinHistorySummary / Actions logs. */
export interface DatedTickerRunSummary {
  enabled: boolean;
  mode: "probe" | "full";
  datesPlanned: number;
  firstPlanned?: string;
  lastPlanned?: string;
  sealed: number;
  alreadySealed: number;
  partial: number;
  probe: number;
  skippedWindow: number;
  skippedGuard: number;
  corrupt: number;
  failed: number;
  requests: number;
  dates: Array<{
    date: string;
    status: DatedTickerDateReport["status"];
    requests: number;
    indexAsOf?: string;
    indexSealed?: boolean;
  }>;
  yieldedForScan?: string;
}

export function tenMinDatedTickerSummary(report: DatedTickerRunReport): DatedTickerRunSummary {
  const counts = {
    sealed: 0,
    alreadySealed: 0,
    partial: 0,
    probe: 0,
    skippedWindow: 0,
    skippedGuard: 0,
    corrupt: 0,
    failed: 0,
  };
  for (const d of report.dates) {
    if (d.status === "SEALED") counts.sealed += 1;
    else if (d.status === "ALREADY_SEALED") counts.alreadySealed += 1;
    else if (d.status === "PARTIAL") counts.partial += 1;
    else if (d.status === "PROBE") counts.probe += 1;
    else if (d.status === "SKIPPED_WINDOW") counts.skippedWindow += 1;
    else if (d.status === "SKIPPED_GUARD") counts.skippedGuard += 1;
    else if (d.status === "CORRUPT") counts.corrupt += 1;
    else if (d.status === "FAILED") counts.failed += 1;
  }
  const first = report.datesPlanned[0];
  const last = report.datesPlanned.length
    ? report.datesPlanned[report.datesPlanned.length - 1]
    : undefined;
  return {
    enabled: report.enabled,
    mode: report.mode,
    datesPlanned: report.datesPlanned.length,
    ...(first ? { firstPlanned: first } : {}),
    ...(last ? { lastPlanned: last } : {}),
    ...counts,
    requests: report.requests,
    dates: report.dates.map((d) => ({
      date: d.date,
      status: d.status,
      requests: d.requests,
      ...(d.indexAsOf ? { indexAsOf: d.indexAsOf } : {}),
      ...(d.indexSealed !== undefined ? { indexSealed: d.indexSealed } : {}),
    })),
    ...(report.yieldedForScan ? { yieldedForScan: report.yieldedForScan } : {}),
  };
}

function parseReply(body: Uint8Array): {
  results: unknown[];
  nextUrl?: string;
  countsByType: Record<string, number>;
  tickers: string[];
} {
  const parsed = JSON.parse(new TextDecoder().decode(body)) as {
    results?: unknown;
    next_url?: unknown;
  };
  const results = Array.isArray(parsed.results) ? parsed.results : [];
  const countsByType: Record<string, number> = {};
  const tickers: string[] = [];
  for (const row of results) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const rec = row as Record<string, unknown>;
    const type = typeof rec.type === "string" ? rec.type : "UNKNOWN";
    countsByType[type] = (countsByType[type] ?? 0) + 1;
    if (typeof rec.ticker === "string" && rec.ticker) tickers.push(rec.ticker);
  }
  const next =
    typeof parsed.next_url === "string" && parsed.next_url.length > 0
      ? stripApiKeyFromUrl(parsed.next_url)
      : undefined;
  return {
    results,
    countsByType,
    tickers,
    ...(next ? { nextUrl: next } : {}),
  };
}

/**
 * Read permanent/security-master.json into a ticker set for offline probe compare.
 * Uses SecurityMasterRecord.currentSymbol and every historicalSymbols[].symbol
 * so a renamed name is not counted as missing.
 */
export async function loadCurrentMasterTickerSet(
  store: Pick<ReplyDustStore, "get">,
): Promise<CurrentMasterTickerLoad> {
  const bytes = await store.get("permanent/security-master.json");
  if (!bytes) return { status: "unavailable", reason: "absent" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return { status: "unavailable", reason: "unparseable" };
  }
  const rows = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { securities?: unknown }).securities)
      ? (parsed as { securities: unknown[] }).securities
      : null;
  if (!rows) return { status: "unavailable", reason: "unparseable" };
  if (rows.length === 0) return { status: "unavailable", reason: "empty" };

  const out = new Set<string>();
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const rec = row as {
      currentSymbol?: unknown;
      historicalSymbols?: unknown;
    };
    if (typeof rec.currentSymbol === "string" && rec.currentSymbol) out.add(rec.currentSymbol);
    const hist = rec.historicalSymbols;
    if (Array.isArray(hist)) {
      for (const h of hist) {
        if (!h || typeof h !== "object" || Array.isArray(h)) continue;
        const sym = (h as { symbol?: unknown }).symbol;
        if (typeof sym === "string" && sym) out.add(sym);
      }
    }
  }
  if (out.size === 0) return { status: "unavailable", reason: "empty" };
  return { status: "ok", tickers: out };
}

async function readDateManifest(
  store: Pick<ReplyDustStore, "get">,
  date: string,
): Promise<DatedTickerDateManifest | undefined> {
  const bytes = await store.get(datedTickerManifestKey(date));
  if (!bytes) return undefined;
  const manifest = JSON.parse(new TextDecoder().decode(bytes)) as DatedTickerDateManifest;
  const { checksum, ...body } = manifest;
  if (
    manifest.schemaVersion !== TICKER_REFERENCE_DATED_MANIFEST_SCHEMA ||
    manifest.date !== date ||
    datedTickerManifestChecksum(body) !== checksum
  )
    throw new Error(`${TICKER_REFERENCE_DATED_OBJECT_CORRUPT}:${datedTickerManifestKey(date)}`);
  return manifest;
}

async function writeDateManifest(
  store: ReplyDustStore,
  manifest: Omit<DatedTickerDateManifest, "checksum">,
): Promise<DatedTickerDateManifest> {
  const full: DatedTickerDateManifest = {
    ...manifest,
    checksum: datedTickerManifestChecksum(manifest),
  };
  const key = datedTickerManifestKey(manifest.date);
  const bytes = new TextEncoder().encode(`${JSON.stringify(full, null, 2)}\n`);
  await store.put(key, bytes);
  const stored = await store.get(key);
  if (!stored || !sameBytes(stored, bytes))
    throw new Error(`${TICKER_REFERENCE_DATED_OBJECT_CORRUPT}:${key}:readback`);
  return full;
}

/**
 * Adopt an existing page object if it verifies; throw CORRUPT on mismatch (never overwrite).
 * Returns undefined when the key is absent.
 */
export async function adoptDatedTickerPage(
  store: ReplyDustStore,
  date: string,
  page: number,
  expected?: Pick<DatedTickerPageEntry, "replySha256" | "fileSha256" | "byteLength" | "version">,
  backend: ReplyDustBackend = nodeReplyDustBackend,
): Promise<{ encoded: Uint8Array; reply: Uint8Array } | undefined> {
  const key = datedTickerPageKey(date, page);
  const existing = await store.get(key);
  if (!existing) return undefined;
  let reply: Uint8Array;
  try {
    reply = decodeReplyDust(existing, backend);
  } catch (error) {
    throw new Error(
      `${TICKER_REFERENCE_DATED_OBJECT_CORRUPT}:${key}:decode:${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const fileSha256 = sha256Hex(existing);
  const replySha256 = sha256Hex(reply);
  if (expected) {
    if (
      expected.byteLength !== existing.length ||
      expected.fileSha256 !== fileSha256 ||
      expected.replySha256 !== replySha256 ||
      expected.version !== existing[0]
    )
      throw new Error(`${TICKER_REFERENCE_DATED_OBJECT_CORRUPT}:${key}`);
  }
  return { encoded: existing, reply };
}

async function storeDatedTickerPage(
  store: ReplyDustStore,
  date: string,
  page: number,
  body: Uint8Array,
  meta: { request: string; fetchedAt: string; nextUrl?: string; provider: string },
  backend: ReplyDustBackend = nodeReplyDustBackend,
): Promise<DatedTickerPageEntry> {
  const key = datedTickerPageKey(date, page);
  if (requestContainsApiKey(meta.request)) throw new Error("DATED_TICKER_REQUEST_HAS_API_KEY");
  if (meta.nextUrl && requestContainsApiKey(meta.nextUrl))
    throw new Error("DATED_TICKER_NEXT_URL_HAS_API_KEY");

  const existing = await store.get(key);
  if (existing) {
    // Immutable: identical reply → adopt; different → CORRUPT (never overwrite).
    let decoded: Uint8Array;
    try {
      decoded = decodeReplyDust(existing, backend);
    } catch {
      throw new Error(`${TICKER_REFERENCE_DATED_OBJECT_CORRUPT}:${key}:decode`);
    }
    if (!sameBytes(decoded, body)) throw new Error(`${TICKER_REFERENCE_DATED_OBJECT_CORRUPT}:${key}`);
    const parsed = parseReply(decoded);
    return {
      page,
      relativePath: datedTickerPageFileName(page),
      key,
      request: meta.request,
      fetchedAt: meta.fetchedAt,
      ...(meta.nextUrl || parsed.nextUrl
        ? { nextUrl: meta.nextUrl ?? parsed.nextUrl }
        : {}),
      version: existing[0]!,
      byteLength: existing.length,
      fileSha256: sha256Hex(existing),
      replySha256: sha256Hex(decoded),
      replyByteLength: decoded.length,
      resultCount: parsed.results.length,
    };
  }

  const encoded = await storeVerifiedReplyDust(store, key, body, `dated-ticker:${date}:p${page}`, backend);
  const parsed = parseReply(body);
  return {
    page,
    relativePath: datedTickerPageFileName(page),
    key,
    request: meta.request,
    fetchedAt: meta.fetchedAt,
    ...(meta.nextUrl || parsed.nextUrl ? { nextUrl: meta.nextUrl ?? parsed.nextUrl } : {}),
    version: encoded[0]!,
    byteLength: encoded.length,
    fileSha256: sha256Hex(encoded),
    replySha256: sha256Hex(body),
    replyByteLength: body.length,
    resultCount: parsed.results.length,
  };
}

/** Build a TickerReferenceCapture from stored dated pages only (active pass). */
export async function captureFromDatedTickerPages(
  store: Pick<ReplyDustStore, "get">,
  date: string,
  pages: readonly DatedTickerPageEntry[],
  backend: ReplyDustBackend = nodeReplyDustBackend,
): Promise<TickerReferenceCapture> {
  const entries = [];
  for (const entry of pages) {
    const bytes = await store.get(entry.key);
    if (!bytes) throw new Error(`${TICKER_REFERENCE_DATED_OBJECT_CORRUPT}:${entry.key}:missing`);
    let reply: Uint8Array;
    try {
      reply = decodeReplyDust(bytes, backend);
    } catch (error) {
      throw new Error(
        `${TICKER_REFERENCE_DATED_OBJECT_CORRUPT}:${entry.key}:decode:${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (sha256Hex(reply) !== entry.replySha256 || sha256Hex(bytes) !== entry.fileSha256)
      throw new Error(`${TICKER_REFERENCE_DATED_OBJECT_CORRUPT}:${entry.key}`);
    entries.push(...tickerReferenceEntriesFromPage("active", entry.page, reply));
  }
  return { pages: { active: pages.length, inactive: 0 }, entries };
}

function buildProbeSummary(
  date: string,
  fetch: DatedTickerFetchResult,
  entry: DatedTickerPageEntry,
  complete: boolean,
  master: CurrentMasterTickerLoad,
): DatedTickerProbeSummary {
  const parsed = parseReply(fetch.body);
  const page1TickersSample = parsed.tickers.slice(0, TICKER_INDEX_DATED_PROBE_TICKER_SAMPLE);
  let missingFromCurrentMaster: MissingFromCurrentMasterReport;
  if (master.status !== "ok") {
    missingFromCurrentMaster = { status: "unavailable", reason: master.reason };
  } else {
    const missing = parsed.tickers.filter((t) => !master.tickers.has(t));
    missingFromCurrentMaster = {
      status: "ok",
      count: missing.length,
      sample: missing.slice(0, TICKER_INDEX_DATED_PROBE_TICKER_SAMPLE),
    };
  }
  return {
    date,
    httpStatus: fetch.status,
    resultCount: parsed.results.length,
    nextUrlPresent: !!parsed.nextUrl || !!fetch.nextUrl,
    countsByType: parsed.countsByType,
    page1TickerCount: parsed.tickers.length,
    page1TickersSample,
    missingFromCurrentMaster,
    estimatedPagesPerMonth: complete
      ? 1
      : Math.max(
          2,
          parsed.results.length >= MASSIVE_TICKER_PAGE_LIMIT
            ? Math.ceil(parsed.results.length / MASSIVE_TICKER_PAGE_LIMIT) * 2
            : 2,
        ),
    pageKey: entry.key,
    replySha256: entry.replySha256,
    complete,
  };
}

export interface RunDatedTickerIndexOptions {
  store: ReplyDustStore;
  provider?: Pick<MassiveMarketProvider, "providerName" | "getDatedTickerReferencePage">;
  fetchPage?: DatedTickerFetchPage;
  env?: NodeJS.ProcessEnv;
  now?: Date;
  clock?: () => Date;
  shouldYield?: () => Promise<string | undefined>;
  /** Override month list (tests). */
  monthStarts?: string[];
  providerName?: string;
  backend?: ReplyDustBackend;
}

/**
 * History-chain phase: probe (default) or full dated ticker index build.
 * No-op when TICKER_INDEX_DATED !== "true".
 */
export async function runDatedTickerIndexBuild(
  options: RunDatedTickerIndexOptions,
): Promise<DatedTickerRunReport> {
  const env = options.env ?? process.env;
  const enabled = tickerIndexDatedEnabled(env);
  const full = tickerIndexDatedFullEnabled(env);
  const clock = options.clock ?? (() => new Date());
  const now = options.now ?? clock();
  const providerName =
    options.providerName ?? options.provider?.providerName ?? "massive-stocks";
  const backend = options.backend ?? nodeReplyDustBackend;
  // Default: live clock scan-guard (same windows as picks/history). Callers may add their own;
  // yield if either the default guard or the caller says so.
  const callerYield = options.shouldYield;
  const shouldYield = async (): Promise<string | undefined> => {
    const t = clock();
    if (inScanGuardWindow(t)) return `SCAN_GUARD_WINDOW:${t.toISOString()}`;
    if (callerYield) {
      const pause = await callerYield();
      if (pause) return pause;
    }
    return undefined;
  };

  const empty = (): DatedTickerRunReport => ({
    schemaVersion: "ticker-reference-dated-run-v1",
    mode: full ? "full" : "probe",
    enabled,
    datesPlanned: [],
    dates: [],
    requests: 0,
  });

  if (!enabled) return empty();

  const fetchPage: DatedTickerFetchPage =
    options.fetchPage ??
    (async (opts) => {
      if (!options.provider?.getDatedTickerReferencePage)
        throw new Error("DATED_TICKER_PROVIDER_UNSUPPORTED");
      return options.provider.getDatedTickerReferencePage(opts);
    });

  const masterLoad = await loadCurrentMasterTickerSet(options.store);

  const windowMonths = new Set(datedTickerMonthStarts(now));
  const datesPlanned = full
    ? (options.monthStarts ?? [...windowMonths])
    : [TICKER_INDEX_DATED_PROBE_DATE];

  const reports: DatedTickerDateReport[] = [];
  let requests = 0;
  let yieldedForScan: string | undefined;
  let probeSummary: DatedTickerProbeSummary | undefined;

  for (const date of datesPlanned) {
    const pause = await shouldYield();
    if (pause) {
      yieldedForScan = pause;
      reports.push({
        date,
        status: "SKIPPED_GUARD",
        requests: 0,
        pagesStored: 0,
        pagesAdopted: 0,
        complete: false,
        error: pause,
      });
      break;
    }

    // Always enforce Massive 2-year window (even if monthStarts injects an older date).
    if (full && !windowMonths.has(date)) {
      reports.push({
        date,
        status: "SKIPPED_WINDOW",
        requests: 0,
        pagesStored: 0,
        pagesAdopted: 0,
        complete: false,
      });
      continue;
    }

    try {
      const result = await buildOneDatedDate({
        store: options.store,
        date,
        fetchPage,
        providerName,
        full,
        shouldYield,
        backend,
        masterLoad,
      });
      requests += result.requests;
      if (result.probe) probeSummary = result.probe;
      reports.push(result.report);
      if (result.yieldedForScan) {
        yieldedForScan = result.yieldedForScan;
        break;
      }
      // Probe mode: stop after the probe date.
      if (!full) break;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith(TICKER_REFERENCE_DATED_OBJECT_CORRUPT)) {
        const key = message.slice(TICKER_REFERENCE_DATED_OBJECT_CORRUPT.length + 1).split(":")[0]!;
        reports.push({
          date,
          status: "CORRUPT",
          requests: 0,
          pagesStored: 0,
          pagesAdopted: 0,
          complete: false,
          corruptKey: key,
          error: message,
        });
        continue;
      }
      reports.push({
        date,
        status: "FAILED",
        requests: 0,
        pagesStored: 0,
        pagesAdopted: 0,
        complete: false,
        error: message,
      });
      continue;
    }
  }

  return {
    schemaVersion: "ticker-reference-dated-run-v1",
    mode: full ? "full" : "probe",
    enabled: true,
    datesPlanned,
    dates: reports,
    requests,
    ...(yieldedForScan ? { yieldedForScan } : {}),
    ...(probeSummary ? { probe: probeSummary } : {}),
  };
}

async function buildOneDatedDate(input: {
  store: ReplyDustStore;
  date: string;
  fetchPage: DatedTickerFetchPage;
  providerName: string;
  full: boolean;
  shouldYield: () => Promise<string | undefined>;
  backend: ReplyDustBackend;
  masterLoad: CurrentMasterTickerLoad;
}): Promise<{
  report: DatedTickerDateReport;
  requests: number;
  probe?: DatedTickerProbeSummary;
  yieldedForScan?: string;
}> {
  const { store, date, fetchPage, providerName, full, shouldYield, backend, masterLoad } = input;
  let manifest = await readDateManifest(store, date);
  let pages = manifest ? [...manifest.pages] : [];
  let requests = 0;
  let pagesStored = 0;
  let pagesAdopted = 0;
  let yieldedForScan: string | undefined;
  let lastFetch: DatedTickerFetchResult | undefined;

  // Resume: verify existing pages; never refetch verified ones.
  for (const entry of pages) {
    await adoptDatedTickerPage(store, date, entry.page, entry, backend);
    pagesAdopted += 1;
  }

  // If the dated manifest was already complete, do not rewrite the live ticker
  // reference index (that would rewind asOf when a later FULL run yields early).
  const alreadyComplete = manifest?.complete === true;
  let complete = alreadyComplete;
  let resumeCursor = manifest?.resumeCursor;

  const maxPagesThisRun = full ? Number.MAX_SAFE_INTEGER : 1;

  while (!complete && pages.length < maxPagesThisRun) {
    const pause = await shouldYield();
    if (pause) {
      yieldedForScan = pause;
      break;
    }

    const nextPage = pages.length + 1;
    const existingAdopt = await adoptDatedTickerPage(store, date, nextPage, undefined, backend);
    if (existingAdopt) {
      // Orphan page on disk without manifest entry — adopt from bytes, do not refetch.
      const parsed = parseReply(existingAdopt.reply);
      const entry: DatedTickerPageEntry = {
        page: nextPage,
        relativePath: datedTickerPageFileName(nextPage),
        key: datedTickerPageKey(date, nextPage),
        request: pages[pages.length - 1]?.nextUrl ?? `/v3/reference/tickers?date=${date}`,
        fetchedAt: new Date(0).toISOString(),
        ...(parsed.nextUrl ? { nextUrl: parsed.nextUrl } : {}),
        version: existingAdopt.encoded[0]!,
        byteLength: existingAdopt.encoded.length,
        fileSha256: sha256Hex(existingAdopt.encoded),
        replySha256: sha256Hex(existingAdopt.reply),
        replyByteLength: existingAdopt.reply.length,
        resultCount: parsed.results.length,
      };
      pages.push(entry);
      pagesAdopted += 1;
      complete = !parsed.nextUrl;
      resumeCursor = parsed.nextUrl;
      manifest = await writeDateManifest(store, {
        schemaVersion: TICKER_REFERENCE_DATED_MANIFEST_SCHEMA,
        format: REPLY_DUST_FORMAT,
        provider: providerName,
        date,
        pages,
        complete,
        ...(resumeCursor ? { resumeCursor } : {}),
      });
      continue;
    }

    const fetched = await fetchPage({
      date,
      ...(resumeCursor ? { nextUrl: resumeCursor } : {}),
    });
    lastFetch = fetched;
    requests += 1;
    if (requestContainsApiKey(fetched.request))
      throw new Error("DATED_TICKER_REQUEST_HAS_API_KEY");
    const nextUrl = fetched.nextUrl
      ? stripApiKeyFromUrl(fetched.nextUrl)
      : parseReply(fetched.body).nextUrl;

    const entry = await storeDatedTickerPage(
      store,
      date,
      nextPage,
      fetched.body,
      {
        request: stripApiKeyFromUrl(fetched.request).includes("/v3/")
          ? (() => {
              // fetched.request is already path+query without apiKey from provider
              const r = fetched.request.startsWith("http")
                ? stripApiKeyFromUrl(fetched.request)
                : fetched.request;
              if (requestContainsApiKey(r)) throw new Error("DATED_TICKER_REQUEST_HAS_API_KEY");
              return r;
            })()
          : fetched.request,
        fetchedAt: fetched.fetchedAt,
        ...(nextUrl ? { nextUrl } : {}),
        provider: providerName,
      },
      backend,
    );
    pagesStored += 1;
    pages.push(entry);
    complete = !nextUrl;
    resumeCursor = nextUrl;
    manifest = await writeDateManifest(store, {
      schemaVersion: TICKER_REFERENCE_DATED_MANIFEST_SCHEMA,
      format: REPLY_DUST_FORMAT,
      provider: providerName,
      date,
      pages,
      complete,
      ...(resumeCursor ? { resumeCursor } : {}),
    });
  }

  let probe: DatedTickerProbeSummary | undefined;
  if (!full && pages.length >= 1 && lastFetch) {
    probe = buildProbeSummary(date, lastFetch, pages[0]!, complete, masterLoad);
  } else if (!full && pages.length >= 1) {
    // Resumed probe with page already stored — rebuild summary from stored page.
    const reply = (await adoptDatedTickerPage(store, date, 1, pages[0], backend))!.reply;
    const fakeFetch: DatedTickerFetchResult = {
      status: 200,
      body: reply,
      request: pages[0]!.request,
      ...(pages[0]!.nextUrl ? { nextUrl: pages[0]!.nextUrl } : {}),
      fetchedAt: pages[0]!.fetchedAt,
    };
    probe = buildProbeSummary(date, fakeFetch, pages[0]!, complete, masterLoad);
  }

  // Seal index only on first-time completion. Already-complete dated manifests
  // return ALREADY_SEALED without calling writeTickerReferenceIndex (avoids
  // rewinding the live index when a later FULL run yields after an early month).
  let indexSealed = false;
  let fingerprints: TickerReferenceIndexFingerprints | undefined;
  if (complete && pages.length > 0) {
    if (alreadyComplete) {
      indexSealed = true;
    } else {
      const capture = await captureFromDatedTickerPages(store, date, pages, backend);
      fingerprints = {
        source: "dated-list",
        requestedDate: date,
        pages: pages.map((p) => ({ key: p.key, sha256: p.replySha256 })),
        knownGap: "mid-month-listings-appear-in-next-month-index",
      };
      await writeTickerReferenceIndex(store, capture, {
        provider: providerName,
        asOf: date,
        fingerprints,
      });
      indexSealed = true;
    }
  }

  const status: DatedTickerDateReport["status"] = yieldedForScan
    ? "SKIPPED_GUARD"
    : !full
      ? "PROBE"
      : alreadyComplete && indexSealed
        ? "ALREADY_SEALED"
        : indexSealed
          ? "SEALED"
          : "PARTIAL";

  return {
    report: {
      date,
      status,
      requests,
      pagesStored,
      pagesAdopted,
      complete,
      ...(indexSealed ? { indexAsOf: date, indexSealed: true } : { indexSealed: false }),
      ...(fingerprints ? { fingerprints } : {}),
      ...(probe ? { probe } : {}),
      ...(yieldedForScan ? { error: yieldedForScan } : {}),
    },
    requests,
    ...(probe ? { probe } : {}),
    ...(yieldedForScan ? { yieldedForScan } : {}),
  };
}
