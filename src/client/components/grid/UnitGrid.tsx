import { useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { Cell, RowsPage, SourceRow } from '../../../shared/rows.js';
import { GridCell } from './GridCell.js';

const ROW_HEIGHT = 44;

/** Fixed column widths (px). */
const CHECK_W = 36;
const ID_W = 110;
const DATE_W = 150;
/** Flexible columns: basis and minimum (grow to fill remaining width). */
const SOURCE_BASIS = 340;
const SOURCE_MIN = 240;
const LANG_BASIS = 200;
const LANG_MIN = 180;

/** Row-selection wiring passed from App. */
export interface RowSelection {
  isSelected: (key: string) => boolean;
  /** Checkbox click on a row; shift = extend from the last anchor. */
  onRowClick: (key: string, index: number, shiftKey: boolean) => void;
  /** Header checkbox: select/deselect every row of the page. */
  onTogglePage: () => void;
  pageHeaderState: 'all' | 'some' | 'none';
}

export function fmtDate(iso: string): string {
  if (iso === '') return '—';
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export interface UnitGridProps {
  page: RowsPage;
  showDates: boolean;
  /** Language codes excluded from the grid (column visibility). */
  hiddenLangs: Set<string>;
  /** Row selection (checkbox column); required for future bulk tools. */
  selection: RowSelection;
  onEditCell: (row: SourceRow, cell: Cell | undefined, language: string) => void;
}

/**
 * The review grid: sticky ID (+ Source) columns, optional date columns,
 * one column per language. Source and language columns grow to cover the
 * remaining view width. Rows are virtualized (components can have tens of
 * thousands of strings).
 */
export function UnitGrid({ page, showDates, hiddenLangs, selection, onEditCell }: UnitGridProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const rows = page.rows;
  const langs = page.languages.filter((lang) => !hiddenLangs.has(lang.code));

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
  });

  const dateCols = showDates ? 2 : 0;
  // With dates hidden, the two date columns' width is given to the ID
  // column instead — long context keys otherwise truncate early.
  const idW = showDates ? ID_W : ID_W + dateCols * DATE_W;
  const stickySourceLeft = CHECK_W + idW + dateCols * DATE_W;

  return (
    <div
      ref={scrollRef}
      className="wl-grid flex-1 overflow-auto rounded border border-slate-200 bg-white"
    >
      <div
        style={{
          minWidth:
            CHECK_W +
            idW +
            dateCols * DATE_W +
            SOURCE_MIN +
            langs.length * LANG_MIN,
        }}
      >
        {/* Header */}
        <div className="flex">
          <div
            className="wl-cell wl-head wl-sticky-check"
            style={{ flex: `0 0 ${CHECK_W}px` }}
          >
            <input
              type="checkbox"
              className="size-3.5 accent-sky-600 cursor-pointer"
              ref={(el) => {
                if (el !== null) el.indeterminate = selection.pageHeaderState === 'some';
              }}
              checked={selection.pageHeaderState === 'all'}
              onChange={selection.onTogglePage}
              title="Select/deselect this page"
              aria-label="Select/deselect this page"
            />
          </div>
          <div
            className="wl-cell wl-head wl-sticky-id"
            style={{ flex: `0 0 ${idW}px`, left: CHECK_W }}
          >
            ID
          </div>
          {showDates && (
            <div className="wl-cell wl-head" style={{ flex: `0 0 ${DATE_W}px` }}>
              Created
            </div>
          )}
          {showDates && (
            <div className="wl-cell wl-head" style={{ flex: `0 0 ${DATE_W}px` }}>
              Modified
            </div>
          )}
          <div
            className="wl-cell wl-head wl-sticky-source"
            style={{
              flex: `1 1 ${SOURCE_BASIS}px`,
              minWidth: SOURCE_MIN,
              left: stickySourceLeft,
            }}
          >
            Source
          </div>
          {langs.map((lang) => (
            <div
              key={lang.code}
              className="wl-cell wl-head"
              style={{ flex: `1 1 ${LANG_BASIS}px`, minWidth: LANG_MIN }}
              title={lang.name}
            >
              {lang.code.toUpperCase()}
            </div>
          ))}
        </div>

        {/* Body */}
        <div className="wl-body">
          {rows.length === 0 ? (
            <div className="p-8 text-center text-slate-400 text-sm">
              {page.complete
                ? 'No strings match the current filters.'
                : 'Loading component…'}
            </div>
          ) : (
            <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
              {virtualizer.getVirtualItems().map((vi) => {
                const row = rows[vi.index]!;
                const selected = selection.isSelected(row.key);
                return (
                  <div
                    key={row.key}
                    className={`wl-row flex absolute left-0 top-0 w-full${selected ? ' wl-selected' : ''}`}
                    style={{
                      transform: `translateY(${vi.start}px)`,
                      height: ROW_HEIGHT,
                    }}
                  >
                    <div
                      className="wl-cell wl-sticky-check"
                      style={{ flex: `0 0 ${CHECK_W}px` }}
                    >
                      <input
                        type="checkbox"
                        className="size-3.5 accent-sky-600 cursor-pointer"
                        checked={selected}
                        onClick={(e) => {
                          // Keep the click from also selecting text.
                          if (e.shiftKey) e.preventDefault();
                          e.stopPropagation();
                          selection.onRowClick(row.key, vi.index, e.shiftKey);
                        }}
                        aria-label="Select row"
                      />
                    </div>
                    <div
                      className="wl-cell wl-sticky-id text-xs text-slate-400 tabular-nums"
                      style={{ flex: `0 0 ${idW}px`, left: CHECK_W }}
                      title={row.context !== ''
                        ? `${row.context} · source unit #${row.sourceUnitId}`
                        : `source unit #${row.sourceUnitId}`}
                    >
                      <span className="wl-text">
                        {row.context !== '' ? row.context : row.sourceUnitId}
                      </span>
                    </div>
                    {showDates && (
                      <div
                        className="wl-cell text-xs text-slate-500 tabular-nums"
                        style={{ flex: `0 0 ${DATE_W}px` }}
                      >
                        <span className="wl-text">{fmtDate(row.createdAt)}</span>
                      </div>
                    )}
                    {showDates && (
                      <div
                        className="wl-cell text-xs text-slate-500 tabular-nums"
                        style={{ flex: `0 0 ${DATE_W}px` }}
                      >
                        <span className="wl-text">{fmtDate(row.lastUpdated)}</span>
                      </div>
                    )}
                    <div
                      className="wl-sticky-source"
                      style={{
                        flex: `1 1 ${SOURCE_BASIS}px`,
                        minWidth: SOURCE_MIN,
                        left: stickySourceLeft,
                      }}
                    >
                      <GridCell
                        cell={{
                          unitId: row.sourceUnitId,
                          language: page.sourceLanguage,
                          target: row.source,
                          state: row.sourceState,
                          hasComment: false,
                          hasSuggestion: false,
                          hasFailingCheck: false,
                          createdAt: row.createdAt,
                          lastUpdated: row.sourceLastUpdated,
                          webUrl: '',
                        }}
                        onEdit={() =>
                          onEditCell(row, undefined, page.sourceLanguage)
                        }
                      />
                    </div>
                    {langs.map((lang) => (
                      <div
                        key={lang.code}
                        style={{ flex: `1 1 ${LANG_BASIS}px`, minWidth: LANG_MIN }}
                        className="overflow-hidden"
                      >
                        <GridCell
                          cell={row.cells[lang.code]}
                          onEdit={() => onEditCell(row, row.cells[lang.code], lang.code)}
                        />
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}