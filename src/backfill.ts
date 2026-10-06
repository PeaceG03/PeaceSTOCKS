import { readFile, writeFile, rename } from "node:fs/promises";
import { assertSafeStoreFile, prepareSafeStoreFile } from "./store-path";
import type {
  CanonicalDailyBar,
  MarketProvider,
  ProviderSecurityRecord,
  SecurityMasterRecord,
} from "./contracts";
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
import { ScanYieldError, scanYieldReason } from "./scan-yield";

const STATE_VERSION = "markets-scanner-backfill-v1" as const;
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

function requireObjectStore(env: NodeJS.ProcessEnv): void {
  if (env.PEACESTOCKS_REQUIRE_OBJECT_STORE === "1" && !env.PEACESTOCKS_R2_BUCKET?.trim()) {
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
  // On Actions the scan always wins the Massive budget; local/test runs opt in via shouldYield.
  const shouldYield =
    options.shouldYield ??
    (env.GITHUB_ACTIONS === "true" ? () => scanYieldReason({ env }) : async () => undefined);
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

  const state = await readProgress(storage, provider.providerName, options.from, options.to);
  const sessions = dates(options.from, options.to).slice(
    0,
    options.maxSessions ?? Number.MAX_SAFE_INTEGER,
  );
  const attemptedSessions: string[] = [],
    completedSessions: string[] = [],
    skippedExistingSessions: string[] = [];
  const failedSessions: Record<string, string> = { ...state.failedSessions };
  let barsStored = 0,
    actionsStored = 0,
    stoppedOnError = false,
    yieldedForScan: string | undefined;
  const activeIds = securities
    .filter((security) => security.status === "ACTIVE")
    .map((security) => security.securityId);

  // Reply Dust: the grouped reply is taken right after its one fetch and stored (encode, decode,
  // compare, put, read back) before any bar of that session is stored or progress advances. A
  // day already sealed in Reply Dust is rebuilt from the stored reply instead of fetched again.
  const dailyBarsWithReplyDust = async (sessionDate: string): Promise<CanonicalDailyBar[]> => {
    const store = replyStore!;
    const bySymbol = groupedDailySymbolIndex(
      symbolBySecurityIdFor(providerRecords(securities, provider.providerName)),
      activeIds,
    );
    if (await readDailyReplyDustManifest(store, sessionDate))
      return readDailyReplyDustBars(store, sessionDate, bySymbol, options.replyDustBackend);
    const takeRawReplies = provider.takeRawReplies!.bind(provider);
    if (takeRawReplies().length) throw new Error("REPLY_DUST_UNEXPECTED_HELD_REPLIES");
    const bars = await provider.getDailyBars(sessionDate, activeIds);
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
    if (state.completedSessions.includes(sessionDate)) {
      skippedExistingSessions.push(sessionDate);
      continue;
    }
    const existing = await storage.loadBars(sessionDate);
    if (existing.length > 0) {
      state.completedSessions = [...new Set([...state.completedSessions, sessionDate])].sort();
      skippedExistingSessions.push(sessionDate);
      await writeProgress(storage, state);
      continue;
    }
    yieldedForScan = await shouldYield();
    if (yieldedForScan) break;
    attemptedSessions.push(sessionDate);
    try {
      const bars = replyDust
        ? await dailyBarsWithReplyDust(sessionDate)
        : await provider.getDailyBars(sessionDate, activeIds);
      await storage.appendBars(bars);
      barsStored += bars.length;
      try {
        const actions = await provider.getCorporateActions(sessionDate, activeIds);
        await storage.appendActions(actions);
        actionsStored += actions.length;
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
        bars.length ? "GOOD" : "PARTIAL_RUN",
      );
      state.completedSessions = [...new Set([...state.completedSessions, sessionDate])].sort();
      delete failedSessions[sessionDate];
      completedSessions.push(sessionDate);
      await writeProgress(storage, { ...state, failedSessions });
    } catch (error) {
      const message = String(error);
      failedSessions[sessionDate] = message;
      stoppedOnError = true;
      await writeProgress(storage, { ...state, failedSessions });
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
  };
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (process.argv[1]?.endsWith("backfill.ts")) {
  const root =
    process.env.PEACEAI_MARKETS_ROOT ??
    process.env.MARKETS_STORAGE_ROOT ??
    "C:\\ProgramData\\PeaceAI\\Markets";
  const from = argument("--from") ?? process.env.MARKETS_BACKFILL_FROM;
  const to = argument("--to") ?? process.env.MARKETS_BACKFILL_TO;
  if (!from || !to) throw new Error("BACKFILL_RANGE_REQUIRED");
  const maxText = argument("--max-sessions");
  const result = await backfillHistoricalEvidence({
    root,
    from,
    to,
    ...(maxText ? { maxSessions: Number(maxText) } : {}),
  });
  console.log(JSON.stringify(result));
  if (result.stoppedOnError) process.exitCode = 2;
}
