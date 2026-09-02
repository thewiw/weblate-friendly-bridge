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
import { packageExport, runExport } from '../export/export-service.js';
import { createItemsSchema, createStrings, deleteTranslation, patchTranslations, translationsPatchSchema } from './operations.js';
import { UpstreamError } from '../http-errors.js';
import { config } from '../config.js';
import type { CacheRegistry } from '../cache/cache-registry.js';
import type { WeblateApi } from '../weblate/client.js';
import { createApiKeyAuth } from './auth.js';

const createSchema = z.object({ items: createItemsSchema });
const patchSchema = z.object({ translations: translationsPatchSchema });

export interface RestRouterOptions {
  registry: CacheRegistry;
  /** Shared client — used as-is in mock mode, ignored in live mode. */
  mockApi: WeblateApi;
}

export function createRestRouter(opts: RestRouterOptions) {
  const router = Router();

  const auth = createApiKeyAuth({
    weblateUrl: config.weblateUrl,
    mode: opts.mockApi.mode,
    mockApi: opts.mockApi,
    // Key-less /export requests may run under the server-wide key when
    // both WEBLATE_API_KEY and WEBLATE_API_ALLOWED_HOSTS are set.
    publicExport: {
      apiKey: config.weblateApiKey,
      allowedHosts: config.weblateApiAllowedHosts,
    },
  });
  router.use(auth);

  const restApi = (req: Request): WeblateApi => {
    if (req.restAuth === undefined) {
      throw new UpstreamError(401, 'Missing API key');
    }
    return req.restAuth.api;
  };

  const handleError = (err: unknown, res: Response, next: NextFunction): void => {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: err.issues[0]?.message ?? 'Bad request' });
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
      handleError(err, res, next);
      return;
    }
    try {
      const files = await runExport(restApi(req), params);
      const payload = await packageExport(files, params.packaging);
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
        handleError(err, res, next);
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
        handleError(err, res, next);
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
        handleError(err, res, next);
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
        handleError(err, res, next);
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