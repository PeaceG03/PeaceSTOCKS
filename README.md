# PeaceSTOCKS

Standalone repository for the PeaceSTOCKS markets scanner. Migrated from PeaceAI `packages/markets-scanner` (`@peaceai/markets-scanner`) without deleting the original. The only PeaceAI runtime dependency, store-path safety, now lives in `src/store-path.ts`. Package name in this repo is `@peacestocks/markets-scanner`. Environment variable names are unchanged. This migration does not claim the scanner is production-ready.

# PeaceAI Markets Scanner V0

This package is the provider-neutral Foundation D evidence layer for approved U.S. stocks and ETFs. It stores source OHLCV observations, security lifecycle and universe membership evidence, corporate actions, correction lineage, immutable scanner beliefs, frozen candidate sets, partition manifests, and measured storage reports.

The package intentionally contains no brokerage or trading connector. MarketProvider is the ingestion boundary: a licensed provider adapter normalizes its records into this contract before a scheduled daily run. MassiveMarketProvider is the read-only Stocks REST adapter for the initial live collection path. It requires the operator to supply MASSIVE_API_KEY outside the repository; the key is never persisted in evidence, reports, logs, or Git. FileMarketProvider remains available for deterministic fixture certification.

Massive Stocks Basic is suitable for the initial end-of-day clock because its current plan includes reference tickers, daily market summaries, splits, and dividends. The current Basic limits and data-retention/licensing terms remain provider obligations: the adapter uses a bounded five-calls-per-minute-compatible interval by default, requests unadjusted grouped daily bars, and does not claim historical coverage beyond the active provider plan. A full-universe run must be executed only after the operator has accepted the provider market-data terms and configured the secret through the deployment secret store.

The scanners scheduled entry is runDueCollection. It deliberately separates the due decision from hosting: a governed service, task scheduler, or existing PeaceAI scheduler invokes it, while durable run reports and idempotent storage provide missed-session recovery. This source package does not install an operating-system scheduler or call a live provider during tests.

Storage is separated into permanent/ evidence, cache/ rebuildable derived material, and transient/ cleanup workspace. Daily bars are raw/unadjusted source evidence; adjustments and technical features are reconstructed from evidence plus versioned recipes.

Historical evidence backfill is run with `pnpm --filter @peaceai/markets-scanner backfill -- --from YYYY-MM-DD --to YYYY-MM-DD`. It is evidence-only, resumable via `backfill-state.json`, idempotent, and never creates scanner beliefs or predictions. Prediction availability is recorded separately under `permanent/prediction-status/` so a provider failure cannot be confused with a valid empty candidate set.
