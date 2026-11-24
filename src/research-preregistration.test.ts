import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { AppendOnlyLog } from "./append-only-log";
import { RESEARCH_LEDGER_DIR } from "./research-harness-cli";
import type { VariantRecord } from "./research-variants";

interface PreregisteredCandidate {
  id: string;
  family: string;
  description: string;
  rationale: string;
  featuresUsed: string[];
  topN: number;
  rebalanceRule: string;
  status: string;
}

interface PreregistrationFile {
  version: string;
  developmentWindow: { from: string; to: string };
  heldOutWindow: { from: string; to: string };
  contaminationDisclosure: string;
  passBar: {
    requireEveryFoldPositive: boolean;
    minFolds: number;
    alphaHolm: number;
    minCostBpsPerSide: number;
    maxDrawdownNet: number;
    maxDrawdownSpyMultiple: number;
  };
  candidates: PreregisteredCandidate[];
}

test("pre-registration file lists <= 20 well-formed, unrun candidate scoring ideas with contamination guard", () => {
  const raw = readFileSync(new URL("../config/research-preregistration-v1.json", import.meta.url), "utf8");
  const doc = JSON.parse(raw) as PreregistrationFile;
  assert.equal(doc.version, "research-preregistration-v1");
  assert.deepEqual(doc.developmentWindow, { from: "2025-03-03", to: "2026-08-26" });
  assert.deepEqual(doc.heldOutWindow, { from: "2026-08-27", to: "2026-11-20" });
  assert.match(doc.contaminationDisclosure, /2026-08-27.*2026-11-19/u);
  assert.equal(doc.passBar.requireEveryFoldPositive, true);
  assert.equal(doc.passBar.minFolds, 3);
  assert.equal(doc.passBar.alphaHolm, 0.05);
  assert.equal(doc.passBar.minCostBpsPerSide, 10);
  assert.equal(doc.passBar.maxDrawdownNet, 0.15);
  assert.equal(doc.passBar.maxDrawdownSpyMultiple, 1.25);
  assert.ok(doc.candidates.length >= 1 && doc.candidates.length <= 20, `count=${doc.candidates.length}`);

  const ids = new Set<string>();
  for (const c of doc.candidates) {
    assert.ok(c.id.length > 0 && !ids.has(c.id), `duplicate/empty id: ${c.id}`);
    ids.add(c.id);
    assert.ok(c.family.length > 0 && c.description.length > 10 && c.rationale.length > 20, c.id);
    assert.ok(Array.isArray(c.featuresUsed) && c.featuresUsed.length >= 1, c.id);
    assert.ok(Number.isInteger(c.topN) && c.topN >= 10 && c.topN <= 50, c.id);
    assert.ok(c.rebalanceRule.length > 0, c.id);
    assert.equal(c.status, "NOT_RUN", `${c.id} must remain NOT_RUN in Phase 2a`);
  }


  // B2: no defensive/down-market or regime-switch candidates tuned around the peeked stretch
  assert.equal(doc.candidates.length, 13);
  for (const forbidden of ["low_vol_mom_quality_top30", "regime_vol_scaled_mom_top20", "regime_rev_vs_mom_top20"]) {
    assert.equal(ids.has(forbidden), false, `forbidden candidate: ${forbidden}`);
  }
  for (const c of doc.candidates) {
    assert.notEqual(c.family, "regime_conditioned", c.id);
    for (const feat of c.featuresUsed) {
      assert.equal(/^spy/u.test(feat), false, `${c.id} uses market regime feature ${feat}`);
    }
  }

  // Ledger must still contain only the 10 baseline records (no Phase 2 runs yet).
  const ledger = new AppendOnlyLog<VariantRecord>(`${RESEARCH_LEDGER_DIR}/variants.jsonl`).entries();
  assert.equal(ledger.length, 10);
});
