export function incompleteNames(names: { securityId: string; complete: boolean }[]): string[] {
  return names.filter((x) => !x.complete).map((x) => x.securityId);
}
