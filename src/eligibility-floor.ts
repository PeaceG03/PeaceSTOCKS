/**
 * Eligibility floor for every stock list (docs/SCANNER.md "Eligibility floor"). A fixed rule from
 * config/eligibility-floor-v1.json, chosen before looking at the held-out window and not tuned on it:
 *
 * - price: the split-adjusted last close on or before the scanned session is at least minLastCloseUsd;
 * - liquidity: the median dollar volume (close x volume) of the last dollarVolumeSessions bars is at
 *   least minMedianDollarVolumeUsd (split-invariant: adjusted close x adjusted volume);
 * - history: at least minHistorySessions sessions with a stored bar in the scan's bar window.
 *
 * A name failing any is left out of ranking (so out of every list) and counted by reason.
 */
import { readFileSync } from "node:fs";
import type { CanonicalDailyBar } from "./contracts";

export interface EligibilityFloor {
  readonly version: string;
  readonly minLastCloseUsd: number;
  readonly minMedianDollarVolumeUsd: number;
  readonly dollarVolumeSessions: number;
  readonly minHistorySessions: number;
}

export type FloorExclusion = "FLOOR_HISTORY" | "FLOOR_PRICE" | "FLOOR_DOLLAR_VOLUME";

const KEYS = ["dollarVolumeSessions", "minHistorySessions", "minLastCloseUsd", "minMedianDollarVolumeUsd", "version"];

function fail(why: string): never {
  throw new Error(`ELIGIBILITY_FLOOR_INVALID:${why}`);
}

/** Strict: exactly the known keys, numbers in sane ranges, whole session counts. */
export function parseEligibilityFloor(text: string): EligibilityFloor {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    fail("NOT_JSON");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("NOT_AN_OBJECT");
  const record = raw as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== KEYS.length || keys.some((key, i) => key !== KEYS[i])) fail("KEYS");
  if (typeof record.version !== "string" || !/^eligibility-floor-v[0-9]+$/u.test(record.version)) fail("version");
  const number = (name: string, min: number, max: number, integer = false) => {
    const value = record[name];
    if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) fail(name);
    if (integer && !Number.isInteger(value)) fail(name);
  };
  number("minLastCloseUsd", 0, 1000);
  number("minMedianDollarVolumeUsd", 0, 1e10);
  number("dollarVolumeSessions", 1, 100, true);
  number("minHistorySessions", 1, 100, true);
  return Object.freeze({ ...record }) as unknown as EligibilityFloor;
}

export const ELIGIBILITY_FLOOR_FILE = new URL("../config/eligibility-floor-v1.json", import.meta.url);

/** The floor every scan applies. */
export const ELIGIBILITY_FLOOR: EligibilityFloor = parseEligibilityFloor(readFileSync(ELIGIBILITY_FLOOR_FILE, "utf8"));

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Why a name fails the floor, or undefined when it passes. `bars`: one split-adjusted bar per session,
 * oldest first, none after the scanned session (what rankSecurities feeds the features).
 */
export function floorExclusion(bars: readonly CanonicalDailyBar[], floor: EligibilityFloor): FloorExclusion | undefined {
  if (bars.length < floor.minHistorySessions) return "FLOOR_HISTORY";
  const last = bars.at(-1)!.close;
  if (!(Number.isFinite(last) && last >= floor.minLastCloseUsd)) return "FLOOR_PRICE";
  const dollars = bars.slice(-floor.dollarVolumeSessions).map((bar) => bar.close * bar.volume);
  const med = median(dollars.map((v) => (Number.isFinite(v) ? v : 0)));
  if (!(med >= floor.minMedianDollarVolumeUsd)) return "FLOOR_DOLLAR_VOLUME";
  return undefined;
}
