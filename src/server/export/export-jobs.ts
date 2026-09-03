/**
 * Background export jobs for the session UI route: POST /export validates
 * the request, starts the export in the background and returns a jobId at
 * once; the client polls GET /export-jobs/:jobId for progress and fetches
 * the finished payload from GET /export-jobs/:jobId/result.
 *
 * Mirrors the bulk-state job pattern in routes.ts (job map, cap, background
 * runner), but as a class so it can be unit-tested. Jobs are in-memory and
 * die with the process — same trade-off as the rest of the caches.
 */
import { randomUUID } from 'node:crypto';
import type { ExportProgress, ExportJobState, ExportRequest } from '../../shared/export.js';
import type { WeblateApi } from '../weblate/client.js';
import { packageExport, runExport, type ExportPayload } from './export-service.js';
import { logError, logInfo } from '../log.js';

/** A job as stored: the polled state plus the delivery payload once done. */
export interface ExportJob extends ExportJobState {
  result: ExportPayload | null;
  /** When the job reached 'done' or 'error' (TTL eviction of old payloads). */
  finishedAt: number | null;
}

const MAX_JOBS = 20;
/** Finished jobs (holding their payload) are dropped this long after completion. */
const FINISHED_TTL_MS = 10 * 60_000;

export class ExportJobStore {
  private readonly jobs = new Map<string, ExportJob>();

  create(): string {
    while (this.jobs.size >= MAX_JOBS) {
      this.evictOldest();
    }
    this.pruneFinished();
    const jobId = randomUUID();
    this.jobs.set(jobId, {
      status: 'running',
      loaded: 0,
      total: 0,
      current: '',
      error: null,
      result: null,
      finishedAt: null,
    });
    return jobId;
  }

  get(jobId: string): ExportJob | undefined {
    this.pruneFinished();
    return this.jobs.get(jobId);
  }

  /**
   * Runs the export in the background with the given (per-request) Weblate
   * client — credentials follow the caller, like bulk-state patches do.
   * Progress updates land on the job record; the payload is packaged once
   * all files exist. Never throws: failures become status 'error'.
   */
  start(jobId: string, api: WeblateApi, params: ExportRequest): void {
    const job = this.jobs.get(jobId);
    if (job === undefined) return;
    const onProgress = (p: ExportProgress): void => {
      job.loaded = p.loaded;
      job.total = p.total;
      job.current = p.current;
    };
    void (async () => {
      const started = Date.now();
      const files = await runExport(api, params, onProgress);
      job.result = await packageExport(files, params.packaging);
      job.status = 'done';
      job.finishedAt = Date.now();
      logInfo(
        `[export] job ${jobId} → done: ${files.length} file(s) ` +
          `(${job.result.kind}) in ${((Date.now() - started) / 1000).toFixed(1)}s`,
      );
    })().catch((err: unknown) => {
      job.status = 'error';
      job.error = err instanceof Error ? err.message : String(err);
      job.finishedAt = Date.now();
      logError(`[export] job ${jobId} → failed: ${job.error}`);
    });
  }

  /** Drops the oldest job when at capacity. */
  private evictOldest(): void {
    const oldest = this.jobs.keys().next().value;
    if (oldest !== undefined) this.jobs.delete(oldest);
  }

  /** Drops finished jobs past the TTL (their payloads are the memory concern). */
  private pruneFinished(): void {
    const now = Date.now();
    for (const [id, job] of this.jobs) {
      if (job.finishedAt !== null && now - job.finishedAt > FINISHED_TTL_MS) {
        this.jobs.delete(id);
      }
    }
  }
}