import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../server/app.js';
import { CacheRegistry } from '../../server/cache/cache-registry.js';
import { MockWeblateClient } from '../../server/weblate/mock/mock-client.js';
import type { RowsPage } from '../../shared/rows.js';

function makeApp() {
  const api = new MockWeblateClient();
  const registry = new CacheRegistry(api);
  return { app: createApp(api, registry), api };
}

const AUTH = { Authorization: 'Token test-key' };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Polls the UI rows endpoint until the progressive load completes. */
async function getRowsUntilComplete(
  agent: ReturnType<typeof request>,
  query: string,
  tries = 20,
): Promise<RowsPage> {
  let last: RowsPage | null = null;
  for (let i = 0; i < tries; i++) {
    const res = await agent.get(`/api/v1/rows?${query}`).expect(200);
    last = res.body as RowsPage;
    if (last.complete) return last;
    await sleep(25);
  }
  throw new Error('rows never completed');
}

const BASE = '/api/rest/v1/projects/friendly-suite/components/web-ui';

// These tests assume the default SWAGGER_UI state; another test file sets
// the variable in the same worker process (env is shared across files).
// vi.hoisted runs before the static imports, so config.ts (which evaluates
// the env at import time) sees the pinned value.
vi.hoisted(() => {
  process.env.SWAGGER_UI = '';
});

describe('REST API authentication', () => {
  it('hides the OpenAPI spec unless SWAGGER_UI is enabled (default off)', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/api/rest/v1/openapi.json').expect(404);
    expect((res.body as { error: string }).error).toContain('SWAGGER_UI');
  });

  it('rejects requests without a key', async () => {
    const { app } = makeApp();
    await request(app).get(`${BASE.replace('/friendly-suite/components/web-ui', '')}/projects`).expect(401);
  });

  it('rejects malformed Authorization headers', async () => {
    const { app } = makeApp();
    await request(app)
      .get('/api/rest/v1/projects')
      .set('Authorization', 'Bearer test-key')
      .expect(401);
  });

  it('accepts a Token header (mock mode)', async () => {
    const { app } = makeApp();
    await request(app)
      .get('/api/rest/v1/projects')
      .set('Authorization', 'Token test-key')
      .expect(200);
  });

  it('accepts an X-API-Key header', async () => {
    const { app } = makeApp();
    await request(app).get('/api/rest/v1/projects').set('X-API-Key', 'test-key').expect(200);
  });
});

describe('REST listings', () => {
  it('lists projects and their components', async () => {
    const { app } = makeApp();
    const agent = request(app);
    const projects = await agent
      .get('/api/rest/v1/projects')
      .set(AUTH)
      .expect(200);
    expect(projects.body.results.map((p: { slug: string }) => p.slug)).toContain('friendly-suite');

    const components = await agent
      .get('/api/rest/v1/projects/friendly-suite/components')
      .set(AUTH)
      .expect(200);
    expect(components.body.results.map((c: { slug: string }) => c.slug).sort()).toEqual([
      'reports',
      'web-ui',
    ]);
  });
});

describe('REST create translations', () => {
  it('answers 400 (not 500) for a malformed JSON body, with the parser detail', async () => {
    const { app } = makeApp();
    // Trailing comma — the classic "Expected double-quoted property name".
    const res = await request(app)
      .post(`${BASE}/translations`)
      .set(AUTH)
      .set('Content-Type', 'application/json')
      .send('{"items":[{"source":"x","translations":{"en":"y",}}]}')
      .expect(400);
    expect((res.body as { error: string }).error).toContain('Malformed request body');
  });

  it('creates a string with explicit context and a Needs-editing translation', async () => {
    const { app } = makeApp();
    const res = await request(app)
      .post(`${BASE}/translations`)
      .set(AUTH)
      .send({
        items: [
          {
            context: 'ID90001',
            source: 'New greeting',
            translations: { de: 'Neue Begrüßung' },
          },
        ],
      })
      .expect(200);
    const item = res.body.results[0];
    expect(item).toMatchObject({
      ok: true,
      context: 'ID90001',
      translations: { de: { state: 10 } },
    });
    expect(typeof item.sourceUnitId).toBe('number');
  });

  it('generates a context when none is provided and reports it', async () => {
    const { app } = makeApp();
    const res = await request(app)
      .post(`${BASE}/translations`)
      .set(AUTH)
      .send({ items: [{ source: 'Contextless string' }] })
      .expect(200);
    const item = res.body.results[0];
    expect(item.ok).toBe(true);
    expect(item.context).toMatch(/^auto-/);
  });

  it('reports per-item failures without aborting the batch', async () => {
    const { app } = makeApp();
    const res = await request(app)
      .post(`${BASE}/translations`)
      .set(AUTH)
      .send({
        items: [
          { context: 'ID90002', source: '   ' },
          { context: 'ID90003', source: 'Good string' },
        ],
      })
      .expect(200);
    expect(res.body.results[0]).toMatchObject({ ok: false });
    expect(res.body.results[1]).toMatchObject({ ok: true, context: 'ID90003' });
  });
});

describe('REST API modify and delete', () => {
  it('patches several languages of one string and echoes unit ids', async () => {
    const { app } = makeApp();
    const agent = request(app);
    // Create a string first.
    const created = await agent
      .post(`${BASE}/translations`)
      .set(AUTH)
      .send({ items: [{ context: 'ID90010', source: 'Patch me', translations: { de: 'Patchen' } }] })
      .expect(200);
    const deUnitId = created.body.results[0].translations.de.unitId;

    const res = await agent
      .patch(`${BASE}/translations/ID90010`)
      .set(AUTH)
      .send({
        translations: {
          de: { target: 'Neuer Text', state: 20 },
          fr: { target: 'Texte nouveau', state: 10 },
        },
      })
      .expect(200);
    expect(res.body.context).toBe('ID90010');
    expect(res.body.translations.de.state).toBe(20);
    expect(res.body.translations.fr.state).toBe(10);
    // The same de unit was updated in place, not duplicated.
    expect(res.body.translations.de.unitId).toBe(deUnitId);
  });

  it('returns 404 for an unknown context', async () => {
    const { app } = makeApp();
    await request(app)
      .patch(`${BASE}/translations/DOES_NOT_EXIST`)
      .set(AUTH)
      .send({ translations: { de: { target: 'x' } } })
      .expect(404);
  });

  it('guards the source language, clears one language on request, deletes whole strings with all=true', async () => {
    const { app } = makeApp();
    const agent = request(app);
    await agent
      .post(`${BASE}/translations`)
      .set(AUTH)
      .send({
        items: [{ context: 'ID90011', source: 'Delete me', translations: { de: 'Löschen' } }],
      })
      .expect(200);

    // Source-language delete requires all=true.
    await agent
      .delete(`${BASE}/translations/ID90011?language=en`)
      .set(AUTH)
      .expect(400);

    // Weblate does not support per-language unit deletion: 422 unless clear=true.
    await agent
      .delete(`${BASE}/translations/ID90011?language=de`)
      .set(AUTH)
      .expect(422);
    await agent
      .delete(`${BASE}/translations/ID90011?language=de&clear=true`)
      .set(AUTH)
      .expect(200);

    const rows = await getRowsUntilComplete(
      agent,
      'project=friendly-suite&component=web-ui&limit=200',
    );
    const row = rows.rows.find((r) => r.context === 'ID90011');
    expect(row).toBeDefined();
    // The de translation was cleared, not deleted.
    expect(row!.cells['de']).toMatchObject({ state: 0, target: [''] });

    // all=true removes the whole string (source unit delete).
    await agent.delete(`${BASE}/translations/ID90011?language=en&all=true`).set(AUTH).expect(200);
    const after = await getRowsUntilComplete(
      agent,
      'project=friendly-suite&component=web-ui&limit=200',
    );
    expect(after.rows.find((r) => r.context === 'ID90011')).toBeUndefined();

    // Omitting the language deletes the whole context at once.
    await agent
      .post(`${BASE}/translations`)
      .set(AUTH)
      .send({ items: [{ context: 'ID90012', source: 'Whole delete' }] })
      .expect(200);
    await agent.delete(`${BASE}/translations/ID90012`).set(AUTH).expect(200);
    const last = await getRowsUntilComplete(
      agent,
      'project=friendly-suite&component=web-ui&limit=200',
    );
    expect(last.rows.find((r) => r.context === 'ID90012')).toBeUndefined();
  });
});