import type { RowsPage } from '../../shared/rows.js';

/** Shown while the backend is still pulling a component from Weblate. */
export function ProgressBanner({ page }: { page: RowsPage }) {
  if (page.complete) {
    if (page.error) {
      return (
        <div className="px-4 py-1.5 text-sm bg-red-100 text-red-700 border-b border-red-200">
          Load error: {page.error} — showing the data that was fetched.
        </div>
      );
    }
    return null;
  }

  const { loaded, total } = page.loadProgress ?? { loaded: 0, total: 0 };
  const pct = total > 0 ? Math.round((loaded / total) * 100) : 0;

  return (
    <div className="px-4 py-1.5 text-sm bg-sky-50 text-sky-700 border-b border-sky-100 flex items-center gap-3">
      <span>
        Loading component from Weblate… {loaded}/{total} translations
      </span>
      <div className="h-1.5 flex-1 rounded bg-sky-100 overflow-hidden max-w-64">
        <div className="h-full bg-sky-500" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}