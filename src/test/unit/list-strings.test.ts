import { describe, expect, it } from 'vitest';
import { listStrings } from '../../server/rest/operations.js';
import { MockWeblateClient } from '../../server/weblate/mock/mock-client.js';

const api = new MockWeblateClient();

describe('listStrings', () => {
  it('returns context + source text with lean payloads by default', async () => {
    const res = await listStrings(api, 'friendly-suite', 'web-ui', { contextPrefix: 'ctx-' });
    expect(res.total).toBeGreaterThan(0);
    expect(res.limit).toBe(100);
    expect(res.results[0]).toMatchObject({ context: expect.stringMatching(/^ctx-/) });
    expect(res.results[0]!.translations).toEqual({}); // no languages requested
  });

  it('exact-matches contexts in caller order and skips missing ones', async () => {
    const all = await listStrings(api, 'friendly-suite', 'web-ui', { contextPrefix: 'ctx-' });
    const a = all.results[0]!.context;
    const b = all.results[1]!.context;
    const res = await listStrings(api, 'friendly-suite', 'web-ui', {
      contexts: [b, 'NO.SUCH.KEY', a],
    });
    expect(res.total).toBe(2);
    expect(res.results.map((r) => r.context)).toEqual([b, a]);
  });

  it('filters by text_contains case-insensitively and returns translations', async () => {
    const probe = await listStrings(api, 'friendly-suite', 'web-ui', { limit: 1 });
    const needle = String(probe.results[0]!.source).slice(0, 6);
    const res = await listStrings(api, 'friendly-suite', 'web-ui', {
      textContains: needle.toUpperCase(),
      languages: ['de', 'fr'],
    });
    expect(res.total).toBeGreaterThan(0);
    const first = res.results.find((r) => r.translations['de'] !== undefined);
    expect(first).toBeDefined();
    expect(Object.keys(first!.translations).sort()).toEqual(['de', 'fr']);
    expect(first!.translations['de']).toHaveProperty('state');
  });

  it('honors language for search + returned text, and pages', async () => {
    const page1 = await listStrings(api, 'friendly-suite', 'web-ui', { limit: 2, offset: 0 });
    const page2 = await listStrings(api, 'friendly-suite', 'web-ui', { limit: 2, offset: 2 });
    expect(page1.results).toHaveLength(2);
    expect(page1.results.map((r) => r.context)).not.toEqual(page2.results.map((r) => r.context));
    const fr = await listStrings(api, 'friendly-suite', 'web-ui', { language: 'fr', limit: 1 });
    expect(fr.results[0]!.source).not.toBe('');
  });

  it('answers precise 404s for unknown component/language', async () => {
    await expect(
      listStrings(api, 'friendly-suite', 'nope', {}),
    ).rejects.toThrow(/Unknown component: friendly-suite\/nope/);
    await expect(
      listStrings(api, 'friendly-suite', 'web-ui', { language: 'xx' }),
    ).rejects.toThrow(/Unknown language "xx".*available:/);
  });

  it('returns empty results (not an error) when nothing matches', async () => {
    const res = await listStrings(api, 'friendly-suite', 'web-ui', { contextPrefix: 'NOPE.' });
    expect(res).toMatchObject({ total: 0, results: [] });
  });

  it('maps the MCP tool shape (exact contexts + translations)', async () => {
    // The MCP tool maps snake_case params onto listStrings — exercise the
    // same shape a Claude client would send.
    const res = await listStrings(api, 'friendly-suite', 'web-ui', {
      contexts: ['ctx-0'],
      languages: ['fr'],
    });
    expect(res.results[0]).toMatchObject({
      context: 'ctx-0',
      translations: { fr: { state: expect.any(Number) } },
    });
  });
});