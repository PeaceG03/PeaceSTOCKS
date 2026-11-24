/**
 * Point-in-time universe for one historical session: which stored securities (ACTIVE and INACTIVE)
 * were listed on that date and under which ticker. A historical backfill binds the grouped-daily
 * reply with this instead of today's ACTIVE names, so names that later went inactive or were
 * delisted keep their bars for the sessions they traded (no survivorship bias), and a ticker that
 * was later reused is credited to the company that held it on that date.
 *
 * Membership evidence: the grouped-daily reply itself (only names that traded that day are in it)
 * plus the master's dates. The bounds used, in order:
 *  - listingDate: not a member before it;
 *  - INACTIVE: not a member after delistedAt (provider delisting date), else after inactiveAt (the
 *    first refresh that saw it inactive; it had stopped trading by then);
 *  - the symbol: from historicalSymbols (an entry covers [effectiveFrom, effectiveTo); the earliest
 *    entry is open to the past, the latest open to the future). In a gap, the next symbol seen.
 * Two records on one symbol on one date: exactly one ACTIVE wins (the old behaviour); otherwise the
 * symbol is ambiguous and dropped for that date (counted, never guessed).
 */
import type { ProviderSecurityRecord, SecurityMasterRecord } from "./contracts";

export function symbolOn(security: SecurityMasterRecord, date: string): string | undefined {
  if (security.listingDate && date < security.listingDate) return undefined;
  if (security.status !== "ACTIVE") {
    const end = security.delistedAt ?? security.inactiveAt;
    if (end && date > end) return undefined;
  }
  const history = security.historicalSymbols ?? [];
  if (!history.length) return security.currentSymbol;
  for (let k = history.length - 1; k >= 0; k -= 1) {
    const entry = history[k]!;
    const startsBefore = k === 0 || entry.effectiveFrom <= date;
    const endsAfter = k === history.length - 1 || !entry.effectiveTo || date < entry.effectiveTo;
    if (startsBefore && endsAfter) return entry.symbol;
  }
  return history.find((entry) => entry.effectiveFrom > date)?.symbol ?? security.currentSymbol;
}

export interface PointInTimeUniverse {
  /** Ticker -> security id for the session (one id per ticker). */
  bySymbol: Map<string, string>;
  /** Member ids, sorted: ACTIVE and INACTIVE names listed on the date. */
  memberIds: string[];
  /** Provider records to bind (the symbol each member traded under on the date). */
  records: ProviderSecurityRecord[];
  /** Members that are INACTIVE in today's master (kept only because of this module). */
  inactiveMembers: number;
  /** Tickers claimed by several records on the date and dropped. */
  ambiguousSymbols: number;
}

export function pointInTimeUniverse(
  securities: readonly SecurityMasterRecord[],
  date: string,
  provider: string,
): PointInTimeUniverse {
  const claims = new Map<string, Array<{ security: SecurityMasterRecord; providerSecurityId: string }>>();
  for (const security of securities) {
    const identity = security.providerIdentities.find((item) => item.provider === provider);
    if (!identity) continue;
    const symbol = symbolOn(security, date);
    if (!symbol) continue;
    let list = claims.get(symbol);
    if (!list) claims.set(symbol, (list = []));
    list.push({ security, providerSecurityId: identity.providerSecurityId });
  }
  const bySymbol = new Map<string, string>();
  const records: ProviderSecurityRecord[] = [];
  let inactiveMembers = 0;
  let ambiguousSymbols = 0;
  for (const [symbol, list] of [...claims].sort((a, b) => a[0].localeCompare(b[0]))) {
    let winner = list.length === 1 ? list[0] : undefined;
    if (!winner) {
      const active = list.filter((item) => item.security.status === "ACTIVE");
      if (active.length === 1) winner = active[0];
    }
    if (!winner) {
      ambiguousSymbols += 1;
      continue;
    }
    const { security, providerSecurityId } = winner;
    if (security.status !== "ACTIVE") inactiveMembers += 1;
    bySymbol.set(symbol, security.securityId);
    records.push({
      provider,
      providerSecurityId,
      symbol,
      assetType: security.assetType,
      country: security.country,
      exchange: security.exchange,
      active: security.status === "ACTIVE",
      tradable: security.tradable,
      ...(security.listingDate === undefined ? {} : { listingDate: security.listingDate }),
    });
  }
  return { bySymbol, memberIds: [...bySymbol.values()].sort(), records, inactiveMembers, ambiguousSymbols };
}
