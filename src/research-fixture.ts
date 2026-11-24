/** Test fixture only: a small synthetic local store for end-to-end research CLI tests (no symbols, no network). */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { rng } from "./holdout-eval";

export function weekdaysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = new Date(`${from}T00:00:00Z`); d.toISOString().slice(0, 10) <= to; d.setUTCDate(d.getUTCDate() + 1))
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) out.push(d.toISOString().slice(0, 10));
  return out;
}

/** Writes permanent/daily-bars/<month>.jsonl, security-master.json and corporate-actions.jsonl under root. */
export function writeSyntheticStore(root: string, opts: { from: string; to: string; names?: number; seed?: number; poisonFrom?: string }): void {
  const r = rng(opts.seed ?? 3);
  const ids = Array.from({ length: opts.names ?? 40 }, (_, k) => `fx${String(k).padStart(3, "0")}`);
  const byMonth = new Map<string, string[]>();
  for (const id of ids) {
    let close = 20 + r() * 50;
    for (const day of weekdaysBetween(opts.from, opts.to)) {
      const open = close * (1 + (r() - 0.5) * 0.002);
      close = open * (1 + (r() - 0.5) * 0.02);
      const poisoned = opts.poisonFrom !== undefined && day >= opts.poisonFrom;
      const bar = { securityId: id, sessionDate: day, open: poisoned ? 1e9 : open, close: poisoned ? 1e-9 : close, volume: 1e5 + r() * 1e5, revision: 1 };
      const month = day.slice(0, 7);
      if (!byMonth.has(month)) byMonth.set(month, []);
      byMonth.get(month)!.push(JSON.stringify(bar));
    }
  }
  mkdirSync(join(root, "permanent/daily-bars"), { recursive: true });
  for (const [month, lines] of byMonth) writeFileSync(join(root, "permanent/daily-bars", `${month}.jsonl`), `${lines.join("\n")}\n`);
  const master = ids.map((id) => ({ securityId: id, currentSymbol: id, assetType: "STOCK", status: "ACTIVE", eligibility: "LEVEL_3", providerIdentities: [] }));
  writeFileSync(join(root, "permanent/security-master.json"), JSON.stringify(master));
  writeFileSync(join(root, "permanent/corporate-actions.jsonl"), "");
}
