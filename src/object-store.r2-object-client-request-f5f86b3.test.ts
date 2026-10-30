import assert from "node:assert/strict";
import test from "node:test";
import { R2ObjectClient } from "./object-store";

// G18 (public-derive-wire-v1): every collaborator is a recorded, injected object-literal fake; a rejects / throws
// outcome may carry the error's fields (code, name, cause); the test reads no clock, environment, network, timer or
// global, and each outcome is captured, so a pre-edit failure is an assertion failure.
type ErrorFields = { code?: string; name?: string; cause?: { code?: string; name?: string; message?: string } };
type Outcome = { kind: "resolves" | "returns" | "rejects" | "throws"; value: () => unknown; error?: () => ErrorFields };
type Fake = ((...args: unknown[]) => unknown) & { calls: unknown[][] };
function failure(o: Outcome): Error {
  const f: ErrorFields = o.error ? o.error() : {};
  const e = f.cause === undefined ? new Error(String(o.value())) : new Error(String(o.value()), { cause: f.cause });
  if (f.code !== undefined) Object.assign(e, { code: f.code });
  if (f.name !== undefined) e.name = f.name;
  return e;
}
function fakeFn(outcomes: Outcome[]): Fake {
  const calls: unknown[][] = [];
  const fn = (...args: unknown[]): unknown => {
    calls.push(args);
    const o = outcomes[Math.min(calls.length, outcomes.length) - 1]!;
    if (o.kind === "returns") return o.value();
    if (o.kind === "resolves") return Promise.resolve(o.value());
    if (o.kind === "rejects") return Promise.reject(failure(o));
    throw failure(o);
  };
  return Object.assign(fn, { calls });
}
type Settled = { ok: true; value: unknown } | { ok: false; message: string };
async function settle(run: () => unknown): Promise<Settled> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}
function settleSync(run: () => unknown): Settled {
  try {
    return { ok: true, value: run() };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

test("PeaceAI G18 derive-wire v2: R2ObjectClient.request in src/object-store.ts (derived rethrow at the retry limit, injected fakes)", async () => {
  const fetchA = fakeFn([{ kind: "rejects", value: () => ("fetch failed"), error: () => ({ cause: { code: "ECONNRESET" } }) }]);
  const clockA = fakeFn([{ kind: "returns", value: () => (new Date("2026-10-29T00:00:00Z")) }]);
  const sleepA = fakeFn([{ kind: "resolves", value: () => (null) }]);
  const fetchU = fakeFn([{ kind: "rejects", value: () => ("bad https://a.r2.cloudflarestorage.com/b/d"), error: () => ({ name: "TypeError" }) }]);
  const sleepU = fakeFn([{ kind: "resolves", value: () => (null) }]);
  const fetchB = fakeFn([{ kind: "rejects", value: () => ("fetch failed") }, { kind: "resolves", value: () => (new Response(null, { status: 404 })) }]);
  const sleepB = fakeFn([{ kind: "resolves", value: () => (null) }]);
  assert.deepEqual(await settle(() => new R2ObjectClient({ accountId: "a", bucket: "b", accessKeyId: "k", secretAccessKey: "s", fetchImpl: fetchA, now: clockA, sleep: sleepA } as never).get("d" as never)), { ok: false, message: "R2_REQUEST_FAILED:GET:fetch failed" });
  assert.equal(fetchA.calls.length, 3);
  assert.deepEqual(await settle(() => new R2ObjectClient({ accountId: "a", bucket: "b", accessKeyId: "k", secretAccessKey: "s", fetchImpl: fetchU, now: clockA, sleep: sleepU } as never).get("d" as never)), { ok: false, message: "R2_REQUEST_FAILED:GET:TypeError" });
  assert.deepEqual(await settle(() => new R2ObjectClient({ accountId: "a", bucket: "b", accessKeyId: "k", secretAccessKey: "s", fetchImpl: fetchB, now: clockA, sleep: sleepB } as never).get("d" as never)), { ok: true, value: undefined });
  assert.equal(fetchB.calls.length, 2);
});
