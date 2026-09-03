import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  WFB_WEBLATE_URL: z
    .string()
    .url()
    .default('http://192.168.56.220:2080')
    .transform((s) => s.replace(/\/+$/, '')),
  WFB_WEBLATE_API_KEY: z.string().default(''),
  /** Server-wide Weblate API key for public (key-less) REST export. */
  WFB_WEBLATE_EXPORT_API_KEY: z.string().default(''),
  /** Comma-separated client hosts (CIDR) allowed to use public export. */
  WFB_WEBLATE_EXPORT_ALLOWED_HOSTS: z.string().default(''),
  WFB_WEBLATE_REVIEW_WORKFLOW: z
    .string()
    .default('true')
    .transform((s) => s !== 'false'),
  WFB_MOCK_WEBLATE: z
    .string()
    .default('false')
    .transform((s) => s === 'true'),
  /**
   * Opt-in OpenAPI UI for the REST API. The value is matched case- and
   * blank-insensitively: 'true' | 'on' | '1' enable the docs read-only;
   * 'try' | 'with-try' | 'with_try' | 'openapi-with-try' | 'openapi_with_try'
   * (legacy spellings 'swagger-with-try' / 'swagger_with_try' still work)
   * additionally enable the "Try it out" button.
   */
  WFB_OPENAPI: z
    .string()
    .default('')
    .transform((s) => {
      const v = s.trim().toLowerCase();
      const tryValues = [
        'try',
        'with-try',
        'with_try',
        'openapi-with-try',
        'openapi_with_try',
        // Legacy spellings kept accepted for existing deployments.
        'swagger-with-try',
        'swagger_with_try',
      ];
      return {
        enabled: ['true', 'on', '1', ...tryValues].includes(v),
        tryIt: tryValues.includes(v),
      };
    }),
  WFB_PORT: z.coerce.number().int().positive().default(4000),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  throw new Error(`Invalid configuration: ${parsed.error.message}`);
}

const env = parsed.data;

/**
 * How upstream requests authenticate when not mocking:
 * - 'token': fixed WFB_WEBLATE_API_KEY (server-side).
 * - 'session': users log in through the UI; their Weblate session cookie
 *   is stored server-side (no API token needed).
 */
export const authMode: 'token' | 'session' =
  env.WFB_WEBLATE_API_KEY !== '' ? 'token' : 'session';

export const config = {
  weblateUrl: env.WFB_WEBLATE_URL,
  weblateApiKey: env.WFB_WEBLATE_API_KEY,
  /** Server-wide key enabling public (key-less) REST export. */
  weblateExportApiKey: env.WFB_WEBLATE_EXPORT_API_KEY,
  /** Client hosts (CIDR) allowed to use public export. */
  weblateExportAllowedHosts: env.WFB_WEBLATE_EXPORT_ALLOWED_HOSTS,
  reviewWorkflow: env.WFB_WEBLATE_REVIEW_WORKFLOW,
  /** 'mock' only when forced via WFB_MOCK_WEBLATE=true. */
  mode: (env.WFB_MOCK_WEBLATE ? 'mock' : 'live') as 'mock' | 'live',
  /** Whether the OpenAPI docs page (/openapi/) and the spec are served. */
  openapiUi: env.WFB_OPENAPI.enabled,
  /** Whether the docs page's "Try it out" button is active (WFB_OPENAPI=try|with-try|…). */
  openapiTryIt: env.WFB_OPENAPI.tryIt,
  authMode,
  port: env.WFB_PORT,
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