import { useState } from 'react';
import { searchReplacePreview, useSearchReplace } from '../api/queries.js';
import type { SearchReplaceMatch, SearchReplaceVars } from '../api/queries.js';
import { Spinner } from './ui.js';

export interface SearchReplaceDialogProps {
  /** The bulk request scope (same shape as the state tools). */
  base: Omit<SearchReplaceVars, 'search' | 'replace' | 'ignoreCase' | 'wholeWord' | 'languages'>;
  /** Currently displayed language columns plus the source language. */
  languages: string[];
  /** The component's source language (labelled "source" in the list). */
  sourceLanguage: string;
  languageNames: Record<string, string>;
  /** Close; with a message, the app shows it as a toast (apply outcome). */
  onClose: (message?: string, kind?: 'success' | 'error') => void;
}

/**
 * Bulk search & replace over the selected rows: preview (count + list of
 * affected cells), then apply as a background job. Apply is enabled only
 * after a preview of the CURRENT parameters.
 */
export function SearchReplaceDialog({ base, languages, sourceLanguage, languageNames, onClose }: SearchReplaceDialogProps) {
  const [search, setSearch] = useState('');
  const [replace, setReplace] = useState('');
  const [ignoreCase, setIgnoreCase] = useState(true);
  const [wholeWord, setWholeWord] = useState(false);
  const [langs, setLangs] = useState<Set<string>>(new Set(languages));
  const [previewing, setPreviewing] = useState(false);
  /** Preview result + the parameter snapshot it was computed with. */
  const [preview, setPreview] = useState<
    { total: number; matches: SearchReplaceMatch[]; key: string } | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const replaceJob = useSearchReplace();

  const currentKey = JSON.stringify({
    search,
    replace,
    ignoreCase,
    wholeWord,
    languages: [...langs].sort(),
  });
  /** A preview is stale as soon as any parameter changes. */
  const paramsCurrent = preview !== null && preview.key === currentKey;

  const runPreview = async (): Promise<void> => {
    setPreviewing(true);
    setError(null);
    try {
      const result = await searchReplacePreview({
        ...base,
        search,
        replace,
        ignoreCase,
        wholeWord,
        languages: [...langs],
      });
      setPreview({ ...result, key: currentKey });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Preview failed');
    } finally {
      setPreviewing(false);
    }
  };

  const apply = (): void => {
    if (preview === null) return;
    replaceJob.mutate(
      { ...base, search, replace, ignoreCase, wholeWord, languages: [...langs] },
      {
        onSuccess: (st) => {
          const parts = [`Replaced in ${st.done} translation${st.done === 1 ? '' : 's'}`];
          if (st.failed > 0) parts.push(`${st.failed} failed`);
          if (st.firstError !== undefined) parts.push(`e.g. ${st.firstError}`);
          replaceJob.reset();
          onClose(parts.join(', '), st.failed > 0 ? 'error' : 'success');
        },
        onError: (err: Error) => {
          replaceJob.reset();
          onClose(err.message, 'error');
        },
      },
    );
  };

  if (replaceJob.isPending) {
    return (
      <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
        <div className="bg-white rounded-lg shadow-xl px-5 py-4 text-slate-700">
          <Spinner label="Applying search & replace…" />
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div
        className="bg-white rounded-lg shadow-xl w-full max-w-xl p-5 flex flex-col gap-3 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="font-semibold text-slate-800">Search &amp; replace</h2>
        <p className="text-xs text-slate-500">
          Applies to the selected rows only. The replacement is inserted literally
          (no regex); the translation state is preserved.
        </p>

        <div className="grid grid-cols-2 gap-3 text-sm">
          <label className="flex flex-col gap-1 text-slate-600">
            Search
            <input
              autoFocus
              className="rounded border border-slate-300 px-2 py-1 bg-white focus:border-sky-500 focus:outline-none"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1 text-slate-600">
            Replace with
            <input
              className="rounded border border-slate-300 px-2 py-1 bg-white focus:border-sky-500 focus:outline-none"
              value={replace}
              onChange={(e) => setReplace(e.target.value)}
            />
          </label>
        </div>

        <div className="flex gap-4 text-sm text-slate-600">
          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              className="size-3.5 accent-sky-600"
              checked={ignoreCase}
              onChange={(e) => setIgnoreCase(e.target.checked)}
            />
            Ignore case
          </label>
          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              className="size-3.5 accent-sky-600"
              checked={wholeWord}
              onChange={(e) => setWholeWord(e.target.checked)}
            />
            Whole word
          </label>
        </div>

        <div className="text-sm text-slate-600">
          <span className="mb-1 block">Languages</span>
          <div className="flex flex-wrap gap-2">
            {languages.map((code) => (
              <label
                key={code}
                className="flex items-center gap-1 text-sm text-slate-600"
                title={code === sourceLanguage ? `${languageNames[code] ?? code} (source language)` : (languageNames[code] ?? code)}
              >
                <input
                  type="checkbox"
                  className="size-3.5 accent-sky-600"
                  checked={langs.has(code)}
                  onChange={() =>
                    setLangs((prev) => {
                      const next = new Set(prev);
                      if (next.has(code)) next.delete(code);
                      else next.add(code);
                      return next;
                    })
                  }
                />
                {code.toUpperCase()}
                {code === sourceLanguage && <span className="text-xs text-slate-400">· source</span>}
              </label>
            ))}
          </div>
        </div>

        {error !== null && <div className="text-sm text-red-600">{error}</div>}

        {preview !== null && paramsCurrent && (
          <div className="border border-slate-200 rounded p-2 flex flex-col gap-1 overflow-y-auto max-h-56">
            <span className="text-sm font-medium text-slate-700">
              {preview.total === 0
                ? 'No translation matches this search.'
                : `${preview.total} translation${preview.total === 1 ? '' : 's'} will be modified:`}
            </span>
            {preview.matches.map((m) => (
              <div key={`${m.context}·${m.language}`} className="text-xs text-slate-600 font-mono break-all">
                <span className="font-semibold">{m.context || '(no context)'}</span>
                <span className="text-slate-400"> · {m.language.toUpperCase()} · </span>
                <span className="text-red-700">{m.before.join(' | ')}</span>
                {' → '}
                <span className="text-emerald-700">{m.after.join(' | ')}</span>
              </div>
            ))}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            className="rounded border border-slate-300 px-3 py-1.5 text-sm bg-white hover:bg-slate-100 disabled:opacity-40"
            disabled={previewing || search.trim() === ''}
            onClick={() => void runPreview()}
          >
            {previewing ? 'Searching…' : 'Search'}
          </button>
          <button
            type="button"
            className="rounded border border-slate-300 px-3 py-1.5 text-sm bg-white hover:bg-slate-100"
            onClick={() => onClose()}
          >
            Cancel
          </button>
          <button
            type="button"
            className="rounded bg-sky-600 px-3 py-1.5 text-sm text-white hover:bg-sky-700 disabled:opacity-40"
            disabled={preview === null || !paramsCurrent || preview.total === 0}
            onClick={apply}
          >
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}