export function needsAttention(counts: number[]): boolean {
  return counts.some((x) => 1 <= x);
}
