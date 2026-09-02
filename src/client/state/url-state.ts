import { useCallback, useEffect, useMemo, useState } from 'react';
import { ROW_FILTERS, SORT_KEYS } from '../../shared/rows.js';
import type { RowFilter, SortKey } from '../../shared/rows.js';

/** View state that lives in the URL so views are shareable. */
export interface ViewParams {
  project: string;
  component: string;
  sort: SortKey;
  filter: RowFilter;
  q: string;
  offset: number;
  /** Show the Created/Modified date columns (default true). */
  dates: boolean;
  /** Comma-separated language codes hidden from the grid ('' = all visible). */
  hiddenLangs: string;
  /** Comma-separated source unit ids for the 'id-list' filter (small lists). */
  ids: string;
  /** Server-side reference to an uploaded large ID list. */
  listId: string;
}

export const DEFAULT_VIEW: ViewParams = {
  project: '',
  component: '',
  sort: 'created-desc',
  filter: 'all',
  q: '',
  offset: 0,
  dates: true,
  hiddenLangs: '',
  ids: '',
  listId: '',
};

/** Comma-separated language codes -> set (ignores empty segments). */
export function parseHiddenLangs(s: string): Set<string> {
  return new Set(s.split(',').filter(Boolean));
}

export function parseView(search: string): ViewParams {
  const sp = new URLSearchParams(search);
  const sort = sp.get('sort');
  const filter = sp.get('filter');
  return {
    project: sp.get('project') ?? '',
    component: sp.get('component') ?? '',
    sort: (SORT_KEYS as readonly string[]).includes(sort ?? '')
      ? (sort as SortKey)
      : DEFAULT_VIEW.sort,
    filter: (ROW_FILTERS as readonly string[]).includes(filter ?? '')
      ? (filter as RowFilter)
      : DEFAULT_VIEW.filter,
    q: sp.get('q') ?? '',
    offset: Math.max(0, Number(sp.get('offset') ?? 0) || 0),
    dates: sp.get('dates') !== '0',
    hiddenLangs: sp.get('hiddenLangs') ?? '',
    ids: sp.get('ids') ?? '',
    listId: sp.get('listId') ?? '',
  };
}

/**
 * Small react-router-free search-param state: reads window.location and
 * pushes history entries on change (back/forward works).
 */
export function useViewParams(): [ViewParams, (patch: Partial<ViewParams>) => void] {
  const [search, setSearch] = useState(() => window.location.search);

  const params = useMemo(() => parseView(search), [search]);

  const setParams = useCallback((patch: Partial<ViewParams>) => {
    const next = new URLSearchParams(window.location.search);
    for (const [key, value] of Object.entries(patch)) {
      // Booleans: true is the default (omitted from the URL), false is
      // serialized as "0" — matching how parseView reads it back.
      if (typeof value === 'boolean') {
        if (value) next.delete(key);
        else next.set(key, '0');
      } else if (value === '' || value === null || value === undefined) {
        next.delete(key);
      } else {
        next.set(key, String(value));
      }
    }
    const qs = next.toString();
    window.history.pushState(null, '', qs ? `?${qs}` : window.location.pathname);
    setSearch(qs ? `?${qs}` : '');
  }, []);

  // Keep state in sync with browser navigation.
  useEffect(() => {
    const onPop = () => setSearch(window.location.search);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  return [params, setParams];
}