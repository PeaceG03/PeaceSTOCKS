# PeaceSTOCKS Operations and Roadmap

## Operational philosophy

PeaceSTOCKS should remain useful even when:

- provider data is late;
- the computer restarts;
- a scheduled run is missed;
- the internet is temporarily unavailable;
- the cloud collector is unavailable;
- a provider revises historical data.

Failures must become explicit states, not silent missing data.

## Scanner operational loop

Intended daily EOD flow:

```text
market session
→ wait for session close
→ wait for provider publication availability
→ refresh universe
→ fetch grouped daily evidence
→ fetch corporate actions
→ validate/normalize
→ persist evidence
→ update eligibility
→ reconstruct features
→ rank universe
→ freeze beliefs/candidate sets
→ write run report
→ expose latest results
→ advance scheduler state
```

The durable scheduler cursor advances only after the required session is safely resolved.

## Provider availability state

Do not equate exchange close with provider readiness.

Operational states should distinguish:

- session still open;
- session complete;
- provider data not yet published;
- provider ready;
- scanner finalization complete;
- provider hard failure.

A publication-delay response is retryable and should not poison the session as permanently failed.

## Rate limiting

Provider request pacing must be global to the provider adapter, not independent per method.

Concurrent calls should not accidentally burst above the active plan.

The provider plan is an external constraint and may change, so current limits belong in configuration/documented adapter behavior rather than scattered assumptions.

## Retry policy

Retry only when safe and meaningful.

Examples:

- publication not ready: retry later;
- rate limited: bounded backoff;
- network failure: bounded backoff;
- invalid credential: human/external boundary;
- unsupported plan endpoint: change architecture or plan, do not hammer endpoint.

Never fabricate scanner results to complete a schedule.

## Catch-up

Historical evidence-only catch-up may fill missed sessions.

Catch-up must not create retroactive forward predictions.

Forward prediction availability remains:

- real forward prediction;
- unavailable/missed.

## Idempotency

Repeated collection of the same provider revision should not duplicate evidence.

Repeated scanner invocation for the same frozen forward decision should not silently create conflicting immutable records.

## Run health

Every run should make visible:

- session date;
- provider;
- universe size;
- bars received;
- missing securities;
- provider errors;
- quality status;
- eligibility counts;
- ranking count;
- prediction availability;
- output path;
- run duration;
- storage impact.

## Online production operation

The scanner's intended production path is **online**.

The production scanner should run on a hosted backend/worker so it does not depend on the user's desktop PC being powered on.

Required production responsibilities:

- provider secret stored in the deployment secret store;
- scheduled EOD execution;
- provider publication-readiness retry;
- global provider rate limiting;
- durable scheduler state;
- restart-safe execution;
- persistent scanner results;
- health/status reporting;
- stable result API/read surface.

The local development PC may run the same scanner for development and verification, but local execution is not the canonical production runtime.

## Local archive / mini-PC role

A local PC or future dedicated mini-PC remains useful for:

- long-term archive;
- verified cloud-to-local evidence sync;
- Strategy Lab/research compute;
- backups;
- offline inspection;
- emergency/fallback collection if intentionally enabled.

The local archive should not be required for the online scanner to finish a daily production run.

## Canonical online + local architecture

```text
Massive / Market Provider
          ↓
Online Collector + Scanner Worker
          ↓
Online Results / Health API
          ↓
Website / PeaceSTOCKS UI

Online Collector
          ↓
short validation/seal buffer
          ↓
verified sync + checksum/manifest
          ↓
Local Archive / Mini-PC
```

Online responsibilities:

- provider collection;
- scanner execution;
- retry/backoff;
- short-term buffering;
- result persistence;
- operational health;
- pending archive sync.

Local responsibilities:

- long-term canonical archive;
- Strategy Lab compute where appropriate;
- backups;
- offline inspection.

## PC-off continuity and deferred archive sync

The online production scanner must not pause, skip scanning, or lose evidence because the user's local PC is off.

When the local archive is unavailable:

- the online scanner continues scheduled collection and ranking;
- scanner results remain available online;
- newly sealed market evidence is marked pending local archive sync;
- the online retention buffer keeps that evidence until the local node returns.

When the local archive becomes available:

1. discover the pending sync range;
2. transfer sealed evidence;
3. verify manifest and checksum;
4. decode/validate the logical records;
5. commit them to the compact local archive;
6. record durable local acknowledgement;
7. mark the corresponding cloud evidence eligible for later purge.

Transfer attempt is not acknowledgement.

A failed, partial, corrupt, or interrupted transfer leaves the online copy retained and retryable.

### Local Dust archive requirement

The local archive is expected to use Dust, or a later validated successor, for compact long-term storage.

Dust is a physical encoding only. PeaceSTOCKS consumers must continue to receive canonical logical market evidence through the Reader abstraction.

The required read path is:

```text
Scanner / Strategy Lab / UI asks for historical evidence
    ↓
Reader locates archive blocks
    ↓
integrity verification
    ↓
Dust decode
    ↓
canonical logical records
    ↓
normal analysis / reconstruction / audit
```

The compact archive must remain fully usable whenever historical data is needed.

## Cloud deletion rule

Cloud evidence may be purged only after:

1. local transfer completes;
2. local archive validates checksum/manifest;
3. acknowledgement is persisted.

## Website

PeaceSTOCKS web UI is a presentation/control layer.

It should show:

- scanner candidates;
- ranking breakdown;
- run health;
- Strategy Lab;
- portfolio/risk later.

The website frontend is not the market collector.

## Immediate roadmap

### Milestone A — dedicated repo

Move PeaceSTOCKS into `PeaceG03/PeaceSTOCKS`.

Keep Scanner as first production subsystem.

### Milestone B — online real scanner

Deploy/prove the real Massive EOD full-universe scanner through the intended hosted backend path.

The production proof must not depend on the user's desktop PC remaining on.

### Milestone C — online repeatability

Prove idempotent rerun, restart recovery, provider-readiness retry, and consecutive scheduled online sessions.

### Milestone D — scanner user surface

Make latest results easy to retrieve.

Minimum:

- ticker;
- asset type;
- rank;
- family scores;
- run/session;
- health/errors.

### Milestone E — evidence/archive stabilization

Continue Foundation D physical-format evaluation independently from scanner uptime.

### Milestone F — Strategy Lab V0

Run paper strategies against canonical archive.

### Milestone G — archive/sync maturity

Harden the already-online collector's verified cloud-to-local archive sync, retention, and recovery behavior.

### Milestone H — risk governor

Build deterministic live-capital boundary.

### Milestone I — paper broker/shadow

Validate execution/reconciliation without money.

### Milestone J — tiny live capital

Only after evidence and explicit user approval.

## Scanner operations completion standard

A scanner operational milestone requires:

- intended real provider reached;
- intended real universe retrieved;
- real market evidence;
- ranking on real data;
- terminal run result;
- explicit incomplete/error handling;
- durable result retrieval;
- restart/rerun safety;
- no fixture masquerading as production.

## Future production maturity

Eventually operational health should include:

- collector heartbeat;
- last provider success;
- last complete session;
- last frozen prediction;
- archive sync status;
- storage health;
- corruption/integrity alerts;
- strategy lab health;
- broker reconciliation health;
- risk governor state.
