/** Joiners announce compatibility information, never their home URL. */
export interface CompatibilityIdentity {
  version: string;
  schema: number;
  caps: string[];
}
/** Bounded public reasons: never free-form owner strings or URLs. */
export const COMPATIBILITY_REASONS = [
  'incompatible_client',
  'missing_caps',
  'schema_mismatch',
  'version_mismatch',
  'owner_timeout',
] as const;
export type CompatibilityReason = (typeof COMPATIBILITY_REASONS)[number];
/** Owner's authoritative compatibility verdict. */
export interface CompatibilityDecision {
  allow: boolean;
  reason?: CompatibilityReason;
  homeUrl?: string;
}

/**
 * Validates an untrusted editor home URL without opening or fetching it.
 *
 * @param value Owner-provided URL.
 * @returns Bounded HTTP(S) URL or null.
 */
export function compatibilityHomeUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 256 || /[\u0000-\u0020\u007f]/u.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!url.hostname || url.username || url.password || url.href.length > 256) return null;
    return url.href;
  } catch {
    return null;
  }
}
