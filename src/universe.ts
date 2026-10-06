import type {
  ListSecuritiesOptions,
  HistoryEligibility,
  MarketProvider,
  ProviderSecurityRecord,
  SecurityMasterRecord,
  UniverseMembershipEvidence,
  UniverseRefreshResult,
} from "./contracts";
import { securityId } from "./identity";
import type { TickerReferenceCapture } from "./ticker-reference-index";
import type { MarketStore } from "./storage";

export function eligibilityForBarCount(barCount: number): HistoryEligibility {
  if (barCount <= 0) return "LEVEL_0";
  if (barCount < 20) return "LEVEL_1";
  if (barCount < 252) return "LEVEL_2";
  return "LEVEL_3";
}

function inScope(record: ProviderSecurityRecord): boolean {
  return (
    record.country.toUpperCase() === "US" &&
    (record.assetType === "STOCK" || record.assetType === "ETF")
  );
}

function nextMembershipReason(
  previous: SecurityMasterRecord | undefined,
  record: ProviderSecurityRecord,
): UniverseMembershipEvidence["reason"] {
  if (!previous) return "NEW";
  if (previous.status !== "ACTIVE" && record.active) return "REACTIVATED";
  return "CONTINUED";
}

export async function refreshUniverse(
  provider: MarketProvider,
  storage: MarketStore,
  asOf: string,
  options: ListSecuritiesOptions = {},
): Promise<UniverseRefreshResult> {
  await storage.initialize();
  const existing = await storage.loadSecurities();
  const byProvider = new Map<string, SecurityMasterRecord>();
  for (const item of existing)
    for (const identity of item.providerIdentities)
      byProvider.set(`${identity.provider}|${identity.providerSecurityId}`, item);
  const byId = new Map(existing.map((item) => [item.securityId, item]));
  const priorMembership = new Map(
    (await storage.loadMembership()).map((event) => [event.securityId, event]),
  );
  const seen = new Set<string>();
  const membershipEvents: UniverseMembershipEvidence[] = [];
  let added = 0;
  let updated = 0;
  let rejected = 0;

  for (const providerRecord of await provider.listApprovedSecurities(options)) {
    if (!inScope(providerRecord)) {
      rejected += 1;
      continue;
    }
    const lookup = `${providerRecord.provider}|${providerRecord.providerSecurityId}`;
    const id =
      byProvider.get(lookup)?.securityId ??
      securityId(
        providerRecord.provider,
        providerRecord.providerSecurityId,
        providerRecord.assetType,
      );
    const previous = byId.get(id);
    const history = previous?.historicalSymbols ?? [];
    if (!history.length || history[history.length - 1]?.symbol !== providerRecord.symbol) {
      const last = history[history.length - 1];
      if (last) history[history.length - 1] = { ...last, effectiveTo: asOf };
      history.push({
        symbol: providerRecord.symbol,
        effectiveFrom: asOf,
        source: providerRecord.provider,
      });
    }
    // Former tickers of the same identity (from the provider's inactive pass) go in front of the
    // history if they are not already recorded. This runs after the current-symbol step above so
    // that step only ever closes a symbol from earlier history, never a former ticker's own dates.
    // Without a provider date the refresh date is used.
    const missingFormer = (providerRecord.formerSymbols ?? [])
      .filter((item) => !history.some((entry) => entry.symbol === item.symbol))
      .map((item) => ({
        symbol: item.symbol,
        effectiveFrom: item.listingDate ?? asOf,
        effectiveTo: item.delistedDate ?? asOf,
        source: providerRecord.provider,
      }))
      .sort((a, b) => a.effectiveTo.localeCompare(b.effectiveTo) || a.symbol.localeCompare(b.symbol));
    if (missingFormer.length) history.unshift(...missingFormer);
    const record: SecurityMasterRecord = {
      securityId: id,
      currentSymbol: providerRecord.symbol,
      historicalSymbols: history,
      assetType: providerRecord.assetType,
      country: "US",
      exchange: providerRecord.exchange,
      firstSeenAt: previous?.firstSeenAt ?? asOf,
      ...(providerRecord.listingDate
        ? { listingDate: providerRecord.listingDate }
        : previous?.listingDate
          ? { listingDate: previous.listingDate }
          : {}),
      ...(providerRecord.active ? {} : { inactiveAt: previous?.inactiveAt ?? asOf }),
      status: providerRecord.active ? "ACTIVE" : "INACTIVE",
      tradable: providerRecord.tradable,
      ...(providerRecord.fractional === undefined ? {} : { fractional: providerRecord.fractional }),
      providerIdentities: previous?.providerIdentities.some(
        (item) =>
          item.provider === providerRecord.provider &&
          item.providerSecurityId === providerRecord.providerSecurityId,
      )
        ? previous.providerIdentities
        : [
            ...(previous?.providerIdentities ?? []),
            {
              provider: providerRecord.provider,
              providerSecurityId: providerRecord.providerSecurityId,
            },
          ],
      eligibility: eligibilityForBarCount(previous?.barCount ?? 0),
      barCount: previous?.barCount ?? 0,
      lastUniverseSeenAt: asOf,
    };
    byId.set(id, record);
    byProvider.set(lookup, record);
    seen.add(id);
    if (!previous) added += 1;
    else updated += 1;
    const prior = priorMembership.get(id);
    if (!prior || prior.included !== providerRecord.active)
      membershipEvents.push({
        securityId: id,
        effectiveDate: asOf,
        included: providerRecord.active,
        eligibility: record.eligibility,
        reason: providerRecord.active ? nextMembershipReason(previous, providerRecord) : "INACTIVE",
        provider: providerRecord.provider,
        observedAt: asOf,
      });
  }

  for (const previous of existing) {
    if (seen.has(previous.securityId) || previous.status !== "ACTIVE") continue;
    const inactive: SecurityMasterRecord = {
      ...previous,
      status: "INACTIVE",
      tradable: false,
      inactiveAt: previous.inactiveAt ?? asOf,
      lastUniverseSeenAt: previous.lastUniverseSeenAt,
    };
    byId.set(previous.securityId, inactive);
    membershipEvents.push({
      securityId: previous.securityId,
      effectiveDate: asOf,
      included: false,
      eligibility: inactive.eligibility,
      reason: "INACTIVE",
      provider: "universe-diff",
      observedAt: asOf,
    });
  }

  const securities = [...byId.values()];
  await storage.saveSecurities(securities);
  await storage.appendMembership(membershipEvents);
  // Same run, after the master is saved: the ticker reference index from the passes just made.
  // Its failure is a warning, never a master failure: the master is already written and is what
  // the scan needs; the index only feeds the ten-minute union's type filter, which treats a
  // missing index as "type unknown" (fetch and count), so nothing is silently excluded.
  const warnings: string[] = [];
  let tickerReferenceIndex: UniverseRefreshResult["tickerReferenceIndex"];
  const capturing = provider as MarketProvider & {
    takeTickerReferenceCapture?: () => TickerReferenceCapture | undefined;
    takeTickerReferenceCaptureError?: () => string | undefined;
  };
  const captureError = capturing.takeTickerReferenceCaptureError?.();
  const capture = capturing.takeTickerReferenceCapture?.();
  if (captureError) warnings.push(`TICKER_REFERENCE_INDEX_NOT_WRITTEN:${captureError}`);
  else if (capture && storage.saveTickerReferenceIndex) {
    try {
      const manifest = await storage.saveTickerReferenceIndex(capture, {
        provider: provider.providerName,
        asOf,
      });
      tickerReferenceIndex = { pages: manifest.pages, records: manifest.records };
    } catch (error) {
      warnings.push(
        `TICKER_REFERENCE_INDEX_WRITE_FAILED:${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return {
    added,
    updated,
    inactivated: membershipEvents.filter((event) => event.reason === "INACTIVE").length,
    rejected,
    securities,
    membershipEvents,
    ...(tickerReferenceIndex ? { tickerReferenceIndex } : {}),
    ...(warnings.length ? { warnings } : {}),
  };
}

export async function refreshEligibility(storage: MarketStore): Promise<SecurityMasterRecord[]> {
  const securities = await storage.loadSecurities();
  const counts = await storage.tallyBarCounts();
  const refreshed = securities.map((security) => ({
    ...security,
    barCount: counts.get(security.securityId) ?? 0,
    eligibility: eligibilityForBarCount(counts.get(security.securityId) ?? 0),
  }));
  await storage.saveSecurities(refreshed);
  return refreshed;
}
