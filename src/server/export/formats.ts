/**
 * Pure file-content builders for the export feature — one function per
 * format, mapping key/value entries to the serialized file content.
 * Extensible: add a case per new format (see EXPORT_FORMATS).
 */
import type { ExportFormat } from '../../shared/export.js';

/** One translated string of a file. */
export interface ExportEntry {
  key: string;
  value: string;
}

/** Serialized content of one export file (pretty-printed, trailing newline). */
export function buildFileContent(
  entries: readonly ExportEntry[],
  language: string,
  format: ExportFormat,
): string {
  switch (format) {
    case 'i18next':
      // Flat resources: { "<key>": "<value>" } — keys are context keys
      // (or source text for key-less components).
      return JSON.stringify(Object.fromEntries(entries.map((e) => [e.key, e.value])), null, 2) + '\n';
    case 'arb':
      // Application Resource Bundle: @@locale marker first, then the pairs.
      // (Plural targets are exported as suffixed keys — see export-service.)
      return (
        JSON.stringify(
          { '@@locale': language, ...Object.fromEntries(entries.map((e) => [e.key, e.value])) },
          null,
          2,
        ) + '\n'
      );
  }
}