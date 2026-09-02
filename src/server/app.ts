import express from 'express';
import { CacheRegistry } from './cache/cache-registry.js';
import type { WeblateApi } from './weblate/client.js';
import { createRouter, errorHandler, type RouterOptions } from './routes.js';
import { createRestRouter } from './rest/router.js';
import { createMcpRouter } from './mcp/server.js';

export function createApp(
  api: WeblateApi,
  registry: CacheRegistry,
  opts: RouterOptions = {},
) {
  const app = express();
  // Large ID lists (POST /id-lists) can reach ~1MB for 100k ids.
  app.use(express.json({ limit: '5mb' }));
  // External REST API (Weblate API-key auth), separate from the UI API.
  app.use('/api/rest/v1', createRestRouter({ registry, mockApi: api }));
  // MCP server over streamable HTTP: the REST operations as MCP tools.
  app.use('/mcp/v1', createMcpRouter({ registry, mockApi: api }));
  app.use('/api/v1', createRouter(api, registry, opts));
  app.use(errorHandler);
  return app;
}