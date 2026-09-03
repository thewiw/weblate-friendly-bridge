/**
 * Public (key-less) export on the REST API: allowed only when the server
 * is configured with both WFB_WEBLATE_EXPORT_API_KEY (a server-wide Weblate key used
 * for the underlying export) and WFB_WEBLATE_EXPORT_ALLOWED_HOSTS (the client
 * hosts, as comma-separated CIDR ranges, allowed to call it without a key).
 *
 * Misconfiguration and key failures are reported: at server start
 * (reportPublicExportStatus) and per request (key re-validated before each
 * public export, with transitions logged).
 */
import { anyIpAllowed, parseHostList } from './cidr.js';
import { createKeyValidator } from './auth.js';
import { logError, logInfo, logWarn } from '../log.js';

export interface PublicExportConfig {
  mode: 'mock' | 'live';
  weblateUrl: string;
  apiKey: string;
  allowedHosts: string;
}

/** Decision for a key-less export request (key validation excluded). */
export type PublicExportDecision =
  | { ok: true }
  | { ok: false; status: number; error: string; /** Extra context for the server log only. */ detail?: string };

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
        'Public export is not enabled (WFB_WEBLATE_EXPORT_API_KEY and WFB_WEBLATE_EXPORT_ALLOWED_HOSTS must both be set)',
    };
  }
  const { cidrs, invalid } = parseHostList(opts.allowedHosts);
  if (invalid.length > 0 || cidrs.length === 0) {
    return {
      ok: false,
      status: 403,
      error:
        invalid.length > 0
          ? `Public export disabled: invalid WFB_WEBLATE_EXPORT_ALLOWED_HOSTS entries (${invalid.join(', ')})`
          : 'Public export disabled: WFB_WEBLATE_EXPORT_ALLOWED_HOSTS contains no valid host',
    };
  }
  if (!anyIpAllowed(opts.clientIp, cidrs)) {
    // The response stays generic; the log line explains WHY (which client
    // address was matched against which allowlist).
    const hosts = opts.allowedHosts
      .split(',')
      .map((e) => e.trim())
      .filter((e) => e !== '');
    return {
      ok: false,
      status: 403,
      error: 'Client host not allowed for public export',
      detail: `client ${opts.clientIp !== '' ? opts.clientIp : '(unknown IP)'} is not in [${hosts.join(', ')}]`,
    };
  }
  return { ok: true };
}

/** Logs the effective public-export state once, at server start. */
export async function reportPublicExportStatus(opts: PublicExportConfig): Promise<void> {
  const prefix = '[rest] Public export (key-less):';
  if (opts.mode === 'mock') {
    logInfo(`${prefix} allowed (mock mode)`);
    return;
  }
  if (opts.apiKey.trim() === '' || opts.allowedHosts.trim() === '') {
    logWarn(
      `${prefix} disabled — WFB_WEBLATE_EXPORT_API_KEY and WFB_WEBLATE_EXPORT_ALLOWED_HOSTS must both be set`,
    );
    return;
  }
  const { cidrs, invalid } = parseHostList(opts.allowedHosts);
  if (invalid.length > 0 || cidrs.length === 0) {
    logError(
      `${prefix} disabled — invalid WFB_WEBLATE_EXPORT_ALLOWED_HOSTS: ${
        invalid.length > 0 ? invalid.join(', ') : 'no valid entry'
      }`,
    );
    return;
  }
  // Common trap: a bare "0.0.0.0" (like any bare IP) matches only that one
  // address — "allow any host" needs 0.0.0.0/0 (plus ::/0 for IPv6).
  const bareAnyV4 = opts.allowedHosts.split(',').some((e) => e.trim() === '0.0.0.0');
  if (bareAnyV4) {
    logWarn(
      `${prefix} note: "0.0.0.0" matches only the address 0.0.0.0 (bare IPs are /32) — ` +
        `use "0.0.0.0/0" to allow any IPv4 host (and "::/0" for IPv6)`,
    );
  }

  const validate = createKeyValidator(opts.weblateUrl);
  const username = await validate(opts.apiKey.trim());
  if (username === null) {
    logError(
      `${prefix} configured WFB_WEBLATE_EXPORT_API_KEY was rejected by Weblate — public export unavailable until the key works again`,
    );
    return;
  }
  const hosts = opts.allowedHosts
    .split(',')
    .map((e) => e.trim())
    .filter((e) => e !== '');
  logInfo(`${prefix} enabled, key accepted — allowed hosts: ${hosts.join(', ')}`);
  // Second common trap: allowing every IPv4 host but not IPv6 — clients
  // reaching the server over IPv6 (e.g. "::1" when curling "localhost")
  // are then rejected despite the 0.0.0.0/0 entry.
  const allowsAllV4 = cidrs.some((c) => c.version === 4 && c.bits === 0 && c.value === 0n);
  const hasV6 = cidrs.some((c) => c.version === 6);
  if (allowsAllV4 && !hasV6) {
    logWarn(
      `${prefix} note: no IPv6 range configured — IPv6 clients (e.g. "::1" when a client ` +
        `resolves "localhost") will be rejected; add "::/0" to allow any IPv6 host`,
    );
  }
}