export function clampPercent(x: number): number {
  return Math.min(100, Math.max(0, x));
}

export function bandOf(x: number, lo: number, hi: number): string {
  if (hi < lo) throw new Error("BAD_BAND");
  const span = hi - lo;
  const pos = span === 0 ? 0 : (x - lo) / span;
  if (pos < 0) return "below";
  if (pos <= 1) return "inside";
  return "above";
}
