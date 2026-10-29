export function silentParts(parts: { name: string; silent: boolean }[]): string[] {
  return parts.filter((x) => x.silent).map((x) => x.name);
}
