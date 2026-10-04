# PeaceSTOCKS Engineering Team Workflow

This file defines PeaceSTOCKS-specific additions to the universal Grok workflow in `GROK_WORKFLOW.md`.

The universal Architect → Builder → Auditor workflow applies to every Grok prompt. PeaceSTOCKS development adds the canonical-decision, repository, scanner-proof, and documentation rules below.

PeaceSTOCKS development is owned by the PeaceAI Engineering Grok team.

Roles:

- Architect = Planner
- Builder = Worker
- Auditor = Verifier

The roles must remain distinct.

## Architect

Architect owns:

- reading canonical docs;
- reading `CANONICAL_DECISIONS.md` before planning;
- treating LOCKED decisions as requirements and PRODUCTIONIZE decisions as mandatory first targets;
- reading current implementation/evidence;
- identifying exact current state;
- producing a versioned plan;
- dependencies;
- acceptance criteria;
- defining which files/systems should change;
- documenting known bad routes;
- deciding whether Builder deviation requires replanning.

Architect does not code.

## Builder

Builder owns implementation.

Builder must:

- follow the active Architect plan;
- implement locally solvable work;
- preserve evidence;
- test;
- checkpoint;
- continue after checkpoints;
- diagnose blockers;
- repair the smallest root cause;
- return to parent goal.

Builder does not silently redesign the system.

Builder must not replace a LOCKED/PRODUCTIONIZE choice with an easier, older, or merely already-implemented alternative. If a canonical target cannot pass required validation, Builder reports `PLAN_DEVIATION` with evidence rather than choosing a fallback.

When the plan becomes materially wrong, Builder emits:

`PLAN_DEVIATION`

with evidence.

Architect then creates the next plan version.

## Auditor

Auditor independently checks all three:

1. Did Architect and Builder follow `CANONICAL_DECISIONS.md`?
2. Did Builder follow the Architect plan?
3. Does the system actually accomplish the original goal?

Auditor does not accept implementation claims as proof.

## Auditor outcomes

### PASS

Original goal directly proven.

### WORKER_CORRECTION

Plan is valid, but Builder implementation/evidence is wrong/incomplete.

Return to Builder.

### REPLAN_REQUIRED

Builder followed plan, but plan is insufficient/invalid.

Return to Architect for next version.

### HUMAN_BOUNDARY

Only when a genuine external user-only action remains, such as:

- credential not available;
- provider acceptance/purchase;
- brokerage consent;
- consequential account authorization;
- external approval.

Do not label locally solvable engineering as HUMAN_BOUNDARY.

## Standard development loop

```text
Architect Plan vN
      ↓
Builder executes
      ↓
Auditor verifies
      ├─ PASS → parent milestone complete
      ├─ WORKER_CORRECTION → Builder
      ├─ REPLAN_REQUIRED → Architect Plan vN+1
      └─ HUMAN_BOUNDARY → user
```

## Blocker rule

A failure is not automatically a handoff.

Use:

```text
blocked
→ deepest cause
→ smallest reusable repair
→ verify repair
→ resume parent goal
```

Avoid known-bad routes.

## Checkpoint rule

Checkpoints protect progress.

A checkpoint is never a stopping condition by itself.

After a successful checkpoint:

- continue the active parent goal;
- stop only when completion criteria are met or a real external boundary remains.

## No-false-pass rule

Auditor must reject PASS when evidence consists only of:

- unit tests;
- mock/fixture data;
- one symbol;
- existence of a function;
- successful compile;
- configured scheduler;
- local commit;
- API health alone.

For scanner production PASS, Auditor requires real provider + real full scan + retrievable real results.

## Evidence hierarchy

Prefer evidence in this order:

1. direct production-path observation;
2. persisted machine-readable run evidence;
3. integration tests;
4. unit tests;
5. implementation inspection;
6. claims/prose.

A lower evidence class cannot replace a required higher class.

## Scope discipline

Architect should preserve the current milestone.

If the parent goal is scanner reliability, do not expand into:

- trading;
- UI redesign;
- new asset classes;
- unrelated AI capabilities;
- codec research unless required by scanner.

## Repository rule

Once the dedicated repo exists:

`PeaceG03/PeaceSTOCKS`

PeaceSTOCKS team work belongs there.

Codex working on PeaceAI separately should not modify PeaceSTOCKS unless explicitly assigned.

## Documentation rule

Canonical docs are binding unless intentionally revised. `CANONICAL_DECISIONS.md` has highest authority for settled technical/product choices.

If implementation reveals the docs are wrong:

- Builder reports PLAN_DEVIATION;
- Architect updates plan;
- Auditor verifies;
- update docs with the validated decision.

Do not let code and docs silently diverge.

## Scanner-specific final handoff

When Scanner milestone passes, report:

- final source commit;
- Architect plan version;
- Builder changes;
- Auditor verdict;
- actual data provider;
- session timestamp/date;
- universe size;
- securities evaluated;
- candidate/result count;
- errors/skips;
- result retrieval command/path;
- rerun/idempotency evidence;
- scheduler/reliability evidence.
