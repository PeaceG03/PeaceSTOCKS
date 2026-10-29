export function attentionParts(parts: { name: string; attention: boolean }[]): string[] {
  return parts.filter((x) => x.attention).map((x) => x.name);
}
