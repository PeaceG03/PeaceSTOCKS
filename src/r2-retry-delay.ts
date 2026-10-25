export function r2RetryDelayMs(attempt: number, baseMs: number): number {
  return (baseMs * ((attempt + 1) * (attempt + 1))) <= 30000 ? (baseMs * ((attempt + 1) * (attempt + 1))) : 30000;
}
