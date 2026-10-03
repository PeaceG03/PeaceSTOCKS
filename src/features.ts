import type { CanonicalDailyBar, DerivedFeatures, FeatureRecipe } from "./contracts";
import { FEATURE_RECIPES, FEATURE_RECIPE_VERSIONS } from "./recipes";

export { FEATURE_RECIPES, FEATURE_RECIPE_VERSIONS };

function returns(closes: number[], lookback: number): number | null {
  if (closes.length <= lookback) return null;
  const prior = closes[closes.length - 1 - lookback];
  const current = closes[closes.length - 1];
  return prior !== undefined && current !== undefined && prior !== 0 ? current / prior - 1 : null;
}

function sampleVolatility(closes: number[]): number | null {
  if (closes.length < 22) return null;
  const values = closes
    .slice(-21)
    .map((close, index, values) => (index === 0 ? null : close / values[index - 1]! - 1))
    .filter((value): value is number => value !== null);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance * 252);
}

export function reconstructFeatures(
  securityId: string,
  asOfDate: string,
  bars: CanonicalDailyBar[],
  benchmarkBars: CanonicalDailyBar[] = [],
): DerivedFeatures {
  const ordered = bars
    .filter((bar) => bar.sessionDate <= asOfDate)
    .sort((a, b) => a.sessionDate.localeCompare(b.sessionDate) || a.revision - b.revision);
  const closes = ordered.map((bar) => bar.close);
  const benchmarkCloses = benchmarkBars
    .filter((bar) => bar.sessionDate <= asOfDate)
    .sort((a, b) => a.sessionDate.localeCompare(b.sessionDate))
    .map((bar) => bar.close);
  const return20 = returns(closes, 20);
  const values: Record<string, number | null> = {
    RETURN_5D: returns(closes, 5),
    RETURN_20D: return20,
    MOMENTUM_60D: returns(closes, 60),
    VOLATILITY_20D: sampleVolatility(closes),
    DRAWDOWN_60D:
      closes.length < 61 ? null : closes[closes.length - 1]! / Math.max(...closes.slice(-61)) - 1,
    AVG_DOLLAR_VOLUME_20D:
      ordered.length < 20
        ? null
        : ordered.slice(-20).reduce((sum, bar) => sum + bar.close * bar.volume, 0) / 20,
    RELATIVE_STRENGTH_MARKET_20D:
      return20 === null || benchmarkCloses.length <= 20
        ? null
        : return20 - returns(benchmarkCloses, 20)!,
  };
  return {
    securityId,
    asOfDate,
    values,
    recipeVersions: Object.fromEntries(
      FEATURE_RECIPES.map((recipe) => [recipe.featureId, recipe.version]),
    ),
  };
}

export function featureRecipe(featureId: string): FeatureRecipe | undefined {
  return FEATURE_RECIPES.find((recipe) => recipe.featureId === featureId);
}
