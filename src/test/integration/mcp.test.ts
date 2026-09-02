import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../server/app.js';
import { CacheRegistry } from '../../server/cache/cache-registry.js';
import { MockWeblateClient } from '../../server/weblate/mock/mock-client.js';

function makeApp() {
  const api = new MockWeblateClient();
  const registry = new CacheRegistry(api);
  return { app: createApp(api, registry) };
}

const AUTH = { Authorization: 'Token test-key' };

/** One JSON-RPC request against the MCP endpoint (stateless: no session). */
function rpc(
  agent: ReturnType<typeof request>,
  method: string,
  params: Record<string, unknown> | undefined,
  id: number,
) {
  const body: Record<string, unknown> = { jsonrpc: '2.0', id, method };
  if (params !== undefined) body.params = params;
  return agent
    .post('/mcp/v1')
    .set(AUTH)
    // The transport requires both content types, as MCP clients send them.
    .set('Accept', 'application/json, text/event-stream')
    .send(body)
    .expect(200)
    .then((res) => res.body as { result: Record<string, unknown> });
}

/** Parses a tool result's JSON text payload. */
function toolJson<T>(result: Record<string, unknown>): T {
  const content = result.content as Array<{ type: string; text: string }>;
  expect(content[0]!.type).toBe('text');
  return JSON.parse(content[0]!.text) as T;
}

interface CreatedItem {
  ok: boolean;
  context: string;
  translations?: Record<string, { unitId: number; state: number }>;
}

const isToolError = (result: Record<string, unknown>): boolean => result.isError === true;

describe('MCP authentication', () => {
  it('rejects requests without an API key', async () => {
    const { app } = makeApp();
    await request(app)
      .post('/mcp/v1')
      .send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
      .expect(401);
  });
});

describe('MCP protocol', () => {
  it('answers initialize with server info', async () => {
    const { app } = makeApp();
    const body = await rpc(
      request(app),
      'initialize',
      {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test-client', version: '1.0.0' },
      },
      1,
    );
    expect(body.result.serverInfo).toMatchObject({ name: 'weblate-friendly-bridge' });
    expect(typeof body.result.protocolVersion).toBe('string');
  });

  it('lists the five string-management tools', async () => {
    const { app } = makeApp();
    const body = await rpc(request(app), 'tools/list', {}, 2);
    const tools = body.result.tools as Array<{ name: string }>;
    expect(tools.map((t) => t.name).sort()).toEqual([
      'create_strings',
      'delete_translation',
      'list_components',
      'list_projects',
      'patch_translations',
    ]);
  });
});

describe('MCP tools', () => {
  it('lists projects and components', async () => {
    const { app } = makeApp();
    const agent = request(app);
    const projects = await rpc(agent, 'tools/call', { name: 'list_projects', arguments: {} }, 3);
    expect(
      toolJson<{ results: Array<{ slug: string }> }>(projects.result).results.map((p) => p.slug),
    ).toContain('friendly-suite');

    const components = await rpc(
      agent,
      'tools/call',
      { name: 'list_components', arguments: { project: 'friendly-suite' } },
      4,
    );
    expect(
      toolJson<{ results: Array<{ slug: string }> }>(components.result).results
        .map((c) => c.slug)
        .sort(),
    ).toEqual(['reports', 'web-ui']);
  });

  it('creates, patches and deletes a string end to end', async () => {
    const { app } = makeApp();
    const agent = request(app);
    let id = 10;
    const call = async (name: string, args: Record<string, unknown>) =>
      rpc(agent, 'tools/call', { name, arguments: args }, ++id).then(
        (res) => res.result as Record<string, unknown>,
      );

    // Create with an explicit context and a German translation.
    const created = await call('create_strings', {
      project: 'friendly-suite',
      component: 'web-ui',
      items: [{ context: 'ID90020', source: 'MCP string', translations: { de: 'MCP Zeichenkette' } }],
    });
    const item = toolJson<{ results: CreatedItem[] }>(created).results[0]!;
    expect(item).toMatchObject({
      ok: true,
      context: 'ID90020',
      translations: { de: { state: 10 } },
    });
    const deUnitId = item.translations!.de!.unitId;

    // Patch several languages; the same de unit is updated in place.
    const patched = await call('patch_translations', {
      project: 'friendly-suite',
      component: 'web-ui',
      context: 'ID90020',
      translations: {
        de: { target: 'Neuer Text', state: 20 },
        fr: { target: 'Texte nouveau', state: 10 },
      },
    });
    expect(
      toolJson<{ translations: Record<string, { unitId: number; state: number }> }>(
        patched,
      ).translations,
    ).toMatchObject({ de: { unitId: deUnitId, state: 20 } });

    // Source-language delete without all=true → error result.
    const guarded = await call('delete_translation', {
      project: 'friendly-suite',
      component: 'web-ui',
      context: 'ID90020',
      language: 'en',
    });
    expect(isToolError(guarded)).toBe(true);

    // Target-language delete without clear=true → error result.
    const notDeletable = await call('delete_translation', {
      project: 'friendly-suite',
      component: 'web-ui',
      context: 'ID90020',
      language: 'de',
    });
    expect(isToolError(notDeletable)).toBe(true);

    // clear=true empties the German translation (state 0).
    const cleared = await call('delete_translation', {
      project: 'friendly-suite',
      component: 'web-ui',
      context: 'ID90020',
      language: 'de',
      clear: true,
    });
    expect(toolJson<{ cleared: boolean; language: string }>(cleared)).toMatchObject({
      cleared: true,
      language: 'de',
    });

    // all=true&language=<source> removes the whole string.
    const deleted = await call('delete_translation', {
      project: 'friendly-suite',
      component: 'web-ui',
      context: 'ID90020',
      language: 'en',
      all: true,
    });
    expect(toolJson<{ deleted: boolean; wholeString: boolean }>(deleted)).toMatchObject({
      deleted: true,
      wholeString: true,
    });
  });

  it('surfaces unknown contexts as tool errors, not protocol errors', async () => {
    const { app } = makeApp();
    const body = await rpc(
      request(app),
      'tools/call',
      {
        name: 'patch_translations',
        arguments: {
          project: 'friendly-suite',
          component: 'web-ui',
          context: 'DOES_NOT_EXIST',
          translations: { de: { target: 'x' } },
        },
      },
      50,
    );
    expect(body.result.isError).toBe(true);
    expect((body.result.content as Array<{ text: string }>)[0]!.text).toContain('DOES_NOT_EXIST');
  });
});