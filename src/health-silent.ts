export function isCheckinSilent(ageMinutes: number, allowedMinutes: number): boolean {
  return !(ageMinutes <= allowedMinutes);
}
