/**
 * Pure functions that turn flat Weblate units into joined, filtered,
 * sorted, windowed rows. No I/O, no state — everything here is unit-tested.
 */
import type {
  Cell,
  LanguageMeta,
  RowFilter,
  SortKey,
  SourceRow,
} from '../../shared/rows.js';
import type { WeblateUnit } from '../../shared/weblate-dto.js';

export type RowMap = Map<string, SourceRow>;

/**
 * Weblate returns datetimes with server-local offsets (e.g. +02:00);
 * string comparison only sorts correctly if everything is normalized
 * to the same shape. Convert to UTC ISO on ingestion.
 */
export function normIso(value: string): string {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toISOString();
}

export function unitToCell(unit: WeblateUnit, language: string): Cell {
  return {
    unitId: unit.id,
    language,
    target: unit.target,
    state: unit.state,
    hasComment: unit.has_comment,
    hasSuggestion: unit.has_suggestion,
    hasFailingCheck: unit.has_failing_check,
    createdAt: normIso(unit.timestamp),
    lastUpdated: normIso(unit.last_updated),
    webUrl: unit.web_url,
  };
}

/**
 * Row identity: the source unit's id. Unlike content_hash (which is
 * derived from the source TEXT and therefore changes when the source
 * string is edited), the source unit id is stable for the lifetime of
 * the string, and every language's unit points at the same source_unit.
 */
export function rowKeyFor(
  unit: WeblateUnit,
  isSourceLanguage: boolean,
): string {
  if (isSourceLanguage) return `u${unit.id}`;
  const m = /(\d+)\/?$/.exec(unit.source_unit ?? '');
  return m !== null ? `u${m[1]!}` : `h${unit.content_hash}`;
}

/**
 * Merges one unit into the row map, creating the row if needed.
 * `language` is the unit's translation language code; source-language
 * units also fill the row's string metadata.
 */
export function applyUnitToRow(
  rows: RowMap,
  unit: WeblateUnit,
  language: string,
  isSourceLanguage: boolean,
): SourceRow {
  const rowKey = rowKeyFor(unit, isSourceLanguage);
  const sourceUnitId = isSourceLanguage
    ? unit.id
    : Number(/(\d+)\/?$/.exec(unit.source_unit ?? '')?.[1] ?? unit.id);
  let row = rows.get(rowKey);

  if (row === undefined) {
    row = {
      key: rowKey,
      sourceUnitId,
      source: unit.source,
      context: unit.context,
      location: unit.location,
      flags: unit.flags,
      explanation: unit.explanation ?? '',
      createdAt: normIso(unit.timestamp),
      lastUpdated: normIso(unit.last_updated),
      sourceLastUpdated: normIso(unit.last_updated),
      sourceState: unit.state,
      cells: {},
      numWords: unit.num_words,
      position: unit.position,
    };
    rows.set(rowKey, row);
  }

  if (isSourceLanguage) {
    // The source unit is authoritative for string metadata and creation date.
    row.sourceUnitId = unit.id;
    row.source = unit.source;
    row.context = unit.context;
    row.location = unit.location;
    row.flags = unit.flags;
    // Undefined (older Weblate) keeps whatever we already have; an empty
    // string is a legitimate cleared explanation.
    row.explanation = unit.explanation ?? row.explanation;
    row.createdAt = normIso(unit.timestamp);
    row.sourceLastUpdated = normIso(unit.last_updated);
    row.sourceState = unit.state;
    row.numWords = unit.num_words;
    row.position = unit.position;
    row.lastUpdated = maxIso(row.lastUpdated, row.sourceLastUpdated);
  } else {
    row.cells[language] = unitToCell(unit, language);
    row.lastUpdated = maxIso(row.lastUpdated, row.cells[language]!.lastUpdated);
  }

  return row;
}

/** Rebuilds the row-level lastUpdated from all cells + the source unit. */
export function recomputeLastUpdated(row: SourceRow): void {
  let latest = row.sourceLastUpdated;
  for (const cell of Object.values(row.cells)) {
    if (cell) latest = maxIso(latest, cell.lastUpdated);
  }
  row.lastUpdated = latest;
}

/** ISO-8601 strings compare correctly as plain strings. */
export function maxIso(a: string, b: string): string {
  return a >= b ? a : b;
}

export interface FilterOptions {
  filter: RowFilter;
  /** Free-text search; substring over source/target/context/IDs, case-insensitive. */
  search?: string;
  /** Whether the instance has the review workflow enabled (state 30 meaningful). */
  reviewWorkflow: boolean;
  /** Languages of the component — a missing cell counts as untranslated. */
  languages: LanguageMeta[];
  /** For the 'id-list' filter: context keys to show (ID0002, spring.mail.host…). */
  contextSet?: Set<string>;
}

export function filterRows(
  rows: Iterable<SourceRow>,
  opts: FilterOptions,
): SourceRow[] {
  const out: SourceRow[] = [];
  const needle = opts.search?.trim().toLowerCase();

  for (const row of rows) {
    if (!rowMatchesFilter(row, opts)) continue;
    if (needle !== undefined && needle !== '' && !rowMatchesSearch(row, needle)) {
      continue;
    }
    out.push(row);
  }
  return out;
}

function rowMatchesFilter(row: SourceRow, opts: FilterOptions): boolean {
  // `languages` contains only target languages (source lives in row metadata).
  const langs = opts.languages;

  switch (opts.filter) {
    case 'all':
      return true;
    case 'needs-review':
      // "Not verified": untranslated, needs editing, or (with review
      // workflow) translated but not approved. Missing cell counts too.
      return langs.some((l) =>
        cellNeedsReview(row.cells[l.code], opts.reviewWorkflow),
      );
    case 'unapproved':
      // Translated but not yet approved (only meaningful with review workflow).
      return langs.some((l) => row.cells[l.code]?.state === 20);
    case 'needs-editing':
      return langs.some((l) => row.cells[l.code]?.state === 10);
    case 'untranslated':
      return langs.some((l) => {
        const cell = row.cells[l.code];
        return cell === undefined || cell.state === 0;
      });
    case 'missing-translation':
      // No translation in at least one of the filtered languages: no unit
      // at all, untranslated, or only empty/whitespace plural forms.
      return langs.some((l) => cellMissingTranslation(row.cells[l.code]));
    case 'failing-check':
      return langs.some((l) => row.cells[l.code]?.hasFailingCheck);
    case 'has-comment':
      return langs.some((l) => row.cells[l.code]?.hasComment);
    case 'has-suggestion':
      return langs.some((l) => row.cells[l.code]?.hasSuggestion);
    case 'id-list':
      // Language-independent: the list contains context keys.
      return row.context !== '' && (opts.contextSet?.has(row.context) ?? false);
  }
}

function cellNeedsReview(
  cell: Cell | undefined,
  reviewWorkflow: boolean,
): boolean {
  if (cell === undefined) return true;
  if (cell.state === 0 || cell.state === 10) return true;
  if (reviewWorkflow && cell.state === 20) return true;
  return false;
}

function cellMissingTranslation(cell: Cell | undefined): boolean {
  if (cell === undefined) return true;
  if (cell.state === 0) return true;
  return cell.target.every((t) => t.trim() === '');
}

function rowMatchesSearch(row: SourceRow, needle: string): boolean {
  if (matchKind(row, needle) !== null) return true;
  return false;
}

export type SearchMatchKind = 'exact-id' | 'exact-context' | 'substring';

/**
 * Classifies how a row matches the search needle. Exact ID / context
 * matches outrank loose substring matches so that searching for a
 * specific ID surfaces that string first.
 */
export function matchKind(row: SourceRow, needle: string): SearchMatchKind | null {
  // Needle that is purely numeric is treated as an ID first (the row's
  // source unit id, or the numeric part of the context, e.g. "3062" in
  // context "ID3062").
  if (/^\d+$/.test(needle)) {
    if (String(row.sourceUnitId) === needle) return 'exact-id';
    if (row.context.replace(/\D/g, '') === needle) return 'exact-context';
  }
  if (row.context !== '' && row.context.toLowerCase() === needle) {
    return 'exact-context';
  }
  if (row.key.toLowerCase().includes(needle)) return 'substring';
  if (String(row.sourceUnitId).includes(needle)) return 'substring';
  if (row.source.join(' ').toLowerCase().includes(needle)) return 'substring';
  if (row.context.toLowerCase().includes(needle)) return 'substring';
  for (const cell of Object.values(row.cells)) {
    if (!cell) continue;
    if (String(cell.unitId).includes(needle)) return 'substring';
    if (cell.target.join(' ').toLowerCase().includes(needle)) return 'substring';
  }
  return null;
}

const KIND_RANK: Record<SearchMatchKind, number> = {
  'exact-id': 0,
  'exact-context': 1,
  substring: 2,
};

/**
 * Stable-reorders search results by match quality (exact ID > exact
 * context > substring). Must run BEFORE the user's sort so ties within
 * a tier keep the requested order.
 */
export function sortBySearchRelevance(rows: SourceRow[], needle: string): SourceRow[] {
  const rank = new Map<SourceRow, number>();
  for (const row of rows) {
    const kind = matchKind(row, needle);
    rank.set(row, kind !== null ? KIND_RANK[kind] : KIND_RANK.substring);
  }
  return [...rows].sort(
    (a, b) => (rank.get(a) ?? 2) - (rank.get(b) ?? 2),
  );
}

export function sortRows(rows: SourceRow[], sortKey: SortKey): SourceRow[] {
  const out = [...rows];
  const dir = sortKey.endsWith('desc') ? -1 : 1;
  const field =
    sortKey.startsWith('id')
      ? undefined
      : sortKey.startsWith('modified')
        ? ('lastUpdated' as const)
        : ('createdAt' as const);

  out.sort((a, b) => {
    let cmp: number;
    if (field === undefined) {
      // ID sort orders by the context string (what the ID column
      // displays), with numeric-aware collation so "ID9" precedes
      // "ID10". Rows without a context go last regardless of direction.
      if ((a.context === '') !== (b.context === '')) {
        return a.context === '' ? 1 : -1;
      }
      cmp = a.context.localeCompare(b.context, undefined, { numeric: true });
    } else {
      cmp = a[field].localeCompare(b[field]);
    }
    if (cmp !== 0) return cmp * dir;
    // Stable tiebreak keeps windowing deterministic.
    return a.key.localeCompare(b.key);
  });
  return out;
}

export function sliceWindow(
  rows: SourceRow[],
  offset: number,
  limit: number,
): SourceRow[] {
  return rows.slice(offset, offset + limit);
}