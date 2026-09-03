/**
 * Our own HTTP API (all under /api/v1), backed by the Weblate proxy and
 * the component cache registry.
 */
import { Router } from 'express';
import type { CookieOptions, Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import pLimit from 'p-limit';
import { z } from 'zod';
import { ROW_FILTERS, SORT_KEYS, type Cell } from '../shared/rows.js';
import { exportRequestSchema, type ExportRequest } from '../shared/export.js';
import { describeExportRequest, listComponentLanguages } from './export/export-service.js';
import { ExportJobStore } from './export/export-jobs.js';
import { UpstreamError } from './http-errors.js';
import { config } from './config.js';
import type { CacheRegistry } from './cache/cache-registry.js';
import { createSessionWeblateApi, type WeblateApi } from './weblate/client.js';
import { unitToCell } from './cache/row-model.js';
import { IdListStore, MAX_IDS_PER_LIST } from './id-lists.js';
import {
  LoginError,
  WeblateSessionStore,
  weblateLogin,
  weblateLoginTotp,
} from './auth/sessions.js';
import { logError, logInfo } from './log.js';

const UI_SESSION_COOKIE = 'wfu_sid';

const rowsQuerySchema = z.object({
  project: z.string().min(1),
  component: z.string().min(1),
  sort: z.enum(SORT_KEYS).default('created-desc'),
  filter: z.enum(ROW_FILTERS).default('all'),
  q: z.string().optional(),
  /** Comma-separated hidden language codes (filters use visible ones). */
  hiddenLangs: z.string().optional(),
  /** Inline, comma-separated context keys ('id-list' filter, small lists). */
  ids: z.string().optional(),
  /** Reference to an uploaded ID list (large lists; see /id-lists). */
  listId: z.string().optional(),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  refresh: z
    .string()
    .optional()
    .transform((v) => v === '1'),
});

const unitPatchSchema = z
  .object({
    target: z.array(z.string()).optional(),
    state: z
      .union([z.literal(0), z.literal(10), z.literal(20), z.literal(30)])
      .optional(),
    explanation: z.string().max(2000).optional(),
  })
  .refine((b) => b.target !== undefined || b.state !== undefined || b.explanation !== undefined, {
    message: 'Provide target, state and/or explanation',
  });

const unitStateSchema = z.union([z.literal(0), z.literal(10), z.literal(20), z.literal(30)]);

const bulkStateSchema = z.object({
  project: z.string().min(1),
  component: z.string().min(1),
  sort: z.enum(SORT_KEYS).default('created-desc'),
  filter: z.enum(ROW_FILTERS).default('all'),
  q: z.string().optional(),
  hiddenLangs: z.string().optional(),
  ids: z.string().optional(),
  listId: z.string().optional(),
  selection: z.object({
    all: z.boolean(),
    keys: z.array(z.string().min(1)).max(100_000),
  }),
  state: unitStateSchema,
  /** Only patch cells currently in one of these states (e.g. "Edited"). */
  onlyStates: z.array(unitStateSchema).optional(),
  /** Target languages to touch (the visible columns). */
  languages: z.array(z.string().min(1)).min(1),
});

interface BulkJob {
  status: 'running' | 'done' | 'error';
  done: number;
  failed: number;
  /** Cells left untouched (e.g. empty translations for content states). */
  skipped: number;
  /** Detail of the first failed patch, for surfacing the real reason. */
  firstError: string | null;
  total: number;
  error: string | null;
}

export interface AuthHooks {
  store: WeblateSessionStore;
}

export interface RouterOptions {
  /** Present in session-auth mode (no WFB_WEBLATE_API_KEY configured). */
  auth?: {
    store: WeblateSessionStore;
    /** Base URL of the Weblate instance (login target). */
    baseUrl: string;
  };
}

/** Converts our stored "a=1; b=2" cookie header back into a record. */
function parseCookieHeader(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of header.split(';')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    out[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return out;
}

function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (header === undefined) return undefined;
  for (const pair of header.split(';')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    if (pair.slice(0, eq).trim() === name) {
      return pair.slice(eq + 1).trim();
    }
  }
  return undefined;
}

const COOKIE_OPTS: CookieOptions = {
  httpOnly: true,
  sameSite: 'lax',
  path: '/',
  maxAge: 7 * 24 * 3600 * 1000,
};

export function createRouter(
  api: WeblateApi,
  registry: CacheRegistry,
  opts: RouterOptions = {},
): Router {
  const router = Router();

  /** The Weblate client for THIS request: the user's own session in
   *  session mode, the fixed token client otherwise. */
  const forRequest = (req: Request): WeblateApi => {
    if (opts.auth === undefined) return api;
    const session = opts.auth.store.getActive(readCookie(req, UI_SESSION_COOKIE));
    if (session === null) return api;
    return createSessionWeblateApi(
      opts.auth.baseUrl,
      session.cookies,
      session.csrfToken,
    );
  };

  // ---- Authentication (session mode) ----
  if (opts.auth !== undefined) {
    const { store, baseUrl } = opts.auth;

    // Everything except /auth/* requires a live session.
    router.use((req, res, next) => {
      if (req.path.startsWith('/auth/')) {
        next();
        return;
      }
      const session = store.getActive(readCookie(req, UI_SESSION_COOKIE));
      if (session === null) {
        res.status(401).json({ error: 'Not logged in' });
        return;
      }
      next();
    });

    router.post('/auth/login', async (req, res, next) => {
      try {
        const body = z
          .object({ username: z.string().min(1), password: z.string().min(1) })
          .parse(req.body);
        const outcome = await weblateLogin(baseUrl, body.username, body.password);
        if (outcome.status === 'totp_required') {
          // Password accepted; keep the partially-authenticated Weblate
          // session server-side and ask the user for the second factor.
          const uiSessionId = store.createPending(
            outcome.username,
            outcome.cookies,
            outcome.twofactorUrl,
            outcome.csrfToken,
          );
          res.cookie(UI_SESSION_COOKIE, uiSessionId, COOKIE_OPTS);
          res.json({ status: 'totp_required', username: outcome.username });
          return;
        }
        const uiSessionId = store.createActive(outcome.username, outcome.cookies, outcome.csrfToken);
        res.cookie(UI_SESSION_COOKIE, uiSessionId, COOKIE_OPTS);
        res.json({ status: 'ok', username: outcome.username });
      } catch (err) {
        if (err instanceof LoginError) {
          res.status(401).json({ error: err.message, invalidCredentials: err.invalidCredentials });
          return;
        }
        next(err);
      }
    });

    router.post('/auth/login/totp', async (req, res, next) => {
      try {
        const sid = readCookie(req, UI_SESSION_COOKIE);
        const session = store.get(sid);
        if (session === null || session.state !== 'pending' || session.twofactorUrl === undefined) {
          res.status(400).json({ error: 'No pending second factor — start the login again.' });
          return;
        }
        const body = z.object({ token: z.string().min(1) }).parse(req.body);
        const outcome = await weblateLoginTotp(
          baseUrl,
          parseCookieHeader(session.cookies),
          session.twofactorUrl,
          session.csrfToken,
          body.token,
        );
        store.activate(sid!, outcome.cookies, outcome.username, outcome.csrfToken);
        res.json({ status: 'ok', username: outcome.username });
      } catch (err) {
        if (err instanceof LoginError) {
          // Keep the pending session so the user can retry with a new code.
          res.status(401).json({ error: err.message, invalidCredentials: err.invalidCredentials });
          return;
        }
        next(err);
      }
    });

    router.post('/auth/logout', (req, res) => {
      const sid = readCookie(req, UI_SESSION_COOKIE);
      if (sid !== undefined) store.remove(sid);
      res.clearCookie(UI_SESSION_COOKIE, { path: '/' });
      res.json({ ok: true });
    });

    router.get('/auth/status', (req, res) => {
      const session = store.getActive(readCookie(req, UI_SESSION_COOKIE));
      res.json({
        authMode: 'session',
        authenticated: session !== null,
        username: session?.username ?? null,
      });
    });
  }

  router.get('/projects', async (req, res, next) => {
    try {
      res.json({ results: await forRequest(req).listProjects() });
    } catch (err) {
      next(err);
    }
  });

  router.get('/projects/:project/components', async (req, res, next) => {
    try {
      res.json({
        results: await forRequest(req).listComponents(req.params.project!),
      });
    } catch (err) {
      next(err);
    }
  });

  // ---- Export (languages of one or more components as i18next/ARB files) ----

  router.get('/languages', async (req, res, next) => {
    try {
      const body = z
        .object({ project: z.string().min(1), component: z.string().min(1) })
        .parse(req.query);
      res.json({
        results: await listComponentLanguages(forRequest(req), body.project, body.component),
      });
    } catch (err) {
      next(err);
    }
  });

  // Export runs as a background job: the POST returns a jobId at once and
  // the client polls /export-jobs/:jobId for progress, then downloads the
  // payload from /export-jobs/:jobId/result. (The REST/MCP export under
  // /api/rest/v1 stays synchronous — script consumers cannot poll a job.)
  const exportJobs = new ExportJobStore();

  router.post('/export', (req, res, next) => {
    let params: ExportRequest;
    try {
      params = exportRequestSchema.parse(req.body);
    } catch (err) {
      if (err instanceof z.ZodError) {
        res.status(400).json({ error: err.issues[0]?.message ?? 'Bad request' });
        return;
      }
      next(err);
      return;
    }
    // The per-request client is captured before the response is sent —
    // the job reads with the requesting user's credentials (session or key).
    const jobId = exportJobs.create();
    logInfo(`[export] job ${jobId} ← ${describeExportRequest(params)}`);
    exportJobs.start(jobId, forRequest(req), params);
    res.json({ jobId });
  });

  router.get('/export-jobs/:jobId', (req, res) => {
    const job = exportJobs.get(req.params.jobId!);
    if (job === undefined) {
      res.status(404).json({ error: 'Unknown export job' });
      return;
    }
    res.json({
      status: job.status,
      loaded: job.loaded,
      total: job.total,
      current: job.current,
      ...(job.error !== null ? { error: job.error } : {}),
    });
  });

  router.get('/export-jobs/:jobId/result', (req, res) => {
    const job = exportJobs.get(req.params.jobId!);
    if (job === undefined) {
      res.status(404).json({ error: 'Unknown export job' });
      return;
    }
    if (job.status === 'error') {
      res.status(409).json({ error: job.error ?? 'Export failed' });
      return;
    }
    if (job.status !== 'done' || job.result === null) {
      res.status(409).json({ error: 'Export not finished yet' });
      return;
    }
    const payload = job.result;
    if (payload.kind === 'zip') {
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${payload.fileName}"`);
      res.send(payload.data);
    } else {
      res.json({ files: payload.files });
    }
  });

  // ---- ID lists (large 'id-list' filters) ----
  // Clients upload lists too big for the URL once and reference them by id.
  const idLists = new IdListStore();

  router.post('/id-lists', (req, res) => {
    try {
      const body = z
        .object({
          keys: z
            .array(z.string().min(1).max(200).regex(/^[^\s,;]+$/))
            .max(MAX_IDS_PER_LIST),
        })
        .parse(req.body);
      res.json(idLists.create(body.keys));
    } catch (err) {
      if (err instanceof z.ZodError) {
        res.status(400).json({ error: err.issues[0]?.message ?? 'Bad body' });
        return;
      }
      throw err;
    }
  });

  /** 'id-list' keys: uploaded list (by id) or inline comma-separated. */
  const resolveContextKeys = (query: { listId?: string; ids?: string }): Set<string> => {
    let keys: string[] = [];
    if (query.listId !== undefined) keys = idLists.get(query.listId) ?? [];
    else if (query.ids !== undefined) keys = query.ids.split(',');
    return new Set(keys.map((k) => k.trim()).filter((k) => k !== ''));
  };

  router.get('/rows', async (req, res, next) => {
    try {
      const query = rowsQuerySchema.parse(req.query);
      const contextSet = resolveContextKeys(query);
      const cache = registry.get(query.project, query.component, forRequest(req));
      const page = cache.getRowsPage(
        {
          sort: query.sort,
          filter: query.filter,
          search: query.q,
          hiddenLangs: query.hiddenLangs,
          contextSet,
          offset: query.offset,
          limit: query.limit,
        },
        { refresh: query.refresh },
      );
      res.json(page);
    } catch (err) {
      if (err instanceof z.ZodError) {
        res.status(400).json({ error: err.issues[0]?.message ?? 'Bad query' });
        return;
      }
      next(err);
    }
  });

  router.patch('/units/:unitId', async (req, res, next) => {
    try {
      const unitId = z.coerce.number().int().parse(req.params.unitId);
      const body = unitPatchSchema.parse(req.body);

      // Weblate's PATCH response is partial (target/state only — no
      // content_hash or timestamps), so re-fetch the full unit to patch
      // the cache with authoritative data. The edit is made with the
      // requesting user's session so Weblate attributes it correctly.
      const reqApi = forRequest(req);
      await reqApi.patchUnit(unitId, body);
      const unit = await reqApi.getUnit(unitId);

      const cache = registry.findByUnitId(unitId);
      if (cache !== null) {
        const applied = cache.applyUnitUpdate(unit);
        if (applied !== null) {
          // Source edits change what Weblate's check engine says about
          // every translation (failing checks etc.). The PATCH is already
          // confirmed (the two awaits above), so unblock the client now;
          // Weblate's recompute runs in its own background task with
          // unpredictable latency, so re-read the row's units on a
          // bounded retry schedule instead of once. The client re-
          // invalidates its rows on a matching schedule to pick flags up.
          if (applied.cell.language === cache.sourceLanguage) {
            for (const delayMs of [1_250, 8_000, 20_000]) {
              void cache
                .refreshRowUnits(applied.rowKey, { delayMs })
                .catch(() => {
                  // Swallow: stale flags converge via the delta refresh.
                });
            }
          }
          res.json({ unit: applied.cell, rowKey: applied.rowKey });
          return;
        }
      }

      // Unit not in any cache (edited before its component was viewed):
      // still report success, deriving the language from the unit's URL.
      const parts = unit.translation.split('/').filter(Boolean);
      const language = parts[parts.length - 1] ?? '';
      res.json({ unit: unitToCell(unit, language), rowKey: unit.content_hash });
    } catch (err) {
      if (err instanceof z.ZodError) {
        res.status(400).json({ error: err.issues[0]?.message ?? 'Bad body' });
        return;
      }
      next(err);
    }
  });

  // ---- Bulk tools ----
  // Apply a translation state to every cell of the selected rows in the
  // requested languages. Long-running: starts a job, the client polls
  // /bulk-state/:jobId for progress.
  const bulkJobs = new Map<string, BulkJob>();

  router.post('/bulk-state', (req, res, next) => {
    try {
      const body = bulkStateSchema.parse(req.body);
      const cache = registry.get(body.project, body.component, forRequest(req));
      const rows = cache.filteredRows({
        sort: body.sort,
        filter: body.filter,
        search: body.q,
        hiddenLangs: body.hiddenLangs,
        contextSet: resolveContextKeys(body),
      });
      const keySet = new Set(body.selection.keys);
      const selected = body.selection.all
        ? rows.filter((r) => !keySet.has(r.key))
        : rows.filter((r) => keySet.has(r.key));

      const languages = new Set(body.languages);
      const targets: Array<{ unitId: number; target: string[]; cell: Cell }> = [];
      let skipped = 0;
      for (const row of selected) {
        for (const lang of languages) {
          const cell = row.cells[lang];
          if (cell === undefined || cell.state === 100) continue; // read-only
          if (cell.state === body.state) continue; // no-op
          if (body.onlyStates !== undefined && !body.onlyStates.includes(cell.state)) continue;
          // Weblate rejects state 10/20/30 with an empty target (a
          // translated string must have content) — leave empty
          // translations untouched instead of failing them one by one.
          if (body.state !== 0 && cell.target.every((t) => t.trim() === '')) {
            skipped++;
            continue;
          }
          // Weblate also rejects the untranslated state with a non-empty
          // target ("Can not use empty state with non empty target") —
          // marking a line untranslated means clearing its text.
          const target =
            body.state === 0
              ? cell.target.length > 0
                ? cell.target.map(() => '')
                : ['']
              : cell.target;
          targets.push({ unitId: cell.unitId, target, cell });
        }
      }

      const reqApi = forRequest(req);
      const budget = reqApi.getRateBudget();
      if (budget.remaining !== null && budget.remaining < targets.length) {
        res.status(429).json({
          error: `Rate budget too low: ${budget.remaining} requests left, ${targets.length} needed.`,
        });
        return;
      }

      while (bulkJobs.size >= 50) {
        const oldest = bulkJobs.keys().next().value;
        if (oldest === undefined) break;
        bulkJobs.delete(oldest);
      }
      const job: BulkJob = {
        status: 'running',
        done: 0,
        failed: 0,
        skipped,
        firstError: null,
        total: targets.length,
        error: null,
      };
      const jobId = randomUUID();
      bulkJobs.set(jobId, job);

      const state = body.state;
      const stamp = new Date().toISOString();
      // The client is unblocked immediately; this runs in the background.
      // Patches use the requesting user's session (attribution) — a
      // session expiring mid-job surfaces as per-unit failures.
      void (async () => {
        const limit = pLimit(config.concurrency);
        await Promise.all(
          targets.map((t) =>
            limit(async () => {
              try {
                // Weblate's PATCH requires target AND state.
                await reqApi.patchUnit(t.unitId, { target: t.target, state });
                t.cell.state = state;
                t.cell.target = t.target; // 'Untranslated' clears the text
                t.cell.lastUpdated = stamp;
                job.done++;
              } catch (err) {
                if (job.firstError === null) {
                  job.firstError = err instanceof Error ? err.message : String(err);
                }
                job.failed++;
              }
            }),
          ),
        );
        job.status = 'done';
      })().catch((err: unknown) => {
        job.status = 'error';
        job.error = err instanceof Error ? err.message : String(err);
      });

      res.json({ jobId, total: targets.length });
    } catch (err) {
      if (err instanceof z.ZodError) {
        res.status(400).json({ error: err.issues[0]?.message ?? 'Bad body' });
        return;
      }
      next(err);
    }
  });

  router.get('/bulk-state/:jobId', (req, res) => {
    const job = bulkJobs.get(req.params.jobId!);
    if (job === undefined) {
      res.status(404).json({ error: 'Unknown bulk job' });
      return;
    }
    res.json({
      status: job.status,
      done: job.done,
      total: job.total,
      failed: job.failed,
      skipped: job.skipped,
      ...(job.firstError !== null ? { firstError: job.firstError } : {}),
      ...(job.error !== null ? { error: job.error } : {}),
    });
  });

  router.get('/health', (req, res) => {
    const session =
      opts.auth !== undefined
        ? opts.auth.store.get(readCookie(req, UI_SESSION_COOKIE))
        : null;
    res.json({
      mode: api.mode,
      authMode: opts.auth !== undefined ? 'session' : config.authMode,
      authenticated:
        opts.auth === undefined ? true : session !== null,
      username: session?.username ?? null,
      reviewWorkflow: config.reviewWorkflow,
      rateBudget: api.getRateBudget(),
      caches: registry.stats(),
    });
  });

  return router;
}

/** Express error handler — maps UpstreamError to status codes. */
export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  // Log everything unexpected so 500s are diagnosable from the console.
  logError(
    `[${req.method} ${req.originalUrl}]`,
    err instanceof Error ? `${err.message}\n${err.stack}` : err,
  );
  if (err instanceof UpstreamError) {
    res
      .status(err.status)
      .json({ error: err.message, retryAfter: err.retryAfterSeconds });
    // Auth failures get the origin IP in the log line.
    if (err.status === 401 || err.status === 403) {
      logError(`[${req.method} ${req.originalUrl}] → ${err.status} from ${req.ip ?? '(unknown IP)'}`);
    }
    return;
  }
  // body-parser failures (express.json) carry an HTTP status themselves —
  // e.g. a malformed JSON body answers 400 with the parser's position, not
  // a 500 "Internal error".
  const status = (err as { status?: unknown }).status;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    const message = err instanceof Error ? err.message : 'Malformed request';
    res.status(status).json({ error: `Malformed request body: ${message}` });
    return;
  }
  res.status(500).json({ error: 'Internal error' });
}