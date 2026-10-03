import { securityId } from "./identity";

/** Frozen, provider-accessible fixture for the first four-day storage baseline. */
export const PEACESTOCKS_STORAGE_BENCHMARK = {
  schemaVersion: "peacestocks-4day-storage-baseline-v1",
  provider: "massive-stocks",
  dates: ["2026-08-31", "2026-09-01", "2026-09-02", "2026-09-03"],
  securities: [
    {
      securityId: securityId("massive-stocks", "SPY", "ETF"),
      providerSecurityId: "SPY",
      symbol: "SPY",
      assetType: "ETF",
    },
    {
      securityId: securityId("massive-stocks", "AAPL", "STOCK"),
      providerSecurityId: "AAPL",
      symbol: "AAPL",
      assetType: "STOCK",
    },
    {
      securityId: securityId("massive-stocks", "QQQ", "ETF"),
      providerSecurityId: "QQQ",
      symbol: "QQQ",
      assetType: "ETF",
    },
  ],
  selectionRationale:
    "Recent completed sessions accessible at the required intraday resolution; SPY, AAPL, and QQQ are a small frozen stock/ETF representative fixture, not a full-universe projection.",
  logicalSchema: "foundation-d.1-10m-v1",
  intervalMinutes: 10,
} as const;

export type StorageBenchmarkDate = (typeof PEACESTOCKS_STORAGE_BENCHMARK.dates)[number];
