import { describe, expect, it } from 'vitest';
import type {
  UnitPatchBody,
  WeblateTranslation,
  WeblateUnit,
} from '../../shared/weblate-dto.js';
import type { WeblateApi } from '../../server/weblate/client.js';
import { ComponentCache } from '../../server/cache/component-cache.js';
import { CacheRegistry } from '../../server/cache/cache-registry.js';

/**
 * Scripted fake Weblate: unit streams can be delayed per language so
 * partial-loading behavior is observable.
 */
class FakeWeblate implements WeblateApi {
  readonly mode = 'mock' as const;
  translations: WeblateTranslation[] = [];
  unitsByLang = new Map<string, WeblateUnit[]>();
  /** Language codes whose unit stream is gated behind this promise. */
  gates = new Map<string, Promise<void>>();

  async listProjects() {
    return [];
  }
  async listComponents() {
    return [];
  }
  async getProject() {
    return { slug: 'p', name: 'P', web_url: '', translation_review: true };
  }
  translationsUrlFor(project: string, component: string) {
    return `fake://components/${project}/${component}/translations/`;
  }
  unitsUrlFor(project: string, component: string, language: string) {
    return `fake://translations/${project}/${component}/${language}/units/`;
  }
  async listTranslations() {
    return this.translations;
  }
  getRateBudget() {
    return { limit: 5000, remaining: 4000, reset: null };
  }
  /** Units served by getUnit (source-edit refreshes); absent = throws. */
  unitsById = new Map<number, WeblateUnit>();

  async getUnit(id: number): Promise<WeblateUnit> {
    const unit = this.unitsById.get(id);
    if (unit === undefined) throw new Error(`not implemented: getUnit ${id}`);
    return unit;
  }
  async patchUnit(id: number, _body: UnitPatchBody): Promise<WeblateUnit> {
    throw new Error(`not implemented: patchUnit ${id}`);
  }
  async createUnit(_unitsUrl: string, _body: never): Promise<WeblateUnit> {
    throw new Error('not implemented: createUnit');
  }
  async deleteUnit(_id: number): Promise<void> {
    throw new Error('not implemented: deleteUnit');
  }

  async *listUnits(url: string, q?: string): AsyncIterable<WeblateUnit> {
    const lang = url.split('/').filter(Boolean).at(-2) ?? '';
    const gate = this.gates.get(lang);
    if (gate !== undefined) await gate;
    for (const unit of this.unitsByLang.get(lang) ?? []) {
      if (q !== undefined) {
        const m = /^changed:>=(.+)$/.exec(q);
        if (m !== null && unit.last_updated < m[1]!) continue;
      }
      yield unit;
    }
  }
}

function translation(lang: string, isSource: boolean): WeblateTranslation {
  return {
    language: { code: lang, name: lang },
    is_source: isSource,
    units_list_url: `fake://translations/p/c/${lang}/units/`,
    web_url: '',
  };
}

function unit(
  id: number,
  hash: number,
  lang: string,
  source: string[],
  target: string[],
  lastUpdated: string,
  state: WeblateUnit['state'] = 20,
): WeblateUnit {
  return {
    id,
    translation: `fake://api/translations/p/c/${lang}`,
    source,
    previous_source: null,
    target,
    content_hash: hash,
    id_hash: hash,
    location: '',
    context: '',
    note: '',
    flags: '',
    state,
    fuzzy: false,
    translated: state >= 20,
    approved: state === 30,
    position: id,
    has_suggestion: false,
    has_comment: false,
    has_failing_check: false,
    num_words: 1,
    priority: 100,
    web_url: '',
    source_unit: 'fake://api/units/1',
    pending: false,
    timestamp: '2026-01-01T00:00:00.000Z',
    last_updated: lastUpdated,
  };
}

const QUERY = {
  sort: 'modified-desc' as const,
  filter: 'all' as const,
  offset: 0,
  limit: 50,
};

describe('ComponentCache', () => {
  it('serves progressively while languages are still loading', async () => {
    const api = new FakeWeblate();
    api.translations = [translation('en', true), translation('de', false)];
    api.unitsByLang.set('en', [unit(1, 101, 'en', ['Hi'], ['Hi'], '2026-02-01T00:00:00.000Z')]);
    api.unitsByLang.set('de', [unit(2, 101, 'de', ['Hi'], ['Hallo'], '2026-03-01T00:00:00.000Z')]);

    let releaseDe!: () => void;
    api.gates.set('de', new Promise<void>((r) => (releaseDe = r)));

    const cache = new ComponentCache('p', 'c', api);
    const first = cache.getRowsPage(QUERY);
    expect(first.complete).toBe(false);
    expect(first.rows).toHaveLength(0);

    // Give the source language stream time to finish.
    await new Promise((r) => setTimeout(r, 10));
    const partial = cache.getRowsPage(QUERY);
    expect(partial.complete).toBe(false);
    expect(partial.rows).toHaveLength(1); // en arrived, de still gated

    releaseDe();
    await cache.loadSettled;
    const done = cache.getRowsPage(QUERY);
    expect(done.complete).toBe(true);
    expect(done.rows).toHaveLength(1);
    expect(done.rows[0]!.cells['de']?.target).toEqual(['Hallo']);
    // row lastUpdated = max(de 03-01, source 02-01)
    expect(done.rows[0]!.lastUpdated).toBe('2026-03-01T00:00:00.000Z');
  });

  it('delta-refreshes changed units when stale', async () => {
    const api = new FakeWeblate();
    api.translations = [translation('en', true), translation('de', false)];
    api.unitsByLang.set('en', [unit(1, 101, 'en', ['Hi'], ['Hi'], '2026-02-01T00:00:00.000Z')]);
    api.unitsByLang.set('de', [unit(2, 101, 'de', ['Hi'], ['Hallo'], '2026-03-01T00:00:00.000Z')]);

    let clock = 1_000_000;
    const cache = new ComponentCache('p', 'c', api, () => clock, 0 /* always stale */);
    cache.getRowsPage(QUERY);
    await cache.loadSettled;
    expect(cache.rows.get('u1')!.cells['de']!.target).toEqual(['Hallo']);

    // Someone edits in Weblate meanwhile.
    api.unitsByLang.set('de', [
      unit(2, 101, 'de', ['Hi'], ['Hallo!'], '2026-09-01T00:00:00.000Z', 30),
    ]);

    clock += 60_000;
    cache.getRowsPage(QUERY); // stale -> triggers background delta
    await cache.deltaPromise;

    const row = cache.rows.get('u1')!;
    expect(row.cells['de']!.target).toEqual(['Hallo!']);
    expect(row.cells['de']!.state).toBe(30);
    expect(row.lastUpdated).toBe('2026-09-01T00:00:00.000Z');
  });

  it('applies unit updates from edits without refetching', async () => {
    const api = new FakeWeblate();
    api.translations = [translation('en', true), translation('de', false)];
    api.unitsByLang.set('en', [unit(1, 101, 'en', ['Hi'], ['Hi'], '2026-02-01T00:00:00.000Z')]);
    api.unitsByLang.set('de', [unit(2, 101, 'de', ['Hi'], ['Hallo'], '2026-03-01T00:00:00.000Z')]);

    const cache = new ComponentCache('p', 'c', api);
    cache.getRowsPage(QUERY);
    await cache.loadSettled;

    const updated = unit(2, 101, 'de', ['Hi'], ['Hallo!!'], '2026-09-01T12:00:00.000Z', 30);
    const applied = cache.applyUnitUpdate(updated);
    expect(applied).not.toBeNull();
    expect(applied!.cell.state).toBe(30);
    expect(cache.rows.get('u1')!.cells['de']!.target).toEqual(['Hallo!!']);
  });

  it('filters follow the visible language columns (hiddenLangs)', async () => {
    const api = new FakeWeblate();
    api.translations = [
      translation('en', true),
      translation('de', false),
      translation('fr', false),
    ];
    // u1: de translated, fr untranslated. u2: de untranslated, fr missing.
    api.unitsByLang.set('en', [
      unit(1, 101, 'en', ['Hi'], ['Hi'], '2026-02-01T00:00:00.000Z'),
      unit(3, 102, 'en', ['Bye'], ['Bye'], '2026-02-02T00:00:00.000Z'),
    ]);
    const byeDe = unit(4, 102, 'de', ['Bye'], [''], '2026-03-02T00:00:00.000Z', 0);
    byeDe.source_unit = 'fake://api/units/3';
    api.unitsByLang.set('de', [
      unit(2, 101, 'de', ['Hi'], ['Hallo'], '2026-03-01T00:00:00.000Z'),
      byeDe,
    ]);
    api.unitsByLang.set('fr', [
      unit(5, 101, 'fr', ['Hi'], [''], '2026-03-03T00:00:00.000Z', 0),
    ]);

    const cache = new ComponentCache('p', 'c', api);
    cache.getRowsPage(QUERY);
    await cache.loadSettled;

    // All languages visible: u1 (fr untranslated) and u3 (de untranslated).
    const all = cache.getRowsPage({ ...QUERY, filter: 'untranslated' });
    expect(all.rows.map((r) => r.key).sort()).toEqual(['u1', 'u3']);

    // fr hidden: u1 is fully translated among the visible languages.
    const deOnly = cache.getRowsPage({ ...QUERY, filter: 'untranslated', hiddenLangs: 'fr' });
    expect(deOnly.rows.map((r) => r.key)).toEqual(['u3']);

    // Hiding every language falls back to all of them.
    const noneVisible = cache.getRowsPage({
      ...QUERY,
      filter: 'untranslated',
      hiddenLangs: 'de,fr',
    });
    expect(noneVisible.rows.map((r) => r.key).sort()).toEqual(['u1', 'u3']);
  });

  it("id-list filter matches by the query's context keys", async () => {
    const api = new FakeWeblate();
    api.translations = [translation('en', true), translation('de', false)];
    const hi = unit(1, 101, 'en', ['Hi'], ['Hi'], '2026-02-01T00:00:00.000Z');
    hi.context = 'ID0002';
    const bye = unit(3, 102, 'en', ['Bye'], ['Bye'], '2026-02-02T00:00:00.000Z');
    bye.context = 'ID0003';
    api.unitsByLang.set('en', [hi, bye]);
    api.unitsByLang.set('de', [
      unit(2, 101, 'de', ['Hi'], ['Hallo'], '2026-03-01T00:00:00.000Z'),
    ]);

    const cache = new ComponentCache('p', 'c', api);
    cache.getRowsPage(QUERY);
    await cache.loadSettled;

    const got = cache.getRowsPage({
      ...QUERY,
      filter: 'id-list',
      contextSet: new Set(['ID0002', 'ID9999']),
    });
    expect(got.rows.map((r) => r.key)).toEqual(['u1']);
    expect(got.total).toBe(1);

    // Empty set shows nothing.
    const empty = cache.getRowsPage({ ...QUERY, filter: 'id-list', contextSet: new Set() });
    expect(empty.total).toBe(0);
  });

  it('refreshRowUnits re-reads translation units after a source edit', async () => {
    const api = new FakeWeblate();
    api.translations = [translation('en', true), translation('de', false)];
    api.unitsByLang.set('en', [unit(1, 101, 'en', ['Hi'], ['Hi'], '2026-02-01T00:00:00.000Z')]);
    api.unitsByLang.set('de', [unit(2, 101, 'de', ['Hi'], ['Hallo'], '2026-03-01T00:00:00.000Z')]);

    const cache = new ComponentCache('p', 'c', api);
    cache.getRowsPage(QUERY);
    await cache.loadSettled;
    expect(cache.rows.get('u1')!.cells['de']!.hasFailingCheck).toBe(false);

    // Editing the source made Weblate's check engine flag the de unit.
    const refreshed = unit(2, 101, 'de', ['Hi!'], ['Hallo'], '2026-03-01T00:00:00.000Z');
    refreshed.has_failing_check = true;
    api.unitsById.set(2, refreshed);

    await cache.refreshRowUnits('u1');
    expect(cache.rows.get('u1')!.cells['de']!.hasFailingCheck).toBe(true);
    // Unknown row keys are a no-op, not an error.
    await expect(cache.refreshRowUnits('u999')).resolves.toBeUndefined();
  });

  it('reports load errors but keeps partial data', async () => {
    const api = new FakeWeblate();
    api.translations = [translation('en', true)];
    api.unitsByLang.set('en', []);
    // No de translation object at all — listUnits will throw for it.

    const failing = new FakeWeblate();
    failing.translations = [translation('en', true), translation('xx', false)];
    failing.gates.set('xx', Promise.reject(new Error('boom')));

    const cache = new ComponentCache('p', 'c', failing);
    cache.getRowsPage(QUERY);
    await cache.loadSettled;
    const page = cache.getRowsPage(QUERY);
    expect(page.complete).toBe(true);
    expect(page.error).toContain('boom');
  });
});

describe('CacheRegistry', () => {
  it('evicts the oldest non-loading cache when over the cap', () => {
    const api = new FakeWeblate();
    api.translations = [translation('en', true)];
    api.unitsByLang.set('en', []);

    let clock = 0;
    const registry = new CacheRegistry(api, 2, 1_000_000, () => clock);

    registry.get('p', 'one');
    clock += 1;
    registry.get('p', 'two');
    clock += 1;
    registry.get('p', 'three'); // over cap -> 'one' evicted

    expect(registry.stats().map((s) => s.key).sort()).toEqual([
      'p/three',
      'p/two',
    ]);
  });
});