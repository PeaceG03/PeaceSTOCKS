import { createHash } from "node:crypto";
import type { CanonicalTenMinuteBar, IntradayIntervalState } from "./contracts";
import { FROZEN_PACKED_FIXTURE_HASH } from "./packed-dust";

export const REGENERABLE_FIXTURE_ID = "peacestocks-regenerable-packed-v1";
export const REGENERABLE_FIXTURE_SEED = "PEACESTOCKS_REGENERABLE_PACKED_FIXTURE_V1";
export const LEGACY_FIXTURE_UNREPRODUCIBLE =
  "The peacestocks-synthetic-foundation-d1-v1 generator is not in this repo or the PeaceAI checkout, so 7d70c208667c51c5f7156d90cbefb4c9a557703d599e26773706d1a228661ecd cannot be reproduced.";

const STATES: readonly IntradayIntervalState[] = [
  "VALID_TRADED",
  "NO_TRADE",
  "HALTED",
  "PARTIAL",
  "PROVIDER_MISSING",
  "SOURCE_FAILURE",
];

function unit(index: number): number {
  const hex = createHash("sha256").update(`${REGENERABLE_FIXTURE_SEED}:${index}`).digest("hex");
  return parseInt(hex.slice(0, 8), 16) / 0xffffffff;
}

function quarter(index: number): number {
  return Math.round(unit(index) * 400) / 4;
}

export function regenerablePackedFixture(): CanonicalTenMinuteBar[] {
  const sessions = ["2026-01-21", "2026-01-22"];
  const bars: CanonicalTenMinuteBar[] = [];
  let n = 0;
  for (let security = 0; security < 8; security += 1) {
    for (const sessionDate of sessions) {
      for (let intervalIndex = 0; intervalIndex < 4; intervalIndex += 1) {
        const state = STATES[Math.floor(unit(n) * STATES.length)] ?? "VALID_TRADED";
        n += 1;
        const close = 20 + quarter(n);
        n += 1;
        const traded = state === "VALID_TRADED" || state === "PARTIAL" || state === "HALTED";
        bars.push({
          securityId: `sec_${String(security).padStart(4, "0")}`,
          sessionDate,
          intervalIndex,
          state,
          ...(traded
            ? {
                open: close,
                high: close + 0.25,
                low: close - 0.25,
                close,
                volume: 1000 + security * 10 + intervalIndex,
                transactionCount: 2 + intervalIndex,
              }
            : {}),
          observedAt: `${sessionDate}T15:00:00Z`,
          ingestedAt: `${sessionDate}T15:01:00Z`,
          dataQuality: traded ? "GOOD" : "MISSING",
          corporateActionIds: security === 1 && intervalIndex === 0 ? ["ca-1"] : [],
          flags: [state],
          schemaVersion: "foundation-d.1-10m-v1",
          revision: 1,
          provenance: {
            provider: "regenerable-fixture",
            dataset: "ten-minute",
            retrievalId: `${REGENERABLE_FIXTURE_ID}:${sessionDate}`,
            ingestionVersion: "test",
            normalizerVersion: "test",
          },
        });
      }
    }
  }
  return bars;
}

export function legacyFixtureCannotBeReproduced(): boolean {
  return LEGACY_FIXTURE_UNREPRODUCIBLE.includes(FROZEN_PACKED_FIXTURE_HASH);
}
