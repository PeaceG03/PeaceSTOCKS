/**
 * Prediction-status identity and session resolution (S1).
 *
 * Add-only ids: prediction-status_<runId>_<first 16 hex of sha256(canonical body without id)>.
 * Identical content reuses the same id (writeImmutable no-op); different content gets a new id.
 * Legacy ids prediction-status_<runId> (no content suffix) remain readable.
 */

import type { PredictionStatus } from "./contracts";
import { sha256, stableJson } from "./identity";
import type { MarketStore } from "./storage";

export type PredictionStatusBody = Omit<PredictionStatus, "predictionStatusId">;

/** Content-addressed id; first 16 hex of sha256(stableJson(body without id)). */
export function predictionStatusContentId(runId: string, body: PredictionStatusBody): string {
  const digest = sha256(stableJson(body)).slice(0, 16);
  return `prediction-status_${runId}_${digest}`;
}

export function makePredictionStatus(runId: string, body: PredictionStatusBody): PredictionStatus {
  return { ...body, predictionStatusId: predictionStatusContentId(runId, body) };
}

/**
 * Resolve the effective prediction status for a session.
 * - If any record is FROZEN, pick among FROZEN only (newest attemptedAt / recordedAt).
 * - Otherwise pick among all records by real attempt time:
 *   newest `attemptedAt` (ISO UTC) wins; records missing `attemptedAt` (old-style) count as oldest.
 * Tie-break when times equal: `predictionStatusId` ascending (stable).
 * Accepts both content-addressed ids and legacy `prediction-status_<runId>` ids.
 */
export function resolveSessionPredictionStatus(
  records: readonly PredictionStatus[],
): PredictionStatus | undefined {
  if (!records.length) return undefined;
  const frozen = records.filter((r) => r.status === "FROZEN");
  const pool = frozen.length ? frozen : records;
  return [...pool].sort((a, b) => {
    const aAt = a.attemptedAt ?? "";
    const bAt = b.attemptedAt ?? "";
    // Missing attemptedAt sorts as oldest (empty string < any ISO timestamp).
    if (aAt !== bAt) return bAt.localeCompare(aAt);
    // Fallback for frozen-only ties that also lack attemptedAt: recordedAt then id.
    const byRecorded = b.recordedAt.localeCompare(a.recordedAt);
    if (byRecorded !== 0) return byRecorded;
    return a.predictionStatusId.localeCompare(b.predictionStatusId);
  })[0];
}

/** True when predictions/<D>.jsonl has any record, or any status for D is FROZEN. */
export async function sessionAlreadyFrozen(
  storage: MarketStore,
  sessionDate: string,
): Promise<boolean> {
  const predictions = await storage.loadPredictions(sessionDate);
  if (predictions.length > 0) return true;
  const statuses = await storage.loadPredictionStatuses(sessionDate);
  return statuses.some((s) => s.status === "FROZEN");
}
