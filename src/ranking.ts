import type {
  CanonicalDailyBar,
  CorporateAction,
  DerivedFeatures,
  PredictionSet,
  ScannerBelief,
  ScannerConfig,
  SecurityMasterRecord,
} from "./contracts";
import { SCANNER_VERSION } from "./contracts";
import { reconstructFeatures } from "./features";
import { fingerprint, sha256 } from "./identity";
import { ELIGIBILITY_FLOOR, floorExclusion, type EligibilityFloor, type FloorExclusion } from "./eligibility-floor";
import { splitAdjustedBars, splitEventsBySecurity, type SplitExclusion } from "./split-adjust";

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

/** Recipe of the FASTEST_IMPROVING list (stored on the set and part of its predictionId). */
export const FASTEST_IMPROVING_RECIPE = "fastest-improving-return20-delta-v1";
/** Closes needed for the improvement value: the latest close plus 40 before it. */
export const IMPROVEMENT_MIN_CLOSES = 41;

/**
 * Improvement: the 20-session return to the latest close minus the 20-session return just before
 * it, from one bar per session (oldest first). Null with fewer than 41 closes or a zero close.
 */
export function improvementValue(closes: readonly number[]): number | null {
  if (closes.length < IMPROVEMENT_MIN_CLOSES) return null;
  const at = (back: number) => closes[closes.length - 1 - back]!;
  if (at(20) === 0 || at(40) === 0) return null;
  const value = at(0) / at(20) - 1 - (at(20) / at(40) - 1);
  return Number.isFinite(value) ? value : null;
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
  /** Eligible names left out because their splits could not be adjusted honestly (absent when none). */
  excluded?: Array<{ securityId: string; reason: SplitExclusion }>;
  /** Eligible names left out by the eligibility floor (price, dollar volume, history); absent when none or no floor. */
  floorExcluded?: Array<{ securityId: string; reason: FloorExclusion }>;
  /** Active names left out because they are not stocks (ETFs); absent when none. */
  nonStockExcluded?: number;
}

/** The only security-master type that may appear in a pick list. */
export const STOCK_LIST_ASSET_TYPE = "STOCK" as const;

export function rankSecurities(
  securities: SecurityMasterRecord[],
  bars: CanonicalDailyBar[],
  benchmarkBars: CanonicalDailyBar[],
  sessionDate: string,
  config: ScannerConfig = DEFAULT_SCANNER_CONFIG,
  splitActions: readonly CorporateAction[] = [],
  /** The eligibility floor (src/eligibility-floor.ts); null turns it off (held-out eval comparison only). */
  floor: EligibilityFloor | null = ELIGIBILITY_FLOOR,
): RankingResult {
  const active = securities.filter(
    (security) =>
      security.status === "ACTIVE" &&
      (security.eligibility === "LEVEL_2" || security.eligibility === "LEVEL_3"),
  );
  // Stock lists hold stocks only: ETFs (and any other non-STOCK type in the security master) are left
  // out here. They stay in the master and in the bars, so SPY is still the market benchmark.
  const eligible = active.filter((security) => security.assetType === STOCK_LIST_ASSET_TYPE);
  const nonStockExcluded = active.length - eligible.length;
  const bySecurity = barsBySecurityUpTo(bars, sessionDate);
  const latestById = new Map<string, CanonicalDailyBar[]>();
  const latestFor = (id: string): CanonicalDailyBar[] => {
    let found = latestById.get(id);
    if (!found) latestById.set(id, (found = latestBars(bySecurity.get(id))));
    return found;
  };
  // Features use split-adjusted closes (stored bars are unadjusted); names whose splits cannot be
  // reconciled are left out. The evidence fingerprint below still hashes the raw bars.
  const splits = splitEventsBySecurity(splitActions);
  const adjustedById = new Map<string, CanonicalDailyBar[]>();
  const excluded: Array<{ securityId: string; reason: SplitExclusion }> = [];
  const floorExcluded: Array<{ securityId: string; reason: FloorExclusion }> = [];
  for (const security of eligible) {
    const adjusted = splitAdjustedBars(latestFor(security.securityId), splits.get(security.securityId), sessionDate);
    if ("excluded" in adjusted) {
      excluded.push({ securityId: security.securityId, reason: adjusted.excluded });
      continue;
    }
    const below = floor ? floorExclusion(adjusted.bars, floor, sessionDate) : undefined;
    if (below) floorExcluded.push({ securityId: security.securityId, reason: below });
    else adjustedById.set(security.securityId, adjusted.bars);
  }
  const featureById = new Map<string, DerivedFeatures>();
  for (const [securityId, adjusted] of adjustedById)
    featureById.set(securityId, reconstructFeatures(securityId, sessionDate, adjusted, benchmarkBars));
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
  // The floor changes the lists, so its version is part of the lists' fingerprint (and predictionId).
  // Production lists (floor on) name the floor version and the stocks-only rule. The floor-off path
  // exists only for the held-out comparison and keeps the old fingerprint (pinned test hashes).
  const configFingerprint = fingerprint(
    floor ? { ...config, eligibilityFloor: floor.version, listAssetType: STOCK_LIST_ASSET_TYPE } : config,
  );
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
  // Its own list (it used to copy TOP_15_OVERALL): ranked names with an improvement value, largest
  // first, ties by id. None has enough history: empty and marked unavailable, never filled from overall.
  const improving = ranked
    .map((item) => ({ id: item.securityId, value: improvementValue(adjustedById.get(item.securityId)!.map((bar) => bar.close)) }))
    .filter((entry): entry is { id: string; value: number } => entry.value !== null)
    .sort((a, b) => b.value - a.value || a.id.localeCompare(b.id))
    .map((entry) => entry.id);
  const frozenAt = `${sessionDate}T23:59:59.999Z`;
  const sets: Array<[PredictionSet["setType"], string[]]> = [
    ["TOP_15_OVERALL", rankedIds.slice(0, 15)],
    ["TOP_50_OVERALL", rankedIds.slice(0, 50)],
    ["STRONGEST_MOMENTUM", strongestMomentum.slice(0, 15)],
    ["FASTEST_IMPROVING", improving.slice(0, 15)],
    ["DEFENSIVE_LOW_RISK", defensive.slice(0, 15)],
  ];
  const predictions = sets.map(([setType, securityIds]): PredictionSet => {
    const improvingSet = setType === "FASTEST_IMPROVING";
    return {
      predictionId: `prediction_${sha256(
        `${sessionDate}|${setType}|${SCANNER_VERSION}|${configFingerprint}${improvingSet ? `|${FASTEST_IMPROVING_RECIPE}` : ""}`,
      )}`,
      sessionDate,
      setType,
      securityIds,
      scannerVersion: SCANNER_VERSION,
      configFingerprint,
      frozenAt,
      ...(improvingSet ? { recipeVersion: FASTEST_IMPROVING_RECIPE } : {}),
      ...(improvingSet && ranked.length > 0 && securityIds.length === 0
        ? { unavailableReason: "INSUFFICIENT_HISTORY" as const }
        : {}),
    };
  });
  return {
    beliefs,
    ranked,
    predictions,
    ...(excluded.length ? { excluded } : {}),
    ...(floorExcluded.length ? { floorExcluded } : {}),
    ...(nonStockExcluded ? { nonStockExcluded } : {}),
  };
}
