/**
 * MCP (Model Context Protocol) server over streamable HTTP, mounted at
 * /mcp/v1. Exposes the same operations as the external REST API
 * (rest/router.ts) as MCP tools, authenticated the same way (Weblate API
 * key; permissions follow the key) and backed by the same shared
 * operations (rest/operations.ts).
 *
 * Stateless mode: every request gets its own McpServer + transport
 * (no session tracking), answering with plain JSON responses (no SSE).
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import {
  createItemsSchema,
  createStrings,
  deleteTranslation,
  patchTranslations,
  translationsPatchSchema,
} from '../rest/operations.js';
import { UpstreamError } from '../http-errors.js';
import { config } from '../config.js';
import type { CacheRegistry } from '../cache/cache-registry.js';
import type { WeblateApi } from '../weblate/client.js';
import { createApiKeyAuth } from '../rest/auth.js';

const SERVER_INFO = { name: 'weblate-friendly-bridge', version: '0.1.0' } as const;

/** State codes accepted by patch_translations (Weblate unit states). */
const STATE_CODES =
  '0 = untranslated (target must be empty), 10 = needs editing, 20 = translated, 30 = approved (only with review workflow)';

export interface McpRouterOptions {
  registry: CacheRegistry;
  /** Shared client — used as-is in mock mode, ignored in live mode. */
  mockApi: WeblateApi;
}

/**
 * Builds one stateless MCP server instance with the string-management
 * tools registered. Called per request so the tool callbacks can close
 * over that request's Weblate client (permissions follow its API key).
 */
function buildServer(api: WeblateApi, registry: CacheRegistry): McpServer {
  const server = new McpServer(SERVER_INFO, { capabilities: { tools: {} } });

  /** Uniform tool result: the operation result as JSON text. */
  const ok = (result: unknown) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
  });

  /** Expected failures (bad context, Weblate rejection) → tool error, not protocol error. */
  const fail = (err: unknown) => {
    const message =
      err instanceof UpstreamError
        ? err.message
        : 'Internal error: ' + (err instanceof Error ? err.message : String(err));
    if (!(err instanceof UpstreamError)) {
      // eslint-disable-next-line no-console
      console.error('[mcp]', err instanceof Error ? `${err.message}\n${err.stack}` : err);
    }
    return { content: [{ type: 'text' as const, text: message }], isError: true as const };
  };

  /** Runs one tool operation: result → JSON text, thrown error → isError result. */
  const call = async (fn: () => Promise<unknown>) => {
    try {
      return ok(await fn());
    } catch (err) {
      return fail(err);
    }
  };

  const project = z.string().min(1).describe('Project slug');
  const component = z.string().min(1).describe('Component slug');
  const context = z
    .string()
    .min(1)
    .describe('Context key of the string (as listed by list tools / the UI)');

  server.registerTool(
    'list_projects',
    {
      title: 'List projects',
      description: 'Lists the Weblate projects accessible with the current API key.',
    },
    async () =>
      call(async () => ({ results: await api.listProjects() })),
  );

  server.registerTool(
    'list_components',
    {
      title: 'List components',
      description: 'Lists the components of one project (with their source language).',
      inputSchema: { project },
    },
    async ({ project: p }) => call(async () => ({ results: await api.listComponents(p) })),
  );

  server.registerTool(
    'create_strings',
    {
      title: 'Create strings',
      description:
        'Batch-creates translation strings (max 100 per call). Each item needs source text; ' +
        'the context key is generated when omitted. Provided translations are set to state 10 ' +
        '(needs editing). Returns per-item results (ok/error with the resolved context).',
      inputSchema: {
        project,
        component,
        items: createItemsSchema.describe(
          'Strings to create: { context?, source, translations? } — texts are strings, ' +
            'or arrays of plural forms',
        ),
      },
    },
    async ({ project: p, component: c, items }) =>
      call(() => createStrings(api, registry, p, c, items)),
  );

  server.registerTool(
    'patch_translations',
    {
      title: 'Patch translations',
      description:
        'Sets several languages of one string at once. Each language gets target text and an ' +
        `optional state (${STATE_CODES}; default 20). Rules: state 0 requires an empty target, ` +
        'states 20+ require content. Unknown context → error result.',
      inputSchema: {
        project,
        component,
        context,
        translations: translationsPatchSchema.describe(
          'Per-language changes: { "de": { target, state? }, … }',
        ),
      },
    },
    async ({ project: p, component: c, context: ctx, translations }) =>
      call(() => patchTranslations(api, registry, p, c, ctx, translations)),
  );

  server.registerTool(
    'delete_translation',
    {
      title: 'Delete translation',
      description:
        'Deletes one string or one of its translations. No language → deletes the whole string ' +
        '(every language). language=<source> requires all=true (removes the whole string). ' +
        'For a single target language Weblate only allows clearing (empty target + state 0): ' +
        'pass clear=true.',
      inputSchema: {
        project,
        component,
        context,
        language: z.string().optional().describe('Language code; omit to delete the whole string'),
        all: z.boolean().optional().describe('Required with language=<source> to delete the whole string'),
        clear: z.boolean().optional().describe('For a target language: empty the translation instead of erroring'),
      },
    },
    async ({ project: p, component: c, context: ctx, language, all, clear }) =>
      call(() => deleteTranslation(api, registry, p, c, ctx, { language, all, clear })),
  );

  return server;
}

export function createMcpRouter(opts: McpRouterOptions): Router {
  const router = Router();

  // Same API-key auth as the REST API (401 answered before transport work).
  router.use(
    createApiKeyAuth({
      weblateUrl: config.weblateUrl,
      mode: opts.mockApi.mode,
      mockApi: opts.mockApi,
    }),
  );

  router.post('/', async (req: Request, res: Response) => {
    if (req.restAuth === undefined) {
      res.status(401).json({ error: 'Missing API key' });
      return;
    }
    // Stateless: one server + transport per request, JSON responses only.
    const server = buildServer(req.restAuth.api, opts.registry);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  // JSON-response mode offers no SSE stream and no sessions to terminate.
  const methodNotAllowed = (_req: Request, res: Response): void => {
    res.status(405).json({ error: 'Method not allowed (JSON-response MCP server: POST only)' });
  };
  router.get('/', methodNotAllowed);
  router.delete('/', methodNotAllowed);

  return router;
}