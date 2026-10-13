export function clampPercent(x: number): number {
  return Math.min(100, Math.max(0, x));
}
