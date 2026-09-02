import { useEffect, useState } from 'react';
import { ROW_FILTERS, SORT_KEYS } from '../../shared/rows.js';

const FILTER_LABELS: Record<string, string> = {
  all: 'All strings',
  'needs-review': 'Not verified',
  unapproved: 'Not approved',
  'needs-editing': 'Needs editing',
  untranslated: 'Untranslated',
  'missing-translation': 'Missing translation',
  'failing-check': 'Failing checks',
  'has-comment': 'Has comments',
  'has-suggestion': 'Has suggestions',
  'id-list': 'ID list',
};

const SORT_LABELS: Record<string, string> = {
  'created-desc': 'Newest created first',
  'modified-desc': 'Newest modified first',
  'created-asc': 'Oldest created first',
  'modified-asc': 'Oldest modified first',
  'id-desc': 'By ID desc',
  'id-asc': 'By ID asc',
};

const PAGE_SIZE = 50;

/**
 * Lists up to this many IDs stay in the URL (shareable); bigger ones are
 * uploaded to the server and referenced by a short listId.
 */
export const INLINE_ID_LIMIT = 500;
/** Hard cap, mirroring the server's MAX_IDS_PER_LIST. */
export const MAX_ID_LIST = 100_000;

/**
 * Parses a paste/file blob of keys separated by line breaks, commas, or
 * semicolons — exactly one separator kind per input. A key is either a
 * numeric source-unit ID (3062) or a string context (ID0002,
 * spring.mail.host…); anything containing whitespace or separators is
 * invalid.
 * 1. A line break wins when there is still a key after the first line
 *    (e.g. "3062,3070\n" parses as the two comma-separated IDs).
 * 2. Otherwise the first comma or semicolon that still has a key after
 *    it is the separator.
 * 3. Otherwise the whole text is a single key (trailing separators
 *    tolerated).
 */
export function parseIdList(text: string): { ids: string[]; invalid: number } {
  const isKey = (s: string) => /^[^\s,;]+$/.test(s.trim());
  /** True when any key token appears in s. */
  const hasKeyIn = (s: string) =>
    s
      .split(/[,;\r\n]+/)
      .some((t) => isKey(t));
  const collect = (tokens: string[]): { ids: string[]; invalid: number } => {
    const seen = new Set<string>();
    let invalid = 0;
    for (const raw of tokens) {
      const t = raw.trim();
      if (t === '') continue;
      if (!isKey(t)) {
        invalid++;
        continue;
      }
      seen.add(t);
    }
    return { ids: [...seen], invalid };
  };

  const firstBreak = text.search(/\r?\n/);
  if (firstBreak !== -1 && hasKeyIn(text.slice(firstBreak))) {
    return collect(text.split(/\r?\n/));
  }

  const separators: Array<[number, string]> = [];
  const comma = text.indexOf(',');
  const semicolon = text.indexOf(';');
  if (comma !== -1) separators.push([comma, ',']);
  if (semicolon !== -1) separators.push([semicolon, ';']);
  separators.sort((a, b) => a[0] - b[0]);
  for (const [idx, sep] of separators) {
    if (hasKeyIn(text.slice(idx + 1))) return collect(text.split(sep));
  }

  return collect([text.trim().replace(/[,;\s]+$/, '')]);
}

export interface ToolbarProps {
  sort: string;
  filter: string;
  q: string;
  offset: number;
  total: number;
  reviewWorkflow: boolean;
  showDates: boolean;
  languages: { code: string; name: string }[];
  hiddenLangs: string[];
  /** Applied 'id-list' filter, comma-separated ('' = none). */
  ids: string;
  onIdListApply: (text: string) => void;
  onSortChange: (v: string) => void;
  onFilterChange: (v: string) => void;
  onSearchChange: (v: string) => void;
  onOffsetChange: (v: number) => void;
  onToggleDates: () => void;
  onToggleLang: (code: string) => void;
  onAllLangs: () => void;
  onNoLangs: () => void;
  /** Opens the export dialog for the current project/component. */
  onExport: () => void;
}

export function Toolbar({
  sort,
  filter,
  q,
  offset,
  total,
  reviewWorkflow,
  showDates,
  languages,
  hiddenLangs,
  ids,
  onIdListApply,
  onSortChange,
  onFilterChange,
  onSearchChange,
  onOffsetChange,
  onToggleDates,
  onToggleLang,
  onAllLangs,
  onNoLangs,
  onExport,
}: ToolbarProps) {
  const hiddenSet = new Set(hiddenLangs);
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + PAGE_SIZE, total);

  // Draft of the ID list panel; kept in sync with the applied value so
  // URL navigation and the Clear button are reflected.
  const [idDraft, setIdDraft] = useState(() => ids.split(',').join('\n'));
  useEffect(() => {
    setIdDraft(ids.split(',').join('\n'));
  }, [ids]);
  const parsedIds = parseIdList(idDraft);

  return (
    <div className="flex flex-wrap items-center gap-3 px-4 py-2 border-b border-slate-200 bg-slate-50">
      <label className="flex items-center gap-1.5 text-sm text-slate-600">
        Sort
        <select
          className="rounded border border-slate-300 px-2 py-1 text-sm bg-white"
          value={sort}
          onChange={(e) => onSortChange(e.target.value)}
        >
          {SORT_KEYS.map((s) => (
            <option key={s} value={s}>
              {SORT_LABELS[s]}
            </option>
          ))}
        </select>
      </label>

      <label className="flex items-center gap-1.5 text-sm text-slate-600">
        Filter
        <select
          className="rounded border border-slate-300 px-2 py-1 text-sm bg-white"
          value={filter}
          onChange={(e) => onFilterChange(e.target.value)}
        >
          {ROW_FILTERS.map((f) => (
            <option key={f} value={f} disabled={f === 'unapproved' && !reviewWorkflow}>
              {FILTER_LABELS[f]}
            </option>
          ))}
        </select>
      </label>

      <input
        type="search"
        placeholder="Search source, target, context, ID…"
        className="rounded border border-slate-300 px-2 py-1 text-sm bg-white w-72"
        value={q}
        onChange={(e) => onSearchChange(e.target.value)}
      />

      <label className="flex items-center gap-1.5 text-sm text-slate-600 cursor-pointer select-none">
        <input
          type="checkbox"
          className="size-3.5 accent-sky-600"
          checked={showDates}
          onChange={onToggleDates}
        />
        Dates
      </label>

      <details className="relative">
        <summary className="flex items-center gap-1.5 text-sm text-slate-600 cursor-pointer select-none list-none rounded border border-slate-300 px-2 py-1 bg-white hover:bg-slate-100">
          Languages ({languages.length - hiddenSet.size}/{languages.length})
        </summary>
        <div className="absolute z-10 mt-1 rounded border border-slate-200 bg-white shadow-lg p-2 flex flex-col gap-1 min-w-32">
          <div className="flex gap-1 pb-1 border-b border-slate-100">
            <button
              type="button"
              className="rounded px-1.5 py-0.5 text-xs bg-white border border-slate-300 hover:bg-slate-100"
              onClick={onAllLangs}
            >
              All
            </button>
            <button
              type="button"
              className="rounded px-1.5 py-0.5 text-xs bg-white border border-slate-300 hover:bg-slate-100"
              onClick={onNoLangs}
            >
              None
            </button>
          </div>
          {languages.map((lang) => (
            <label
              key={lang.code}
              className="flex items-center gap-1.5 text-sm text-slate-600 cursor-pointer select-none whitespace-nowrap"
              title={lang.name}
            >
              <input
                type="checkbox"
                className="size-3.5 accent-sky-600"
                checked={!hiddenSet.has(lang.code)}
                onChange={() => onToggleLang(lang.code)}
              />
              {lang.code.toUpperCase()}
            </label>
          ))}
        </div>
      </details>

      <button
        type="button"
        className="rounded border border-slate-300 px-2 py-1 text-sm bg-white hover:bg-slate-100"
        onClick={onExport}
      >
        Export
      </button>

      <div className="ml-auto flex items-center gap-2 text-sm text-slate-600">
        <button
          type="button"
          className="rounded border border-slate-300 px-2 py-1 bg-white hover:bg-slate-100 disabled:opacity-40"
          disabled={offset === 0}
          onClick={() => onOffsetChange(Math.max(0, offset - PAGE_SIZE))}
        >
          ‹ Prev
        </button>
        <span className="tabular-nums whitespace-nowrap">
          {total === 0 ? '0 strings' : `${from}–${to} of ${total}`}
        </span>
        <button
          type="button"
          className="rounded border border-slate-300 px-2 py-1 bg-white hover:bg-slate-100 disabled:opacity-40"
          disabled={offset + PAGE_SIZE >= total}
          onClick={() => onOffsetChange(offset + PAGE_SIZE)}
        >
          Next ›
        </button>
      </div>

      {filter === 'id-list' && (
        <div className="w-full flex flex-wrap items-center gap-2 border-t border-slate-200 pt-2">
          <textarea
            rows={2}
            className="rounded border border-slate-300 px-2 py-1 text-sm font-mono flex-1 min-w-64 focus:border-sky-500 focus:outline-none"
            placeholder={'Paste IDs — one per line, or comma/semicolon-separated\nID0002\nID0003'}
            value={idDraft}
            onChange={(e) => setIdDraft(e.target.value)}
          />
          <label className="rounded border border-slate-300 px-2 py-1 bg-white hover:bg-slate-100 text-sm text-slate-600 cursor-pointer select-none">
            Load file…
            <input
              type="file"
              accept=".txt,.csv,text/plain"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file !== undefined) {
                  void file.text().then((t) => setIdDraft(t));
                }
                e.target.value = '';
              }}
            />
          </label>
          <span className="text-sm text-slate-500 tabular-nums">
            {parsedIds.ids.length} ID{parsedIds.ids.length === 1 ? '' : 's'}
          </span>
          {parsedIds.invalid > 0 && (
            <span className="text-xs text-amber-600">
              {parsedIds.invalid} invalid line{parsedIds.invalid === 1 ? '' : 's'} ignored
            </span>
          )}
          <button
            type="button"
            className="rounded bg-sky-600 text-white px-3 py-1.5 text-sm hover:bg-sky-700"
            onClick={() => onIdListApply(idDraft)}
          >
            Apply
          </button>
          <button
            type="button"
            className="rounded border border-slate-300 px-2 py-1 bg-white hover:bg-slate-100 text-sm text-slate-600"
            onClick={() => {
              setIdDraft('');
              onIdListApply('');
            }}
          >
            Clear
          </button>
        </div>
      )}
    </div>
  );
}

export { PAGE_SIZE };