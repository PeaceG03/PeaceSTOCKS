export function countMissingParts(states: string[]): number {
  return states.filter((x) => x === "SILENT").length;
}
