import type {
  ListSecuritiesOptions,
  CanonicalDailyBar,
  CanonicalTenMinuteBar,
  CorporateAction,
  MarketProvider,
  MassiveAggregateBar,
  ProviderRawReply,
  ProviderSecurityRecord,
  TenMinuteRangeReply,
} from "./contracts";
import { MARKET_SCHEMA_VERSION } from "./contracts";
import { securityId } from "./identity";
import { ScanYieldError } from "./scan-yield";
import { intradaySessionSpec, normalizeMassiveTenMinuteBars } from "./intraday";

const DEFAULT_BASE_URL = "https://api.massive.com";
const DEFAULT_MIN_REQUEST_INTERVAL_MS = 12_500;
const PAGE_LIMIT = 1_000;
/** Most pages one 10-minute range request may take; more is an error, never a silent truncation. */
export const TENMIN_RANGE_PAGE_CAP = 8;
type JsonRecord = Record<string, unknown>;

export interface MassiveProviderOptions {
  apiKey?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  minRequestIntervalMs?: number;
  retryBackoffMs?: number;
  now?: () => string;
  /** Test hook: monotonic clock in ms for pacing (defaults to Date.now). */
  clock?: () => number;
  /** Test hook: delay used by the shared pace and retry backoff (defaults to setTimeout). */
  sleep?: (ms: number) => Promise<void>;
  /** Keep each bar reply's exact bytes until takeRawReplies(); off by default so nothing piles up unread. */
  keepRawReplies?: boolean;
}

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;
const finite = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;
const records = (value: unknown): JsonRecord[] =>
  Array.isArray(value)
    ? value.filter((item): item is JsonRecord => !!item && typeof item === "object")
    : [];

const details = (record: JsonRecord): Record<string, string | number | boolean> =>
  Object.fromEntries(
    Object.entries(record).filter(
      ([key, value]) => key !== "ticker" && ["string", "number", "boolean"].includes(typeof value),
    ),
  ) as Record<string, string | number | boolean>;

function requireDate(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("INVALID_SESSION_DATE");
}

function responseRecord(value: unknown): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("MASSIVE_INVALID_RESPONSE");
  return value as JsonRecord;
}

function safeProviderErrorBody(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return "empty-body";
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as JsonRecord;
      const safe = Object.fromEntries(
        ["status", "code", "message", "error", "request_id", "requestId"].flatMap((key) =>
          key in record && ["string", "number", "boolean"].includes(typeof record[key])
            ? [[key, record[key]]]
            : [],
        ),
      );
      return JSON.stringify(Object.keys(safe).length ? safe : { body: trimmed.slice(0, 500) });
    }
  } catch {
    // Preserve a bounded, non-secret diagnostic for non-JSON provider errors.
  }
  return trimmed.replaceAll(/\s+/gu, " ").slice(0, 500);
}

/** Read-only adapter for Massive Stocks REST reference, EOD, split, and dividend APIs. */
// The active pass runs before the inactive pass and both share one map keyed by identity. An
// inactive record must never replace an active one with the same FIGI (that dropped live tickers
// from the universe); among records with the same status the later one wins as before. The
// losing ticker is kept on the winner as a former symbol so the security master records it.
export function mergeSameIdentity(
  output: Map<string, ProviderSecurityRecord>,
  incoming: ProviderSecurityRecord,
): void {
  const key = `${incoming.providerSecurityId}|${incoming.assetType}`;
  const current = output.get(key);
  if (!current) {
    output.set(key, incoming);
    return;
  }
  const incomingWins = incoming.active || !current.active;
  const winner = incomingWins ? incoming : current;
  const loser = incomingWins ? current : incoming;
  const former = [...(current.formerSymbols ?? []), ...(incoming.formerSymbols ?? [])];
  if (loser.symbol !== winner.symbol)
    former.push({
      symbol: loser.symbol,
      ...(loser.listingDate ? { listingDate: loser.listingDate } : {}),
      ...(loser.delistedDate ? { delistedDate: loser.delistedDate } : {}),
    });
  const unique = former.filter(
    (item, index) =>
      item.symbol !== winner.symbol && former.findIndex((other) => other.symbol === item.symbol) === index,
  );
  const { formerSymbols: _drop, ...rest } = winner;
  output.set(key, unique.length ? { ...rest, formerSymbols: unique } : rest);
}

/** The security-id -> symbol map bindUniverse builds (a later record with the same id wins). */
export function symbolBySecurityIdFor(recordsToBind: readonly ProviderSecurityRecord[]): Map<string, string> {
  const output = new Map<string, string>();
  for (const record of recordsToBind)
    output.set(securityId(record.provider, record.providerSecurityId, record.assetType), record.symbol);
  return output;
}

/**
 * The security-id -> symbol map getDailyBars filters with, inverted to symbol -> security id and
 * limited to the requested ids (a later id with the same symbol wins, as before).
 */
export function groupedDailySymbolIndex(
  symbolBySecurityId: ReadonlyMap<string, string>,
  securityIds: readonly string[],
): Map<string, string> {
  const ids = new Set(securityIds);
  return new Map(
    [...symbolBySecurityId.entries()].filter(([id]) => ids.has(id)).map(([id, symbol]) => [symbol, id]),
  );
}

/**
 * Turns one parsed Massive grouped-daily reply (the whole market) into canonical daily bars for
 * the symbols in bySymbol. getDailyBars and the Reply Dust reader both use this.
 */
export function massiveGroupedDailyBarsFromReply(input: {
  provider: string;
  sessionDate: string;
  reply: Record<string, unknown>;
  observedAt: string;
  bySymbol: ReadonlyMap<string, string>;
}): CanonicalDailyBar[] {
  const { sessionDate, observedAt, bySymbol } = input;
  const retrievalId = text(input.reply.request_id) ?? `grouped-${sessionDate}`;
  return records(input.reply.results)
    .flatMap((raw) => {
      const id = bySymbol.get(text(raw.T) ?? "");
      const open = finite(raw.o),
        high = finite(raw.h),
        low = finite(raw.l),
        close = finite(raw.c),
        volume = finite(raw.v);
      if (
        !id ||
        open === undefined ||
        high === undefined ||
        low === undefined ||
        close === undefined ||
        volume === undefined
      )
        return [];
      const timestamp = finite(raw.t);
      return [
        {
          securityId: id,
          sessionDate,
          open,
          high,
          low,
          close,
          volume,
          ...(timestamp === undefined
            ? {}
            : { sourceTimestamp: new Date(timestamp).toISOString() }),
          observedAt,
          ingestedAt: observedAt,
          dataQuality: "GOOD" as const,
          corporateActionIds: [],
          flags: ["MASSIVE_GROUPED_DAILY", "UNADJUSTED"],
          schemaVersion: MARKET_SCHEMA_VERSION,
          revision: 1,
          provenance: {
            provider: input.provider,
            dataset: "stocks-grouped-daily",
            retrievalId,
            providerTimestamp: observedAt,
            ingestionVersion: "markets-scanner-v0",
            normalizerVersion: "massive-v1",
          },
        },
      ];
    })
    .sort((a, b) => a.securityId.localeCompare(b.securityId));
}

/**
 * Turns one parsed Massive 10-minute aggregates reply into canonical bars. Both the live fetch and
 * the Reply Dust reader use this, so a stored reply rebuilds exactly the bars the fetch produced.
 */
export function massiveTenMinuteBarsFromReply(input: {
  provider: string;
  sessionDate: string;
  securityId: string;
  symbol: string;
  reply: Record<string, unknown>;
  observedAt: string;
}): CanonicalTenMinuteBar[] {
  const aggregates: MassiveAggregateBar[] = records(input.reply.results).flatMap((raw) => {
    const timestamp = finite(raw.t);
    const open = finite(raw.o),
      high = finite(raw.h),
      low = finite(raw.l),
      close = finite(raw.c),
      volume = finite(raw.v);
    if (
      timestamp === undefined ||
      open === undefined ||
      high === undefined ||
      low === undefined ||
      close === undefined ||
      volume === undefined
    )
      return [];
    const vwap = finite(raw.vw);
    const transactionCount = finite(raw.n);
    return [
      {
        symbol: input.symbol,
        timestamp,
        open,
        high,
        low,
        close,
        volume,
        ...(vwap === undefined ? {} : { vwap }),
        ...(transactionCount === undefined ? {} : { transactionCount }),
      },
    ];
  });
  return normalizeMassiveTenMinuteBars({
    sessionDate: input.sessionDate,
    securityId: input.securityId,
    symbol: input.symbol,
    aggregates,
    observedAt: input.observedAt,
    provenance: {
      provider: input.provider,
      dataset: "stocks-aggregates-10m",
      retrievalId:
        text(input.reply.request_id) ?? `aggregate-10m-${input.sessionDate}-${input.symbol}`,
      providerTimestamp: input.observedAt,
      ingestionVersion: "markets-scanner-v0.2",
      normalizerVersion: "massive-10m-v1",
    },
  });
}

/** Grouped daily (whole US stock market, one session): the only params getDailyBars uses. */
export const GROUPED_DAILY_PARAMS: Readonly<Record<string, string>> = { adjusted: "false", include_otc: "false" };
export function groupedDailyPath(sessionDate: string): string {
  return `/v2/aggs/grouped/locale/us/market/stocks/${sessionDate}`;
}

export class MassiveMarketProvider implements MarketProvider {
  readonly providerName = "massive-stocks";
  private readonly apiKey: string;
  private readonly baseUrl: URL;
  private readonly fetchImpl: typeof fetch;
  private readonly minRequestIntervalMs: number;
  private readonly now: () => string;
  private readonly clock: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private lastRequestAt = 0;
  private pace: Promise<void> = Promise.resolve();
  private readonly symbolBySecurityId = new Map<string, string>();
  private readonly maxTransientAttempts = 3;
  private rateLimitedCount = 0;
  private rawReplies: ProviderRawReply[] = [];
  private readonly keepRawReplies: boolean;
  private readonly retryBackoffMs: number;

  constructor(options: MassiveProviderOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.MASSIVE_API_KEY ?? "";
    this.baseUrl = new URL(options.baseUrl ?? DEFAULT_BASE_URL);
    if (this.baseUrl.protocol !== "https:") throw new Error("MASSIVE_HTTPS_REQUIRED");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.minRequestIntervalMs = options.minRequestIntervalMs ?? DEFAULT_MIN_REQUEST_INTERVAL_MS;
    if (this.minRequestIntervalMs < 0) throw new Error("MASSIVE_INVALID_RATE_LIMIT");
    this.retryBackoffMs = options.retryBackoffMs ?? 250;
    if (this.retryBackoffMs < 0) throw new Error("MASSIVE_INVALID_RATE_LIMIT");
    this.now = options.now ?? (() => new Date().toISOString());
    this.clock = options.clock ?? Date.now;
    this.sleep =
      options.sleep ??
      ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    this.keepRawReplies = options.keepRawReplies ?? false;
  }

  /** Every HTTP 429 received, including ones a retry later recovered from. */
  get rateLimitedResponses(): number {
    return this.rateLimitedCount;
  }

  private requireApiKey(): void {
    if (!this.apiKey) throw new Error("MASSIVE_API_KEY_REQUIRED");
  }

  private async waitForRateLimit(): Promise<void> {
    const run = this.pace.then(async () => {
      const wait = this.lastRequestAt + this.minRequestIntervalMs - this.clock();
      if (wait > 0) await this.sleep(wait);
      this.lastRequestAt = this.clock();
    });
    this.pace = run.then(
      () => undefined,
      () => undefined,
    );
    await run;
  }

  private async backoff(attempt: number): Promise<void> {
    const wait = this.retryBackoffMs * attempt;
    if (wait > 0) await this.sleep(wait);
  }

  private url(pathOrUrl: string, params?: Record<string, string>): URL {
    const url = new URL(pathOrUrl, this.baseUrl);
    if (url.origin !== this.baseUrl.origin || url.protocol !== "https:")
      throw new Error("MASSIVE_UNTRUSTED_NEXT_URL");
    if (params) for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    url.searchParams.set("apiKey", this.apiKey);
    return url;
  }

  /** Hands over (and forgets) every bar reply received since the last call, oldest first. */
  takeRawReplies(): ProviderRawReply[] {
    const taken = this.rawReplies;
    this.rawReplies = [];
    return taken;
  }

  private async get(pathOrUrl: string, params?: Record<string, string>): Promise<JsonRecord> {
    return (await this.getWithBody(pathOrUrl, params)).record;
  }

  // Bar requests keep the exact reply bytes; the parsed record is built from those same bytes.
  private async getBars(
    reply: Omit<ProviderRawReply, "request" | "fetchedAt" | "body">,
    path: string,
    params: Record<string, string>,
  ): Promise<JsonRecord> {
    const { record, body } = await this.getWithBody(path, params);
    if (!this.keepRawReplies) return record;
    const request = new URL(path, this.baseUrl);
    for (const [key, value] of Object.entries(params)) request.searchParams.set(key, value);
    this.rawReplies.push({
      ...reply,
      request: `${request.pathname}${request.search}`,
      fetchedAt: this.now(),
      body,
    });
    return record;
  }

  private async getWithBody(
    pathOrUrl: string,
    params?: Record<string, string>,
  ): Promise<{ record: JsonRecord; body: Uint8Array }> {
    this.requireApiKey();
    let transientAttempt = 0;
    for (;;) {
      await this.waitForRateLimit();
      let response: Response;
      try {
        response = await this.fetchImpl(this.url(pathOrUrl, params), {
          headers: { accept: "application/json" },
        });
      } catch (error) {
        transientAttempt += 1;
        if (transientAttempt >= this.maxTransientAttempts) {
          throw new Error(
            `MASSIVE_NETWORK:${error instanceof Error ? error.message : "UNKNOWN"}`,
          );
        }
        await this.backoff(transientAttempt);
        continue;
      }
      if (response.ok) {
        const body = new Uint8Array(await response.arrayBuffer());
        return { record: responseRecord(JSON.parse(new TextDecoder().decode(body))), body };
      }
      const body = await response.text();
      const requestId = response.headers.get("request-id") ?? response.headers.get("x-request-id");
      const safeBody = safeProviderErrorBody(body);
      if (response.status === 429) {
        this.rateLimitedCount += 1;
        transientAttempt += 1;
        if (transientAttempt < this.maxTransientAttempts) {
          await this.backoff(transientAttempt);
          continue;
        }
      }
      if (response.status === 403 && /before end of day/iu.test(safeBody)) {
        throw new Error(`PROVIDER_NOT_READY:${safeBody}`);
      }
      if (
        response.status === 401 ||
        (response.status === 403 && /invalid api key|unknown api key/iu.test(safeBody))
      ) {
        throw new Error(
          `MASSIVE_CREDENTIAL_REJECTED:requestId=${requestId ?? "unknown"}:body=${safeBody}`,
        );
      }
      throw new Error(
        `MASSIVE_HTTP_${response.status}:requestId=${requestId ?? "unknown"}:body=${safeBody}`,
      );
    }
  }

  private normalize(record: JsonRecord): ProviderSecurityRecord | undefined {
    const symbol = text(record.ticker);
    const providerSecurityId =
      text(record.share_class_figi) ?? text(record.composite_figi) ?? symbol;
    const type = text(record.type)?.toUpperCase();
    const market = text(record.market)?.toLowerCase();
    const locale = text(record.locale)?.toLowerCase();
    const listingDate = text(record.list_date);
    const providerUpdatedAt = text(record.last_updated);
    const delistedDate = text(record.delisted_utc)?.slice(0, 10);
    if (!symbol || !providerSecurityId || (type !== "CS" && type !== "ETF")) return undefined;
    if (market && market !== "stocks") return undefined;
    if (locale && locale !== "us") return undefined;
    return {
      provider: this.providerName,
      providerSecurityId,
      symbol,
      assetType: type === "ETF" ? "ETF" : "STOCK",
      country: "US",
      exchange: text(record.primary_exchange) ?? "UNKNOWN",
      active: record.active !== false,
      tradable: record.active !== false,
      ...(typeof record.fractionable === "boolean" ? { fractional: record.fractionable } : {}),
      ...(listingDate ? { listingDate } : {}),
      ...(providerUpdatedAt ? { providerUpdatedAt } : {}),
      ...(record.active === false && delistedDate ? { delistedDate } : {}),
    };
  }

  async listApprovedSecurities(options: ListSecuritiesOptions = {}): Promise<ProviderSecurityRecord[]> {
    const output = new Map<string, ProviderSecurityRecord>();
    let pagesFetched = 0;
    for (const active of ["true", "false"]) {
      let next: string | undefined = "/v3/reference/tickers";
      let first = true;
      while (next) {
        // The caller checked before calling; re-check at every later page boundary. Stopping
        // throws away everything read so far and leaves the bound universe untouched.
        if (pagesFetched > 0 && options.shouldStop) {
          const reason = await options.shouldStop();
          if (reason) throw new ScanYieldError(reason);
        }
        pagesFetched += 1;
        const response = await this.get(
          next,
          first
            ? {
                market: "stocks",
                locale: "us",
                active,
                order: "asc",
                sort: "ticker",
                limit: String(PAGE_LIMIT),
              }
            : undefined,
        );
        first = false;
        for (const record of records(response.results)) {
          const normalized = this.normalize(record);
          if (normalized) mergeSameIdentity(output, normalized);
        }
        const candidate = text(response.next_url);
        next = candidate && candidate !== next ? candidate : undefined;
      }
    }
    const result = [...output.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
    this.bindUniverse(result);
    return result;
  }

  bindUniverse(recordsToBind: ProviderSecurityRecord[]): void {
    this.symbolBySecurityId.clear();
    for (const [id, symbol] of symbolBySecurityIdFor(recordsToBind))
      this.symbolBySecurityId.set(id, symbol);
  }

  async getDailyBars(sessionDate: string, securityIds: string[]): Promise<CanonicalDailyBar[]> {
    requireDate(sessionDate);
    if (!this.symbolBySecurityId.size) throw new Error("MASSIVE_UNIVERSE_REQUIRED_BEFORE_BARS");
    const response = await this.getBars(
      { dataset: "stocks-grouped-daily", sessionDate },
      groupedDailyPath(sessionDate),
      { ...GROUPED_DAILY_PARAMS },
    );
    const bySymbol = groupedDailySymbolIndex(this.symbolBySecurityId, securityIds);
    return massiveGroupedDailyBarsFromReply({
      provider: this.providerName,
      sessionDate,
      reply: response,
      observedAt: this.now(),
      bySymbol,
    });
  }

  /**
   * The exact whole-market grouped-daily reply for one session (same path and params as
   * getDailyBars, no universe needed). The request kept has no API key.
   */
  async getGroupedDailyReply(sessionDate: string): Promise<ProviderRawReply> {
    requireDate(sessionDate);
    const path = groupedDailyPath(sessionDate);
    const params = { ...GROUPED_DAILY_PARAMS };
    const { body } = await this.getWithBody(path, params);
    const request = new URL(path, this.baseUrl);
    for (const [key, value] of Object.entries(params)) request.searchParams.set(key, value);
    return {
      dataset: "stocks-grouped-daily",
      sessionDate,
      request: `${request.pathname}${request.search}`,
      fetchedAt: this.now(),
      body,
    };
  }

  async getIntradayBars(
    sessionDate: string,
    securityIds: string[],
  ): Promise<CanonicalTenMinuteBar[]> {
    requireDate(sessionDate);
    if (!this.symbolBySecurityId.size) throw new Error("MASSIVE_UNIVERSE_REQUIRED_BEFORE_BARS");
    const session = intradaySessionSpec(sessionDate);
    if (session.expectedIntervals === 0) return [];
    const output: CanonicalTenMinuteBar[] = [];
    const observedAt = this.now();
    for (const securityIdValue of securityIds) {
      const symbol = this.symbolBySecurityId.get(securityIdValue);
      if (!symbol) continue;
      const response = await this.getBars(
        { dataset: "stocks-aggregates-10m", sessionDate, securityId: securityIdValue, symbol },
        `/v2/aggs/ticker/${encodeURIComponent(symbol)}/range/10/minute/${sessionDate}/${sessionDate}`,
        {
          adjusted: "false",
          sort: "asc",
          limit: "50000",
        },
      );
      output.push(
        ...massiveTenMinuteBarsFromReply({
          provider: this.providerName,
          sessionDate,
          securityId: securityIdValue,
          symbol,
          reply: response,
          observedAt,
        }),
      );
    }
    return output.sort(
      (a, b) => a.securityId.localeCompare(b.securityId) || a.intervalIndex - b.intervalIndex,
    );
  }

  /**
   * Fetch every page of a multi-day 10-minute aggregates range for one security, keeping each
   * page's exact response bytes. The caller supplies the historical symbol valid for the range;
   * this method does not look it up from the bound universe. Pages are returned directly (not
   * buffered in takeRawReplies). Pagination reuses getWithBody (shared pace, 429/network backoff,
   * and MASSIVE_UNTRUSTED_NEXT_URL origin check); apiKey is never stored in recorded requests.
   * More than TENMIN_RANGE_PAGE_CAP pages throws MASSIVE_RANGE_PAGE_CAP:<symbol>:<from>:<to>.
   */
  async getTenMinuteRangeReplies(
    security: { securityId: string; symbol: string },
    from: string,
    to: string,
  ): Promise<TenMinuteRangeReply[]> {
    requireDate(from);
    requireDate(to);
    const path = `/v2/aggs/ticker/${encodeURIComponent(security.symbol)}/range/10/minute/${from}/${to}`;
    const params = { adjusted: "false", sort: "asc", limit: "50000" };
    const pages: TenMinuteRangeReply[] = [];
    let next: string | undefined = path;
    let first = true;
    let page = 0;
    while (next) {
      // A next_url cycle (A -> B -> A) or a runaway cursor stops here, before page 9 is fetched.
      if (page >= TENMIN_RANGE_PAGE_CAP)
        throw new Error(`MASSIVE_RANGE_PAGE_CAP:${security.symbol}:${from}:${to}`);
      page += 1;
      const pathOrUrl: string = next;
      const pageParams = first ? params : undefined;
      const { record, body } = await this.getWithBody(pathOrUrl, pageParams);
      const request = new URL(pathOrUrl, this.baseUrl);
      if (pageParams)
        for (const [key, value] of Object.entries(pageParams)) request.searchParams.set(key, value);
      request.searchParams.delete("apiKey");
      pages.push({
        page,
        request: `${request.pathname}${request.search}`,
        fetchedAt: this.now(),
        body,
        rangeFrom: from,
        rangeTo: to,
        securityId: security.securityId,
        symbol: security.symbol,
      });
      const candidate = text(record.next_url);
      next = candidate && candidate !== pathOrUrl ? candidate : undefined;
      first = false;
    }
    return pages;
  }

  private async actions(
    path: string,
    dateParam: string,
    sessionDate: string,
  ): Promise<JsonRecord[]> {
    const response = await this.get(path, {
      [dateParam]: sessionDate,
      limit: "5000",
      order: "asc",
    });
    const result = records(response.results);
    const next = text(response.next_url);
    if (!next) return result;
    const page = await this.get(next);
    return [...result, ...records(page.results)];
  }

  async getCorporateActions(
    sessionDate: string,
    securityIds: string[],
  ): Promise<CorporateAction[]> {
    requireDate(sessionDate);
    const ids = new Set(securityIds);
    const bySymbol = new Map(
      [...this.symbolBySecurityId.entries()]
        .filter(([id]) => ids.has(id))
        .map(([id, symbol]) => [symbol, id]),
    );
    const [splits, dividends] = await Promise.all([
      this.actions("/stocks/v1/splits", "execution_date", sessionDate),
      this.actions("/stocks/v1/dividends", "ex_dividend_date", sessionDate),
    ]);
    const observedAt = this.now();
    const provenance = (dataset: string, id: string) => ({
      provider: this.providerName,
      dataset,
      retrievalId: id,
      providerTimestamp: observedAt,
      ingestionVersion: "markets-scanner-v0",
      normalizerVersion: "massive-v1",
    });
    const result: CorporateAction[] = [];
    for (const raw of splits) {
      const id = bySymbol.get(text(raw.ticker) ?? "");
      if (!id) continue;
      const actionId = text(raw.id) ?? `split:${id}:${sessionDate}`;
      result.push({
        actionId,
        securityId: id,
        actionType: text(raw.adjustment_type) === "reverse_split" ? "REVERSE_SPLIT" : "SPLIT",
        effectiveDate: sessionDate,
        details: details(raw),
        observedAt,
        provenance: provenance("stocks-splits", actionId),
      });
    }
    for (const raw of dividends) {
      const id = bySymbol.get(text(raw.ticker) ?? "");
      if (!id) continue;
      const actionId = text(raw.id) ?? `dividend:${id}:${sessionDate}`;
      result.push({
        actionId,
        securityId: id,
        actionType: "DIVIDEND",
        effectiveDate: sessionDate,
        details: details(raw),
        observedAt,
        provenance: provenance("stocks-dividends", actionId),
      });
    }
    return result.sort((a, b) => a.actionId.localeCompare(b.actionId));
  }
}
