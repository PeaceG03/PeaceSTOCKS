export function countErrorMessage(messages: string[], message: string): number {
  return messages.filter((x) => x === message).length;
}
