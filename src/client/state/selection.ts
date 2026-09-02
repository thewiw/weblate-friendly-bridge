/**
 * Row-selection model for the grid (foundation for future bulk tools).
 *
 * `all` selects every string of the current filtered result; `keys` are
 * the explicit exceptions — the selected rows when all=false, the
 * DEselected rows when all=true. This keeps "select all 20,000" cheap:
 * the filtered set is resolved server-side later, the client only tracks
 * exceptions. Selection is cleared whenever the filtered set changes.
 */
export interface Selection {
  all: boolean;
  keys: Set<string>;
}

export function emptySelection(): Selection {
  return { all: false, keys: new Set() };
}

/** Is one row selected? */
export function isSelected(s: Selection, key: string): boolean {
  return s.all ? !s.keys.has(key) : s.keys.has(key);
}

/** Number of selected rows (total = size of the filtered result). */
export function selectionCount(s: Selection, total: number): number {
  return s.all ? Math.max(0, total - s.keys.size) : s.keys.size;
}

/** Flips a group of keys (one row, a click range, a page) to makeSelected. */
export function setKeysState(
  s: Selection,
  keys: Iterable<string>,
  makeSelected: boolean,
): Selection {
  const next = new Set(s.keys);
  for (const key of keys) {
    if (s.all) {
      if (makeSelected) next.delete(key);
      else next.add(key);
    } else {
      if (makeSelected) next.add(key);
      else next.delete(key);
    }
  }
  return { all: s.all, keys: next };
}

/** Toggles one row. */
export function toggleKey(s: Selection, key: string): Selection {
  return setKeysState(s, [key], !isSelected(s, key));
}