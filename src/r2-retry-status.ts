export function isRetryableR2Status(status: number): boolean {
  return (status === 429) || (500 <= status && status <= 599);
}
