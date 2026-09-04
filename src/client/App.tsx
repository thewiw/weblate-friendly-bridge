import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Cell, RowFilter, SortKey, SourceRow } from '../shared/rows.js';
import { STATE_LABELS } from '../shared/rows.js';
import type { UnitState } from '../shared/weblate-dto.js';
import { useAuth, useBulkState, useComponents, useEditUnit, useHealth, useProjects, useRows, logout, triggerRefresh, uploadIdList } from './api/queries.js';
import { useViewParams, parseHiddenLangs } from './state/url-state.js';
import {
  emptySelection,
  isSelected as isSelectedIn,
  selectionCount,
  setKeysState,
  toggleKey,
  type Selection,
} from './state/selection.js';
import { TopBar } from './components/TopBar.js';
import { Toolbar, PAGE_SIZE, parseIdList, INLINE_ID_LIMIT, MAX_ID_LIST } from './components/Toolbar.js';
import { ProgressBanner } from './components/ProgressBanner.js';
import { UnitGrid } from './components/grid/UnitGrid.js';
import { CellEditor } from './components/grid/CellEditor.js';
import { LoginView } from './components/LoginView.js';
import { ExportDialog } from './components/ExportDialog.js';
import { useToast, Spinner } from './components/ui.js';

interface Editing {
  row: SourceRow;
  cell: Cell;
  language: string;
  sourceMode: boolean;
}

export function App() {
  const [view, setView] = useViewParams();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const auth = useAuth();
  const health = useHealth();

  // Session mode: gate the whole app behind the login view until the user
  // has a live Weblate session. Any 401 from data queries re-opens it.
  const needsLogin =
    auth.data !== undefined &&
    auth.data.authMode === 'session' &&
    !auth.data.authenticated;

  useEffect(() => {
    const onUnauthorized = () => {
      void queryClient.invalidateQueries({ queryKey: ['auth'] });
    };
    window.addEventListener('wl-unauthorized', onUnauthorized);
    return () => window.removeEventListener('wl-unauthorized', onUnauthorized);
  }, [queryClient]);

  const projects = useProjects();
  const components = useComponents(view.project);
  const rows = useRows({
    project: view.project,
    component: view.component,
    sort: view.sort,
    filter: view.filter,
    q: view.q,
    // Sent so filters follow the visible language columns; stale codes
    // from other components simply never match, and hiding every
    // language falls back to all of them on the server.
    hiddenLangs: view.hiddenLangs,
    ids: view.ids,
    listId: view.listId,
    offset: view.offset,
    limit: PAGE_SIZE,
  });

  // Debounce the search box: local state, synced to the URL after a pause.
  const [search, setSearch] = useState(view.q);
  useEffect(() => {
    setSearch(view.q);
  }, [view.q]);
  useEffect(() => {
    if (search === view.q) return;
    const t = setTimeout(() => setView({ q: search, offset: 0 }), 300);
    return () => clearTimeout(t);
  }, [search, view.q, setView]);

  const [editing, setEditing] = useState<Editing | null>(null);
  const editUnit = useEditUnit();

  const reviewWorkflow = health.data?.reviewWorkflow ?? true;

  // Language column visibility: hidden codes live in the URL; unknown codes
  // (e.g. left over from another component) simply never match.
  const hiddenLangs = parseHiddenLangs(view.hiddenLangs);
  const setLangVisible = (code: string, visible: boolean) => {
    const next = new Set(hiddenLangs);
    if (visible) next.delete(code);
    else next.add(code);
    setView({ hiddenLangs: [...next].join(',') });
  };

  // Applies the ID-list panel: parse, cap, and either keep small lists
  // in the URL (shareable) or upload large ones and reference them by id.
  const handleIdListApply = (text: string) => {
    const { ids, invalid } = parseIdList(text);
    if (invalid > 0) {
      toast(`${invalid} invalid line${invalid === 1 ? '' : 's'} ignored`);
    }
    if (ids.length > MAX_ID_LIST) {
      toast(`ID list truncated to the first ${MAX_ID_LIST} IDs`);
    }
    const capped = ids.slice(0, MAX_ID_LIST);
    if (capped.length <= INLINE_ID_LIMIT) {
      setView({ ids: capped.join(','), listId: '', offset: 0 });
      return;
    }
    uploadIdList(capped)
      .then((listId) => setView({ ids: '', listId, offset: 0 }))
      .catch((err: Error) => toast(err.message));
  };

  const handleRefresh = () => {
    // A refresh reloads the data — any row selection is stale afterwards.
    selectionAnchor.current = null;
    setSelection(emptySelection());
    void triggerRefresh({
      project: view.project,
      component: view.component,
      sort: view.sort,
      filter: view.filter,
      q: view.q,
      hiddenLangs: view.hiddenLangs,
      ids: view.ids,
      listId: view.listId,
      offset: view.offset,
      limit: PAGE_SIZE,
    })
      .then(() => queryClient.invalidateQueries({ queryKey: ['rows'] }))
      .catch((err: Error) => toast(err.message));
  };

  const handleSave = (patch: { target?: string[]; state?: UnitState }) => {
    if (editing === null) return;
    editUnit.mutate(
      {
        unitId: editing.cell.unitId,
        language: editing.language,
        patch,
      },
      {
        onSuccess: () => {
          setEditing(null);
          toast('Saved', 'success');
          // After a source edit, the server re-reads the row's units in
          // the background (1.25s/8s/20s later) to pick up Weblate's
          // recomputed check flags; refetch on a matching schedule so the
          // alert icons update whenever a re-read lands.
          if (editing.sourceMode) {
            for (const delayMs of [2_500, 10_000, 22_000]) {
              setTimeout(() => {
                void queryClient.invalidateQueries({ queryKey: ['rows'] });
              }, delayMs);
            }
          }
        },
        // The editor stays open and shows the failure inline (CellEditor
        // error banner) — no toast needed.
      },
    );
  };

  // ---- Row selection (for future bulk tools) ----
  // Model in state/selection.ts: `all` selects every string of the current
  // filtered result; `keys` are the explicit exceptions. Cleared whenever
  // the filtered set changes.
  const page = rows.data;
  const [selection, setSelection] = useState<Selection>(emptySelection());
  const selectionAnchor = useRef<number | null>(null);
  useEffect(() => {
    setSelection(emptySelection());
    selectionAnchor.current = null;
  }, [view.project, view.component, view.filter, view.q, view.ids, view.listId]);

  const isSelected = (key: string) => isSelectedIn(selection, key);
  const selectedCount = selectionCount(selection, page?.total ?? 0);

  const handleSelectRow = (key: string, index: number, shiftKey: boolean) => {
    if (!shiftKey) selectionAnchor.current = index;
    setSelection((prev) => {
      if (shiftKey && selectionAnchor.current !== null && page !== undefined) {
        // Extend from the anchor to the clicked row (within the page).
        const from = Math.min(selectionAnchor.current, index);
        const to = Math.max(selectionAnchor.current, index);
        const range = page.rows.slice(from, to + 1).map((r) => r.key);
        return setKeysState(prev, range, !isSelectedIn(prev, key));
      }
      return toggleKey(prev, key);
    });
    if (shiftKey) selectionAnchor.current = index;
  };

  const pageKeys = page?.rows.map((r) => r.key) ?? [];
  const pageSelectedCount = pageKeys.filter((k) => isSelectedIn(selection, k)).length;
  const pageHeaderState: 'all' | 'some' | 'none' =
    pageKeys.length === 0
      ? 'none'
      : pageSelectedCount === pageKeys.length
        ? 'all'
        : pageSelectedCount > 0
          ? 'some'
          : 'none';
  const handleTogglePage = () => {
    setSelection((prev) => setKeysState(prev, pageKeys, pageHeaderState !== 'all'));
  };

  // ---- Bulk status tools ----
  const bulk = useBulkState();
  const [bulkProgress, setBulkProgress] = useState<{ done: number; total: number } | null>(null);
  /** Export dialog open (grid mode) or multi-select mode ('multi'). */
  const [exportMode, setExportMode] = useState<'grid' | 'multi' | null>(null);
  /** Tool awaiting confirmation (the dialog shows scope + counts). */
  const [confirmBulk, setConfirmBulk] = useState<{
    state: UnitState;
    onlyStates?: UnitState[];
  } | null>(null);
  const visibleLangs = page?.languages.map((l) => l.code).filter((c) => !hiddenLangs.has(c)) ?? [];
  useEffect(() => {
    if (confirmBulk === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setConfirmBulk(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [confirmBulk]);
  const handleBulkState = (state: UnitState, onlyStates?: UnitState[]) => {
    if (page === undefined || selectedCount === 0) return;
    if (visibleLangs.length === 0) {
      toast('No visible language columns to update');
      return;
    }
    bulk.mutate(
      {
        project: view.project,
        component: view.component,
        sort: view.sort,
        filter: view.filter,
        q: view.q,
        hiddenLangs: view.hiddenLangs,
        ids: view.ids,
        listId: view.listId,
        selection: { all: selection.all, keys: [...selection.keys] },
        state,
        onlyStates,
        languages: visibleLangs,
        onProgress: (done, total) => setBulkProgress({ done, total }),
      },
      {
        onSuccess: (st) => {
          setBulkProgress(null);
          const parts = [`Updated ${st.done} translation${st.done === 1 ? '' : 's'}`];
          if (st.failed > 0) parts.push(`${st.failed} failed`);
          if (st.skipped > 0) parts.push(`${st.skipped} skipped (empty)`);
          if (st.notApplicable > 0) parts.push(`${st.notApplicable} not affected (state didn't match)`);
          if (st.firstError !== undefined) parts.push(`e.g. ${st.firstError}`);
          toast(parts.join(', '), st.failed > 0 ? 'error' : 'success');
        },
        onError: (err: Error) => {
          setBulkProgress(null);
          toast(err.message);
        },
      },
    );
  };

  if (needsLogin) {
    return (
      <LoginView
        onSuccess={() => {
          void queryClient.invalidateQueries();
        }}
      />
    );
  }

  return (
    <div className="h-screen flex flex-col bg-slate-50">
      <TopBar
        projects={projects.data?.results}
        components={components.data?.results}
        project={view.project}
        component={view.component}
        loadingComponents={components.isFetching}
        dataLoading={rows.isFetching || (page !== undefined && !page.complete)}
        onProjectChange={(p) => setView({ project: p, component: '', offset: 0 })}
        onComponentChange={(c) => setView({ component: c, offset: 0 })}
        onRefresh={handleRefresh}
      />

      {view.component !== '' && (
        <>
          <Toolbar
            sort={view.sort}
            filter={view.filter}
            q={search}
            offset={view.offset}
            total={page?.total ?? 0}
            reviewWorkflow={page?.reviewWorkflow ?? reviewWorkflow}
            showDates={view.dates}
            languages={page?.languages ?? []}
            hiddenLangs={[...hiddenLangs]}
            ids={view.ids}
            onIdListApply={handleIdListApply}
            onSortChange={(s) => setView({ sort: s as SortKey, offset: 0 })}
            onFilterChange={(f) => setView({ filter: f as RowFilter, offset: 0 })}
            onSearchChange={setSearch}
            onOffsetChange={(o) => setView({ offset: o })}
            onToggleDates={() => setView({ dates: !view.dates })}
            onToggleLang={(code) => setLangVisible(code, hiddenLangs.has(code))}
            onAllLangs={() => setView({ hiddenLangs: '' })}
            onExport={() => setExportMode('grid')}
            onNoLangs={() =>
              setView({ hiddenLangs: (page?.languages ?? []).map((l) => l.code).join(',') })
            }
          />
          {page !== undefined && <ProgressBanner page={page} />}
          {selectedCount > 0 && page !== undefined && (
            <div className="flex flex-wrap items-center gap-3 px-4 py-1.5 border-b border-slate-200 bg-sky-50 text-sm">
              <span className="font-medium text-sky-800">{selectedCount} selected</span>
              {!selection.all && page.total > selectedCount && (
                <button
                  type="button"
                  className="rounded border border-sky-300 bg-white px-2 py-0.5 text-sky-700 hover:bg-sky-100"
                  onClick={() => setSelection({ all: true, keys: new Set() })}
                >
                  Select all {page.total} (filtered)
                </button>
              )}
              <span className="text-slate-400">|</span>
              <span className="text-xs text-slate-500 uppercase tracking-wide">
                Set status on visible languages
              </span>
              {(
                [
                  { label: 'Needs editing', state: 10 as UnitState },
                  { label: 'Edited', state: 20 as UnitState, onlyStates: [10] as UnitState[] },
                  { label: 'Untranslated', state: 0 as UnitState },
                  { label: 'Translated', state: 20 as UnitState },
                ] as Array<{ label: string; state: UnitState; onlyStates?: UnitState[] }>
              ).map((tool) => (
                <button
                  key={tool.label}
                  type="button"
                  title={
                    tool.onlyStates !== undefined
                      ? `Set state ${tool.state} only on cells currently ${tool.onlyStates.join('/')}`
                      : `Set state ${tool.state}`
                  }
                  className="rounded border border-slate-300 bg-white px-2 py-0.5 hover:bg-slate-100 disabled:opacity-40"
                  disabled={bulk.isPending}
                  onClick={() => setConfirmBulk({ state: tool.state, onlyStates: tool.onlyStates })}
                >
                  {tool.label}
                </button>
              ))}
              <span className="text-slate-400">|</span>
              <button
                type="button"
                className="rounded border border-slate-300 bg-white px-2 py-0.5 hover:bg-slate-100"
                onClick={() => {
                  selectionAnchor.current = null;
                  setSelection(emptySelection());
                }}
              >
                Clear selection
              </button>
            </div>
          )}
          {page !== undefined && (
            <UnitGrid
              page={page}
              showDates={view.dates}
              hiddenLangs={hiddenLangs}
              selection={{
                isSelected,
                onRowClick: handleSelectRow,
                onTogglePage: handleTogglePage,
                pageHeaderState,
              }}
              onEditCell={(row, cell, language) => {
                if (cell !== undefined) {
                  setEditing({ row, cell, language, sourceMode: false });
                } else {
                  // Source column: no cached cell — build one from row metadata.
                  setEditing({
                    row,
                    cell: {
                      unitId: row.sourceUnitId,
                      language,
                      target: row.source,
                      state: row.sourceState,
                      hasComment: false,
                      hasSuggestion: false,
                      hasFailingCheck: false,
                      createdAt: row.createdAt,
                      lastUpdated: row.sourceLastUpdated,
                      webUrl: '',
                    },
                    language,
                    sourceMode: true,
                  });
                }
              }}
            />
          )}
          {page === undefined && rows.isFetching && (
            <div className="flex-1 flex items-center justify-center text-slate-400">
              Loading…
            </div>
          )}
          {rows.isError && (
            <div className="flex-1 flex items-center justify-center text-red-500">
              {(rows.error as Error)?.message ?? 'Failed to load rows'}
            </div>
          )}
        </>
      )}

      {view.component === '' && (
        <div className="flex-1 flex flex-col items-center justify-center text-slate-400 gap-2">
          <div className="text-lg">Select a project and component</div>
          <div className="text-sm">
            Every source string with all its translations in one grid.
          </div>
          {/* Multi-component export is offered before any project is
              selected (from the grid, export targets the current one). */}
          {view.project === '' && projects.data !== undefined && (
            <button
              type="button"
              className="mt-2 rounded border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-100"
              onClick={() => setExportMode('multi')}
            >
              Export translations…
            </button>
          )}
        </div>
      )}

      {exportMode !== null && (
        <ExportDialog
          projects={projects.data?.results}
          scope={
            exportMode === 'grid'
              ? { project: view.project, component: view.component }
              : undefined
          }
          languages={exportMode === 'grid' ? page?.languages : undefined}
          onClose={() => setExportMode(null)}
        />
      )}

      {editing !== null && (
        <CellEditor
          row={editing.row}
          cell={editing.cell}
          sourceMode={editing.sourceMode}
          reviewWorkflow={page?.reviewWorkflow ?? reviewWorkflow}
          saving={
            editUnit.isPending &&
            editUnit.variables?.unitId === editing.cell.unitId
          }
          error={editUnit.isError ? (editUnit.error as Error).message : null}
          onSave={handleSave}
          onClose={() => setEditing(null)}
        />
      )}

      {/* While a save is in flight, block every interaction (editor included)
          behind a spinner until the response — or the client timeout —
          settles the mutation. */}
      {editUnit.isPending && (
        <div className="fixed inset-0 z-50 bg-black/30 flex items-center justify-center">
          <div className="bg-white rounded-lg shadow-xl px-5 py-4 text-slate-700">
            <Spinner label="Saving translation…" />
          </div>
        </div>
      )}

      {/* Bulk tools ask for confirmation first: scope, counts, cancel. */}
      {confirmBulk !== null && (
        <div
          className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
          onClick={() => setConfirmBulk(null)}
        >
          <div
            className="bg-white rounded-lg shadow-xl w-full max-w-md p-5 flex flex-col gap-3"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="font-semibold text-slate-800">Confirm bulk update</h2>
            <p className="text-sm text-slate-600">
              Set the status of translations to{' '}
              <span className="font-medium text-slate-800">
                “{STATE_LABELS[confirmBulk.state] ?? confirmBulk.state}”
              </span>{' '}
              on <span className="font-medium">{selectedCount}</span> selected{' '}
              {selectedCount === 1 ? 'line' : 'lines'} across{' '}
              <span className="font-medium">{visibleLangs.length}</span> visible{' '}
              {visibleLangs.length === 1 ? 'language' : 'languages'} (
              {visibleLangs.map((l) => l.toUpperCase()).join(', ')}).
            </p>
            <p className="text-sm text-slate-600">
              Up to{' '}
              <span className="font-medium">{selectedCount * visibleLangs.length}</span>{' '}
              translations will be updated
              {confirmBulk.onlyStates !== undefined && (
                <> — only those currently marked “{STATE_LABELS[confirmBulk.onlyStates[0]!]}”</>
              )}
              .
            </p>
            {confirmBulk.state === 0 && (
              <p className="text-sm text-amber-700">
                Marking lines untranslated <span className="font-medium">clears their
                translation text</span> (Weblate requires untranslated strings to be empty).
              </p>
            )}
            <p className="text-xs text-slate-400">
              Empty translations are left untouched (except by “Untranslated”). Each
              translation is one request to Weblate; this cannot be undone in bulk.
            </p>
            <div className="flex justify-end gap-2 mt-1">
              <button
                type="button"
                className="rounded px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-100"
                onClick={() => setConfirmBulk(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                autoFocus
                className="rounded px-3 py-1.5 text-sm bg-sky-600 text-white hover:bg-sky-700"
                onClick={() => {
                  const { state, onlyStates } = confirmBulk;
                  setConfirmBulk(null);
                  handleBulkState(state, onlyStates);
                }}
              >
                Continue
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Bulk status tools run as a background job; show live progress and
          block interaction until it settles. */}
      {bulk.isPending && (
        <div className="fixed inset-0 z-50 bg-black/30 flex items-center justify-center">
          <div className="bg-white rounded-lg shadow-xl px-5 py-4 text-slate-700">
            <Spinner
              label={
                bulkProgress !== null
                  ? `Updating translations… ${bulkProgress.done}/${bulkProgress.total}`
                  : 'Updating translations…'
              }
            />
          </div>
        </div>
      )}
    </div>
  );
}