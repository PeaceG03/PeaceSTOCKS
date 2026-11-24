import { readFile, writeFile, rename } from "node:fs/promises";
import { assertSafeStoreFile, prepareSafeStoreFile } from "./store-path";
import type {
  CanonicalDailyBar,
  MarketProvider,
  ProviderSecurityRecord,
  SecurityMasterRecord,
} from "./contracts";
import { checkSealedDailyBarsPack } from "./daily-bars-sidecar";
import {
  dailyBarsFromReply,
  readDailyReplyDustBars,
  readDailyReplyDustManifest,
  writeDailyReplyDust,
} from "./daily-reply-dust";
import { FileReplyDustStore, type ReplyDustStore } from "./intraday-reply-dust";
import {
  MassiveMarketProvider,
  groupedDailySymbolIndex,
  symbolBySecurityIdFor,
} from "./massive-provider";
import { openMarketStore } from "./object-storage";
import { corporateActionCoverageRecords } from "./corporate-action-coverage";
import { REPLY_DUST_FALLBACK_VERSION, type ReplyDustBackend } from "./reply-dust";
import {
  type ZstdVersionProbe,
  assertPinnedZstdForWriting,
  replyDustRunReport,
} from "./reply-dust-pin";
import { MarketStorage, type MarketStore } from "./storage";
import { refreshEligibility, refreshUniverse } from "./universe";
import { US_EQUITY_MARKET_CALENDAR } from "./us-calendar";
import { finalizeDailyPartition } from "./scanner";
import { pointInTimeUniverse } from "./pit-universe";
import { ScanYieldError, createScanYieldCheck } from "./scan-yield";

const STATE_VERSION = "markets-scanner-backfill-v1" as const;
const REOPEN_STATE_VERSION = "markets-scanner-backfill-reopen-v1" as const;
export const MARKET_BACKFILL_PATH_ERROR = "MARKET_BACKFILL_PATH_INVALID";

export interface BackfillState {
  schemaVersion: typeof STATE_VERSION;
  provider: string;
  from: string;
  to: string;
  completedSessions: string[];
  failedSessions: Record<string, string>;
  updatedAt: string;
}

export interface BackfillReopenState {
  schemaVersion: typeof REOPEN_STATE_VERSION;
  provider: string;
  completedSessions: string[];
  failedSessions: Record<string, string>;
  updatedAt: string;
}

export interface BackfillResult {
  provider: string;
  requestedFrom: string;
  requestedTo: string;
  attemptedSessions: string[];
  completedSessions: string[];
  skippedExistingSessions: string[];
  failedSessions: Record<string, string>;
  barsStored: number;
  actionsStored: number;
  stoppedOnError: boolean;
  /** Set when backfill stopped at a session boundary so a scan gets the request budget. */
  yieldedForScan?: string;
  eligibility: Record<string, number>;
  /** Present only with replyDust on: grouped-daily Reply Dust files written by this run. */
  replyDustFilesWritten?: number;
  /** Present only with replyDust on: files written as the raw-zstd fallback (0x81). */
  replyDustFallbackFiles?: number;
  /** Present only with replyDust on: the pinned zstd version the run checked before writing. */
  replyDustZstdVersion?: string;
  /** Run warnings (not failures), e.g. REPLY_DUST_FALLBACK_FILES:<n> when fallback files > 0. */
  warnings?: string[];
  /**
   * Point-in-time membership counts over the attempted sessions (absent when both are 0):
   * name-sessions bound for names INACTIVE in today's master, and tickers dropped as ambiguous.
   */
  survivorship?: { inactiveNameSessions: number; ambiguousSymbolSessions: number };
}

function parseDate(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("INVALID_SESSION_DATE");
  return new Date(`${value}T00:00:00Z`);
}

function dates(from: string, to: string): string[] {
  const start = parseDate(from),
    end = parseDate(to);
  if (start > end) throw new Error("BACKFILL_RANGE_INVALID");
  const result: string[] = [];
  for (const cursor = new Date(start); cursor <= end; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    const date = cursor.toISOString().slice(0, 10);
    if (US_EQUITY_MARKET_CALENDAR.getSession(date).kind !== "CLOSED") result.push(date);
  }
  return result;
}

/** File-path helpers kept for path-safety tests; live backfill uses MarketStore. */
export async function loadBackfillState(
  path: string,
  provider: string,
  from: string,
  to: string,
): Promise<BackfillState> {
  const target = prepareSafeStoreFile(path, MARKET_BACKFILL_PATH_ERROR);
  assertSafeStoreFile(target, MARKET_BACKFILL_PATH_ERROR);
  try {
    const state = JSON.parse(await readFile(target, "utf8")) as BackfillState;
    if (
      state.schemaVersion === STATE_VERSION &&
      state.provider === provider &&
      state.from === from &&
      state.to === to
    )
      return state;
  } catch (error) {
    if (error instanceof Error && error.message === MARKET_BACKFILL_PATH_ERROR) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return {
    schemaVersion: STATE_VERSION,
    provider,
    from,
    to,
    completedSessions: [],
    failedSessions: {},
    updatedAt: new Date().toISOString(),
  };
}

export async function saveBackfillState(path: string, state: BackfillState): Promise<void> {
  const target = prepareSafeStoreFile(path, MARKET_BACKFILL_PATH_ERROR);
  assertSafeStoreFile(target, MARKET_BACKFILL_PATH_ERROR);
  const temporary = `${target}.tmp-${process.pid}`;
  assertSafeStoreFile(temporary, MARKET_BACKFILL_PATH_ERROR);
  await writeFile(
    temporary,
    JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2) + "\n",
    "utf8",
  );
  assertSafeStoreFile(temporary, MARKET_BACKFILL_PATH_ERROR);
  assertSafeStoreFile(target, MARKET_BACKFILL_PATH_ERROR);
  await rename(temporary, target);
  assertSafeStoreFile(target, MARKET_BACKFILL_PATH_ERROR);
}

function providerRecords(
  securities: SecurityMasterRecord[],
  provider: string,
): ProviderSecurityRecord[] {
  return securities.flatMap((security) => {
    const identity = security.providerIdentities.find((item) => item.provider === provider);
    return identity
      ? [
          {
            provider,
            providerSecurityId: identity.providerSecurityId,
            symbol: security.currentSymbol,
            assetType: security.assetType,
            country: security.country,
            exchange: security.exchange,
            active: security.status === "ACTIVE",
            tradable: security.tradable,
            ...(security.fractional === undefined ? {} : { fractional: security.fractional }),
            ...(security.listingDate === undefined ? {} : { listingDate: security.listingDate }),
          },
        ]
      : [];
  });
}

function emptyState(provider: string, from: string, to: string): BackfillState {
  return {
    schemaVersion: STATE_VERSION,
    provider,
    from,
    to,
    completedSessions: [],
    failedSessions: {},
    updatedAt: new Date().toISOString(),
  };
}

async function readProgress(
  storage: MarketStore,
  provider: string,
  from: string,
  to: string,
): Promise<BackfillState> {
  try {
    const raw = (await storage.loadBackfillProgress()) as BackfillState | undefined;
    if (
      raw &&
      raw.schemaVersion === STATE_VERSION &&
      raw.provider === provider &&
      raw.from === from &&
      raw.to === to
    )
      return raw;
  } catch {
    // Treat corrupt or missing progress as a fresh range.
  }
  return emptyState(provider, from, to);
}

async function writeProgress(storage: MarketStore, state: BackfillState): Promise<void> {
  await storage.saveBackfillProgress({ ...state, updatedAt: new Date().toISOString() });
}

function emptyReopenState(provider: string): BackfillReopenState {
  return {
    schemaVersion: REOPEN_STATE_VERSION,
    provider,
    completedSessions: [],
    failedSessions: {},
    updatedAt: new Date().toISOString(),
  };
}

async function readReopenProgress(storage: MarketStore, provider: string): Promise<BackfillReopenState> {
  try {
    const raw = (await storage.loadBackfillReopenProgress?.()) as BackfillReopenState | undefined;
    if (
      raw &&
      raw.schemaVersion === REOPEN_STATE_VERSION &&
      raw.provider === provider &&
      Array.isArray(raw.completedSessions) &&
      raw.failedSessions &&
      typeof raw.failedSessions === "object"
    )
      return raw;
  } catch {
    // Treat corrupt or missing reopen progress as fresh.
  }
  return emptyReopenState(provider);
}

async function writeReopenProgress(storage: MarketStore, state: BackfillReopenState): Promise<void> {
  await storage.saveBackfillReopenProgress?.({ ...state, updatedAt: new Date().toISOString() });
}

/** PEACESTOCKS_REQUIRE_OBJECT_STORE: unset/""/"0" -> off, "1" -> on; anything else throws (a typo must not turn the requirement off). */
export function backfillRequiresObjectStore(value: string | undefined): boolean {
  const s = value?.trim() ?? "";
  if (s === "" || s === "0") return false;
  if (s === "1") return true;
  throw new Error(`PEACESTOCKS_REQUIRE_OBJECT_STORE_INVALID:${JSON.stringify(s.slice(0, 20))}`);
}

function requireObjectStore(env: NodeJS.ProcessEnv): void {
  if (backfillRequiresObjectStore(env.PEACESTOCKS_REQUIRE_OBJECT_STORE) && !env.PEACESTOCKS_R2_BUCKET?.trim()) {
    throw new Error("OBJECT_STORE_REQUIRED");
  }
}

export async function backfillHistoricalEvidence(options: {
  root: string;
  from: string;
  to: string;
  provider?: MarketProvider;
  maxSessions?: number;
  storage?: MarketStore;
  env?: NodeJS.ProcessEnv;
  /** Asked before starting and before every session; a reason stops at the session boundary. */
  shouldYield?: () => Promise<string | undefined>;
  /**
   * Off by default. When on, each session's whole grouped-daily reply is also stored as a Reply
   * Dust file under permanent/daily-reply-dust/ before its bars are stored. A given provider must
   * keep raw replies (MassiveMarketProvider keepRawReplies: true).
   */
  replyDust?: boolean;
  /** Where Reply Dust files go. Defaults to the local root only when storage is local. */
  replyDustStore?: ReplyDustStore;
  replyDustBackend?: ReplyDustBackend;
  /** Tests inject this; production asks the zstd program. */
  zstdVersionProbe?: ZstdVersionProbe;
  /** Opt-in: revisit already-stored sessions using point-in-time ACTIVE+INACTIVE universe. */
  reopenInactiveTails?: boolean;
  /** Called immediately when a session is attempted (including Dust-cached reopen sessions). */
  onSessionAttempt?: () => void;
}): Promise<BackfillResult> {
  const env = options.env ?? process.env;
  requireObjectStore(env);
  const replyDust = options.replyDust === true;
  // Checked once per run, before anything is fetched or written.
  const replyDustZstdVersion = replyDust
    ? assertPinnedZstdForWriting(options.zstdVersionProbe)
    : undefined;
  const provider =
    options.provider ?? new MassiveMarketProvider(replyDust ? { keepRawReplies: true } : {});
  if (replyDust && !provider.takeRawReplies) throw new Error("REPLY_DUST_PROVIDER_KEEPS_NO_REPLIES");
  const storage = options.storage ?? openMarketStore(options.root, env);
  const replyStore = !replyDust
    ? undefined
    : (options.replyDustStore ??
      (storage instanceof MarketStorage ? new FileReplyDustStore(options.root) : undefined));
  if (replyDust && !replyStore) throw new Error("REPLY_DUST_STORE_REQUIRED");
  let replyDustFilesWritten = 0;
  let replyDustFallbackFiles = 0;
  await storage.initialize();
  const reopenInactiveTails = options.reopenInactiveTails === true;
  const allSessions = dates(options.from, options.to);
  const reopenState = reopenInactiveTails ? await readReopenProgress(storage, provider.providerName) : undefined;
  const reopenCompleted = new Set(reopenState?.completedSessions ?? []);
  if (reopenInactiveTails && allSessions.length > 0 && allSessions.every((d) => reopenCompleted.has(d))) {
    return {
      provider: provider.providerName,
      requestedFrom: options.from,
      requestedTo: options.to,
      attemptedSessions: [],
      completedSessions: [],
      skippedExistingSessions: allSessions,
      failedSessions: {},
      barsStored: 0,
      actionsStored: 0,
      stoppedOnError: false,
      eligibility: {},
    };
  }
  // On Actions the scan always wins the Massive budget; local/test runs opt in via shouldYield.
  const shouldYield =
    options.shouldYield ??
    (env.GITHUB_ACTIONS === "true" ? createScanYieldCheck({ env }) : async () => undefined);
  const yieldedBeforeSessions = (reason: string): BackfillResult => ({
    provider: provider.providerName,
    requestedFrom: options.from,
    requestedTo: options.to,
    attemptedSessions: [],
    completedSessions: [],
    skippedExistingSessions: [],
    failedSessions: {},
    barsStored: 0,
    actionsStored: 0,
    stoppedOnError: false,
    yieldedForScan: reason,
    eligibility: {},
  });
  const startYield = await shouldYield();
  if (startYield) return yieldedBeforeSessions(startYield);

  // Cold start: build the security master before grouped-daily can bind symbols. The yield check
  // also runs at every ticker-list page boundary; stopping there discards the partial list, so
  // the stored master is never compared against half the provider universe.
  try {
    await refreshUniverse(provider, storage, options.to, { shouldStop: shouldYield });
  } catch (error) {
    if (error instanceof ScanYieldError) return yieldedBeforeSessions(error.reason);
    throw error;
  }
  let securities = await storage.loadSecurities();
  const bind = (
    provider as MarketProvider & { bindUniverse?: (records: ProviderSecurityRecord[]) => void }
  ).bindUniverse;
  if (bind) bind.call(provider, providerRecords(securities, provider.providerName));

  const state = reopenInactiveTails ? undefined : await readProgress(storage, provider.providerName, options.from, options.to);
  const sessions = reopenInactiveTails
    ? allSessions
    : allSessions.slice(0, options.maxSessions ?? Number.MAX_SAFE_INTEGER);
  const attemptedSessions: string[] = [],
    completedSessions: string[] = [],
    skippedExistingSessions: string[] = [];
  const failedSessions: Record<string, string> = { ...(reopenInactiveTails ? reopenState!.failedSessions : state!.failedSessions) };
  let barsStored = 0,
    actionsStored = 0,
    stoppedOnError = false,
    yieldedForScan: string | undefined;
  // Survivorship: each session is bound to the names listed ON THAT DATE (ACTIVE and INACTIVE, with
  // the ticker each held then), not to today's ACTIVE names. See src/pit-universe.ts.
  let inactiveNameSessions = 0,
    ambiguousSymbolSessions = 0;
  const membersOn = (sessionDate: string) => {
    const pit = pointInTimeUniverse(securities, sessionDate, provider.providerName);
    inactiveNameSessions += pit.inactiveMembers;
    ambiguousSymbolSessions += pit.ambiguousSymbols;
    if (bind) bind.call(provider, pit.records);
    return pit;
  };

  // Reply Dust: the grouped reply is taken right after its one fetch and stored (encode, decode,
  // compare, put, read back) before any bar of that session is stored or progress advances. A
  // day already sealed in Reply Dust is rebuilt from the stored reply instead of fetched again.
  const dailyBarsWithReplyDust = async (
    sessionDate: string,
    memberIds: string[],
    records: ProviderSecurityRecord[],
  ): Promise<CanonicalDailyBar[]> => {
    const store = replyStore!;
    const bySymbol = groupedDailySymbolIndex(symbolBySecurityIdFor(records), memberIds);
    if (await readDailyReplyDustManifest(store, sessionDate))
      return readDailyReplyDustBars(store, sessionDate, bySymbol, options.replyDustBackend);
    const takeRawReplies = provider.takeRawReplies!.bind(provider);
    if (takeRawReplies().length) throw new Error("REPLY_DUST_UNEXPECTED_HELD_REPLIES");
    const bars = await provider.getDailyBars(sessionDate, memberIds);
    const replies = takeRawReplies();
    const reply = replies[0];
    if (
      replies.length !== 1 ||
      !reply ||
      reply.dataset !== "stocks-grouped-daily" ||
      reply.sessionDate !== sessionDate
    )
      throw new Error(`REPLY_DUST_REPLY_MISSING_OR_UNEXPECTED:${sessionDate}:${replies.length}`);
    // observedAt is stamped by the provider on every bar; with no matching bar, keep fetchedAt.
    const observedAt = bars[0]?.observedAt ?? reply.fetchedAt;
    const rebuilt = dailyBarsFromReply({
      provider: provider.providerName,
      sessionDate,
      observedAt,
      reply: reply.body,
      bySymbol,
    });
    if (JSON.stringify(rebuilt) !== JSON.stringify(bars))
      throw new Error(`REPLY_DUST_DAILY_REBUILD_MISMATCH:${sessionDate}`);
    const manifest = await writeDailyReplyDust(
      store,
      reply,
      { provider: provider.providerName, observedAt },
      options.replyDustBackend,
    );
    replyDustFilesWritten += 1;
    if (manifest.version === REPLY_DUST_FALLBACK_VERSION) replyDustFallbackFiles += 1;
    return bars;
  };

  for (const sessionDate of sessions) {
    if (reopenInactiveTails) {
      if (reopenCompleted.has(sessionDate)) {
        skippedExistingSessions.push(sessionDate);
        continue;
      }
      if (options.maxSessions !== undefined && attemptedSessions.length >= options.maxSessions) {
        yieldedForScan = "JOB_MAX_SESSIONS_REACHED";
        break;
      }
    } else {
      if (state!.completedSessions.includes(sessionDate)) {
        skippedExistingSessions.push(sessionDate);
        continue;
      }
    }
    const existing = await storage.loadBars(sessionDate);
    if (!reopenInactiveTails && existing.length > 0) {
      state!.completedSessions = [...new Set([...state!.completedSessions, sessionDate])].sort();
      skippedExistingSessions.push(sessionDate);
      await writeProgress(storage, state!);
      continue;
    }
    yieldedForScan = await shouldYield();
    if (yieldedForScan) break;
    if (reopenInactiveTails && replyStore) {
      const sealed = await checkSealedDailyBarsPack({
        store: replyStore,
        sessionDate,
        storedRows: existing,
        ...(options.replyDustBackend ? { backend: options.replyDustBackend } : {}),
      });
      if (sealed.state === "conflict") {
        failedSessions[sessionDate] = `REOPEN_PACK_CONFLICT:${sealed.reason}`;
        stoppedOnError = true;
        await writeReopenProgress(storage, { ...reopenState!, failedSessions });
        break;
      }
    }
    options.onSessionAttempt?.();
    attemptedSessions.push(sessionDate);
    try {
      const members = membersOn(sessionDate);
      const memberIds = members.memberIds;
      const bars = replyDust
        ? await dailyBarsWithReplyDust(sessionDate, memberIds, members.records)
        : await provider.getDailyBars(sessionDate, memberIds);
      let rowsWritten = bars.length;
      if (reopenInactiveTails) {
        const existingKeys = new Set(existing.map((b) => `${b.securityId}|${b.sessionDate}|${b.revision}`));
        const newBars = bars.filter((b) => !existingKeys.has(`${b.securityId}|${b.sessionDate}|${b.revision}`));
        rowsWritten = newBars.length;
        if (newBars.length > 0) {
          await storage.appendBars(newBars);
          barsStored += newBars.length;
        }
      } else {
        await storage.appendBars(bars);
        barsStored += bars.length;
      }
      try {
        const actions = await provider.getCorporateActions(sessionDate, memberIds);
        await storage.appendActions(actions);
        actionsStored += actions.length;
        await storage
          .recordCorporateActionCoverage?.(
            corporateActionCoverageRecords([sessionDate], actions, {
              provider: provider.providerName,
              source: "backfill",
              recordedAt: new Date().toISOString(),
            }),
          )
          .catch((error: unknown) => console.warn(`CORPORATE_ACTION_COVERAGE_WRITE_FAILED:${sessionDate}:${String(error)}`));
      } catch (error) {
        const message = String(error);
        if (message.includes("PROVIDER_NOT_READY") || message.includes("MASSIVE_CREDENTIAL_REJECTED"))
          throw error;
        failedSessions[`${sessionDate}:corporate-actions`] = message;
      }
      await finalizeDailyPartition(
        storage,
        sessionDate,
        provider.providerName,
        existing.length + rowsWritten ? "GOOD" : "PARTIAL_RUN",
      );
      delete failedSessions[sessionDate];
      completedSessions.push(sessionDate);
      if (reopenInactiveTails) {
        reopenState!.completedSessions = [...new Set([...reopenState!.completedSessions, sessionDate])].sort();
        reopenCompleted.add(sessionDate);
        await writeReopenProgress(storage, { ...reopenState!, failedSessions });
      } else {
        state!.completedSessions = [...new Set([...state!.completedSessions, sessionDate])].sort();
        await writeProgress(storage, { ...state!, failedSessions });
      }
    } catch (error) {
      const message = String(error);
      failedSessions[sessionDate] = message;
      stoppedOnError = true;
      if (reopenInactiveTails) await writeReopenProgress(storage, { ...reopenState!, failedSessions });
      else await writeProgress(storage, { ...state!, failedSessions });
      break;
    }
  }
  securities = await refreshEligibility(storage);
  const eligibility = securities.reduce<Record<string, number>>(
    (counts, security) => ({
      ...counts,
      [security.eligibility]: (counts[security.eligibility] ?? 0) + 1,
    }),
    {},
  );
  return {
    provider: provider.providerName,
    requestedFrom: options.from,
    requestedTo: options.to,
    attemptedSessions,
    completedSessions,
    skippedExistingSessions,
    failedSessions,
    barsStored,
    actionsStored,
    stoppedOnError,
    ...(yieldedForScan ? { yieldedForScan } : {}),
    eligibility,
    ...(replyDustZstdVersion
      ? replyDustRunReport(replyDustFilesWritten, replyDustFallbackFiles, replyDustZstdVersion)
      : {}),
    ...(inactiveNameSessions || ambiguousSymbolSessions
      ? { survivorship: { inactiveNameSessions, ambiguousSymbolSessions } }
      : {}),
  };
}

// `pnpm backfill` (the workflow's backfill mode) runs src/backfill-job-cli.ts: the resumable,
// sha-checked backfill job. This module is the library it drives; running it directly is refused so
// nothing can backfill without the per-session verification.
if (process.argv[1]?.endsWith("backfill.ts")) throw new Error("BACKFILL_ENTRY_MOVED:use pnpm backfill (src/backfill-job-cli.ts)");
