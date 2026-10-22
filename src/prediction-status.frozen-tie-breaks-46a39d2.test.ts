import assert from "node:assert/strict";
import test from "node:test";
import { resolveSessionPredictionStatus } from "./prediction-status";

test("frozen tie-breaks", () => {
  assert.equal(resolveSessionPredictionStatus([]), undefined);
  assert.deepEqual(resolveSessionPredictionStatus([{ predictionStatusId: "b", sessionDate: "2026-10-13", status: "FROZEN", reason: "PREDICTIONS_FROZEN", scannerVersion: "v", configFingerprint: "c", recordedAt: "2026-10-13T13:00:00Z", supersedesPredictionIds: [] }, { predictionStatusId: "a", sessionDate: "2026-10-13", status: "FROZEN", reason: "PREDICTIONS_FROZEN", scannerVersion: "v", configFingerprint: "c", recordedAt: "2026-10-13T14:00:00Z", supersedesPredictionIds: [] }]), { predictionStatusId: "a", sessionDate: "2026-10-13", status: "FROZEN", reason: "PREDICTIONS_FROZEN", scannerVersion: "v", configFingerprint: "c", recordedAt: "2026-10-13T14:00:00Z", supersedesPredictionIds: [] });
  assert.deepEqual(resolveSessionPredictionStatus([{ predictionStatusId: "b", sessionDate: "2026-10-13", status: "FROZEN", reason: "PREDICTIONS_FROZEN", scannerVersion: "v", configFingerprint: "c", recordedAt: "2026-10-13T13:00:00Z", supersedesPredictionIds: [] }, { predictionStatusId: "a", sessionDate: "2026-10-13", status: "FROZEN", reason: "PREDICTIONS_FROZEN", scannerVersion: "v", configFingerprint: "c", recordedAt: "2026-10-13T13:00:00Z", supersedesPredictionIds: [] }]), { predictionStatusId: "a", sessionDate: "2026-10-13", status: "FROZEN", reason: "PREDICTIONS_FROZEN", scannerVersion: "v", configFingerprint: "c", recordedAt: "2026-10-13T13:00:00Z", supersedesPredictionIds: [] });
});
