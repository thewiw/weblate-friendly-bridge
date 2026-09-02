import type { WeblateComponent, WeblateProject } from '../../shared/weblate-dto.js';
import { useHealth, useAuth, logout } from '../api/queries.js';
import { useQueryClient } from '@tanstack/react-query';

export interface TopBarProps {
  projects: WeblateProject[] | undefined;
  components: WeblateComponent[] | undefined;
  project: string;
  component: string;
  loadingComponents: boolean;
  /** Rows data is loading/reloading — refresh is unavailable meanwhile. */
  dataLoading?: boolean;
  onProjectChange: (slug: string) => void;
  onComponentChange: (slug: string) => void;
  onRefresh: () => void;
}

export function TopBar({
  projects,
  components,
  project,
  component,
  loadingComponents,
  dataLoading,
  onProjectChange,
  onComponentChange,
  onRefresh,
}: TopBarProps) {
  const health = useHealth();
  const auth = useAuth();
  const queryClient = useQueryClient();

  const handleLogout = async () => {
    await logout();
    void queryClient.invalidateQueries();
  };

  return (
    <header className="flex items-center gap-3 px-4 py-2 border-b border-slate-200 bg-white">
      <h1 className="font-semibold text-slate-800 whitespace-nowrap">
        Weblate <span className="text-sky-600">friendly</span>
      </h1>

      <select
        className="rounded border border-slate-300 px-2 py-1 text-sm bg-white max-w-56"
        value={project}
        onChange={(e) => onProjectChange(e.target.value)}
      >
        <option value="">
          {projects === undefined ? 'Loading…' : 'Select project…'}
        </option>
        {projects?.map((p) => (
          <option key={p.slug} value={p.slug}>
            {p.name}
          </option>
        ))}
      </select>

      <select
        className="rounded border border-slate-300 px-2 py-1 text-sm bg-white max-w-56 disabled:bg-slate-50"
        value={component}
        onChange={(e) => onComponentChange(e.target.value)}
        disabled={project === ''}
      >
        <option value="">
          {project === ''
            ? 'Select a project first…'
            : loadingComponents
              ? 'Loading…'
              : 'Select component…'}
        </option>
        {components?.map((c) => (
          <option key={c.slug} value={c.slug}>
            {c.name}
          </option>
        ))}
      </select>

      <button
        type="button"
        className="rounded border border-slate-300 px-3 py-1 text-sm hover:bg-slate-100 disabled:opacity-50"
        onClick={onRefresh}
        disabled={project === '' || component === '' || dataLoading === true}
        title={dataLoading ? 'Data is loading — refresh is unavailable' : 'Reload all data from Weblate'}
      >
        ⟳ Refresh
      </button>

      <div className="ml-auto flex items-center gap-2 text-xs text-slate-500">
        {health.data !== undefined && (
          <>
            <span
              className={`rounded px-2 py-0.5 font-medium ${
                health.data.mode === 'mock'
                  ? 'bg-amber-100 text-amber-700'
                  : 'bg-emerald-100 text-emerald-700'
              }`}
            >
              {health.data.mode === 'mock' ? 'MOCK DATA' : 'live'}
            </span>
            {health.data.rateBudget.remaining !== null && (
              <span title="Weblate API rate budget remaining">
                ⚡ {health.data.rateBudget.remaining}
              </span>
            )}
            {auth.data?.authMode === 'session' && auth.data.authenticated && (
              <>
                <span title="Signed in Weblate user">👤 {auth.data.username}</span>
                <button
                  type="button"
                  className="rounded border border-slate-300 px-2 py-0.5 hover:bg-slate-100"
                  onClick={() => void handleLogout()}
                >
                  Sign out
                </button>
              </>
            )}
          </>
        )}
      </div>
    </header>
  );
}