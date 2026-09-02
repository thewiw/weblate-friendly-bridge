import { describe, expect, it } from 'vitest';
import request from 'supertest';
import JSZip from 'jszip';
import { createApp } from '../../server/app.js';
import { CacheRegistry } from '../../server/cache/cache-registry.js';
import { MockWeblateClient } from '../../server/weblate/mock/mock-client.js';
import type { ExportResponse } from '../../shared/export.js';

function makeApp() {
  const api = new MockWeblateClient();
  const registry = new CacheRegistry(api);
  return { app: createApp(api, registry) };
}

const AUTH = { Authorization: 'Token test-key' };

const singleScopeRequest = {
  scope: [{ project: 'friendly-suite', component: 'web-ui' }],
  languages: ['de'],
  format: 'i18next',
  fileName: '[language].json',
  grouping: 'per-component',
  packaging: 'json',
} as const;

describe('REST POST /api/rest/v1/export', () => {
  it('rejects requests without an API key on other routes but allows key-less export in mock mode', async () => {
    const { app } = makeApp();
    // Public export is allowed in mock mode (no live Weblate to validate against).
    await request(app).post('/api/rest/v1/export').send(singleScopeRequest).expect(200);
    // Other REST routes still require a key.
    await request(app).get('/api/rest/v1/projects').expect(401);
  });

  it('exports files as base64 JSON entries', async () => {
    const { app } = makeApp();
    const res = await request(app)
      .post('/api/rest/v1/export')
      .set(AUTH)
      .send(singleScopeRequest)
      .expect(200);
    const body = res.body as ExportResponse;
    expect(body.files).toHaveLength(1);
    expect(body.files[0]!.name).toBe('friendly-suite/web-ui/de.json');
    const parsed = JSON.parse(
      Buffer.from(body.files[0]!.contentBase64, 'base64').toString('utf-8'),
    ) as Record<string, string>;
    expect(Object.keys(parsed).length).toBeGreaterThan(40);
    expect(Object.values(parsed)).toContain('');
  });

  it('exports a zip archive when packaging is zip', async () => {
    const { app } = makeApp();
    const res = await request(app)
      .post('/api/rest/v1/export')
      .set(AUTH)
      .buffer(true)
      .parse((res2, callback) => {
        const chunks: Buffer[] = [];
        res2.on('data', (chunk: Buffer) => chunks.push(chunk));
        res2.on('end', () => callback(null, Buffer.concat(chunks)));
      })
      .send({ ...singleScopeRequest, languages: ['de', 'fr'], packaging: 'zip' })
      .expect(200);
    expect(res.headers['content-type']).toBe('application/zip');
    expect(res.headers['content-disposition']).toContain('attachment');

    const zip = await JSZip.loadAsync(res.body);
    expect(zip.file('friendly-suite/web-ui/de.json')).not.toBeNull();
    expect(zip.file('friendly-suite/web-ui/fr.json')).not.toBeNull();
  });

  it('exports several components with the merged grouping', async () => {
    const { app } = makeApp();
    const res = await request(app)
      .post('/api/rest/v1/export')
      .set(AUTH)
      .send({
        ...singleScopeRequest,
        languages: ['fr'],
        grouping: 'merged',
        scope: [
          { project: 'friendly-suite', component: 'web-ui' },
          { project: 'friendly-suite', component: 'reports' },
        ],
      })
      .expect(200);
    const body = res.body as ExportResponse;
    expect(body.files.map((f) => f.name)).toEqual(['fr.json']);
  });

  it('rejects invalid parameters with 400', async () => {
    const { app } = makeApp();
    await request(app)
      .post('/api/rest/v1/export')
      .set(AUTH)
      .send({ ...singleScopeRequest, format: 'yaml' })
      .expect(400);
    await request(app).post('/api/rest/v1/export').set(AUTH).send({ scope: [] }).expect(400);
  });

  it('answers 404 for an unknown component', async () => {
    const { app } = makeApp();
    await request(app)
      .post('/api/rest/v1/export')
      .set(AUTH)
      .send({
        ...singleScopeRequest,
        scope: [{ project: 'friendly-suite', component: 'nope' }],
      })
      .expect(404);
  });
});

describe('UI API export', () => {
  it('exports via POST /api/v1/export (mock mode needs no session)', async () => {
    const { app } = makeApp();
    const res = await request(app)
      .post('/api/v1/export')
      .send({
        ...singleScopeRequest,
        languages: ['en'],
        scope: [{ project: 'friendly-suite', component: 'reports' }],
      })
      .expect(200);
    const body = res.body as ExportResponse;
    expect(body.files[0]!.name).toBe('friendly-suite/reports/en.json');
  });

  it('lists the languages of a component (source first)', async () => {
    const { app } = makeApp();
    const res = await request(app)
      .get('/api/v1/languages?project=friendly-suite&component=web-ui')
      .expect(200);
    const langs = res.body.results as Array<{ code: string; isSource: boolean }>;
    expect(langs[0]).toMatchObject({ code: 'en', isSource: true });
    expect(langs).toHaveLength(4);
  });
});