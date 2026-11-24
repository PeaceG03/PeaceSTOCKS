/**
 * Paper-trading run (simulated only; docs/PAPER_TRADING.md). Started by .github/workflows/paper-trading.yml
 * on main when the repository variable PAPER_TRADING_ENABLED is exactly "true".
 *
 * Gates are checked before any storage client is made. The scanner's data is read through a client that
 * refuses every write; the only writer is the append-only paper ledger (paper/v1/ keys only, no delete).
 * Output is one aggregate line: counts and session dates, never symbols or prices.
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ObjectMarketStorage } from "./object-storage";
import { R2ObjectClient, type ObjectClient } from "./object-store";
import { PaperLedgerStore, type PaperObjectClient } from "./paper-ledger";
import { loadPaperRules } from "./paper-rules";
import { paperGate, runPaperTrading, type PaperRunResult } from "./paper-trading";

/** Committing a file with this name at the repository root stops all new paper orders. */
export const PAPER_KILL_FILE = "PAPER_TRADING_KILL";

/** The scanner's data, read-only: put and delete throw. */
export function readOnlyObjectClient(client: ObjectClient): ObjectClient {
  return {
    putIfAbsent: async () => {
      throw new Error("PAPER_MARKET_READ_ONLY");
    },
    get: (key) => client.get(key),
    head: (key) => client.head(key),
    list: (prefix) => client.list(prefix),
    put: async () => {
      throw new Error("PAPER_MARKET_READ_ONLY");
    },
    delete: async () => {
      throw new Error("PAPER_MARKET_READ_ONLY");
    },
  };
}

/** The ledger's view of the bucket: get, create-only put (If-None-Match: *), list. No plain put, no delete. */
export function ledgerObjectClient(client: ObjectClient): PaperObjectClient {
  const putIfAbsent = client.putIfAbsent?.bind(client);
  if (!putIfAbsent) throw new Error("PAPER_LEDGER_NEEDS_CONDITIONAL_PUT");
  return {
    get: (key) => client.get(key),
    putIfAbsent: (key, body) => putIfAbsent(key, body),
    list: (prefix) => client.list(prefix),
  };
}

export function paperRunLine(result: PaperRunResult): string {
  const parts = [`paper-trading: ${result.gate}`];
  if (result.killedBy) parts.push(`killed-by=${result.killedBy}`);
  if (result.gate === "ON") {
    parts.push(`filled=${result.filled.length}`, `pending=${result.pendingFills}`, `days=${result.days.length}`, `corrections=${result.corrections?.length ?? 0}`);
    if (result.intents)
      parts.push(
        `intents=${result.intents.sessionDate}:${result.intents.outcome}`,
        `entries=${result.intents.entries}`,
        `exits=${result.intents.exits}`,
        `refused=${result.intents.entriesRefused ?? "-"}`,
      );
  }
  return parts.join(" ");
}

export async function paperMain(options: {
  env: Readonly<Record<string, string | undefined>>;
  now: Date;
  repoRoot: string;
  makeClient?: (env: Readonly<Record<string, string | undefined>>) => ObjectClient;
}): Promise<string> {
  const killFileExists = existsSync(join(options.repoRoot, PAPER_KILL_FILE));
  const gate = paperGate(options.env, killFileExists);
  if (gate.state !== "ON")
    return paperRunLine({ gate: gate.state, ...(gate.state === "KILLED" ? { killedBy: gate.source } : {}), filled: [], pendingFills: 0, days: [] });
  if (!options.env.PEACESTOCKS_R2_BUCKET) throw new Error("PAPER_R2_NOT_CONFIGURED");
  const client = (options.makeClient ?? ((env) => R2ObjectClient.fromEnv(env as NodeJS.ProcessEnv)))(options.env);
  const result = await runPaperTrading({
    ledger: new PaperLedgerStore(ledgerObjectClient(client)),
    market: new ObjectMarketStorage(readOnlyObjectClient(client)),
    loaded: loadPaperRules(),
    now: options.now,
    env: options.env,
    killFileExists,
  });
  return paperRunLine(result);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  paperMain({ env: process.env, now: new Date(), repoRoot: resolve(fileURLToPath(new URL("..", import.meta.url))) })
    .then((line) => process.stdout.write(`${line}\n`))
    .catch((error: unknown) => {
      process.stderr.write(`paper-trading: FAILED ${error instanceof Error ? error.message.slice(0, 120) : "unknown"}\n`);
      process.exitCode = 2;
    });
}
