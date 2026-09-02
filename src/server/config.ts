import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  WEBLATE_URL: z
    .string()
    .url()
    .default('http://192.168.56.220:2080')
    .transform((s) => s.replace(/\/+$/, '')),
  WEBLATE_TOKEN: z.string().default(''),
  /** Server-wide Weblate API key for public (key-less) REST export. */
  WEBLATE_API_KEY: z.string().default(''),
  /** Comma-separated client hosts (CIDR) allowed to use public export. */
  WEBLATE_API_ALLOWED_HOSTS: z.string().default(''),
  WEBLATE_REVIEW_WORKFLOW: z
    .string()
    .default('true')
    .transform((s) => s !== 'false'),
  MOCK_WEBLATE: z
    .string()
    .default('false')
    .transform((s) => s === 'true'),
  PORT: z.coerce.number().int().positive().default(4000),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  throw new Error(`Invalid configuration: ${parsed.error.message}`);
}

const env = parsed.data;

/**
 * How upstream requests authenticate when not mocking:
 * - 'token': fixed WEBLATE_TOKEN (server-side).
 * - 'session': users log in through the UI; their Weblate session cookie
 *   is stored server-side (no API token needed).
 */
export const authMode: 'token' | 'session' =
  env.WEBLATE_TOKEN !== '' ? 'token' : 'session';

export const config = {
  weblateUrl: env.WEBLATE_URL,
  weblateToken: env.WEBLATE_TOKEN,
  /** Server-wide key enabling public (key-less) REST export. */
  weblateApiKey: env.WEBLATE_API_KEY,
  /** Client hosts (CIDR) allowed to use public export. */
  weblateApiAllowedHosts: env.WEBLATE_API_ALLOWED_HOSTS,
  reviewWorkflow: env.WEBLATE_REVIEW_WORKFLOW,
  /** 'mock' only when forced via MOCK_WEBLATE=true. */
  mode: (env.MOCK_WEBLATE ? 'mock' : 'live') as 'mock' | 'live',
  authMode,
  port: env.PORT,
  /** Units page size for Weblate requests (API max is 10000). */
  unitsPageSize: 1000,
  /** Max parallel requests to Weblate. */
  concurrency: 4,
  /** Background delta refresh is triggered when the cache is older than this (ms). */
  refreshAfterMs: 30_000,
  /** Safety margin subtracted from lastRefreshAt for delta queries. */
  refreshMarginMs: 2 * 60_000,
  /** Suspend background refreshes when the rate budget drops below this. */
  rateBudgetFloor: 500,
  /** Component cache: max components kept in memory. */
  cacheMaxComponents: 10,
  /** Component cache: idle eviction after this (ms). */
  cacheIdleMs: 15 * 60_000,
} as const;