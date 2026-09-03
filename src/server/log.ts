/**
 * Timestamped console logging for the server: every line gets an ISO 8601
 * UTC date+time prefix (e.g. `2026-09-03T09:45:12.345Z [rest] …`). All
 * server-side logging goes through these helpers so log lines are uniform
 * and greppable.
 */
const stamp = (): string => new Date().toISOString();

export function logInfo(...args: unknown[]): void {
  console.log(stamp(), ...args);
}

export function logWarn(...args: unknown[]): void {
  console.warn(stamp(), ...args);
}

export function logError(...args: unknown[]): void {
  console.error(stamp(), ...args);
}