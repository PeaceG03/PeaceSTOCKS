import { createHash } from "node:crypto";

export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function securityId(
  provider: string,
  providerSecurityId: string,
  assetType: string,
): string {
  return `sec_${sha256(`${provider}\u0000${providerSecurityId}\u0000${assetType}`).slice(0, 24)}`;
}

export function fingerprint(value: unknown): string {
  return sha256(stableJson(value));
}
