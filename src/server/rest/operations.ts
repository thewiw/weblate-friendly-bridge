/**
 * Shared string operations backing both the external REST API
 * (rest/router.ts) and the MCP server (mcp/server.ts).
 *
 * Functions take the caller's Weblate client (per-request for REST/MCP, so
 * permissions follow the API key) and the shared CacheRegistry, throw
 * UpstreamError (HTTP status semantics) instead of writing responses, and
 * return plain result objects the two surfaces serialize as they see fit.
 *
 * Unit identity: context keys (the live instance keys strings as ID0002…).
 * Lookups go straight to Weblate (units search q=context:<key>) so requests
 * never wait for the component cache; the cache is refreshed opportunistically.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { UnitState, WeblateTranslation, WeblateUnit } from '../../shared/weblate-dto.js';
import { UpstreamError } from '../http-errors.js';
import { isNotFound, unknownComponentError } from '../component-lookup.js';
import type { CacheRegistry } from '../cache/cache-registry.js';
import type { WeblateApi } from '../weblate/client.js';

/** State that means "needs editing" — required for created translations. */
const NEEDS_EDITING: UnitState = 10;
/** Max strings per batch-create request. */
export const MAX_BATCH_ITEMS = 100;

/** One string to create: source text plus optional per-language translations. */
export const createItemSchema = z.object({
  /** Context key; Weblate generates one when omitted. */
  context: z.string().min(1).max(500).optional(),
  /** Source-language text (string, or array for plural forms). */
  source: z.union([z.string(), z.array(z.string())]),
  /** Other-language texts; created as "Needs editing". */
  translations: z
    .record(z.string().min(1), z.union([z.string(), z.array(z.string())]))
    .optional(),
});

export const createItemsSchema = z.array(createItemSchema).min(1).max(MAX_BATCH_ITEMS);

export const translationsPatchSchema = z
  .record(
    z.string().min(1),
    z.object({
      target: z.union([z.string(), z.array(z.string())]),
      state: z.union([z.literal(0), z.literal(10), z.literal(20), z.literal(30)]).optional(),
    }),
  )
  .refine((t) => Object.keys(t).length > 0, 'At least one language is required');

/** Item shape for batch-create (context optional, source required). */
export type CreateItem = z.infer<typeof createItemSchema>;
/** Per-language change for a modify (target required, state defaults to 20). */
export type TranslationPatch = z.infer<typeof translationsPatchSchema>;

/** Result of one batch-create item (or of one translation inside it). */
export type CreateResult = Record<string, unknown>;

export interface DeleteOptions {
  /** Target language; omit to delete the whole string. */
  language?: string;
  /** Required to delete the whole string via language=<source>. */
  all?: boolean;
  /** Per-language delete = clear (state 0 + empty target). */
  clear?: boolean;
}

const asArray = (v: string | string[]): string[] => (Array.isArray(v) ? v : [v]);

/**
 * Resolves a component's source language from its translation list,
 * turning "not there" into a precise, actionable 404 (unknown project vs
 * component, slug suggestion) instead of the raw upstream "Not found".
 */
const sourceLanguageOf = async (
  api: WeblateApi,
  project: string,
  component: string,
): Promise<string> => {
  const translations = await listTranslationsOr404(api, project, component);
  return translations.find((t) => t.is_source)?.language.code ?? '';
};

/** Lists a component's translations, mapping "not there" to a precise 404. */
const listTranslationsOr404 = async (
  api: WeblateApi,
  project: string,
  component: string,
): Promise<WeblateTranslation[]> => {
  let translations;
  try {
    translations = await api.listTranslations(api.translationsUrlFor(project, component));
  } catch (err) {
    if (!isNotFound(err)) throw err;
    throw await unknownComponentError(api, project, component);
  }
  if (translations.length === 0) {
    throw await unknownComponentError(api, project, component);
  }
  return translations;
};

/** First unit id of a context within one translation (null = none). */
const findUnitByContext = async (
  api: WeblateApi,
  project: string,
  component: string,
  language: string,
  context: string,
): Promise<number | null> => {
  // Weblate's context: search is a SUBSTRING match ("context:truc" also
  // finds "…INSTRUCTION…") — verify the context is exactly the requested
  // one before trusting a hit.
  for await (const unit of api.listUnits(
    api.unitsUrlFor(project, component, language),
    `context:${context}`,
  )) {
    if (unit.context === context) return unit.id;
  }
  return null;
};

/**
 * Cache touch-ups for UI consistency — no-ops when the component cache
 * is not loaded (a fresh UI load fetches the current data anyway).
 */

/** Delta refresh: picks up created/modified units by timestamp. */
const touchCacheChanged = (registry: CacheRegistry, project: string, component: string): void => {
  const cache = registry.peek(project, component);
  if (cache !== null && cache.status === 'ready') {
    void cache.refreshChanged().catch(() => {});
  }
};

/** Applies an updated unit to the cache (after a modify). */
const touchCacheUnit = (registry: CacheRegistry, unit: WeblateUnit): void => {
  const cache = registry.findByUnitId(unit.id);
  if (cache !== null) cache.applyUnitUpdate(unit);
};

/** Applies a deletion to the cache (whole row for source-unit deletes). */
const touchCacheRemoval = (registry: CacheRegistry, unitId: number): void => {
  const cache = registry.findByUnitId(unitId);
  if (cache !== null) cache.removeUnit(unitId);
};

/** Creates a batch of strings (source unit + per-language translations). */
export async function createStrings(
  api: WeblateApi,
  registry: CacheRegistry,
  project: string,
  component: string,
  items: readonly CreateItem[],
): Promise<{ results: CreateResult[] }> {
  const sourceLanguage = await sourceLanguageOf(api, project, component);
  if (sourceLanguage === '') {
    throw new UpstreamError(
      404,
      `Component ${project}/${component} has no source translation`,
    );
  }

  const results: CreateResult[] = [];
  for (const item of items) {
    const source = asArray(item.source);
    try {
      if (source.length === 0 || source.every((t) => t.trim() === '')) {
        throw new UpstreamError(400, 'Source text must not be empty');
      }

      // 1. Create the source unit. This Weblate version requires an
      //    explicit key (no auto-generation), so we generate one here
      //    when the caller did not provide a context.
      const requestedContext = item.context ?? `auto-${randomUUID().slice(0, 12)}`;
      const created = await api.createUnit(api.unitsUrlFor(project, component, sourceLanguage), {
        key: requestedContext,
        source,
        target: source,
        state: 20,
      });
      const context = created.context !== '' ? created.context : requestedContext;

      // 2. Each provided translation: find the propagated sibling unit
      //    and set it to "Needs editing"; create it when not visible.
      //    RACE: Weblate propagates the new string to every translation
      //    immediately, but its search index (q=context:…) can lag — the
      //    lookup then misses the propagated unit and the fallback create
      //    collides with it (upstream 404). On a failed create, re-check
      //    the lookup before giving up.
      const translations: Record<string, { unitId: number; state: number }> = {};
      for (const [lang, text] of Object.entries(item.translations ?? {})) {
        try {
          const target = asArray(text);
          let unitId: number | null = await findUnitByContext(
            api,
            project,
            component,
            lang,
            context,
          );
          if (unitId !== null) {
            await api.patchUnit(unitId, { target, state: NEEDS_EDITING });
          } else {
            try {
              const fallback = await api.createUnit(api.unitsUrlFor(project, component, lang), {
                key: context,
                source,
                target,
                state: NEEDS_EDITING,
              });
              unitId = fallback.id;
            } catch (err) {
              // The context exists after all (propagation outran the search
              // index) — patch the propagated unit instead of failing.
              unitId = await findUnitByContext(api, project, component, lang, context);
              if (unitId === null) throw err;
              await api.patchUnit(unitId, { target, state: NEEDS_EDITING });
            }
          }
          translations[lang] = { unitId, state: NEEDS_EDITING };
        } catch (err) {
          results.push({
            ok: false,
            context,
            language: lang,
            error:
              `Weblate rejected the "${lang}" translation for context "${context}": ` +
              (err instanceof Error ? err.message : String(err)),
          });
        }
      }
      results.push({
        ok: true,
        context,
        sourceUnitId: created.id,
        ...(Object.keys(translations).length > 0 ? { translations } : {}),
      });
    } catch (err) {
      results.push({
        ok: false,
        ...(item.context !== undefined ? { context: item.context } : {}),
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  touchCacheChanged(registry, project, component);
  return { results };
}

/** Sets several languages of one string (target + optional state). */
export async function patchTranslations(
  api: WeblateApi,
  registry: CacheRegistry,
  project: string,
  component: string,
  context: string,
  changes: TranslationPatch,
): Promise<{ context: string; translations: Record<string, { unitId: number; state: number }>; errors?: Record<string, string> }> {
  const translations: Record<string, { unitId: number; state: number }> = {};
  const errors: Record<string, string> = {};
  let notFoundCount = 0;
  for (const [lang, change] of Object.entries(changes)) {
    try {
      const target = asArray(change.target);
      const state: UnitState = change.state ?? 20;
      // Live rules: state 20+ requires content; state 0 requires empty.
      const effectiveTarget = state === 0 ? target.map(() => '') : target;
      const unitId = await findUnitByContext(api, project, component, lang, context);
      if (unitId === null) {
        notFoundCount++;
        errors[lang] =
          `No "${lang}" translation exists for this context yet (create it via a batch-create with "${lang}" in translations)`;
        continue;
      }
      await api.patchUnit(unitId, { target: effectiveTarget, state });
      const full = await api.getUnit(unitId);
      touchCacheUnit(registry, full);
      translations[lang] = { unitId, state };
    } catch (err) {
      errors[lang] = err instanceof Error ? err.message : String(err);
    }
  }
  // Nothing found at all → the string does not exist.
  if (
    Object.keys(translations).length === 0 &&
    notFoundCount === Object.keys(changes).length
  ) {
    throw new UpstreamError(
      404,
      `Unknown context: no string with context key "${context}" exists in ${project}/${component} ` +
        `(strings are addressed by their context key, e.g. ID0001 — not by unit id)`,
    );
  }
  return {
    context,
    translations,
    ...(Object.keys(errors).length > 0 ? { errors } : {}),
  };
}

/**
 * Deletes one language of a string, or the whole string when no language
 * is given. Live Weblate removes the entire string with the source unit;
 * a single target-language translation can only be cleared (state 0).
 */
export async function deleteTranslation(
  api: WeblateApi,
  registry: CacheRegistry,
  project: string,
  component: string,
  context: string,
  opts: DeleteOptions = {},
): Promise<Record<string, unknown>> {
  const sourceLanguage = await sourceLanguageOf(api, project, component);
  if (sourceLanguage === '') {
    throw new UpstreamError(
      404,
      `Component ${project}/${component} has no source translation`,
    );
  }

  // Blank language counts as "no language" (matches the REST query param).
  const language =
    opts.language !== undefined && opts.language.trim() !== '' ? opts.language : undefined;

  // No language → delete the whole context (every language at once):
  // live Weblate removes the entire string with the source unit.
  if (language === undefined) {
    const unitId = await findUnitByContext(api, project, component, sourceLanguage, context);
    if (unitId === null) {
      throw new UpstreamError(
        404,
        `Unknown context: no string with context key "${context}" exists in ${project}/${component}`,
      );
    }
    await api.deleteUnit(unitId);
    touchCacheRemoval(registry, unitId);
    return { deleted: true, context, wholeString: true };
  }

  const isSource = language === sourceLanguage;
  if (isSource && !opts.all) {
    throw new UpstreamError(
      400,
      'Deleting the source-language unit removes the whole string — pass all=true to confirm',
    );
  }
  const unitId = await findUnitByContext(api, project, component, language, context);
  if (unitId === null) {
    throw new UpstreamError(404, `No translation in "${language}" for context ${context}`);
  }

  // Live Weblate does not allow deleting individual target-language
  // units — per-language "delete" means clearing the translation
  // (state 0 + empty target), opted in with clear=true.
  if (!isSource && !opts.clear) {
    throw new UpstreamError(
      422,
      'Weblate does not support deleting a single target-language translation. Use clear=true to empty it (state 0), or all=true&language=<source> to delete the whole string.',
    );
  }

  if (!isSource) {
    await api.patchUnit(unitId, { target: [''], state: 0 });
    const full = await api.getUnit(unitId);
    touchCacheUnit(registry, full);
    return { cleared: true, context, language };
  }

  await api.deleteUnit(unitId);
  touchCacheRemoval(registry, unitId);
  return {
    deleted: true,
    context,
    language,
    ...(isSource ? { wholeString: true } : {}),
  };
}
// ---- Read-only string lookup (list_strings) ----

/** Max page size for listStrings (callers page via offset). */
export const MAX_LIST_STRINGS = 500;

export interface ListStringsOptions {
  /** Exact context keys — short-circuits all other filters. */
  contexts?: string[];
  /** Context starts with (namespace browsing). */
  contextPrefix?: string;
  /** Case-insensitive substring match against the text of `language`. */
  textContains?: string;
  /** Language searched and returned as `source` (default: source language). */
  language?: string;
  /** Translations included in the results (default: none). */
  languages?: string[];
  limit?: number;
  offset?: number;
}

/** Text of one unit: single string, or array of plural forms. */
const textOf = (values: string[]): string | string[] =>
  values.length > 1 ? values : (values[0] ?? '');

/** All units of one translation, keyed by content_hash (insertion order). */
const unitsByHash = async (
  api: WeblateApi,
  project: string,
  component: string,
  language: string,
): Promise<Map<number, WeblateUnit>> => {
  const map = new Map<number, WeblateUnit>();
  for await (const unit of api.listUnits(api.unitsUrlFor(project, component, language))) {
    map.set(unit.content_hash, unit);
  }
  return map;
};

/**
 * Read-only search over the strings of one component. `contexts` is an
 * exact-match lookup (one targeted Weblate search per key — existence
 * checks and post-create verification); the other filters scan the units
 * of the search language and are applied in code (case-insensitive), so
 * behavior never depends on Weblate's q operator semantics. Unknown
 * project/component answer the same precise 404s as the write operations;
 * an empty result set is not an error.
 */
export async function listStrings(
  api: WeblateApi,
  project: string,
  component: string,
  opts: ListStringsOptions = {},
): Promise<{
  total: number;
  offset: number;
  limit: number;
  results: Array<{
    context: string;
    source: string | string[];
    translations: Record<string, { target: string | string[]; state: UnitState }>;
  }>;
}> {
  const translations = await listTranslationsOr404(api, project, component);
  const available = new Set(translations.map((t) => t.language.code));
  const sourceLanguage = translations.find((t) => t.is_source)?.language.code ?? '';

  const searchLanguage = opts.language?.trim() !== '' && opts.language !== undefined
    ? opts.language.trim()
    : sourceLanguage;
  if (!available.has(searchLanguage)) {
    throw new UpstreamError(
      404,
      `Unknown language "${searchLanguage}" in ${project}/${component} — available: ${[...available].join(', ')}.`,
    );
  }

  // The searched strings, in a stable order.
  let units: WeblateUnit[];
  const contexts = (opts.contexts ?? [])
    .map((c) => c.trim())
    .filter((c) => c !== '');
  if (contexts.length > 0) {
    // Exact-match lookups: one targeted search per context (Weblate's
    // context: operator is a substring match — exact-check every hit).
    const found = new Map<number, WeblateUnit>();
    for (const context of contexts) {
      for await (const unit of api.listUnits(
        api.unitsUrlFor(project, component, searchLanguage),
        `context:${context}`,
      )) {
        if (unit.context === context && !found.has(unit.content_hash)) {
          found.set(unit.content_hash, unit);
        }
      }
    }
    // Preserve the caller's context order, dropping missing ones.
    const byContext = new Map([...found.values()].map((u) => [u.context, u]));
    units = contexts.map((c) => byContext.get(c)).filter((u): u is WeblateUnit => u !== undefined);
  } else {
    units = [...(await unitsByHash(api, project, component, searchLanguage)).values()];
    const prefix = opts.contextPrefix?.trim();
    if (prefix !== undefined && prefix !== '') {
      units = units.filter((u) => u.context.startsWith(prefix));
    }
    const text = opts.textContains?.trim().toLowerCase();
    if (text !== undefined && text !== '') {
      units = units.filter((u) => u.target.some((t) => t.toLowerCase().includes(text)));
    }
  }

  const requested = (opts.languages ?? []).filter((l) => available.has(l));
  const transMaps = new Map<string, Map<number, WeblateUnit>>();
  for (const lang of requested) {
    transMaps.set(lang, await unitsByHash(api, project, component, lang));
  }

  const limit = Math.min(Math.max(opts.limit ?? 100, 1), MAX_LIST_STRINGS);
  const offset = Math.max(opts.offset ?? 0, 0);
  const page = units.slice(offset, offset + limit);

  return {
    total: units.length,
    offset,
    limit,
    results: page.map((unit) => ({
      context: unit.context,
      source: textOf(unit.target),
      translations: Object.fromEntries(
        [...transMaps.entries()].map(([lang, map]) => {
          const t = map.get(unit.content_hash);
          return [lang, { target: textOf(t?.target ?? []), state: t?.state ?? 0 }];
        }),
      ),
    })),
  };
}
