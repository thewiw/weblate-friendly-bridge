import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { MockWeblateClient } from '../../server/weblate/mock/mock-client.js';
import { buildFileContent } from '../../server/export/formats.js';
import {
  listComponentLanguages,
  packageExport,
  runExport,
} from '../../server/export/export-service.js';
import { fileNameForLanguage } from '../../shared/export.js';

const api = new MockWeblateClient();

const baseRequest = {
  format: 'i18next',
  fileName: '[language].json',
  grouping: 'per-component',
  packaging: 'json',
} as const;

describe('file naming', () => {
  it('resolves the name patterns verbatim (no extension added)', () => {
    expect(fileNameForLanguage('[language].json', 'en')).toBe('en.json');
    expect(fileNameForLanguage('i18n.[language]', 'en')).toBe('i18n.en');
    expect(fileNameForLanguage('i18n.[LANGUAGE]', 'en')).toBe('i18n.EN');
    expect(fileNameForLanguage('i18n.[LANGUAGE]', 'pt-BR')).toBe('i18n.PT-BR');
  });
});

describe('format builders', () => {
  it('builds flat i18next resources', () => {
    const content = buildFileContent(
      [
        { key: 'ID0001', value: 'Hallo' },
        { key: 'Save changes', value: 'Änderungen speichern' },
      ],
      'de',
      'i18next',
    );
    expect(JSON.parse(content)).toEqual({
      ID0001: 'Hallo',
      'Save changes': 'Änderungen speichern',
    });
  });

  it('builds ARB with the @@locale marker first', () => {
    const content = buildFileContent([{ key: 'ID0001', value: 'Bonjour' }], 'fr', 'arb');
    const parsed = JSON.parse(content);
    expect(Object.keys(parsed)[0]).toBe('@@locale');
    expect(parsed).toMatchObject({ '@@locale': 'fr', ID0001: 'Bonjour' });
  });
});

describe('runExport (mock client)', () => {
  it('exports one file per component and language by default', async () => {
    const files = await runExport(api, {
      ...baseRequest,
      scope: [{ project: 'friendly-suite', component: 'web-ui' }],
    });
    // en + de + fr + cs
    expect(files.map((f) => f.name)).toEqual([
      'friendly-suite/web-ui/en.json',
      'friendly-suite/web-ui/de.json',
      'friendly-suite/web-ui/fr.json',
      'friendly-suite/web-ui/cs.json',
    ]);
    for (const file of files) {
      // ~400 strings collapse to fewer unique file keys: key-less strings
      // use their source text as natural key (12 distinct mock sources).
      expect(Object.keys(JSON.parse(file.content)).length).toBeGreaterThan(40);
    }
  });

  it('exports only requested languages when given', async () => {
    const files = await runExport(api, {
      ...baseRequest,
      scope: [{ project: 'friendly-suite', component: 'web-ui' }],
      languages: ['fr', 'de'],
    });
    expect(files.map((f) => f.name)).toEqual([
      'friendly-suite/web-ui/fr.json',
      'friendly-suite/web-ui/de.json',
    ]);
  });

  it('uses context keys, falls back to source text for key-less strings', async () => {
    const files = await runExport(api, {
      ...baseRequest,
      scope: [{ project: 'friendly-suite', component: 'web-ui' }],
      languages: ['en'],
    });
    const entries = JSON.parse(files[0]!.content) as Record<string, string>;
    expect(entries['ctx-11']).toBeDefined(); // context-keyed string
    expect(entries['Save changes']).toBeDefined(); // natural key
  });

  it('exports untranslated strings as empty targets', async () => {
    const files = await runExport(api, {
      ...baseRequest,
      scope: [{ project: 'friendly-suite', component: 'web-ui' }],
      languages: ['de'],
    });
    const values = Object.values(JSON.parse(files[0]!.content) as Record<string, string>);
    expect(values).toContain('');
  });

  it('exports plural forms as suffixed keys', async () => {
    const files = await runExport(api, {
      ...baseRequest,
      scope: [{ project: 'friendly-suite', component: 'web-ui' }],
      languages: ['de'],
    });
    const keys = Object.keys(JSON.parse(files[0]!.content) as Record<string, string>);
    expect(keys.some((k) => /_1$/.test(k))).toBe(true);
  });

  it('merges components into one file per language (first component wins)', async () => {
    const files = await runExport(api, {
      ...baseRequest,
      grouping: 'merged',
      scope: [
        { project: 'friendly-suite', component: 'web-ui' },
        { project: 'friendly-suite', component: 'reports' },
      ],
      languages: ['de'],
    });
    expect(files.map((f) => f.name)).toEqual(['de.json']);
    const entries = JSON.parse(files[0]!.content) as Record<string, string>;
    // Both components contributed (fewer unique keys than strings — natural keys).
    expect(Object.keys(entries).length).toBeGreaterThan(50);
  });

  it('deduplicates repeated scope pairs', async () => {
    const files = await runExport(api, {
      ...baseRequest,
      scope: [
        { project: 'friendly-suite', component: 'web-ui' },
        { project: 'friendly-suite', component: 'web-ui' },
      ],
      languages: ['en'],
    });
    expect(files).toHaveLength(1);
  });

  it('rejects unknown components and unmatched language filters', async () => {
    // Unknown slug: the error lists the available slugs.
    await expect(
      runExport(api, {
        ...baseRequest,
        scope: [{ project: 'friendly-suite', component: 'nope' }],
      }),
    ).rejects.toThrow(/Unknown component: friendly-suite\/nope\. Available components/);

    // A display-name look-up suggests the actual slug (dots are not slugs).
    await expect(
      runExport(api, {
        ...baseRequest,
        scope: [{ project: 'friendly-suite', component: 'Web.UI' }],
      }),
    ).rejects.toThrow(/did you mean the slug "web-ui"/);

    await expect(
      runExport(api, {
        ...baseRequest,
        scope: [{ project: 'friendly-suite', component: 'web-ui' }],
        languages: ['xx'],
      }),
    ).rejects.toThrow(/No matching languages to export — requested \[xx\], available/);
  });
});

describe('packaging', () => {
  it('returns base64 file entries for packaging json', async () => {
    const files = await runExport(api, {
      ...baseRequest,
      scope: [{ project: 'friendly-suite', component: 'reports' }],
      languages: ['en'],
    });
    const payload = await packageExport(files, 'json');
    expect(payload.kind).toBe('json');
    if (payload.kind !== 'json') return;
    expect(payload.files[0]!.name).toBe('friendly-suite/reports/en.json');
    expect(Buffer.from(payload.files[0]!.contentBase64, 'base64').toString('utf-8')).toBe(
      files[0]!.content,
    );
  });

  it('produces a readable zip for packaging zip', async () => {
    const files = await runExport(api, {
      ...baseRequest,
      scope: [{ project: 'friendly-suite', component: 'reports' }],
      languages: ['en'],
    });
    const payload = await packageExport(files, 'zip');
    expect(payload.kind).toBe('zip');
    if (payload.kind !== 'zip') return;
    const zip = await JSZip.loadAsync(payload.data);
    const entry = zip.file('friendly-suite/reports/en.json');
    expect(await entry!.async('string')).toBe(files[0]!.content);
  });
});

describe('listComponentLanguages', () => {
  it('lists languages with the source first', async () => {
    const langs = await listComponentLanguages(api, 'friendly-suite', 'web-ui');
    expect(langs[0]).toMatchObject({ code: 'en', isSource: true });
    expect(langs.map((l) => l.code).sort()).toEqual(['cs', 'de', 'en', 'fr']);
  });
});