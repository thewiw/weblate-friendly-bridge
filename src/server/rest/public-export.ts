/**
 * Public (key-less) export on the REST API: allowed only when the server
 * is configured with both WEBLATE_API_KEY (a server-wide Weblate key used
 * for the underlying export) and WEBLATE_API_ALLOWED_HOSTS (the client
 * hosts, as comma-separated CIDR ranges, allowed to call it without a key).
 *
 * Misconfiguration and key failures are reported: at server start
 * (reportPublicExportStatus) and per request (key re-validated before each
 * public export, with transitions logged).
 */
import { anyIpAllowed, parseHostList } from './cidr.js';
import { createKeyValidator } from './auth.js';

export interface PublicExportConfig {
  mode: 'mock' | 'live';
  weblateUrl: string;
  apiKey: string;
  allowedHosts: string;
}

/** Decision for a key-less export request (key validation excluded). */
export type PublicExportDecision =
  | { ok: true }
  | { ok: false; status: number; error: string };

/**
 * Pure config/host decision for a key-less export request. The configured
 * key's validity is checked separately (async) by the auth middleware.
 */
export function evaluatePublicExport(
  opts: PublicExportConfig & { clientIp: string },
): PublicExportDecision {
  // Mock mode has no live Weblate to validate against (its auth accepts
  // any key) — public export follows the same rule.
  if (opts.mode === 'mock') return { ok: true };
  if (opts.apiKey.trim() === '' || opts.allowedHosts.trim() === '') {
    return {
      ok: false,
      status: 403,
      error:
        'Public export is not enabled (WEBLATE_API_KEY and WEBLATE_API_ALLOWED_HOSTS must both be set)',
    };
  }
  const { cidrs, invalid } = parseHostList(opts.allowedHosts);
  if (invalid.length > 0 || cidrs.length === 0) {
    return {
      ok: false,
      status: 403,
      error:
        invalid.length > 0
          ? `Public export disabled: invalid WEBLATE_API_ALLOWED_HOSTS entries (${invalid.join(', ')})`
          : 'Public export disabled: WEBLATE_API_ALLOWED_HOSTS contains no valid host',
    };
  }
  if (!anyIpAllowed(opts.clientIp, cidrs)) {
    return { ok: false, status: 403, error: 'Client host not allowed for public export' };
  }
  return { ok: true };
}

/** Logs the effective public-export state once, at server start. */
export async function reportPublicExportStatus(opts: PublicExportConfig): Promise<void> {
  const prefix = '[rest] Public export (key-less):';
  if (opts.mode === 'mock') {
    console.log(`${prefix} allowed (mock mode)`);
    return;
  }
  if (opts.apiKey.trim() === '' || opts.allowedHosts.trim() === '') {
    console.warn(
      `${prefix} disabled — WEBLATE_API_KEY and WEBLATE_API_ALLOWED_HOSTS must both be set`,
    );
    return;
  }
  const { cidrs, invalid } = parseHostList(opts.allowedHosts);
  if (invalid.length > 0 || cidrs.length === 0) {
    console.error(
      `${prefix} disabled — invalid WEBLATE_API_ALLOWED_HOSTS: ${
        invalid.length > 0 ? invalid.join(', ') : 'no valid entry'
      }`,
    );
    return;
  }

  const validate = createKeyValidator(opts.weblateUrl);
  const username = await validate(opts.apiKey.trim());
  if (username === null) {
    console.error(
      `${prefix} configured WEBLATE_API_KEY was rejected by Weblate — public export unavailable until the key works again`,
    );
    return;
  }
  console.log(
    `${prefix} enabled for ${cidrs.map((c) => (c.version === 4 ? 'IPv4' : 'IPv6')).join(', ')} ranges (key accepted)`,
  );
}