/**
 * Raw DTOs as returned by the Weblate REST API.
 * Docs: https://docs.weblate.org/en/latest/api.html
 */

/** A Weblate project (from GET /api/projects/). */
export interface WeblateProject {
  slug: string;
  name: string;
  web_url: string;
  /** Whether the review workflow (state 30) is enabled for this project. */
  translation_review?: boolean;
}

/** A Weblate component (from GET /api/projects/(project)/components/). */
export interface WeblateComponent {
  slug: string;
  name: string;
  project: string;
  source_language: { code: string; name: string };
  /** URL of the translations listing for this component. */
  translations_url: string;
  web_url: string;
}

/** A translation = component + language (from a component's translations_url). */
export interface WeblateTranslation {
  language: { code: string; name: string };
  is_source: boolean;
  /** URL of the units listing for this translation. */
  units_list_url: string;
  web_url: string;
}

/** Unit states as documented for GET /api/units/(id)/. */
export const UNIT_STATE = {
  UNTRANSLATED: 0,
  NEEDS_EDITING: 10,
  TRANSLATED: 20,
  APPROVED: 30,
  READ_ONLY: 100,
} as const;

export type UnitState = 0 | 10 | 20 | 30 | 100;

/** A single translation unit (from the units endpoints). */
export interface WeblateUnit {
  id: number;
  translation: string;
  /** Convenience language code (present on Weblate >= 4.10ish). */
  language_code?: string;
  source: string[];
  previous_source: string | null;
  target: string[];
  /**
   * Units of the same source string across languages share this hash.
   * The API returns a signed int64; JS parses it as a double — the
   * rounding is deterministic, so cross-language equality still holds.
   */
  content_hash: number;
  id_hash: number;
  location: string;
  context: string;
  note: string;
  /**
   * Free-text guidance for translators ("Explanation" on the source
   * string, Weblate >= 4.5). Only meaningful on source units.
   */
  explanation?: string;
  flags: string;
  state: UnitState;
  fuzzy: boolean;
  translated: boolean;
  approved: boolean;
  position: number;
  has_suggestion: boolean;
  has_comment: boolean;
  has_failing_check: boolean;
  num_words: number;
  priority: number;
  web_url: string;
  /** URL of the source-language unit this unit belongs to. */
  source_unit: string;
  pending: boolean;
  /** String age: when the unit was added to Weblate. */
  timestamp: string;
  /** Last string update. */
  last_updated: string;
}

/** Standard DRF list envelope: {count, next, previous, results}. */
export interface Paginated<T> {
  count: number;
  next: string | null;
  previous: string | null;
  results: T[];
}

/** Body accepted by our PATCH /units endpoint (subset Weblate understands). */
export interface UnitPatchBody {
  target?: string[];
  state?: UnitState;
  /** Guidance for translators; only settable on source units. */
  explanation?: string;
}

/** Body for creating a new unit (POST on a translation's units URL). */
export interface UnitCreateBody {
  /** Context key; Weblate generates one when omitted. */
  key?: string;
  /** Source text (one entry per plural form). */
  source: string[];
  target?: string[];
  state?: number;
}