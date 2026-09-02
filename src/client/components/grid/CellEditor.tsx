import { useEffect, useMemo, useState } from 'react';
import type { Cell, SourceRow } from '../../../shared/rows.js';
import type { UnitState } from '../../../shared/weblate-dto.js';
import { STATE_LABELS } from '../../../shared/rows.js';

export interface CellEditorProps {
  row: SourceRow;
  cell: Cell;
  /** True when editing the source string itself (no state actions). */
  sourceMode?: boolean;
  /** Review workflow on for this project — Approve (state 30) is offered. */
  reviewWorkflow?: boolean;
  saving: boolean;
  /** Save failure message; shown inline and keeps the editor open. */
  error?: string | null;
  onSave: (patch: { target?: string[]; state?: UnitState }) => void;
  onClose: () => void;
}

/**
 * Modal editor for one (row, language) cell — or for the source string
 * when sourceMode is set. Plural forms get one textarea per form,
 * matching the source forms.
 */
export function CellEditor({
  row,
  cell,
  sourceMode = false,
  reviewWorkflow = false,
  saving,
  error = null,
  onSave,
  onClose,
}: CellEditorProps) {
  const [forms, setForms] = useState<string[]>(cell.target);
  const [explanation, setExplanation] = useState(row.explanation ?? '');
  const initialExplanation = row.explanation ?? '';

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // A save is in flight — keep the editor open until it settles.
      if (saving) return;
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, saving]);

  const plural = useMemo(() => row.source.length > 1, [row.source.length]);

  return (
    <div
      className="fixed inset-0 z-40 bg-black/40 flex items-center justify-center p-4"
      onClick={() => {
        if (!saving) onClose();
      }}
    >
      <div
        className="bg-white rounded-lg shadow-xl w-full max-w-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-slate-200 px-4 py-3">
          <div className="text-sm text-slate-500">
            {sourceMode
              ? 'Source string'
              : `${cell.language.toUpperCase()} · unit #${cell.unitId}`}
          </div>
          {!sourceMode && (
            <div className="font-medium text-slate-800">
              {row.source.map((s, i) => (
                <div key={i}>
                  {plural && <span className="text-slate-400 mr-1">#{i}</span>}
                  {s}
                </div>
              ))}
            </div>
          )}
          {row.context && (
            <div className="text-xs text-slate-400">Context: {row.context}</div>
          )}
          {row.location && (
            <div className="text-xs text-slate-400">Location: {row.location}</div>
          )}
        </div>

        {!sourceMode && explanation !== '' && (
          <div className="mx-4 mt-3 rounded bg-sky-50 border border-sky-100 px-3 py-2 text-xs text-sky-800">
            <span className="font-medium">Translator note: </span>
            {explanation}
          </div>
        )}

        <div className="px-4 py-3 flex flex-col gap-2">
          {forms.map((form, i) => (
            <label key={i} className="flex flex-col gap-1">
              {plural && (
                <span className="text-xs text-slate-500">Form #{i}</span>
              )}
              <textarea
                autoFocus={i === 0}
                rows={forms.length > 1 ? 2 : 3}
                className="w-full rounded border border-slate-300 px-2 py-1 text-sm focus:border-sky-500 focus:outline-none"
                value={form}
                onChange={(e) => {
                  const next = [...forms];
                  next[i] = e.target.value;
                  setForms(next);
                }}
              />
            </label>
          ))}
          {sourceMode && (
            <label className="flex flex-col gap-1">
              <span className="text-xs text-slate-500">
                Explanation — guidance shown to translators in every language
              </span>
              <textarea
                rows={2}
                className="w-full rounded border border-slate-300 px-2 py-1 text-sm focus:border-sky-500 focus:outline-none"
                value={explanation}
                onChange={(e) => setExplanation(e.target.value)}
              />
            </label>
          )}
          {error !== null && error !== '' && (
            <div
              role="alert"
              className="rounded bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700"
            >
              {error}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-slate-200 px-4 py-3">
          <button
            type="button"
            className="rounded px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-100"
            onClick={onClose}
            disabled={saving}
          >
            Cancel
          </button>
          {sourceMode ? (
            <button
              type="button"
              className="rounded px-3 py-1.5 text-sm bg-sky-600 text-white hover:bg-sky-700 disabled:opacity-50"
              onClick={() =>
                onSave({
                  target: forms,
                  state: cell.state,
                  // Only send the explanation when it actually changed:
                  // older Weblate instances may reject the field.
                  ...(explanation !== initialExplanation ? { explanation } : {}),
                })
              }
              disabled={saving}
              title={`Save source string (${STATE_LABELS[cell.state] ?? cell.state})`}
            >
              Save
            </button>
          ) : (
            <>
              <button
                type="button"
                className="rounded px-3 py-1.5 text-sm bg-amber-500 text-white hover:bg-amber-600 disabled:opacity-50"
                onClick={() => onSave({ target: forms, state: 10 })}
                disabled={saving}
                title={STATE_LABELS[10]}
              >
                Needs editing
              </button>
              {reviewWorkflow && (
                <button
                  type="button"
                  className="rounded px-3 py-1.5 text-sm bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
                  onClick={() => onSave({ target: forms, state: 30 })}
                  disabled={saving}
                  title={STATE_LABELS[30]}
                >
                  Approve
                </button>
              )}
              <button
                type="button"
                className="rounded px-3 py-1.5 text-sm bg-sky-600 text-white hover:bg-sky-700 disabled:opacity-50"
                onClick={() => onSave({ target: forms, state: 20 })}
                disabled={saving}
                title={STATE_LABELS[20]}
              >
                Save
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}