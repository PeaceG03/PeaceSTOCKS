import type {
  CanonicalDailyBar,
  DerivedFeatures,
  PredictionSet,
  ScannerBelief,
  ScannerConfig,
  SecurityMasterRecord,
} from "./contracts";
import { SCANNER_VERSION } from "./contracts";
import { reconstructFeatures } from "./features";
import { fingerprint, sha256 } from "./identity";

export const DEFAULT_SCANNER_CONFIG: ScannerConfig = {
  version: "scanner-config-v0.1",
  weights: { momentum: 0.25, trend: 0.2, relativeStrength: 0.2, risk: 0.2, liquidity: 0.15 },
  selectionThreshold: 0,
};

function normalized(values: Map<string, number | null>): Map<string, number> {
  const usable = [...values.entries()].filter(
    (entry): entry is [string, number] => entry[1] !== null && Number.isFinite(entry[1]),
  );
  if (!usable.length) return new Map();
  const min = Math.min(...usable.map((entry) => entry[1]));
  const max = Math.max(...usable.map((entry) => entry[1]));
  return new Map(
    usable.map(([id, value]) => [id, max === min ? 0.5 : (value - min) / (max - min)]),
  );
}

/**
 * Each security's bars up to `date`, in input order, grouped in one pass. (latestBars used to filter the
 * whole bars array once per security: O(securities x bars), ~9 min per session at ~10.7k securities.)
 */
function barsBySecurityUpTo(bars: CanonicalDailyBar[], date: string): Map<string, CanonicalDailyBar[]> {
  const grouped = new Map<string, CanonicalDailyBar[]>();
  for (const bar of bars) {
    if (bar.sessionDate > date) continue;
    const list = grouped.get(bar.securityId);
    if (list) list.push(bar);
    else grouped.set(bar.securityId, [bar]);
  }
  return grouped;
}

/** One bar per session (highest revision; later input wins a tie), oldest first. */
function latestBars(own: readonly CanonicalDailyBar[] | undefined): CanonicalDailyBar[] {
  const byDate = new Map<string, CanonicalDailyBar>();
  for (const bar of [...(own ?? [])].sort(
    (a, b) => a.sessionDate.localeCompare(b.sessionDate) || a.revision - b.revision,
  ))
    byDate.set(bar.sessionDate, bar);
  return [...byDate.values()].sort((a, b) => a.sessionDate.localeCompare(b.sessionDate));
}

export interface RankedSecurity {
  securityId: string;
  features: DerivedFeatures;
  familyScores: Record<string, number>;
  overallScore: number;
}

export interface RankingResult {
  beliefs: ScannerBelief[];
  ranked: RankedSecurity[];
  predictions: PredictionSet[];
}

export function rankSecurities(
  securities: SecurityMasterRecord[],
  bars: CanonicalDailyBar[],
  benchmarkBars: CanonicalDailyBar[],
  sessionDate: string,
  config: ScannerConfig = DEFAULT_SCANNER_CONFIG,
): RankingResult {
  const eligible = securities.filter(
    (security) =>
      security.status === "ACTIVE" &&
      (security.eligibility === "LEVEL_2" || security.eligibility === "LEVEL_3"),
  );
  const bySecurity = barsBySecurityUpTo(bars, sessionDate);
  const latestById = new Map<string, CanonicalDailyBar[]>();
  const latestFor = (id: string): CanonicalDailyBar[] => {
    let found = latestById.get(id);
    if (!found) latestById.set(id, (found = latestBars(bySecurity.get(id))));
    return found;
  };
  const featureById = new Map<string, DerivedFeatures>();
  for (const security of eligible)
    featureById.set(
      security.securityId,
      reconstructFeatures(
        security.securityId,
        sessionDate,
        latestFor(security.securityId),
        benchmarkBars,
      ),
    );
  const momentum = normalized(
    new Map(
      [...featureById].map(([id, features]): [string, number | null] => [
        id,
        features.values.MOMENTUM_60D ?? features.values.RETURN_20D ?? null,
      ]),
    ),
  );
  const trend = normalized(
    new Map(
      [...featureById].map(([id, features]): [string, number | null] => [
        id,
        features.values.RETURN_20D ?? null,
      ]),
    ),
  );
  const relativeStrength = normalized(
    new Map(
      [...featureById].map(([id, features]): [string, number | null] => [
        id,
        features.values.RELATIVE_STRENGTH_MARKET_20D ?? null,
      ]),
    ),
  );
  const risk = normalized(
    new Map(
      [...featureById].map(([id, features]): [string, number | null] => {
        const volatility = features.values.VOLATILITY_20D;
        return [id, volatility === undefined || volatility === null ? null : -volatility];
      }),
    ),
  );
  const liquidity = normalized(
    new Map(
      [...featureById].map(([id, features]): [string, number | null] => [
        id,
        features.values.AVG_DOLLAR_VOLUME_20D ?? null,
      ]),
    ),
  );
  const ranked: RankedSecurity[] = [...featureById]
    .map(([securityId, features]) => {
      const familyScores = {
        momentum: momentum.get(securityId) ?? 0,
        trend: trend.get(securityId) ?? 0,
        relativeStrength: relativeStrength.get(securityId) ?? 0,
        risk: risk.get(securityId) ?? 0,
        liquidity: liquidity.get(securityId) ?? 0,
      };
      const overallScore =
        familyScores.momentum * config.weights.momentum +
        familyScores.trend * config.weights.trend +
        familyScores.relativeStrength * config.weights.relativeStrength +
        familyScores.risk * config.weights.risk +
        familyScores.liquidity * config.weights.liquidity;
      return { securityId, features, familyScores, overallScore };
    })
    .sort((a, b) => b.overallScore - a.overallScore || a.securityId.localeCompare(b.securityId));
  const rankById = new Map(
    ranked.map((item, index) => [item.securityId, { item, rank: index + 1 }]),
  );
  const configFingerprint = fingerprint(config);
  const beliefs: ScannerBelief[] = securities.map((security) => {
    const selected = rankById.get(security.securityId);
    const evidenceAsOfFingerprint = sha256(
      JSON.stringify(latestFor(security.securityId)),
    );
    const meaningfulDecision = selected
      ? selected.item.overallScore >= config.selectionThreshold
        ? "RANKED"
        : "BELOW_SELECTION_THRESHOLD"
      : security.eligibility === "LEVEL_0" || security.eligibility === "LEVEL_1"
        ? "INSUFFICIENT_HISTORY"
        : "NOT_ELIGIBLE";
    return {
      decisionId: `belief_${sha256(`${security.securityId}|${sessionDate}|${SCANNER_VERSION}|${configFingerprint}`)}`,
      securityId: security.securityId,
      sessionDate,
      eligibility: security.eligibility,
      ...(selected ? { overallRank: selected.rank } : {}),
      familyScores: selected?.item.familyScores ?? {},
      meaningfulDecision,
      scannerVersion: SCANNER_VERSION,
      featureRecipeVersions: selected?.item.features.recipeVersions ?? {},
      configFingerprint,
      evidenceAsOfFingerprint,
    };
  });
  const rankedIds = ranked.map((item) => item.securityId);
  const strongestMomentum = [...ranked]
    .sort(
      (a, b) =>
        (b.features.values.MOMENTUM_60D ?? b.features.values.RETURN_20D ?? -Infinity) -
          (a.features.values.MOMENTUM_60D ?? a.features.values.RETURN_20D ?? -Infinity) ||
        a.securityId.localeCompare(b.securityId),
    )
    .map((item) => item.securityId);
  const defensive = [...ranked]
    .sort(
      (a, b) =>
        (b.familyScores.risk ?? 0) - (a.familyScores.risk ?? 0) ||
        a.securityId.localeCompare(b.securityId),
    )
    .map((item) => item.securityId);
  const frozenAt = `${sessionDate}T23:59:59.999Z`;
  const sets: Array<[PredictionSet["setType"], string[]]> = [
    ["TOP_15_OVERALL", rankedIds.slice(0, 15)],
    ["TOP_50_OVERALL", rankedIds.slice(0, 50)],
    ["STRONGEST_MOMENTUM", strongestMomentum.slice(0, 15)],
    ["FASTEST_IMPROVING", rankedIds.slice(0, 15)],
    ["DEFENSIVE_LOW_RISK", defensive.slice(0, 15)],
  ];
  const predictions = sets.map(([setType, securityIds]) => ({
    predictionId: `prediction_${sha256(`${sessionDate}|${setType}|${SCANNER_VERSION}|${configFingerprint}`)}`,
    sessionDate,
    setType,
    securityIds,
    scannerVersion: SCANNER_VERSION,
    configFingerprint,
    frozenAt,
  }));
  return { beliefs, ranked, predictions };
}
