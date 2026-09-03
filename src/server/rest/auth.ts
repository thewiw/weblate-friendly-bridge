/**
 * API-key authentication for the external REST API. Callers pass their own
 * Weblate API key (`Authorization: Token <key>` or `X-API-Key`); the key is
 * validated against Weblate (short in-memory cache) and used as the auth
 * for the underlying Weblate calls, so permissions follow the key.
 *
 * Exception: key-less requests to /export may be served with the
 * server-wide WEBLATE_EXPORT_API_KEY when public export is configured
 * (see public-export.ts).
 */
import type { Request, Response, NextFunction } from 'express';
import { createTokenWeblateApi, type WeblateApi } from '../weblate/client.js';
import { evaluatePublicExport } from './public-export.js';
import { logError } from '../log.js';

export interface RestAuth {
  username: string;
  /** Weblate client authenticated by the caller's key. */
  api: WeblateApi;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      restAuth?: RestAuth;
    }
  }
}

const VALIDATION_TTL_MS = 5 * 60_000;
const MAX_CACHED_KEYS = 200;
const HTTP_TIMEOUT_MS = 10_000;

export interface RestAuthOptions {
  weblateUrl: string;
  /** 'mock' accepts any non-empty key; 'live' validates against Weblate. */
  mode: 'mock' | 'live';
  /** Shared mock client (used as-is in mock mode). */
  mockApi: WeblateApi;
  /**
   * Key-less requests to /export are served with this server-wide key when
   * the client host is allowed (see public-export.ts). Omitted = never.
   */
  publicExport?: { apiKey: string; allowedHosts: string };
}

/** Reads the caller's Weblate API key from the request (null = none). */
export function extractApiKey(req: Request): string | null {
  const header = req.headers.authorization;
  if (header !== undefined && header.startsWith('Token ')) {
    const key = header.slice('Token '.length).trim();
    return key === '' ? null : key;
  }
  const apiKey = req.headers['x-api-key'];
  if (typeof apiKey === 'string' && apiKey.trim() !== '') return apiKey.trim();
  return null;
}

/**
 * Key validator with a short in-memory cache: resolves to the Weblate
 * username when the key is accepted, null otherwise. /api/user/ does not
 * exist on every instance (not on the live one); /api/projects/ exists
 * everywhere and requires authentication.
 */
export function createKeyValidator(
  weblateUrl: string,
  onStateChange?: (accepted: boolean) => void,
): (key: string) => Promise<string | null> {
  const cache = new Map<string, { username: string; expiresAt: number }>();
  let lastState: boolean | null = null;

  const setState = (accepted: boolean): void => {
    if (lastState !== accepted) onStateChange?.(accepted);
    lastState = accepted;
  };

  return async (key: string): Promise<string | null> => {
    const cached = cache.get(key);
    if (cached !== undefined && cached.expiresAt > Date.now()) {
      setState(true);
      return cached.username;
    }
    if (cached !== undefined) cache.delete(key);

    try {
      const res = await fetch(`${weblateUrl}/api/projects/`, {
        headers: { Authorization: `Token ${key}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
      if (res.status !== 200) {
        setState(false);
        return null;
      }
      const body = (await res.json().catch(() => ({}))) as { results?: Array<{ name?: string }> };
      const username =
        body.results !== undefined && body.results.length > 0
          ? (body.results[0]!.name ?? 'weblate-user')
          : 'weblate-user';
      // Bounded cache: refresh insertion order, drop the oldest beyond cap.
      cache.delete(key);
      cache.set(key, { username, expiresAt: Date.now() + VALIDATION_TTL_MS });
      while (cache.size > MAX_CACHED_KEYS) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        cache.delete(oldest);
      }
      setState(true);
      return username;
    } catch {
      setState(false);
      return null;
    }
  };
}

/**
 * Builds the middleware. On success `req.restAuth` carries the username
 * and the per-key Weblate client; on failure it answers itself (401, or
 * the public-export decision's status for key-less /export requests).
 */
export function createApiKeyAuth(opts: RestAuthOptions) {
  const validate = createKeyValidator(opts.weblateUrl);

  /** Logs every client-facing rejection (they bypass the errorHandler). */
  const reject = (req: Request, res: Response, status: number, error: string, detail?: string): void => {
    logError(`[rest] ${req.method} ${req.originalUrl} → ${status}: ${error}${detail !== undefined ? ` (${detail})` : ''}`);
    res.status(status).json({ error });
  };

  return (req: Request, res: Response, next: NextFunction): void => {
    const key = extractApiKey(req);
    if (key === null) {
      // Key-less export: fall back to the server-wide key when configured.
      if (opts.publicExport !== undefined && req.path === '/export') {
        void (async () => {
          const decision = evaluatePublicExport({
            mode: opts.mode,
            weblateUrl: opts.weblateUrl,
            apiKey: opts.publicExport!.apiKey,
            allowedHosts: opts.publicExport!.allowedHosts,
            clientIp: req.ip ?? '',
          });
          if (!decision.ok) {
            reject(req, res, decision.status, decision.error, decision.detail);
            return;
          }
          if (opts.mode === 'mock') {
            req.restAuth = { username: 'public-export', api: opts.mockApi };
            next();
            return;
          }
          // Live: the configured key must work right now (re-checked per
          // request; every working→failed transition is reported).
          const username = await validate(opts.publicExport!.apiKey.trim());
          if (username === null) {

            logError(
              '[rest] Public export: configured WEBLATE_EXPORT_API_KEY was rejected by Weblate — public export unavailable until it works again',
            );
            reject(
              req,
              res,
              503,
              'Public export temporarily unavailable: the configured WEBLATE_EXPORT_API_KEY was rejected by Weblate',
            );
            return;
          }
          req.restAuth = {
            username: 'public-export',
            api: createTokenWeblateApi(opts.weblateUrl, opts.publicExport!.apiKey.trim()),
          };
          next();
        })().catch(() => {
          res.status(503).json({ error: 'Public export temporarily unavailable' });
        });
        return;
      }
      reject(req, res, 401, 'Missing API key (Authorization: Token <key>)');
      return;
    }
    void (async () => {
      let username: string | null;
      if (opts.mode === 'mock') {
        // No live Weblate to validate against: accept any non-empty key.
        username = 'mock-user';
      } else {
        username = await validate(key);
        if (username === null) {
          reject(req, res, 401, 'Invalid Weblate API key');
          return;
        }
      }
      req.restAuth = {
        username,
        api:
          opts.mode === 'mock'
            ? opts.mockApi
            : createTokenWeblateApi(opts.weblateUrl, key),
      };
      next();
    })().catch((err: unknown) => {

      logError('[rest] key validation failed:', err instanceof Error ? err.message : err);
      reject(req, res, 401, 'Invalid Weblate API key');
    });
  };
}