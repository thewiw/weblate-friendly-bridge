import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import type { RowsPage, SortKey, UnitPatchResult } from '../../shared/rows.js';
import type {
  ExportJobState,
  ExportProgress,
  ExportRequest,
  ExportResponse,
} from '../../shared/export.js';
import type { UnitState, WeblateComponent, WeblateProject } from '../../shared/weblate-dto.js';
import { api, ApiError } from './http.js';

export interface RowsQueryParams {
  project: string;
  component: string;
  sort: SortKey;
  filter: string;
  q: string;
  /** Comma-separated hidden language codes (filters use visible ones). */
  hiddenLangs: string;
  /** Inline, comma-separated source unit ids ('id-list' filter, small lists). */
  ids: string;
  /** Reference to an uploaded large ID list (see uploadIdList). */
  listId: string;
  offset: number;
  limit: number;
  refresh?: boolean;
}

function rowsQueryString(p: RowsQueryParams): string {
  const sp = new URLSearchParams({
    project: p.project,
    component: p.component,
    sort: p.sort,
    filter: p.filter,
    offset: String(p.offset),
    limit: String(p.limit),
  });
  if (p.q) sp.set('q', p.q);
  if (p.hiddenLangs) sp.set('hiddenLangs', p.hiddenLangs);
  if (p.ids) sp.set('ids', p.ids);
  if (p.listId) sp.set('listId', p.listId);
  if (p.refresh) sp.set('refresh', '1');
  return sp.toString();
}

/**
 * Uploads a large ID/key list once and returns the server-side reference.
 * Memoized per list content so refetches (polling, pagination) never
 * re-upload the same list.
 */
const idListUploads = new Map<string, Promise<string>>();

export function uploadIdList(keys: string[]): Promise<string> {
  const memoKey = keys.join(',');
  const cached = idListUploads.get(memoKey);
  if (cached !== undefined) return cached;
  const promise = api<{ listId: string }>('/id-lists', {
    method: 'POST',
    body: JSON.stringify({ keys }),
  }).then((res) => res.listId);
  idListUploads.set(memoKey, promise);
  return promise;
}

export interface AuthStatus {
  authMode: 'token' | 'session';
  authenticated: boolean;
  username: string | null;
}

export function useAuth() {
  return useQuery({
    queryKey: ['auth'],
    queryFn: () =>
      api<AuthStatus>('/auth/status').catch((err: unknown) => {
        // Token mode has no /auth/status endpoint — treat as authenticated.
        if (err instanceof ApiError && err.status === 404) {
          return { authMode: 'token', authenticated: true, username: null } as AuthStatus;
        }
        throw err;
      }),
    staleTime: 60_000,
  });
}

export type LoginResponse =
  | { status: 'ok'; username: string }
  | { status: 'totp_required'; username: string };

export async function login(username: string, password: string): Promise<LoginResponse> {
  return api<LoginResponse>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  });
}

export async function loginTotp(token: string): Promise<{ status: 'ok'; username: string }> {
  return api<{ status: 'ok'; username: string }>('/auth/login/totp', {
    method: 'POST',
    body: JSON.stringify({ token }),
  });
}

export async function logout(): Promise<void> {
  await api('/auth/logout', { method: 'POST' });
}

export function useProjects() {
  return useQuery({
    queryKey: ['projects'],
    queryFn: () => api<{ results: WeblateProject[] }>('/projects'),
  });
}

/** Manual refresh button: forces a full cache rebuild, then re-reads. */
export async function triggerRefresh(p: RowsQueryParams): Promise<void> {
  await api(`/rows?${rowsQueryString({ ...p, refresh: true })}`);
}

export function useComponents(project: string) {
  return useQuery({
    queryKey: ['components', project],
    queryFn: () =>
      api<{ results: WeblateComponent[] }>(
        `/projects/${encodeURIComponent(project)}/components`,
      ),
    enabled: project !== '',
  });
}

export interface ComponentLanguage {
  code: string;
  name: string;
  /** Present on /languages responses (the grid's LanguageMeta omits it). */
  isSource?: boolean;
}

export function useComponentLanguages(project: string, component: string) {
  return useQuery({
    queryKey: ['languages', project, component],
    queryFn: () =>
      api<{ results: ComponentLanguage[] }>(
        `/languages?project=${encodeURIComponent(project)}&component=${encodeURIComponent(component)}`,
      ),
    enabled: project !== '' && component !== '',
  });
}

/** Triggers a browser download for the given blob under the given name. */
function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}

export interface ExportVars {
  request: ExportRequest;
  onProgress?: (p: ExportProgress) => void;
}

/**
 * Runs an export as a background job and downloads the result: the zip
 * archive itself, or one download per file when packaging is 'json'.
 * Mirrors useBulkState: POST /export returns a jobId at once, we poll
 * /export-jobs/:jobId for progress, then fetch the finished payload.
 */
export function useExport() {
  return useMutation({
    mutationFn: async (vars: ExportVars): Promise<void> => {
      const { jobId } = await api<{ jobId: string }>('/export', {
        method: 'POST',
        body: JSON.stringify(vars.request),
      });
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, 400));
        const st = await api<ExportJobState>(`/export-jobs/${jobId}`);
        vars.onProgress?.(st);
        if (st.status === 'error') throw new Error(st.error ?? 'Export failed');
        if (st.status === 'done') break;
      }
      // The result can be a binary zip — raw fetch, not api() (JSON only).
      let res: Response;
      try {
        res = await fetch(`/api/v1/export-jobs/${jobId}/result`, {
          signal: AbortSignal.timeout(120_000),
        });
      } catch (err) {
        throw new ApiError(
          0,
          err instanceof DOMException && err.name === 'TimeoutError'
            ? 'Export download timed out'
            : 'Backend unreachable',
        );
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new ApiError(res.status, body?.error ?? `HTTP ${res.status}`);
      }

      if (vars.request.packaging === 'zip') {
        downloadBlob(await res.blob(), 'export.zip');
        return;
      }
      const body = (await res.json()) as ExportResponse;
      for (const file of body.files) {
        const bytes = Uint8Array.from(atob(file.contentBase64), (c) => c.charCodeAt(0));
        downloadBlob(
          new Blob([bytes], { type: 'application/json' }),
          file.name.split('/').pop() ?? file.name,
        );
      }
    },
  });
}

export function useRows(p: RowsQueryParams) {
  return useQuery({
    queryKey: ['rows', p],
    queryFn: () => api<RowsPage>(`/rows?${rowsQueryString(p)}`),
    enabled: p.project !== '' && p.component !== '',
    placeholderData: keepPreviousData,
    // Poll while the backend is still loading the component in the
    // background; stop once the page is complete.
    refetchInterval: (query) =>
      query.state.data?.complete === false ? 1000 : false,
  });
}

export function useHealth() {
  return useQuery({
    queryKey: ['health'],
    queryFn: () =>
      api<{
        mode: 'live' | 'mock';
        reviewWorkflow: boolean;
        rateBudget: { limit: number | null; remaining: number | null; reset: string | null };
        caches: Array<{ key: string; status: string; rows: number; lastRefreshAt: number }>;
      }>('/health'),
    refetchInterval: 10_000,
  });
}

export interface BulkStateVars {
  project: string;
  component: string;
  sort: SortKey;
  filter: string;
  q: string;
  hiddenLangs: string;
  ids: string;
  listId: string;
  selection: { all: boolean; keys: string[] };
  state: UnitState;
  /** Only patch cells currently in one of these states (e.g. "Edited"). */
  onlyStates?: UnitState[];
  languages: string[];
  onProgress?: (done: number, total: number) => void;
}

/** Outcome of a settled bulk job (returned by useBulkState). */
export interface BulkStateResult {
  done: number;
  total: number;
  failed: number;
  skipped: number;
  /** Cells in the selection but out of scope (missing, read-only, onlyStates mismatch). */
  notApplicable: number;
  firstError?: string;
}

/**
 * Bulk status change: starts a server job, polls until it settles.
 * Resolves with the job outcome — never with the rows themselves.
 */
export function useBulkState() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (vars: BulkStateVars): Promise<BulkStateResult> => {
      const { jobId } = await api<{ jobId: string }>('/bulk-state', {
        method: 'POST',
        body: JSON.stringify(vars),
      });
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, 400));
        const st = await api<{
          status: 'running' | 'done' | 'error';
          done: number;
          total: number;
          failed: number;
          skipped?: number;
          notApplicable?: number;
          firstError?: string;
          error?: string;
        }>(`/bulk-state/${jobId}`);
        vars.onProgress?.(st.done, st.total);
        if (st.status === 'done') {
          return {
            done: st.done,
            total: st.total,
            failed: st.failed,
            skipped: st.skipped ?? 0,
            notApplicable: st.notApplicable ?? 0,
            ...(st.firstError !== undefined ? { firstError: st.firstError } : {}),
          };
        }
        if (st.status === 'error') {
          throw new Error(st.error ?? 'Bulk update failed');
        }
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['rows'] });
    },
  });
}

export interface EditUnitVars {
  unitId: number;
  language: string;
  patch: { target?: string[]; state?: UnitState; explanation?: string };
}

/**
 * Optimistic edit: patch the cell in every cached rows page immediately,
 * roll back on error, and let the server truth win on success.
 */
export function useEditUnit() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (vars: EditUnitVars) =>
      api<UnitPatchResult>(`/units/${vars.unitId}`, {
        method: 'PATCH',
        body: JSON.stringify(vars.patch),
      }),

    onMutate: async (vars: EditUnitVars) => {
      await queryClient.cancelQueries({ queryKey: ['rows'] });

      const snapshots = queryClient
        .getQueriesData<RowsPage>({ queryKey: ['rows'] })
        .map(([key, data]) => ({ key, data }));

      const optimisticTime = new Date().toISOString();
      queryClient.setQueriesData<RowsPage>({ queryKey: ['rows'] }, (page) => {
        if (page === undefined) return page;
        const isSource = vars.language === page.sourceLanguage;
        return {
          ...page,
          rows: page.rows.map((row) => {
            if (isSource) {
              // Source edit: the source text lives in row metadata.
              if (row.sourceUnitId !== vars.unitId) return row;
              return {
                ...row,
                source: vars.patch.target ?? row.source,
                explanation: vars.patch.explanation ?? row.explanation,
                lastUpdated: optimisticTime,
              };
            }
            const cell = row.cells[vars.language];
            if (cell === undefined || cell.unitId !== vars.unitId) return row;
            return {
              ...row,
              lastUpdated: optimisticTime,
              cells: {
                ...row.cells,
                [vars.language]: {
                  ...cell,
                  target: vars.patch.target ?? cell.target,
                  state: vars.patch.state ?? cell.state,
                  lastUpdated: optimisticTime,
                },
              },
            };
          }),
        };
      });

      return { snapshots };
    },

    onError: (_err, _vars, ctx) => {
      for (const { key, data } of ctx?.snapshots ?? []) {
        queryClient.setQueryData(key, data);
      }
    },

    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['rows'] });
    },
  });
}