/**
 * Export dialog: configures and triggers a translation export.
 * Two modes:
 * - Grid mode: scope is fixed to the current project/component.
 * - Multi mode (no project selected): pick any number of components across
 *   projects; the language choices are the union across them.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  EXPORT_FORMATS,
  EXPORT_FILE_NAMES,
  EXPORT_PACKAGINGS,
  fileNameForLanguage,
} from '../../shared/export.js';
import type {
  ExportFileName,
  ExportFormat,
  ExportGrouping,
  ExportPackaging,
  ExportRequest,
  ExportScopeItem,
} from '../../shared/export.js';
import type { WeblateProject } from '../../shared/weblate-dto.js';
import type { ExportProgress } from '../../shared/export.js';
import { api } from '../api/http.js';
import { useComponents, useExport } from '../api/queries.js';
import type { ComponentLanguage } from '../api/queries.js';
import { Spinner } from './ui.js';

export interface ExportDialogProps {
  projects?: WeblateProject[];
  /** Fixed scope (opened from the grid) — omit for multi-select mode. */
  scope?: ExportScopeItem;
  /** Languages offered in grid mode (from the loaded page). */
  languages?: ComponentLanguage[];
  onClose: () => void;
}

const GROUPING_LABELS: Record<ExportGrouping, string> = {
  'per-component': 'One file per project + component',
  merged: 'All components in one file per language',
};

/** One project row of the multi-select mode, with its component checkboxes. */
function ProjectScopeRow({
  project,
  selected,
  onToggle,
}: {
  project: WeblateProject;
  selected: Set<string>;
  onToggle: (project: string, component: string) => void;
}) {
  const components = useComponents(project.slug);
  return (
    <div className="flex flex-col gap-1">
      <label className="flex items-center gap-1.5 text-sm font-medium text-slate-700">
        <input
          type="checkbox"
          className="size-3.5 accent-sky-600"
          checked={selected.has(`${project.slug}/*`)}
          onChange={() => onToggle(project.slug, '*')}
        />
        {project.name}
      </label>
      {components.data !== undefined && selected.has(`${project.slug}/*`) && (
        <div className="ml-5 flex flex-col gap-1">
          {components.data.results.map((c) => (
            <label key={c.slug} className="flex items-center gap-1.5 text-sm text-slate-600">
              <input
                type="checkbox"
                className="size-3.5 accent-sky-600"
                checked={selected.has(`${project.slug}/${c.slug}`)}
                onChange={() => onToggle(project.slug, c.slug)}
              />
              {c.name}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

/** "3 of 4 languages" caption; an empty selection means all languages. */
function languageSummary(langSet: Set<string>, choices: ComponentLanguage[]): string {
  if (langSet.size === 0 || langSet.size === choices.length) return 'all languages';
  return `${langSet.size} of ${choices.length}`;
}

/**
 * Export progress while the server job runs (same styling as the grid's
 * ProgressBanner). Without unit totals from Weblate the bar stays
 * indeterminate and only the fetched count is shown.
 */
function ExportProgressBar({ progress }: { progress: ExportProgress }) {
  const { loaded, total, current } = progress;
  const pct = total > 0 ? Math.round((loaded / total) * 100) : 0;
  return (
    <div className="flex items-center gap-3 text-sm text-sky-700">
      <span className="truncate">
        Exporting {current || '…'}{' '}
        {total > 0 ? `— ${loaded}/${total} strings (${pct}%)` : `— ${loaded} strings`}
      </span>
      <div className="h-1.5 flex-1 rounded bg-sky-100 overflow-hidden">
        <div className="h-full bg-sky-500 transition-all" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function ExportDialog({ projects, scope, languages, onClose }: ExportDialogProps) {
  const [format, setFormat] = useState<ExportFormat>('i18next');
  const [fileName, setFileName] = useState<ExportFileName>('[language].json');
  const [grouping, setGrouping] = useState<ExportGrouping>('per-component');
  const [packaging, setPackaging] = useState<ExportPackaging>('zip');

  // Multi-select mode: 'project/*' marks a checked project.
  const [selectedPairs, setSelectedPairs] = useState<Set<string>>(new Set());
  // Grid-mode language selection (empty set = all languages).
  const [langSet, setLangSet] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (languages !== undefined) setLangSet(new Set(languages.map((l) => l.code)));
  }, [languages]);

  /** Resolved scope (multi-select mode): the checked component pairs. */
  const resolvedScope = useMemo<ExportScopeItem[]>(() => {
    if (scope !== undefined) return [scope];
    const pairs: ExportScopeItem[] = [];
    for (const pair of selectedPairs) {
      const [project, component] = pair.split('/');
      if (project === undefined || component === undefined || component === '*') continue;
      pairs.push({ project, component });
    }
    return pairs;
  }, [scope, selectedPairs]);

  // Union of languages across the resolved scope (multi-select mode).
  const [multiLangs, setMultiLangs] = useState<ComponentLanguage[]>([]);
  useEffect(() => {
    if (scope !== undefined) return;
    let cancelled = false;
    setMultiLangs([]);
    void Promise.all(
      resolvedScope.map((s) =>
        api<{ results: ComponentLanguage[] }>(
          `/languages?project=${encodeURIComponent(s.project)}&component=${encodeURIComponent(s.component)}`,
        ).catch(() => ({ results: [] as ComponentLanguage[] })),
      ),
    ).then((lists) => {
      if (cancelled) return;
      const byCode = new Map<string, ComponentLanguage>();
      for (const list of lists) {
        for (const lang of list.results) {
          if (!byCode.has(lang.code)) byCode.set(lang.code, lang);
        }
      }
      setMultiLangs([...byCode.values()]);
    });
    return () => {
      cancelled = true;
    };
  }, [scope, resolvedScope]);

  /** Language list offered to the user (grid languages or multi union). */
  const languageChoices = scope !== undefined ? (languages ?? []) : multiLangs;

  const togglePair = (project: string, component: string): void => {
    setSelectedPairs((prev) => {
      const next = new Set(prev);
      const key = `${project}/${component}`;
      if (component === '*') {
        // Unchecking a project clears it and its components.
        if (next.has(key)) {
          for (const pair of next) {
            if (pair.startsWith(`${project}/`)) next.delete(pair);
          }
        } else {
          next.add(key);
        }
      } else if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const exportJob = useExport();

  const handleExport = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setProgress(null);
    const request: ExportRequest = {
      scope: resolvedScope,
      // Empty selection = all languages (per the export contract).
      languages: langSet.size === 0 ? undefined : [...langSet],
      format,
      fileName,
      grouping,
      packaging,
    };
    try {
      await exportJob.mutateAsync({
        request,
        onProgress: setProgress,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Export failed');
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg shadow-xl w-full max-w-lg p-5 flex flex-col gap-3 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="font-semibold text-slate-800">Export translations</h2>
        <p className="text-xs text-slate-500">
          One file per language (e.g. {fileNameForLanguage(fileName, 'en')}) — untranslated
          strings export as empty values.
        </p>

        {scope !== undefined ? (
          <div className="text-sm text-slate-600">
            <span className="font-medium text-slate-800">{scope.project}</span>
            {' / '}
            <span className="font-medium text-slate-800">{scope.component}</span>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <span className="text-sm text-slate-600">Projects / components</span>
            <div className="border border-slate-200 rounded p-2 flex flex-col gap-2 max-h-48 overflow-y-auto">
              {(projects ?? []).map((project) => (
                <ProjectScopeRow
                  key={project.slug}
                  project={project}
                  selected={selectedPairs}
                  onToggle={togglePair}
                />
              ))}
            </div>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3 text-sm">
          <label className="flex flex-col gap-1 text-slate-600">
            Content format
            <select
              className="rounded border border-slate-300 px-2 py-1 bg-white"
              value={format}
              onChange={(e) => setFormat(e.target.value as ExportFormat)}
            >
              {EXPORT_FORMATS.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-slate-600">
            File name
            <select
              className="rounded border border-slate-300 px-2 py-1 bg-white"
              value={fileName}
              onChange={(e) => setFileName(e.target.value as ExportFileName)}
            >
              {EXPORT_FILE_NAMES.map((n) => (
                <option key={n} value={n}>
                  {fileNameForLanguage(n, 'en')}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-slate-600">
            Grouping
            <select
              className="rounded border border-slate-300 px-2 py-1 bg-white"
              value={grouping}
              onChange={(e) => setGrouping(e.target.value as ExportGrouping)}
            >
              {(Object.keys(GROUPING_LABELS) as ExportGrouping[]).map((g) => (
                <option key={g} value={g}>
                  {GROUPING_LABELS[g]}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-slate-600">
            Packaging
            <select
              className="rounded border border-slate-300 px-2 py-1 bg-white"
              value={packaging}
              onChange={(e) => setPackaging(e.target.value as ExportPackaging)}
            >
              {EXPORT_PACKAGINGS.map((p) => (
                <option key={p} value={p}>
                  {p === 'zip' ? 'ZIP archive' : 'JSON (base64 files)'}
                </option>
              ))}
            </select>
          </label>
        </div>

        <span className="text-sm text-slate-600">
          Languages ({languageSummary(langSet, languageChoices)})
        </span>
        <div className="border border-slate-200 rounded p-2 flex flex-col gap-1 max-h-40 overflow-y-auto">
          <div className="flex gap-1 pb-1 border-b border-slate-100">
            <button
              type="button"
              className="rounded px-1.5 py-0.5 text-xs bg-white border border-slate-300 hover:bg-slate-100"
              onClick={() => setLangSet(new Set(languageChoices.map((l) => l.code)))}
            >
              All
            </button>
            <button
              type="button"
              className="rounded px-1.5 py-0.5 text-xs bg-white border border-slate-300 hover:bg-slate-100"
              onClick={() => setLangSet(new Set())}
            >
              None (= all languages)
            </button>
          </div>
          {languageChoices.map((lang) => (
            <label
              key={lang.code}
              className="flex items-center gap-1.5 text-sm text-slate-600"
              title={lang.name}
            >
              <input
                type="checkbox"
                className="size-3.5 accent-sky-600"
                checked={langSet.has(lang.code)}
                onChange={() =>
                  setLangSet((prev) => {
                    const next = new Set(prev);
                    if (next.has(lang.code)) next.delete(lang.code);
                    else next.add(lang.code);
                    return next;
                  })
                }
              />
              {lang.code.toUpperCase()}
              {lang.isSource ? ' (source)' : ''}
            </label>
          ))}
          {languageChoices.length === 0 && (
            <span className="text-xs text-slate-400">
              Select components to list their languages.
            </span>
          )}
        </div>

        {busy && progress !== null && (
          <ExportProgressBar progress={progress} />
        )}
        {error !== null && <div className="text-sm text-red-600">{error}</div>}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            className="rounded border border-slate-300 px-3 py-1.5 text-sm bg-white hover:bg-slate-100"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            className="rounded bg-sky-600 px-3 py-1.5 text-sm text-white hover:bg-sky-700 disabled:opacity-40 flex items-center gap-2"
            disabled={busy || resolvedScope.length === 0}
            onClick={() => void handleExport()}
          >
            {busy && progress === null && <Spinner label="" />}
            Export
          </button>
        </div>
      </div>
    </div>
  );
}