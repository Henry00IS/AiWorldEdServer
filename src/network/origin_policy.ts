/**
 * Origin allow list check for WebSocket upgrades.
 */

/**
 * Checks an Origin header against the allow list. Entries are exact origins
 * or `scheme://host:*`, which matches the host with any (or no) port.
 * Requests without an Origin header are rejected.
 *
 * @param origin Origin header value or null.
 * @param allowedOrigins Allow list entries.
 * @returns True when allowed.
 */
export function originIsAllowed(origin: string | null, allowedOrigins: readonly string[]): boolean {
  if (origin === null || origin === '' || origin === 'null') return false;
  const loweredOrigin = origin.toLowerCase();
  return allowedOrigins.some((entry) => originMatchesEntry(loweredOrigin, entry.toLowerCase()));
}

/**
 * @param origin Lower-case origin.
 * @param entry Lower-case allow list entry.
 * @returns True when the origin matches the entry.
 */
function originMatchesEntry(origin: string, entry: string): boolean {
  if (!entry.endsWith(':*')) return origin === entry;
  const base = entry.slice(0, -2);
  if (origin === base) return true;
  return origin.startsWith(`${base}:`) && /^\d{1,5}$/.test(origin.slice(base.length + 1));
}
