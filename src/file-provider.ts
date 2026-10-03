import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  CanonicalDailyBar,
  CorporateAction,
  MarketProvider,
  ProviderSecurityRecord,
} from "./contracts";

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function readJsonLines<T>(path: string): Promise<T[]> {
  const text = await readFile(path, "utf8");
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

function datePath(root: string, kind: "bars" | "actions", sessionDate: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(sessionDate)) throw new Error("INVALID_SESSION_DATE");
  return join(root, kind, `${sessionDate}.jsonl`);
}

/** A narrow source adapter for normalized, licensed input files. */
export class FileMarketProvider implements MarketProvider {
  readonly providerName: string;

  constructor(
    private readonly root: string,
    providerName = "normalized-file-provider",
  ) {
    this.providerName = providerName;
  }

  async listApprovedSecurities(): Promise<ProviderSecurityRecord[]> {
    return readJson<ProviderSecurityRecord[]>(join(this.root, "universe.json"));
  }

  async getDailyBars(sessionDate: string, securityIds: string[]): Promise<CanonicalDailyBar[]> {
    const bars = await readJsonLines<CanonicalDailyBar>(datePath(this.root, "bars", sessionDate));
    return bars.filter((bar) => securityIds.includes(bar.securityId));
  }

  async getCorporateActions(
    sessionDate: string,
    securityIds: string[],
  ): Promise<CorporateAction[]> {
    const actions = await readJsonLines<CorporateAction>(
      datePath(this.root, "actions", sessionDate),
    );
    return actions.filter((action) => securityIds.includes(action.securityId));
  }
}
