/**
 * SWAGGER_UI gating of the OpenAPI spec (rest/router.ts): the spec (and the
 * /openapi/ docs page, gated in index.ts) is opt-in via the SWAGGER_UI env
 * variable — enabled only for 'true', 'TRUE', 'on', 'ON' and '1'.
 *
 * config.ts evaluates the env at import time, so each case re-imports the
 * module graph (vi.resetModules) after setting the variable.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

const makeApp = async (): Promise<ReturnType<typeof import('../../server/app.js')['createApp']>> => {
  vi.resetModules();
  const { createApp } = await import('../../server/app.js');
  const { CacheRegistry } = await import('../../server/cache/cache-registry.js');
  const { MockWeblateClient } = await import('../../server/weblate/mock/mock-client.js');
  return createApp(new MockWeblateClient(), new CacheRegistry(new MockWeblateClient()));
};

// Re-importing the whole module graph per env value is slow — give the
// default 5s test timeout some headroom.
const TIMEOUT = 30_000;

describe('SWAGGER_UI gating of the OpenAPI spec', () => {
  // process.env is shared across test files in a worker — don't leak state.
  afterAll(() => {
    delete process.env.SWAGGER_UI;
  });

  /** Values (casing/blank variants included) that enable the docs, and whether "Try it out" is active. */
  const enabled: Array<[string, boolean]> = [
    ['true', false],
    ['TRUE', false],
    [' true ', false],
    ['on', false],
    ['ON', false],
    ['1', false],
    ['try', true],
    ['with_try', true],
    ['with-try', true],
    [' WITH-TRY ', true],
    ['With_Try', true],
    ['swagger-with-try', true],
    ['SWAGGER_WITH_TRY', true],
    [' Swagger-With-Try ', true],
  ];
  for (const [value, tryIt] of enabled) {
    it(`serves the spec without a key for SWAGGER_UI=${JSON.stringify(value)}`, { timeout: TIMEOUT }, async () => {
      process.env.SWAGGER_UI = value;
      const app = await makeApp();
      const res = await request(app).get('/api/rest/v1/openapi.json').expect(200);
      expect(res.body).toMatchObject({
        openapi: expect.stringMatching(/^3\./),
        info: { title: expect.stringContaining('REST API') },
        // The page reads the "Try it out" flag from this extension.
        'x-try-it-out': tryIt,
      });
      // Every documented operation: listings, create/patch/delete, export.
      expect(Object.keys(res.body.paths).sort()).toEqual([
        '/api/rest/v1/export',
        '/api/rest/v1/projects',
        '/api/rest/v1/projects/{project}/components',
        '/api/rest/v1/projects/{project}/components/{component}/translations',
        '/api/rest/v1/projects/{project}/components/{component}/translations/{context}',
      ]);
    });
  }

  const disabledValues = ['', '   ', 'false', 'yes', '0', 'with'];
  for (const value of disabledValues) {
    it(`answers 404 for SWAGGER_UI=${JSON.stringify(value)}`, { timeout: TIMEOUT }, async () => {
      process.env.SWAGGER_UI = value;
      const app = await makeApp();
      await request(app).get('/api/rest/v1/openapi.json').expect(404);
    });
  }

  it('answers 404 when the variable is unset', { timeout: TIMEOUT }, async () => {
    delete process.env.SWAGGER_UI;
    const app = await makeApp();
    await request(app).get('/api/rest/v1/openapi.json').expect(404);
  });
});