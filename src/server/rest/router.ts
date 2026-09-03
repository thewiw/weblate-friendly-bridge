/**
 * External REST API (mounted under /api/rest) for creating, modifying and
 * deleting translation strings, authenticated by Weblate API keys
 * (see rest/auth.ts). Separate from /api/v1, which serves the UI with
 * browser sessions.
 *
 * The business logic lives in rest/operations.ts, shared with the MCP
 * server; these routes only do HTTP concerns (zod parsing, statuses).
 */
import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { exportRequestSchema, type ExportRequest } from '../../shared/export.js';
import { describeExportRequest, packageExport, runExport } from '../export/export-service.js';
import { createItemsSchema, createStrings, deleteTranslation, patchTranslations, translationsPatchSchema } from './operations.js';
import { openApiSpec } from './openapi.js';
import { UpstreamError } from '../http-errors.js';
import { config } from '../config.js';
import type { CacheRegistry } from '../cache/cache-registry.js';
import type { WeblateApi } from '../weblate/client.js';
import { createApiKeyAuth } from './auth.js';
import { logError, logInfo } from '../log.js';

const createSchema = z.object({ items: createItemsSchema });
const patchSchema = z.object({ translations: translationsPatchSchema });

export interface RestRouterOptions {
  registry: CacheRegistry;
  /** Shared client — used as-is in mock mode, ignored in live mode. */
  mockApi: WeblateApi;
}

export function createRestRouter(opts: RestRouterOptions) {
  const router = Router();

  // The API description itself is not sensitive and must load without a
  // key (the Swagger UI page at /openapi/ fetches it) — mounted before auth.
  // Only served when WFB_OPENAPI enables the docs (opt-in, see config.ts).
  // The `x-try-it-out` extension tells the docs page whether the "Try it
  // out" button is active (WFB_OPENAPI=with-try) — the page is static, so
  // this is the channel it reads the flag from.
  router.get('/openapi.json', (_req, res) => {
    if (!config.openapiUi) {
      res.status(404).json({ error: 'Not found (Swagger UI disabled — set WFB_OPENAPI=true to enable)' });
      return;
    }
    res.json({ ...openApiSpec, 'x-try-it-out': config.openapiTryIt });
  });

  const auth = createApiKeyAuth({
    weblateUrl: config.weblateUrl,
    mode: opts.mockApi.mode,
    mockApi: opts.mockApi,
    // Key-less /export requests may run under the server-wide key when
    // both WFB_WEBLATE_EXPORT_API_KEY and WFB_WEBLATE_EXPORT_ALLOWED_HOSTS are set.
    publicExport: {
      apiKey: config.weblateExportApiKey,
      allowedHosts: config.weblateExportAllowedHosts,
    },
  });
  router.use(auth);

  const restApi = (req: Request): WeblateApi => {
    if (req.restAuth === undefined) {
      throw new UpstreamError(401, 'Missing API key');
    }
    return req.restAuth.api;
  };

  /**
   * Client-facing error responses that bypass the app-level errorHandler
   * (which logs) are logged here, so every REST error is visible in the
   * console — same as timeouts/network failures are.
   */
  const logRestError = (req: Request, status: number, error: string): void => {

    logError(`[rest] ${req.method} ${req.originalUrl} → ${status}: ${error}`);
  };

  const handleError = (err: unknown, req: Request, res: Response, next: NextFunction): void => {
    if (err instanceof z.ZodError) {
      const message = err.issues[0]?.message ?? 'Bad request';
      logRestError(req, 400, message);
      res.status(400).json({ error: message });
      return;
    }
    next(err);
  };

  // ---- Listings ----

  router.get('/projects', async (req, res, next) => {
    try {
      res.json({ results: await restApi(req).listProjects() });
    } catch (err) {
      next(err);
    }
  });

  router.get('/projects/:project/components', async (req, res, next) => {
    try {
      res.json({ results: await restApi(req).listComponents(String(req.params.project)) });
    } catch (err) {
      next(err);
    }
  });

  // ---- Export (one file per language, i18next/ARB; zip or base64 JSON) ----

  router.post('/export', async (req: Request, res: Response, next: NextFunction) => {
    let params: ExportRequest;
    try {
      params = exportRequestSchema.parse(req.body);
    } catch (err) {
      handleError(err, req, res, next);
      return;
    }
    try {
      logInfo(`[rest] ${req.method} ${req.originalUrl} ← ${describeExportRequest(params)}`);
      const started = Date.now();
      const files = await runExport(restApi(req), params);
      const payload = await packageExport(files, params.packaging);
      logInfo(
        `[rest] ${req.method} ${req.originalUrl} → ${files.length} file(s) ` +
          `(${payload.kind}) in ${((Date.now() - started) / 1000).toFixed(1)}s`,
      );
      if (payload.kind === 'zip') {
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="${payload.fileName}"`);
        res.send(payload.data);
      } else {
        res.json({ files: payload.files });
      }
    } catch (err) {
      next(err);
    }
  });

  // ---- Create (batch) ----

  router.post(
    '/projects/:project/components/:component/translations',
    async (req: Request, res: Response, next: NextFunction) => {
      let body: z.infer<typeof createSchema>;
      try {
        body = createSchema.parse(req.body);
      } catch (err) {
        handleError(err, req, res, next);
        return;
      }

      try {
        const result = await createStrings(
          restApi(req),
          opts.registry,
          String(req.params.project),
          String(req.params.component),
          body.items,
        );
        res.json(result);
      } catch (err) {
        handleError(err, req, res, next);
      }
    },
  );

  // ---- Modify (several languages of one string) ----

  router.patch(
    '/projects/:project/components/:component/translations/:context',
    async (req: Request, res: Response, next: NextFunction) => {
      let body: z.infer<typeof patchSchema>;
      try {
        body = patchSchema.parse(req.body);
      } catch (err) {
        handleError(err, req, res, next);
        return;
      }

      try {
        const result = await patchTranslations(
          restApi(req),
          opts.registry,
          String(req.params.project),
          String(req.params.component),
          String(req.params.context),
          body.translations,
        );
        res.json(result);
      } catch (err) {
        handleError(err, req, res, next);
      }
    },
  );

  // ---- Delete (one language, or the whole context when no language is given) ----

  router.delete(
    '/projects/:project/components/:component/translations/:context',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const language =
          typeof req.query.language === 'string' ? req.query.language : undefined;
        const result = await deleteTranslation(
          restApi(req),
          opts.registry,
          String(req.params.project),
          String(req.params.component),
          String(req.params.context),
          {
            language,
            all: req.query.all === 'true',
            clear: req.query.clear === 'true',
          },
        );
        res.json(result);
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}