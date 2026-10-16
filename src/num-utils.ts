export function clampPercent(x: number): number {
  return Math.min(100, Math.max(0, x));
}

export function bandOf(x: number, lo: number, hi: number): string {
  if (hi < lo) throw new Error("BAD_BAND");
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) throw new Error("INVALID_BAND_BOUNDS");
  const span = hi - lo;
  const pos = span === 0 ? 0 : (x - lo) / span;
  if (pos < 0) return "below";
  if (pos <= 1) return "inside";
  return "above";
}

export function countWholeHours(ms: number): number {
  let h = 0;
  let t = 0;
  while (h < 168) {
  if (ms < (h + 1) * 3600000) break;
  t += 1;
  h += 1;
  }
  return t;
}
