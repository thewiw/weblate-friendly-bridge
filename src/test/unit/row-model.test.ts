import { describe, expect, it } from 'vitest';
import type { WeblateUnit } from '../../shared/weblate-dto.js';
import {
  applyUnitToRow,
  filterRows,
  sortRows,
  sliceWindow,
  recomputeLastUpdated,
  sortBySearchRelevance,
  type RowMap,
} from '../../server/cache/row-model.js';
import type { LanguageMeta, SourceRow } from '../../shared/rows.js';

const LANGS: LanguageMeta[] = [
  { code: 'de', name: 'German' },
  { code: 'fr', name: 'French' },
];

function unit(overrides: Partial<WeblateUnit> & { id: number }): WeblateUnit {
  return {
    translation: 'http://wl/api/translations/p/c/en',
    source: ['Hello'],
    previous_source: null,
    target: ['Hello'],
    content_hash: 101,
    id_hash: 101,
    location: 'a.ts:1',
    context: '',
    note: '',
    flags: '',
    state: 20,
    fuzzy: false,
    translated: true,
    approved: false,
    position: 1,
    has_suggestion: false,
    has_comment: false,
    has_failing_check: false,
    num_words: 1,
    priority: 100,
    web_url: 'http://wl/unit/1',
    source_unit: 'http://wl/api/units/1',
    pending: false,
    timestamp: '2026-01-01T10:00:00.000Z',
    last_updated: '2026-01-02T10:00:00.000Z',
    ...overrides,
  };
}

function buildRows(): RowMap {
  const rows: RowMap = new Map();

  // String A: fully approved everywhere, created/modified early.
  applyUnitToRow(rows, unit({ id: 1, content_hash: 1 }), 'en', true);
  applyUnitToRow(
    rows,
    unit({
      id: 11,
      source_unit: 'http://wl/api/units/1',
      content_hash: 1,
      state: 30,
      target: ['Hallo'],
      last_updated: '2026-02-01T10:00:00.000Z',
      timestamp: '2026-01-01T10:00:00.000Z',
    }),
    'de',
    false,
  );
  applyUnitToRow(
    rows,
    unit({
      id: 12,
      source_unit: 'http://wl/api/units/1',
      content_hash: 1,
      state: 30,
      target: ['Bonjour'],
      last_updated: '2026-02-02T10:00:00.000Z',
    }),
    'fr',
    false,
  );

  // String B: de needs editing, fr untranslated; modified recently.
  applyUnitToRow(
    rows,
    unit({
      id: 2,
      source_unit: 'http://wl/api/units/2',
      content_hash: 2,
      source: ['Goodbye'],
      target: ['Goodbye'],
      timestamp: '2026-05-01T10:00:00.000Z',
      last_updated: '2026-08-20T10:00:00.000Z',
    }),
    'en',
    true,
  );
  applyUnitToRow(
    rows,
    unit({
      id: 21,
      source_unit: 'http://wl/api/units/2',
      content_hash: 2,
      source: ['Goodbye'],
      state: 10,
      target: ['Tschüss'],
      has_comment: true,
      last_updated: '2026-08-25T10:00:00.000Z',
    }),
    'de',
    false,
  );
  applyUnitToRow(
    rows,
    unit({
      id: 22,
      source_unit: 'http://wl/api/units/2',
      content_hash: 2,
      source: ['Goodbye'],
      state: 0,
      target: [''],
      has_suggestion: true,
      last_updated: '2026-08-26T10:00:00.000Z',
    }),
    'fr',
    false,
  );

  // String C: translated but not approved, missing a de unit entirely.
  applyUnitToRow(
    rows,
    unit({
      id: 3,
      source_unit: 'http://wl/api/units/3',
      content_hash: 3,
      source: ['Plural', 'Plurals'],
      target: ['Plural', 'Plurals'],
      timestamp: '2026-06-01T10:00:00.000Z',
      last_updated: '2026-08-10T10:00:00.000Z',
    }),
    'en',
    true,
  );
  applyUnitToRow(
    rows,
    unit({
      id: 31,
      source_unit: 'http://wl/api/units/3',
      content_hash: 3,
      source: ['Plural'],
      state: 20,
      target: ['Pluriel', 'Pluriels'],
      has_failing_check: true,
      last_updated: '2026-08-15T10:00:00.000Z',
    }),
    'fr',
    false,
  );
  // de deliberately missing for C.

  // String D: fully translated in every language, but not approved —
  // only "needs review" when the review workflow is enabled.
  applyUnitToRow(
    rows,
    unit({
      id: 4,
      source_unit: 'http://wl/api/units/4',
      content_hash: 4,
      source: ['Settings'],
      target: ['Settings'],
      timestamp: '2026-03-01T10:00:00.000Z',
      last_updated: '2026-07-01T10:00:00.000Z',
    }),
    'en',
    true,
  );
  applyUnitToRow(
    rows,
    unit({
      id: 41,
      source_unit: 'http://wl/api/units/4',
      content_hash: 4,
      source: ['Settings'],
      state: 20,
      target: ['Einstellungen'],
      last_updated: '2026-07-02T10:00:00.000Z',
    }),
    'de',
    false,
  );
  applyUnitToRow(
    rows,
    unit({
      id: 42,
      source_unit: 'http://wl/api/units/4',
      content_hash: 4,
      source: ['Settings'],
      state: 20,
      target: ['Réglages'],
      last_updated: '2026-07-03T10:00:00.000Z',
    }),
    'fr',
    false,
  );

  return rows;
}

describe('applyUnitToRow', () => {
  it('joins units of the same content_hash across languages', () => {
    const rows = buildRows();
    expect(rows.size).toBe(4);
    const a = rows.get('u1')!;
    expect(a.cells['de']?.target).toEqual(['Hallo']);
    expect(a.cells['fr']?.target).toEqual(['Bonjour']);
    expect(a.sourceUnitId).toBe(1);
  });

  it('stores the source explanation and only source units update it', () => {
    const rows: RowMap = new Map();
    applyUnitToRow(rows, unit({ id: 1, explanation: 'Means greeting' }), 'en', true);
    expect(rows.get('u1')!.explanation).toBe('Means greeting');

    // Target units never carry an explanation — they must not clobber it.
    applyUnitToRow(
      rows,
      unit({ id: 11, source_unit: 'http://wl/api/units/1', content_hash: 1 }),
      'de',
      false,
    );
    expect(rows.get('u1')!.explanation).toBe('Means greeting');

    // A re-fetched source unit (with the field) refreshes it.
    applyUnitToRow(
      rows,
      unit({ id: 1, explanation: 'Updated guidance' }),
      'en',
      true,
    );
    expect(rows.get('u1')!.explanation).toBe('Updated guidance');
  });

  it('keeps plural arrays intact', () => {
    const rows = buildRows();
    expect(rows.get('u3')!.source).toEqual(['Plural', 'Plurals']);
    expect(rows.get('u3')!.cells['fr']?.target).toEqual(['Pluriel', 'Pluriels']);
  });

  it('computes row lastUpdated as max across cells and source unit', () => {
    const rows = buildRows();
    // B: source 08-20, de 08-25, fr 08-26 -> 08-26
    expect(rows.get('u2')!.lastUpdated).toBe('2026-08-26T10:00:00.000Z');
    // createdAt comes from the source unit
    expect(rows.get('u2')!.createdAt).toBe('2026-05-01T10:00:00.000Z');
  });

  it('allows a missing language cell', () => {
    const rows = buildRows();
    expect(rows.get('u3')!.cells['de']).toBeUndefined();
  });

  it('updates an existing cell on re-apply (edit patch)', () => {
    const rows = buildRows();
    applyUnitToRow(
      rows,
      unit({
        id: 21,
        content_hash: 2,
        source_unit: 'http://wl/api/units/2',
        state: 30,
        target: ['Tschüss!'],
        last_updated: '2026-09-01T12:00:00.000Z',
      }),
      'de',
      false,
    );
    const row = rows.get('u2')!;
    expect(row.cells['de']?.state).toBe(30);
    expect(row.cells['de']?.target).toEqual(['Tschüss!']);
    expect(row.lastUpdated).toBe('2026-09-01T12:00:00.000Z');
  });
});

describe('filterRows', () => {
  const all = () => [...buildRows().values()];

  it('all returns everything', () => {
    expect(
      filterRows(all(), { filter: 'all', languages: LANGS, reviewWorkflow: true }),
    ).toHaveLength(4);
  });

  it('needs-review matches untranslated/needs-editing/not-approved (workflow on)', () => {
    const got = filterRows(all(), {
      filter: 'needs-review',
      languages: LANGS,
      reviewWorkflow: true,
    });
    // B: needs-editing/untranslated; C: not approved + missing de; D: not approved
    expect(got.map((r) => r.key)).toEqual(['u2', 'u3', 'u4']);
  });

  it('needs-review with workflow off ignores translated-not-approved', () => {
    const got = filterRows(all(), {
      filter: 'needs-review',
      languages: LANGS,
      reviewWorkflow: false,
    });
    // D (all state 20) is complete when reviews are off; C still matches
    // because its de unit is missing entirely.
    expect(got.map((r) => r.key)).toEqual(['u2', 'u3']);
  });

  it('unapproved matches translated-but-not-approved', () => {
    const got = filterRows(all(), {
      filter: 'unapproved',
      languages: LANGS,
      reviewWorkflow: true,
    });
    expect(got.map((r) => r.key)).toEqual(['u3', 'u4']);
  });

  it('needs-editing matches state 10', () => {
    const got = filterRows(all(), {
      filter: 'needs-editing',
      languages: LANGS,
      reviewWorkflow: true,
    });
    expect(got.map((r) => r.key)).toEqual(['u2']);
  });

  it('untranslated matches state 0 and missing cells', () => {
    const got = filterRows(all(), {
      filter: 'untranslated',
      languages: LANGS,
      reviewWorkflow: true,
    });
    expect(got.map((r) => r.key).sort()).toEqual(['u2', 'u3']);
  });

  it('missing-translation matches missing cells, state 0, and blank targets', () => {
    const rows = buildRows();
    // Blank-but-translated target on fr for string D.
    const d = rows.get('u4')!;
    d.cells['fr'] = { ...d.cells['fr']!, target: [' ', ''] };
    const got = filterRows([...rows.values()], {
      filter: 'missing-translation',
      languages: LANGS,
      reviewWorkflow: true,
    });
    // B: fr state 0; C: de unit missing entirely; D: fr blank target.
    expect(got.map((r) => r.key).sort()).toEqual(['u2', 'u3', 'u4']);
  });

  it('missing-translation honors the requested language subset', () => {
    // Only de visible: D is translated in de, so it must NOT match even
    // though fr would be blank; C still matches (de missing entirely).
    const rows = buildRows();
    const got = filterRows(rows.values(), {
      filter: 'missing-translation',
      languages: [LANGS[0]!],
      reviewWorkflow: true,
    });
    expect(got.map((r) => r.key)).toEqual(['u3']);
  });

  it('failing-check / has-comment / has-suggestion match cell flags', () => {
    const base = { languages: LANGS, reviewWorkflow: true } as const;
    expect(filterRows(all(), { ...base, filter: 'failing-check' }).map((r) => r.key)).toEqual(['u3']);
    expect(filterRows(all(), { ...base, filter: 'has-comment' }).map((r) => r.key)).toEqual(['u2']);
    expect(filterRows(all(), { ...base, filter: 'has-suggestion' }).map((r) => r.key)).toEqual(['u2']);
  });

  it('id-list matches rows by context key, regardless of languages', () => {
    const rows = buildRows();
    rows.get('u1')!.context = 'ID0002';
    rows.get('u2')!.context = 'CUSTOM0001';
    const all = () => [...rows.values()];
    const base = { languages: LANGS, reviewWorkflow: true } as const;

    expect(
      filterRows(all(), { ...base, filter: 'id-list', contextSet: new Set(['ID0002', 'ID9999']) })
        .map((r) => r.key),
    ).toEqual(['u1']);
    // Empty contexts never match, even for an empty-string entry.
    expect(
      filterRows(all(), { ...base, filter: 'id-list', contextSet: new Set(['']) }),
    ).toHaveLength(0);
    expect(
      filterRows(all(), { ...base, filter: 'id-list', contextSet: new Set() }),
    ).toHaveLength(0);
    expect(filterRows(all(), { ...base, filter: 'id-list' })).toHaveLength(0);
  });

  it('search matches source, target, context, and ids case-insensitively', () => {
    const base = { filter: 'all', languages: LANGS, reviewWorkflow: true } as const;
    expect(filterRows(all(), { ...base, search: 'goodbye' }).map((r) => r.key)).toEqual(['u2']);
    expect(filterRows(all(), { ...base, search: 'BONJOUR' }).map((r) => r.key)).toEqual(['u1']);
    expect(filterRows(all(), { ...base, search: '31' }).map((r) => r.key)).toEqual(['u3']);
    expect(filterRows(all(), { ...base, search: 'zzz' })).toHaveLength(0);
  });

  it('exact ID and exact context matches outrank substring noise', () => {
    const base = { filter: 'all', languages: LANGS, reviewWorkflow: true } as const;

    // '3' matches the row with ID 3 exactly AND other rows loosely
    // (e.g. unit id 31 in row u3's cells, id 21 in u2, ...). The exact
    // ID match must come first; within the substring tier the row order
    // is stable (insertion order).
    const got = sortBySearchRelevance(filterRows(all(), { ...base, search: '3' }), '3');
    expect(got[0]!.key).toBe('u3');

    // Context match: 'ID3062'-style exact context beats substring hits.
    // Row u2 has no context; give u1 one via direct mutation for the test.
    const rows = buildRows();
    rows.get('u1')!.context = 'ID3062';
    const byContext = sortBySearchRelevance([...rows.values()], 'id3062');
    expect(byContext[0]!.key).toBe('u1');
    // Exact context outranks a substring-only row (u3 contains 'id' in... nothing —
    // use a numeric substring that hits multiple rows):
    const numeric = sortBySearchRelevance(
      filterRows([...rows.values()], { ...base, search: '4' }),
      '4',
    );
    expect(numeric[0]!.key).toBe('u4'); // exact ID 4 first, substring hits after
  });
});

describe('sortRows', () => {
  const rows = [...buildRows().values()];

  it('modified-desc sorts newest modification first', () => {
    const got = sortRows(rows, 'modified-desc');
    expect(got.map((r) => r.key)).toEqual(['u2', 'u3', 'u4', 'u1']);
  });

  it('modified-asc sorts oldest modification first', () => {
    const got = sortRows(rows, 'modified-asc');
    expect(got.map((r) => r.key)).toEqual(['u1', 'u4', 'u3', 'u2']);
  });

  it('created-desc / created-asc sort by source unit timestamp', () => {
    expect(sortRows(rows, 'created-desc').map((r) => r.key)).toEqual(['u3', 'u2', 'u4', 'u1']);
    expect(sortRows(rows, 'created-asc').map((r) => r.key)).toEqual(['u1', 'u4', 'u2', 'u3']);
  });

  it('id sorts order by the context string, numeric-aware', () => {
    // Contexts chosen so plain string order would differ from numeric:
    // ID0002 < ID0009 < ID0010. Row u2 has no context -> always last.
    const ctx: SourceRow[] = [...buildRows().values()];
    for (const row of ctx) row.context = '';
    const byKey = new Map(ctx.map((r) => [r.key, r] as const));
    const a = byKey.get('u1')!;
    const b = byKey.get('u2')!;
    const c = byKey.get('u3')!;
    const d = byKey.get('u4')!;
    a.context = 'ID0009';
    b.context = ''; // no context -> last in both directions
    c.context = 'ID0010';
    d.context = 'ID0002';

    expect(sortRows(ctx, 'id-asc').map((r) => r.key)).toEqual(['u4', 'u1', 'u3', 'u2']);
    expect(sortRows(ctx, 'id-desc').map((r) => r.key)).toEqual(['u3', 'u1', 'u4', 'u2']);
  });

  it('uses a stable tiebreak on key (deterministic windows)', () => {
    const same: RowMap = new Map();
    for (const k of [9, 1, 5]) {
      applyUnitToRow(
        same,
        unit({ id: 100 + k, content_hash: k, source_unit: `http://wl/api/units/${k}` }),
        'en',
        true,
      );
    }
    const sorted = sortRows([...same.values()], 'modified-desc');
    expect(sorted.map((r) => r.key)).toEqual(['u101', 'u105', 'u109']);
    // Slicing into windows and concatenating reproduces the full order.
    const viaWindows = [
      ...sliceWindow(sorted, 0, 2),
      ...sliceWindow(sorted, 2, 2),
    ];
    expect(viaWindows.map((r) => r.key)).toEqual(['u101', 'u105', 'u109']);
  });
});

describe('recomputeLastUpdated', () => {
  it('recomputes after a cell was mutated', () => {
    const rows = buildRows();
    const row = rows.get('u1')!;
    row.cells['de']!.lastUpdated = '2026-09-01T00:00:00.000Z';
    recomputeLastUpdated(row);
    expect(row.lastUpdated).toBe('2026-09-01T00:00:00.000Z');
  });
});