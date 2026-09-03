/**
 * Export contract between server and clients (UI + REST API): request
 * parameters, response shape, and the zod schema validating requests.
 *
 * An export produces one file per (grouping, language) from the selected
 * project/component pairs:
 * - grouping 'per-component': one file per project+component+language
 * - grouping 'merged':       one file per language, all components combined
 * 'packaging' chooses the delivery: a zip archive, or a JSON response whose
 * files carry their name and base64-encoded content.
 */
import { z } from 'zod';

export const EXPORT_FORMATS = ['i18next', 'arb'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export const EXPORT_FILE_NAMES = ['[language].json', 'i18n.[language]', 'i18n.[LANGUAGE]'] as const;
export type ExportFileName = (typeof EXPORT_FILE_NAMES)[number];

export const EXPORT_GROUPINGS = ['per-component', 'merged'] as const;
export type ExportGrouping = (typeof EXPORT_GROUPINGS)[number];

export const EXPORT_PACKAGINGS = ['zip', 'json'] as const;
export type ExportPackaging = (typeof EXPORT_PACKAGINGS)[number];

/** One project/component pair to export. */
export interface ExportScopeItem {
  project: string;
  component: string;
}

export interface ExportRequest {
  scope: ExportScopeItem[];
  /** Languages to export; omitted/empty = all languages of each component. */
  languages?: string[];
  format: ExportFormat;
  /** File-name pattern; `[language]` is replaced by the language code. */
  fileName: ExportFileName;
  grouping: ExportGrouping;
  packaging: ExportPackaging;
}

/** One exported file (packaging 'json'); content is base64 (utf-8). */
export interface ExportFile {
  name: string;
  contentBase64: string;
}

/** Response of POST .../export with packaging 'json'. */
export interface ExportResponse {
  files: ExportFile[];
}

/**
 * Progress of a background export job (session UI route): the server runs
 * the export asynchronously, the client polls for this state and fetches
 * the result once status is 'done'.
 */
export interface ExportProgress {
  /** Units fetched so far. */
  loaded: number;
  /** Units expected (0 = unknown — the UI shows an indeterminate progress). */
  total: number;
  /** What is being exported right now, e.g. "project/component/de". */
  current: string;
}

export interface ExportJobState extends ExportProgress {
  status: 'running' | 'done' | 'error';
  error: string | null;
}

export const exportRequestSchema = z.object({
  scope: z
    .array(
      z.object({
        project: z.string().min(1),
        component: z.string().min(1),
      }),
    )
    .min(1)
    .max(100),
  languages: z.array(z.string().min(1)).optional(),
  format: z.enum(EXPORT_FORMATS),
  fileName: z.enum(EXPORT_FILE_NAMES),
  grouping: z.enum(EXPORT_GROUPINGS),
  packaging: z.enum(EXPORT_PACKAGINGS),
});

/**
 * Replaces `[language]` with the language code (e.g. `en.json`, `i18n.en`)
 * and `[LANGUAGE]` with the uppercased code (e.g. `i18n.EN`).
 */
export function fileNameForLanguage(pattern: ExportFileName, language: string): string {
  return pattern.replace('[LANGUAGE]', language.toUpperCase()).replace('[language]', language);
}