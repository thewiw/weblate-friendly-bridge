/**
 * The row contract between backend and frontend.
 * A row = one source string with all of its per-language cells.
 */
import type { UnitState } from './weblate-dto.js';

/** One language's translation of a source string. */
export interface Cell {
  /** Weblate unit id — the handle for PATCH /units/:id. */
  unitId: number;
  /** Weblate language code, e.g. "de". */
  language: string;
  /** Plural-aware target array (length 1 unless plural forms). */
  target: string[];
  state: UnitState;
  hasComment: boolean;
  hasSuggestion: boolean;
  hasFailingCheck: boolean;
  createdAt: string;
  lastUpdated: string;
  webUrl: string;
}

/** A source string joined across all languages. */
export interface SourceRow {
  /** content_hash — shared by all units of this source string. */
  key: string;
  sourceUnitId: number;
  source: string[];
  context: string;
  location: string;
  flags: string;
  /** "Explanation" from the source unit — guidance shown to translators. */
  explanation: string;
  /** When the source string was added to Weblate (source unit timestamp). */
  createdAt: string;
  /** Max lastUpdated across all cells including the source unit. */
  lastUpdated: string;
  /** The source-language unit's own last_updated. */
  sourceLastUpdated: string;
  /** The source-language unit's state (source strings are editable too). */
  sourceState: UnitState;
  /** Language code -> cell. Missing key = language has no unit for this string. */
  cells: Record<string, Cell | undefined>;
  numWords: number;
  position: number;
}

export const SORT_KEYS = [
  'created-desc',
  'modified-desc',
  'created-asc',
  'modified-asc',
  'id-desc',
  'id-asc',
] as const;
export type SortKey = (typeof SORT_KEYS)[number];

export const ROW_FILTERS = [
  'all',
  'needs-review',
  'unapproved',
  'needs-editing',
  'untranslated',
  'missing-translation',
  'failing-check',
  'has-comment',
  'has-suggestion',
  'id-list',
] as const;
export type RowFilter = (typeof ROW_FILTERS)[number];

export interface LanguageMeta {
  code: string;
  name: string;
}

/** Response of GET /api/v1/rows. */
export interface RowsPage {
  total: number;
  offset: number;
  limit: number;
  rows: SourceRow[];
  /** Languages present in the component, source language first. */
  languages: LanguageMeta[];
  /** False while the backend is still loading this component's units. */
  complete: boolean;
  /** Whether the review workflow (state 30) is enabled for this project. */
  reviewWorkflow: boolean;
  /** Language code of the source strings (e.g. "fr"). */
  sourceLanguage: string;
  /** Present while complete === false: translations fully loaded so far. */
  loadProgress?: { loaded: number; total: number };
  /** Set when loading failed; whatever data was fetched is still served. */
  error?: string | null;
}

/** Response of PATCH /api/v1/units/:id. */
export interface UnitPatchResult {
  unit: Cell;
  /** content_hash of the row this unit belongs to. */
  rowKey: string;
}

export const STATE_LABELS: Record<number, string> = {
  0: 'Untranslated',
  10: 'Needs editing',
  20: 'Translated',
  30: 'Approved',
  100: 'Read-only',
};