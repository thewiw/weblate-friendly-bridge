/**
 * The create race: right after the source unit exists, Weblate has already
 * propagated empty units to the other languages, but its context search
 * can lag — the lookup misses, the fallback create collides (upstream 404),
 * and createStrings must re-check and patch instead of failing the item.
 */
import { describe, expect, it } from 'vitest';
import { createStrings } from '../../server/rest/operations.js';
import { CacheRegistry } from '../../server/cache/cache-registry.js';
import { MockWeblateClient } from '../../server/weblate/mock/mock-client.js';
import type { WeblateApi } from '../../server/weblate/client.js';
import { UpstreamError } from '../../server/http-errors.js';
import type { WeblateUnit } from '../../shared/weblate-dto.js';

/** Wraps the mock so context searches return nothing for the first N calls,
 *  and unit creation on an existing context answers 404 like live Weblate. */
function laggyApi(missCount: number): WeblateApi {
  const real = new MockWeblateClient();
  let searches = 0;
  const originalListUnits = real.listUnits.bind(real);
  // Prototype-based delegation: {...real} would drop the class methods.
  const api = Object.create(real) as WeblateApi;
  api.listUnits = (url: string, q?: string): AsyncIterable<WeblateUnit> => {
    const inner = originalListUnits(url, q);
    if (q === undefined) return inner;
    searches++;
    if (searches <= missCount) {
      // Index lag: the propagated unit is not visible yet.
      return {
        async *[Symbol.asyncIterator]() {},
      };
    }
    return inner;
  };
  api.createUnit = async (unitsUrl: string, body: Parameters<WeblateApi['createUnit']>[1]) => {
    // Live behavior: creating a unit whose context already exists (the
    // propagated one) is rejected — but only for the target languages;
    // the source unit creation passes through.
    if (unitsUrl.includes('/de/')) throw new UpstreamError(404, 'Not found.');
    return real.createUnit(unitsUrl, body);
  };
  return api;
}

describe('createStrings propagation race', () => {
  it('falls back to the propagated unit when the search index lags', async () => {
    // The first translation lookup misses (index lag), the fallback create
    // collides with the propagated unit, and the retry lookup finds it.
    const api = laggyApi(1);
    const res = await createStrings(
      api,
      new CacheRegistry(new MockWeblateClient()),
      'friendly-suite',
      'web-ui',
      [{ context: 'race-1', source: 'la source', translations: { de: 'übersetzt' } }],
    );
    expect(res.results[0]).toMatchObject({
      ok: true,
      context: 'race-1',
      translations: { de: { state: 10 } },
    });
  });

  it('reports the real error when the unit never appears', async () => {
    const api = laggyApi(999);
    const res = await createStrings(
      api,
      new CacheRegistry(new MockWeblateClient()),
      'friendly-suite',
      'web-ui',
      [{ context: 'race-2', source: 'la source', translations: { de: 'übersetzt' } }],
    );
    expect(res.results[0]).toMatchObject({
      ok: false,
      context: 'race-2',
      language: 'de',
    });
    expect((res.results[0] as { error: string }).error).toContain('rejected the "de" translation');
  });
});