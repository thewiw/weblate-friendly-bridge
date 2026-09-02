/**
 * Export orchestration: turns one ExportRequest into exported files, going
 * straight to Weblate (per-request client — permissions follow the caller's
 * key/session; no component-cache dependency, so multi-component exports
 * work without caches being loaded).
 *
 * Key set: the source-language units of each component (i.e. every string).
 * Export key: the unit context when non-empty, otherwise the source text
 * (natural-key style, common for bilingual components).
 * Plural targets export as suffixed keys `key_0`, `key_1`, … (lossless).
 */
import JSZip from 'jszip';
import type { ExportRequest, ExportFile } from '../../shared/export.js';
import { fileNameForLanguage } from '../../shared/export.js';
import type { WeblateApi } from '../weblate/client.js';
import { UpstreamError } from '../http-errors.js';
import { buildFileContent, type ExportEntry } from './formats.js';

/** A finished export file: archive path + serialized content. */
export interface ExportResultFile {
  name: string;
  content: string;
}

/** What a route serializes into the HTTP response, per the packaging param. */
export type ExportPayload =
  | { kind: 'zip'; fileName: string; data: Buffer }
  | { kind: 'json'; files: ExportFile[] };

/** Languages of one component (source first) — used by the UI dialog. */
export async function listComponentLanguages(
  api: WeblateApi,
  project: string,
  component: string,
): Promise<Array<{ code: string; name: string; isSource: boolean }>> {
  const translations = await api.listTranslations(api.translationsUrlFor(project, component));
  const sorted = [...translations].sort((a, b) => Number(b.is_source) - Number(a.is_source));
  return sorted.map((t) => ({
    code: t.language.code,
    name: t.language.name,
    isSource: t.is_source,
  }));
}

/**
 * Units of one translation, keyed by content_hash — the cross-language
 * identity of a string (contexts are not unique: key-less components have
 * many units with context '').
 */
const unitsByHash = async (
  api: WeblateApi,
  project: string,
  component: string,
  language: string,
): Promise<Map<number, { context: string; target: string[] }>> => {
  const map = new Map<number, { context: string; target: string[] }>();
  for await (const unit of api.listUnits(api.unitsUrlFor(project, component, language))) {
    map.set(unit.content_hash, { context: unit.context, target: unit.target });
  }
  return map;
};

/**
 * Runs the export and returns the file set (grouping + file-name rules
 * applied). Throws UpstreamError (404) for unknown components or when no
 * requested language matches.
 */
export async function runExport(
  api: WeblateApi,
  params: ExportRequest,
): Promise<ExportResultFile[]> {
  // Deduplicate scope pairs (same component twice = one export).
  const seen = new Set<string>();
  const scope = params.scope.filter((s) => {
    const key = `${s.project}/${s.component}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const requestedLangs = params.languages?.filter((l) => l.trim() !== '') ?? [];
  const mergedEntries = new Map<string, Map<string, ExportEntry>>(); // language -> key -> entry
  const resultFiles: ExportResultFile[] = [];

  for (const { project, component } of scope) {
    let translations;
    try {
      translations = await api.listTranslations(api.translationsUrlFor(project, component));
    } catch (err) {
      // Unknown components surface as 404s regardless of how the client
      // reports them (live maps upstream 404s differently than the mock).
      if (err instanceof UpstreamError) throw err;
      throw new UpstreamError(404, `Unknown component: ${project}/${component}`);
    }
    if (translations.length === 0) {
      throw new UpstreamError(404, `Unknown component: ${project}/${component}`);
    }
    const sourceLanguage = translations.find((t) => t.is_source)?.language.code ?? '';
    const available = new Set(translations.map((t) => t.language.code));
    const languages =
      requestedLangs.length > 0
        ? requestedLangs.filter((l) => available.has(l))
        : [...available];

    // Key set + source values from the source-language units.
    const sourceUnits =
      sourceLanguage !== ''
        ? await unitsByHash(api, project, component, sourceLanguage)
        : new Map<number, { context: string; target: string[] }>();

    for (const language of languages) {
      const targets =
        language === sourceLanguage
          ? sourceUnits
          : await unitsByHash(api, project, component, language);

      const entries: ExportEntry[] = [];
      for (const [hash, sourceUnit] of sourceUnits) {
        // Plural forms export as key_0, key_1, …
        const forms =
          sourceUnit.target.length > 1 ? sourceUnit.target : [sourceUnit.target[0] ?? ''];
        for (const [idx, form] of forms.entries()) {
          // File key: the context when the component has one, otherwise
          // the source text (natural key, common for bilingual formats).
          const key = sourceUnit.context !== '' ? sourceUnit.context : form;
          const suffix = forms.length > 1 ? `_${idx}` : '';
          const value = language === sourceLanguage ? form : (targets.get(hash)?.target[idx] ?? '');
          entries.push({ key: `${key}${suffix}`, value });
        }
      }

      if (params.grouping === 'per-component') {
        const name = `${project}/${component}/${fileNameForLanguage(params.fileName, language)}`;
        resultFiles.push({ name, content: buildFileContent(entries, language, params.format) });
      } else {
        // Merged: one file per language across all components; the first
        // component in scope order wins on duplicate keys.
        let byKey = mergedEntries.get(language);
        if (byKey === undefined) {
          byKey = new Map();
          mergedEntries.set(language, byKey);
        }
        for (const entry of entries) {
          if (!byKey.has(entry.key)) byKey.set(entry.key, entry);
        }
      }
    }
  }

  for (const [language, byKey] of mergedEntries) {
    resultFiles.push({
      name: fileNameForLanguage(params.fileName, language),
      content: buildFileContent([...byKey.values()], language, params.format),
    });
  }

  if (resultFiles.length === 0) {
    throw new UpstreamError(404, 'No matching languages to export');
  }
  return resultFiles;
}

/** Packs the export per the packaging parameter. */
export async function packageExport(
  files: readonly ExportResultFile[],
  packaging: ExportRequest['packaging'],
): Promise<ExportPayload> {
  if (packaging === 'json') {
    return {
      kind: 'json',
      files: files.map((f) => ({ name: f.name, contentBase64: Buffer.from(f.content, 'utf-8').toString('base64') })),
    };
  }
  const zip = new JSZip();
  for (const file of files) zip.file(file.name, file.content);
  const data = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  return { kind: 'zip', fileName: 'export.zip', data };
}