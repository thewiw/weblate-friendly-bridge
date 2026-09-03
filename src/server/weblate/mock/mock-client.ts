/**
 * Deterministic in-memory Weblate: same interface as LiveWeblateClient,
 * fully mutable (patchUnit updates the stored units). Used for offline
 * development and integration tests — the whole app, including editing,
 * works without network access.
 */
import type {
  UnitCreateBody,
  UnitPatchBody,
  WeblateComponent,
  WeblateProject,
  WeblateTranslation,
  WeblateUnit,
} from '../../../shared/weblate-dto.js';
import type {
  ListUnitsOptions,
  RateBudget,
  WeblateApi,
} from '../client.js';
import { UpstreamError } from '../../http-errors.js';

const SOURCE_LANG = 'en';
const TARGET_LANGS = ['de', 'fr', 'cs'] as const;
const LANG_NAMES: Record<string, string> = {
  en: 'English',
  de: 'German',
  fr: 'French',
  cs: 'Czech',
};
const STRING_COUNT = 400;

export interface MockData {
  projects: WeblateProject[];
  components: Map<string, WeblateComponent>; // key `${project}/${component}`
  translations: Map<string, WeblateTranslation[]>; // key `${project}/${component}`
  units: Map<number, WeblateUnit>; // unit id -> unit
}

/** Deterministic PRNG so every run sees identical mock data. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rand: () => number, items: readonly T[]): T {
  return items[Math.floor(rand() * items.length)] as T;
}

const SAMPLE_SOURCES = [
  'Save changes',
  'Delete project',
  'Connection lost. Please retry.',
  'Welcome back, {name}!',
  'Search translations…',
  '{count} item(s) selected',
  'This action cannot be undone.',
  'Loading…',
  'Invalid username or password',
  'Server error — try again later',
  'Language preferences',
  'Notifications',
];

export function buildMockData(now: Date = new Date()): MockData {
  const rand = mulberry32(42);
  const projects: WeblateProject[] = [
    { slug: 'friendly-suite', name: 'Friendly Suite', web_url: '#/friendly-suite' },
    { slug: 'friendly-mobile', name: 'Friendly Mobile', web_url: '#/friendly-mobile' },
    { slug: 'customer-portal', name: 'Customer Portal', web_url: '#/customer-portal' },
  ];

  const componentSpecs = [
    { project: 'friendly-suite', slug: 'web-ui', name: 'Web UI' },
    { project: 'friendly-suite', slug: 'reports', name: 'Reports' },
    { project: 'friendly-mobile', slug: 'app-strings', name: 'App Strings' },
    { project: 'customer-portal', slug: 'frontend', name: 'Frontend' },
  ];

  const components = new Map<string, WeblateComponent>();
  const translations = new Map<string, WeblateTranslation[]>();
  const units = new Map<number, WeblateUnit>();

  const allLangs = [SOURCE_LANG, ...TARGET_LANGS];
  const nowMs = now.getTime();

  for (const spec of componentSpecs) {
    const key = `${spec.project}/${spec.slug}`;
    components.set(key, {
      slug: spec.slug,
      name: spec.name,
      project: spec.project,
      source_language: { code: SOURCE_LANG, name: LANG_NAMES[SOURCE_LANG]! },
      translations_url: `mock://components/${spec.project}/${spec.slug}/translations/`,
      web_url: `mock://translate/${key}`,
    });

    translations.set(
      key,
      allLangs.map((code) => ({
        language: { code, name: LANG_NAMES[code]! },
        is_source: code === SOURCE_LANG,
        // Live Weblate reports the unit count per translation; export
        // progress uses it as the denominator.
        total: STRING_COUNT,
        units_list_url: `mock://translations/${key}/${code}/units/`,
        web_url: `mock://translate/${key}/${code}`,
      })),
    );

    for (let i = 0; i < STRING_COUNT; i++) {
      const base = pick(rand, SAMPLE_SOURCES);
      const isPlural = i % 23 === 0; // a handful of plural strings
      const source = isPlural ? [base, base.replace('{count}', '{count, plural, =1 {one item} other {# items}}')] : [base];
      // Created spread over the last 180 days.
      const createdAt = new Date(
        nowMs - Math.floor(rand() * 180 * 24 * 3600 * 1000),
      ).toISOString();
      // Int64-style hash like the live API returns (JS-safe range).
      const contentHash = ((i + 1) * 2654435761) % 281474976710655 - 281474976710656 / 2;
      const context = i % 11 === 0 ? `ctx-${i}` : '';

      for (const [langIdx, lang] of allLangs.entries()) {
        // Czech is missing some units entirely — exercises missing cells.
        if (lang === 'cs' && i % 37 === 5) continue;

        const unitId = 100_000 + componentSpecs.indexOf(spec) * 10_000_000
          + langIdx * 100_000 + i;

        // Recent edits cluster in the last minutes so modified-desc looks live.
        let lastUpdated: string;
        const roll = rand();
        if (roll < 0.06) {
          lastUpdated = new Date(
            nowMs - Math.floor(rand() * 20 * 60 * 1000),
          ).toISOString();
        } else if (roll < 0.3) {
          lastUpdated = new Date(
            nowMs - Math.floor(rand() * 30 * 24 * 3600 * 1000),
          ).toISOString();
        } else {
          lastUpdated = createdAt;
        }

        let state: WeblateUnit['state'];
        if (lang === SOURCE_LANG) {
          state = 20; // source units are editable, like live Weblate
        } else {
          const s = rand();
          state =
            s < 0.15 ? 0 : s < 0.3 ? 10 : s < 0.75 ? 20 : 30;
        }

        const target =
          lang === SOURCE_LANG
            ? source
            : state === 0
              ? source.map(() => '')
              : source.map((s) => `${s} [${lang.toUpperCase()}]`);

        units.set(unitId, {
          id: unitId,
          translation: `mock://api/translations/${key}/${lang}`,
          language_code: lang,
          source,
          previous_source: null,
          target,
          content_hash: contentHash,
          id_hash: contentHash,
          location: `src/strings/${i}.ts:${10 + i}`,
          context,
          note: i % 13 === 0 ? 'Max length: 80 chars' : '',
          flags: isPlural ? 'c-format' : '',
          state,
          fuzzy: state === 10,
          translated: state >= 20,
          approved: state === 30,
          position: i + 1,
          has_suggestion: state === 0 && rand() < 0.2,
          has_comment: rand() < 0.05,
          has_failing_check: state >= 20 && rand() < 0.08,
          num_words: base.split(' ').length,
          priority: 100,
          web_url: `mock://translate/${key}/-/unit/${unitId}`,
          source_unit: `mock://api/units/${100_000 + componentSpecs.indexOf(spec) * 10_000_000 + i}`,
          pending: false,
          timestamp: createdAt,
          last_updated: lastUpdated,
        });
      }
    }
  }

  return { projects, components, translations, units };
}


export class MockWeblateClient implements WeblateApi {
  readonly mode = 'mock' as const;

  private data: MockData;
  /** Ids for units created through createUnit (disjoint from fixtures). */
  private nextUnitId = 900_000_000;
  /** Autogenerated context keys for key-less creates. */
  private nextAutoKey = 1;
  private nextContentHash = -900_000_000;

  constructor(now: Date = new Date()) {
    this.data = buildMockData(now);
  }

  getRateBudget(): RateBudget {
    return { limit: 5000, remaining: 4900, reset: null };
  }

  async listProjects(): Promise<WeblateProject[]> {
    return this.data.projects;
  }

  async getProject(project: string): Promise<WeblateProject> {
    const p = this.data.projects.find((x) => x.slug === project);
    if (p === undefined) throw new UpstreamError(404, `Unknown project: ${project}`);
    return { ...p, translation_review: true };
  }

  async listComponents(project: string): Promise<WeblateComponent[]> {
    return [...this.data.components.values()].filter(
      (c) => c.project === project,
    );
  }

  translationsUrlFor(project: string, component: string): string {
    return `mock://components/${project}/${component}/translations/`;
  }

  unitsUrlFor(project: string, component: string, language: string): string {
    return `mock://translations/${project}/${component}/${language}/units/`;
  }

  async listTranslations(
    translationsUrl: string,
  ): Promise<WeblateTranslation[]> {
    const key = this.parseKey(translationsUrl, 'translations');
    const list = this.data.translations.get(key);
    if (list === undefined) throw new Error(`Unknown component: ${translationsUrl}`);
    return list;
  }

  listUnits(
    translationUnitsUrl: string,
    q?: string,
    _opts?: ListUnitsOptions,
  ): AsyncIterable<WeblateUnit> {
    const { key, lang } = this.parseUnitsUrl(translationUnitsUrl);
    const translation = this.data.translations.get(key)?.find(
      (t) => t.language.code === lang,
    );
    if (translation === undefined) {
      throw new Error(`Unknown translation: ${translationUnitsUrl}`);
    }

    const units = [...this.data.units.values()].filter(
      (u) => u.translation.endsWith(`${key}/${lang}`),
    );

    const filtered = q !== undefined ? filterByQ(units, q) : units;

    return {
      async *[Symbol.asyncIterator]() {
        for (const unit of filtered) yield { ...unit };
      },
    };
  }

  async getUnit(id: number): Promise<WeblateUnit> {
    const unit = this.data.units.get(id);
    if (unit === undefined) throw new UpstreamError(404, `Unknown unit: ${id}`);
    return { ...unit };
  }

  async patchUnit(id: number, body: UnitPatchBody): Promise<WeblateUnit> {
    const unit = this.data.units.get(id);
    if (unit === undefined) throw new UpstreamError(404, `Unknown unit: ${id}`);
    if (unit.state === 100) {
      throw new UpstreamError(403, 'Cannot edit a read-only unit');
    }
    const unitLang = unit.translation.split('/').filter(Boolean).at(-1);
    // Live Weblate rejects a needs-editing/translated/approved state on an
    // empty target (translated strings must have content), and the
    // untranslated state on a non-empty target.
    const effectiveTarget = body.target ?? unit.target;
    if (
      (body.state ?? unit.state) >= 10 &&
      effectiveTarget.every((t) => t.trim() === '')
    ) {
      throw new UpstreamError(400, 'Translated string must not be empty');
    }
    if ((body.state ?? 0) === 0 && effectiveTarget.some((t) => t.trim() !== '')) {
      throw new UpstreamError(400, 'Can not use empty state with non empty target');
    }
    if (body.target !== undefined) {
      unit.target = body.target;
      // Editing the source-language unit's target changes the source string.
      if (unitLang === SOURCE_LANG) unit.source = body.target;
    }
    if (body.state !== undefined) {
      unit.state = body.state;
      unit.approved = body.state === 30;
      unit.translated = body.state >= 20;
      unit.fuzzy = body.state === 10;
    }
    if (body.explanation !== undefined) {
      if (unitLang !== SOURCE_LANG) {
        throw new UpstreamError(400, 'Explanation can only be set on source units');
      }
      unit.explanation = body.explanation;
    }
    unit.last_updated = new Date().toISOString();
    return { ...unit };
  }

  async createUnit(unitsUrl: string, body: UnitCreateBody): Promise<WeblateUnit> {
    const { key: compKey, lang } = this.parseUnitsUrl(unitsUrl);
    const translations = this.data.translations.get(compKey);
    if (translations === undefined) throw new UpstreamError(404, `Unknown component: ${compKey}`);
    if (body.source.length === 0 || body.source.some((s) => s.trim() === '')) {
      throw new UpstreamError(400, 'Source string must not be empty');
    }
    const context = body.key !== undefined && body.key !== '' ? body.key : `auto-${this.nextAutoKey++}`;
    const componentUnits = [...this.data.units.values()].filter((u) =>
      u.translation.includes(`/${compKey}/`),
    );
    if (componentUnits.some((u) => u.context === context && u.language_code === lang)) {
      throw new UpstreamError(409, `Unit already exists: ${context} (${lang})`);
    }

    const now = new Date().toISOString();
    const contentHash = this.nextContentHash--;
    // Live Weblate propagates new units to every translation; ensure the
    // source-language sibling exists and remember its id (source_unit).
    let sourceUnit = componentUnits.find(
      (u) => u.context === context && u.language_code === SOURCE_LANG,
    );
    if (sourceUnit === undefined) {
      const id = this.nextUnitId++;
      sourceUnit = this.buildUnit(compKey, SOURCE_LANG, contentHash, context, body.source, body.target ?? body.source, (body.state ?? 20) as WeblateUnit['state'], now, id, id);
      this.data.units.set(id, sourceUnit);
    }

    const isSource = lang === SOURCE_LANG;
    const target = isSource
      ? (body.target ?? body.source)
      : (body.target ?? body.source.map(() => ''));
    const state = (isSource
      ? (body.state ?? 20)
      : (body.target !== undefined ? (body.state ?? 0) : 0)) as WeblateUnit['state'];
    const id = isSource ? sourceUnit.id : this.nextUnitId++;
    const unit = this.buildUnit(compKey, lang, contentHash, context, body.source, target, state, now, sourceUnit.id, id);
    this.data.units.set(id, unit);

    // Propagate empty siblings to the remaining languages.
    for (const t of translations) {
      const other = t.language.code;
      if (other === lang) continue;
      if (componentUnits.some((u) => u.context === context && u.language_code === other)) continue;
      const otherIsSource = other === SOURCE_LANG;
      const otherId = otherIsSource && sourceUnit !== undefined ? sourceUnit.id : this.nextUnitId++;
      const otherTarget = otherIsSource ? body.source : body.source.map(() => '');
      const otherState = otherIsSource ? 20 : 0;
      this.data.units.set(
        otherId,
        this.buildUnit(compKey, other, contentHash, context, body.source, otherTarget, otherState, now, sourceUnit.id, otherId),
      );
    }
    return { ...unit };
  }

  async deleteUnit(id: number): Promise<void> {
    const unit = this.data.units.get(id);
    if (unit === undefined) throw new UpstreamError(404, `Unknown unit: ${id}`);
    const unitLang = unit.translation.split('/').filter(Boolean).at(-1);
    if (unitLang !== SOURCE_LANG) {
      // Live Weblate refuses to delete individual target-language units.
      throw new UpstreamError(400, 'Add the string to the source language instead.');
    }
    // Deleting the source unit removes the whole string.
    for (const [uid, u] of [...this.data.units]) {
      if (u.source_unit === unit.source_unit) this.data.units.delete(uid);
    }
  }

  /** Builds a full WeblateUnit for the mock store. */
  private buildUnit(
    compKey: string,
    lang: string,
    contentHash: number,
    context: string,
    source: string[],
    target: string[],
    state: WeblateUnit['state'],
    now: string,
    sourceUnitId: number,
    id: number,
  ): WeblateUnit {
    return {
      id,
      translation: `mock://api/translations/${compKey}/${lang}`,
      language_code: lang,
      source,
      previous_source: null,
      target,
      content_hash: contentHash,
      id_hash: contentHash,
      location: '',
      context,
      note: '',
      flags: '',
      state,
      fuzzy: state === 10,
      translated: state >= 20,
      approved: state === 30,
      position: 1,
      has_suggestion: false,
      has_comment: false,
      has_failing_check: false,
      num_words: source.join(' ').split(/\s+/).filter(Boolean).length,
      priority: 100,
      web_url: `mock://translate/${compKey}/-/unit/${id}`,
      source_unit: `mock://api/units/${sourceUnitId}`,
      pending: false,
      timestamp: now,
      last_updated: now,
    };
  }

  private parseKey(url: string, what: 'translations'): string {
    // mock://components/<project>/<component>/translations/
    const parts = url.split('/').filter(Boolean).slice(2, 4);
    if (parts.length !== 2) throw new Error(`Bad ${what} URL: ${url}`);
    return `${parts[0]}/${parts[1]}`;
  }

  private parseUnitsUrl(url: string): { key: string; lang: string } {
    // mock://translations/<project>/<component>/<lang>/units/
    const parts = url.split('/').filter(Boolean).slice(2, 5);
    if (parts.length !== 3) throw new Error(`Bad units URL: ${url}`);
    return { key: `${parts[0]}/${parts[1]}`, lang: parts[2] ?? '' };
  }
}

/** Minimal q support: `changed:>=<ISO datetime>` and `context:<key>`. */
function filterByQ(units: WeblateUnit[], q: string): WeblateUnit[] {
  const trimmed = q.trim();
  const changed = /^changed:>=?(.+)$/.exec(trimmed);
  if (changed !== null) return units.filter((u) => u.last_updated >= changed[1]!.trim());
  const context = /^context:(.+)$/.exec(trimmed);
  if (context !== null) {
    const ctx = context[1]!.replace(/^"(.*)"$/, '$1');
    return units.filter((u) => u.context === ctx);
  }
  return units;
}