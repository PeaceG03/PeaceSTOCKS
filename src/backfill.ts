import { readFile, writeFile, rename } from "node:fs/promises";
import { assertSafeStoreFile, prepareSafeStoreFile } from "./store-path";
import type { MarketProvider, ProviderSecurityRecord, SecurityMasterRecord } from "./contracts";
import { MassiveMarketProvider } from "./massive-provider";
import { openMarketStore } from "./object-storage";
import type { MarketStore } from "./storage";
import { refreshEligibility, refreshUniverse } from "./universe";
import { US_EQUITY_MARKET_CALENDAR } from "./us-calendar";
import { finalizeDailyPartition } from "./scanner";
import { scanYieldReason } from "./scan-yield";

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
}): Promise<BackfillResult> {
  const env = options.env ?? process.env;
  requireObjectStore(env);
  const provider = options.provider ?? new MassiveMarketProvider();
  const storage = options.storage ?? openMarketStore(options.root, env);
  await storage.initialize();
  // On Actions the scan always wins the Massive budget; local/test runs opt in via shouldYield.
  const shouldYield =
    options.shouldYield ??
    (env.GITHUB_ACTIONS === "true" ? () => scanYieldReason({ env }) : async () => undefined);
  const startYield = await shouldYield();
  if (startYield)
    return {
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
      yieldedForScan: startYield,
      eligibility: {},
    };

  // Cold start: build the security master before grouped-daily can bind symbols.
  await refreshUniverse(provider, storage, options.to);
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
      const bars = await provider.getDailyBars(sessionDate, activeIds);
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
