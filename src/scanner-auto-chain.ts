/** Repo variable SCANNER_AUTO_CHAIN: auto re-dispatch, follow-up, and backstop dispatch only when exactly "true". Unset defaults off. */
export function scannerAutoChainEnabled(value: string | undefined): boolean {
  return value === "true";
}
