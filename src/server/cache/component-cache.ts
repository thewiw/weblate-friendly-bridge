/**
 * In-memory cache for one (project, component): lazily loads all units of
 * all languages in the background, joins them into rows, and serves
 * windowed/filtered/sorted pages from memory.
 */
import pLimit from 'p-limit';
import type {
  LanguageMeta,
  RowFilter,
  RowsPage,
  SortKey,
  SourceRow,
  Cell,
} from '../../shared/rows.js';
import type { WeblateTranslation, WeblateUnit } from '../../shared/weblate-dto.js';
import { config } from '../config.js';
import type { WeblateApi } from '../weblate/client.js';
import {
  applyUnitToRow,
  filterRows,
  normIso,
  recomputeLastUpdated,
  rowKeyFor,
  sliceWindow,
  sortBySearchRelevance,
  sortRows,
  unitToCell,
  type RowMap,
} from './row-model.js';

export type CacheStatus = 'empty' | 'loading' | 'ready' | 'error';

export interface RowsQuery {
  sort: SortKey;
  filter: RowFilter;
  search?: string;
  offset: number;
  limit: number;
  /**
   * Comma-separated hidden language codes (client's column selection).
   * Filters consider only the visible languages.
   */
  hiddenLangs?: string;
  /** Context keys for the 'id-list' filter (resolved by the route). */
  contextSet?: Set<string>;
}

export class ComponentCache {
  status: CacheStatus = 'empty';
  error: string | null = null;
  rows: RowMap = new Map();
  /** Target languages (source language excluded — it lives in row metadata). */
  languages: LanguageMeta[] = [];
  sourceLanguage = '';
  lastRefreshAt = 0;
  loadProgress = { loaded: 0, total: 0 };
  /** Detected from the project's translation_review setting on load. */
  reviewWorkflow = config.reviewWorkflow;

  private translations: WeblateTranslation[] = [];
  /** In-flight delta refresh, if any (public for tests). */
  deltaPromise: Promise<void> | null = null;
  private limit = pLimit(config.concurrency);
  /** Resolves when the currently-running load/reload settles (tests). */
  loadSettled: Promise<void> = Promise.resolve();

  constructor(
    public readonly project: string,
    public readonly component: string,
    private api: WeblateApi,
    /** Injectable for tests. */
    private readonly now: () => number = () => Date.now(),
    /** Staleness threshold for delta refreshes (tests set it low). */
    private readonly refreshAfterMs: number = config.refreshAfterMs,
  ) {}

  /**
   * Swap the upstream client — used in session mode so background loads
   * and delta refreshes follow the most recently active user's session.
   */
  setApi(api: WeblateApi): void {
    this.api = api;
  }

  /**
   * Serves a window. Kicks off the initial load (or a background delta
   * refresh when stale) but never waits for Weblate — always answers from
   * whatever is already in memory.
   */
  getRowsPage(query: RowsQuery, opts?: { refresh?: boolean }): RowsPage {
    if (opts?.refresh) {
      void this.reload();
    } else {
      this.ensureLoaded();
      this.maybeDeltaRefresh();
    }

    const complete = this.status === 'ready' || this.status === 'error';
    const needle = query.search?.trim().toLowerCase();
    const filtered = this.filteredRows(query);
    let sorted = sortRows(filtered, query.sort);
    // Exact-ID matches float above substring noise. Applied AFTER the
    // user's sort so each relevance tier keeps the requested order
    // (both sorts are stable).
    if (needle !== undefined && needle !== '') {
      sorted = sortBySearchRelevance(sorted, needle);
    }

    return {
      total: sorted.length,
      offset: query.offset,
      limit: query.limit,
      rows: sliceWindow(sorted, query.offset, query.limit),
      languages: this.languages,
      complete,
      reviewWorkflow: this.reviewWorkflow,
      sourceLanguage: this.sourceLanguage,
      ...(complete ? {} : { loadProgress: this.loadProgress }),
      ...(this.error !== null ? { error: this.error } : {}),
    };
  }

  /**
   * Rows matching the query's filters (including search), unsorted and
   * unpaged. Shared by the rows endpoint and bulk tools.
   */
  filteredRows(query: Omit<RowsQuery, 'offset' | 'limit'>): SourceRow[] {
    // Filters follow the user's visible language columns (hidden codes
    // sent from the URL): "Untranslated" etc. adapt to the column
    // selection. Hiding every language falls back to all of them.
    const hidden = new Set(
      (query.hiddenLangs ?? '')
        .split(',')
        .map((c) => c.trim())
        .filter((c) => c !== ''),
    );
    const filterLangs =
      hidden.size > 0 && hidden.size < this.languages.length
        ? this.languages.filter((l) => !hidden.has(l.code))
        : this.languages;
    return filterRows(this.rows.values(), {
      filter: query.filter,
      search: query.search,
      reviewWorkflow: this.reviewWorkflow,
      languages: filterLangs,
      contextSet: query.contextSet,
    });
  }

  /** Finds the row with the given context key (REST API lookups). */
  findRowByContext(context: string): SourceRow | null {
    for (const row of this.rows.values()) {
      if (row.context === context) return row;
    }
    return null;
  }

  /**
   * Removes a unit from the cache after a DELETE: one cell, or the whole
   * row when the source unit (the whole string) was deleted.
   */
  removeUnit(unitId: number): void {
    const found = this.findCellByUnitId(unitId);
    if (found === null) return;
    const { row, cell } = found;
    if (cell.language === this.sourceLanguage || cell.unitId === row.sourceUnitId) {
      this.rows.delete(row.key);
      return;
    }
    delete row.cells[cell.language];
  }

  /** Delta refresh, for callers that need new units immediately (REST API). */
  async refreshChanged(): Promise<void> {
    await this.doDeltaRefresh();
  }

  /** Kicks off the load and resolves once it settles (REST API lookups). */
  async ensureLoadedAsync(): Promise<void> {
    this.ensureLoaded();
    await this.loadSettled;
  }

  /** Applies a unit received from a Weblate PATCH response to the cache. */
  applyUnitUpdate(unit: WeblateUnit): { rowKey: string; cell: Cell } | null {
    const language = this.languageOfUnit(unit);
    if (language === null) return null;
    const isSource = language !== '' && language === this.sourceLanguage;
    const row = this.rows.get(rowKeyFor(unit, isSource));
    if (row === undefined) return null;

    if (language === this.sourceLanguage) {
      row.source = unit.source;
      row.sourceState = unit.state;
      row.sourceLastUpdated = normIso(unit.last_updated);
      row.explanation = unit.explanation ?? row.explanation;
      recomputeLastUpdated(row);
    } else {
      row.cells[language] = unitToCell(unit, language);
      recomputeLastUpdated(row);
    }
    return {
      rowKey: rowKeyFor(unit, isSource),
      cell: unitToCell(unit, language),
    };
  }

  /**
   * Re-reads every language cell of a row from Weblate and applies it to
   * the cache. Used after a source edit: Weblate recomputes the
   * translation checks (failing checks, placeholders, max-length…) from
   * the new source text, and those flags live on the translation units —
   * the source unit's own PATCH/getUnit response cannot report them.
   * `delayMs` gives Weblate's background recompute a head start before
   * the re-read. Individual failures are swallowed (stale flags beat a
   * failed edit).
   */
  async refreshRowUnits(rowKey: string, opts?: { delayMs?: number }): Promise<void> {
    const row = this.rows.get(rowKey);
    if (row === undefined) return;
    if (opts?.delayMs !== undefined && opts.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, opts.delayMs));
    }
    const unitIds = Object.values(row.cells)
      .filter((c): c is Cell => c !== undefined)
      .map((c) => c.unitId);
    await Promise.all(
      unitIds.map((id) =>
        this.limit(async () => {
          try {
            const unit = await this.api.getUnit(id);
            const lang = this.languageOfUnit(unit);
            const before = lang !== null ? row.cells[lang] : undefined;
            this.applyUnitUpdate(unit);
            // Diagnostic: when did Weblate's recompute actually show up?
            const after = lang !== null ? row.cells[lang] : undefined;
            if (
              before !== undefined &&
              after !== undefined &&
              (before.hasFailingCheck !== after.hasFailingCheck ||
                before.hasComment !== after.hasComment ||
                before.hasSuggestion !== after.hasSuggestion)
            ) {
              console.log(
                `[wfu] source-edit refresh: unit #${id} (${lang}) flags ` +
                  `check=${before.hasFailingCheck}->${after.hasFailingCheck}, ` +
                  `comment=${before.hasComment}->${after.hasComment}, ` +
                  `suggestion=${before.hasSuggestion}->${after.hasSuggestion}`,
              );
            }
          } catch {
            // Keep whatever flags we have rather than failing the edit.
          }
        }),
      ),
    );
  }

  private languageOfUnit(unit: WeblateUnit): string | null {
    if (unit.language_code !== undefined) return unit.language_code;
    // unit.translation is a URL like .../api/translations/<p>/<c>/<lang>/
    const parts = unit.translation.split('/').filter(Boolean);
    return parts[parts.length - 1] ?? null;
  }

  /** Finds the row and cell for a Weblate unit id (used by the edit route). */
  findCellByUnitId(unitId: number): { row: SourceRow; cell: Cell } | null {
    for (const row of this.rows.values()) {
      for (const cell of Object.values(row.cells)) {
        if (cell && cell.unitId === unitId) return { row, cell };
      }
      // Source-language units are not cells; they live in row metadata.
      if (row.sourceUnitId === unitId) {
        return {
          row,
          cell: {
            unitId: row.sourceUnitId,
            language: this.sourceLanguage,
            target: row.source,
            state: row.sourceState,
            hasComment: false,
            hasSuggestion: false,
            hasFailingCheck: false,
            createdAt: row.createdAt,
            lastUpdated: row.sourceLastUpdated,
            webUrl: '',
          },
        };
      }
    }
    return null;
  }

  private ensureLoaded(): void {
    // Only the initial load: after an error the status sticks (complete +
    // error message) until the user hits Refresh — a failed Weblate must not
    // be re-attacked on every poll.
    if (this.status !== 'empty') return;
    this.loadSettled = this.load();
  }

  /**
   * Initial load: units stream into this.rows so the grid fills progressively.
   * Reload (Refresh button): builds into a shadow map and swaps atomically,
   * so users keep seeing the previous data during the rebuild.
   */
  private async load(shadow = false): Promise<void> {
    this.status = 'loading';
    this.error = null;
    const target = shadow ? new Map<string, SourceRow>() : this.rows;
    try {
      await this.doLoad(target);
      if (shadow) this.rows = target;
      this.status = 'ready';
      this.lastRefreshAt = this.now();
    } catch (err) {
      this.status = 'error';
      this.error = err instanceof Error ? err.message : String(err);
    }
  }

  private async reload(): Promise<void> {
    // Already loading something? The in-flight load is the freshest answer.
    if (this.status === 'loading') return;
    this.loadSettled = this.load(true);
  }

  private async doLoad(target: RowMap): Promise<void> {
    const translationsUrl = this.api.translationsUrlFor(
      this.project,
      this.component,
    );
    this.translations = await this.api.listTranslations(translationsUrl);

    // Detect the review workflow from the project settings (one request
    // per component load); fall back to the configured default.
    try {
      const project = await this.api.getProject(this.project);
      this.reviewWorkflow = project.translation_review ?? config.reviewWorkflow;
    } catch {
      // keep previous value
    }

    const source = this.translations.find((t) => t.is_source);
    this.sourceLanguage = source?.language.code ?? '';
    this.languages = this.translations
      .filter((t) => !t.is_source)
      .map((t) => ({ code: t.language.code, name: t.language.name }));

    this.loadProgress = { loaded: 0, total: this.translations.length };

    let loaded = 0;
    await Promise.all(
      this.translations.map((t) =>
        this.limit(async () => {
          try {
            const unitsUrl = this.api.unitsUrlFor(
              this.project,
              this.component,
              t.language.code,
            );
            for await (const unit of this.api.listUnits(unitsUrl)) {
              applyUnitToRow(target, unit, t.language.code, t.is_source);
            }
          } finally {
            loaded += 1;
            this.loadProgress = { loaded, total: this.translations.length };
          }
        }),
      ),
    );
  }

  /**
   * Stale-while-revalidate: fetch units changed since the last refresh and
   * patch them in. The current request is already answered from memory.
   */
  private maybeDeltaRefresh(): void {
    if (this.status !== 'ready') return;
    if (this.deltaPromise !== null) return;
    if (this.now() - this.lastRefreshAt < this.refreshAfterMs) return;

    const budget = this.api.getRateBudget();
    if (
      budget.remaining !== null &&
      budget.remaining < config.rateBudgetFloor
    ) {
      return; // suspend background refreshes near the rate floor
    }

    this.deltaPromise = this.doDeltaRefresh().finally(() => {
      this.deltaPromise = null;
    });
    void this.deltaPromise;
  }

  private async doDeltaRefresh(): Promise<void> {
    const since = new Date(
      this.lastRefreshAt - config.refreshMarginMs,
    ).toISOString();

    await Promise.all(
      this.translations.map((t) =>
        this.limit(async () => {
          const unitsUrl = this.api.unitsUrlFor(
            this.project,
            this.component,
            t.language.code,
          );
          for await (const unit of this.api.listUnits(
            unitsUrl,
            `changed:>=${since}`,
          )) {
            applyUnitToRow(this.rows, unit, t.language.code, t.is_source);
          }
        }),
      ),
    );
    this.lastRefreshAt = this.now();
  }
}