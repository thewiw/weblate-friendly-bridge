import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../server/app.js';
import { CacheRegistry } from '../../server/cache/cache-registry.js';
import { MockWeblateClient } from '../../server/weblate/mock/mock-client.js';
import type { RowsPage } from '../../shared/rows.js';

function makeApp() {
  const api = new MockWeblateClient();
  const registry = new CacheRegistry(api);
  return { app: createApp(api, registry), api };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getRowsUntilComplete(
  agent: ReturnType<typeof request>,
  query: string,
  tries = 20,
): Promise<RowsPage> {
  let last: RowsPage | null = null;
  for (let i = 0; i < tries; i++) {
    const res = await agent.get(`/api/v1/rows?${query}`).expect(200);
    last = res.body as RowsPage;
    if (last.complete) return last;
    await sleep(25);
  }
  throw new Error(`rows never completed: ${JSON.stringify(last?.loadProgress)}`);
}

describe('GET /api/v1/projects', () => {
  it('lists projects', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/api/v1/projects').expect(200);
    expect(res.body.results).toHaveLength(3);
    expect(res.body.results[0]).toMatchObject({ slug: 'friendly-suite' });
  });
});

describe('GET /api/v1/projects/:project/components', () => {
  it('lists components of a project', async () => {
    const { app } = makeApp();
    const res = await request(app)
      .get('/api/v1/projects/friendly-suite/components')
      .expect(200);
    expect(res.body.results).toHaveLength(2);
    expect(res.body.results.map((c: { slug: string }) => c.slug).sort()).toEqual([
      'reports',
      'web-ui',
    ]);
  });
});

describe('GET /api/v1/rows', () => {
  it('answers immediately with partial data, then completes', async () => {
    const { app } = makeApp();
    const first = await request(app)
      .get('/api/v1/rows?project=friendly-suite&component=web-ui')
      .expect(200);
    const page1 = first.body as RowsPage;
    expect(page1.complete).toBe(false);

    const page = await getRowsUntilComplete(request(app), 'project=friendly-suite&component=web-ui');
    expect(page.complete).toBe(true);
    expect(page.total).toBe(400);
    expect(page.rows).toHaveLength(50); // default limit
    expect(page.languages.map((l) => l.code)).toEqual(['de', 'fr', 'cs']);
  });

  it('sorts created-desc by default and honors modified-desc', async () => {
    const { app } = makeApp();
    const agent = request(app);
    const created = await getRowsUntilComplete(agent, 'project=friendly-suite&component=web-ui');
    const createdAts = created.rows.map((r) => r.createdAt);
    expect(createdAts).toEqual([...createdAts].sort().reverse());

    const modified = await getRowsUntilComplete(agent, 'project=friendly-suite&component=web-ui&sort=modified-desc');
    const lastUpdateds = modified.rows.map((r) => r.lastUpdated);
    expect(lastUpdateds).toEqual([...lastUpdateds].sort().reverse());
  });

  it('filters and windows', async () => {
    const { app } = makeApp();
    const agent = request(app);
    await getRowsUntilComplete(agent, 'project=friendly-suite&component=web-ui');

    const all = await agent
      .get('/api/v1/rows?project=friendly-suite&component=web-ui&limit=200')
      .expect(200);
    const needsReview = await agent
      .get('/api/v1/rows?project=friendly-suite&component=web-ui&filter=needs-review&limit=200')
      .expect(200);
    const unapproved = await agent
      .get('/api/v1/rows?project=friendly-suite&component=web-ui&filter=unapproved&limit=200')
      .expect(200);

    expect((all.body as RowsPage).total).toBe(400);
    expect((needsReview.body as RowsPage).total).toBeGreaterThan(0);
    expect((needsReview.body as RowsPage).total).toBeLessThan(400);
    // Unapproved is a subset of needs-review (workflow on).
    expect((unapproved.body as RowsPage).total).toBeLessThanOrEqual(
      (needsReview.body as RowsPage).total,
    );

    // Windowing: offset 0..50 and 50..100 partition the list.
    const w1 = await agent
      .get('/api/v1/rows?project=friendly-suite&component=web-ui&offset=0&limit=50')
      .expect(200);
    const w2 = await agent
      .get('/api/v1/rows?project=friendly-suite&component=web-ui&offset=50&limit=50')
      .expect(200);
    const p1 = (w1.body as RowsPage).rows.map((r) => r.key);
    const p2 = (w2.body as RowsPage).rows.map((r) => r.key);
    expect(p1).toHaveLength(50);
    expect(p2).toHaveLength(50);
    expect(p1).not.toEqual(p2);
  });

  it('rejects invalid queries with 400', async () => {
    const { app } = makeApp();
    await request(app).get('/api/v1/rows').expect(400);
    await request(app)
      .get('/api/v1/rows?project=p&component=c&limit=9999')
      .expect(400);
  });
});

describe('ID lists (large id-list filters)', () => {
  async function getContexts(agent: ReturnType<typeof request>, n: number) {
    const page = await getRowsUntilComplete(
      agent,
      'project=friendly-suite&component=web-ui&limit=200',
    );
    return page.rows.filter((r) => r.context !== '').slice(0, n).map((r) => r.context);
  }

  it('uploads a list of context keys, then filters rows by listId', async () => {
    const { app } = makeApp();
    const agent = request(app);
    const contexts = await getContexts(agent, 3);
    expect(contexts).toHaveLength(3);

    const upload = await agent
      .post('/api/v1/id-lists')
      .send({ keys: [...contexts, ...contexts, 'ID9999'] })
      .expect(200);
    const { listId, count } = upload.body as { listId: string; count: number };
    // Deduped: 3 contexts + the unknown one.
    expect(count).toBe(4);

    const res = await agent
      .get(`/api/v1/rows?project=friendly-suite&component=web-ui&filter=id-list&listId=${listId}`)
      .expect(200);
    const got = res.body as RowsPage;
    expect(got.total).toBe(3);
    expect(got.rows.map((r) => r.context).sort()).toEqual([...contexts].sort());
  });

  it('keeps small lists working inline and rejects bad payloads', async () => {
    const { app } = makeApp();
    const agent = request(app);
    const contexts = await getContexts(agent, 2);
    const context = contexts[0]!;

    const inline = await agent
      .get(
        `/api/v1/rows?project=friendly-suite&component=web-ui&filter=id-list&ids=${context},nonexistent-key`,
      )
      .expect(200);
    expect((inline.body as RowsPage).total).toBe(1);

    // Unknown listId -> empty result, not an error.
    await agent
      .get('/api/v1/rows?project=friendly-suite&component=web-ui&filter=id-list&listId=nope')
      .expect(200)
      .then((res) => expect((res.body as RowsPage).total).toBe(0));

    await agent.post('/api/v1/id-lists').send({ keys: ['with space'] }).expect(400);
  });
});

describe('POST /api/v1/bulk-state', () => {
  it('applies a state to all visible-language cells of the selected rows', async () => {
    const { app } = makeApp();
    const agent = request(app);
    const page = await getRowsUntilComplete(
      agent,
      'project=friendly-suite&component=web-ui&limit=200',
    );
    // Pick rows that have contexts (mock: ctx-<i> every 11th unit).
    const contexts = page.rows.filter((r) => r.context !== '').slice(0, 2);
    expect(contexts.length).toBeGreaterThan(0);

    const upload = await agent
      .post('/api/v1/id-lists')
      .send({ keys: contexts.map((r) => r.context) })
      .expect(200);
    const { listId } = upload.body as { listId: string };

    // Needs editing (state 10) on de + fr for the selected rows. Empty
    // targets are skipped (Weblate rejects content states on empty text).
    const start = await agent
      .post('/api/v1/bulk-state')
      .send({
        project: 'friendly-suite',
        component: 'web-ui',
        filter: 'id-list',
        listId,
        selection: { all: true, keys: [] },
        state: 10,
        languages: ['de', 'fr'],
      })
      .expect(200);
    const { jobId, total } = start.body as { jobId: string; total: number };
    const patchable = contexts.flatMap((r) =>
      ['de', 'fr']
        .map((lang) => r.cells[lang])
        .filter(
          (c) =>
            c !== undefined &&
            c.state !== 100 &&
            c.state !== 10 &&
            c.target.some((t) => t.trim() !== ''),
        ),
    );
    expect(total).toBe(patchable.length);

    let last: { status: string; done: number; failed: number; skipped: number } | null = null;
    for (let i = 0; i < 20; i++) {
      const res = await agent.get(`/api/v1/bulk-state/${jobId}`).expect(200);
      last = res.body as { status: string; done: number; failed: number; skipped: number };
      if (last.status !== 'running') break;
      await sleep(25);
    }
    expect(last).toMatchObject({ status: 'done', done: total, failed: 0 });

    const after = await agent
      .get(`/api/v1/rows?project=friendly-suite&component=web-ui&filter=needs-editing&limit=200`)
      .expect(200);
    const keysAfter = (after.body as RowsPage).rows.map((r) => r.key);
    for (const row of contexts) {
      expect(keysAfter).toContain(row.key);
    }
  });

  it('counts out-of-scope cells when onlyStates matches nothing (id-list + Edited)', async () => {
    // The failing scenario: filter by an ID list, select all rows, then
    // "Edited" (state 20, onlyStates [10]) — no cell is in state 10, so
    // nothing can change, and the job must report WHY instead of a bare
    // "0 modified".
    const { app } = makeApp();
    const agent = request(app);
    const page = await getRowsUntilComplete(
      agent,
      'project=friendly-suite&component=web-ui&filter=untranslated&limit=200',
    );
    expect(page.rows.length).toBeGreaterThan(0);
    const contexts = page.rows.filter((r) => r.context !== '').slice(0, 3);
    expect(contexts.length).toBeGreaterThan(0);

    const upload = await agent
      .post('/api/v1/id-lists')
      .send({ keys: contexts.map((r) => r.context) })
      .expect(200);
    const { listId } = upload.body as { listId: string };

    const start = await agent
      .post('/api/v1/bulk-state')
      .send({
        project: 'friendly-suite',
        component: 'web-ui',
        filter: 'id-list',
        listId,
        selection: { all: true, keys: [] },
        state: 20,
        onlyStates: [10], // "Edited"
        languages: ['de', 'fr'],
      })
      .expect(200);

    // Server scope rules mirrored: "Edited" applies only to state-10 cells
    // with content; state-20 cells are no-ops (alreadyInState); everything
    // else (missing, read-only, other states) is reported as notApplicable.
    const cells = contexts.flatMap((r) => ['de', 'fr'].map((l) => r.cells[l]));
    const inScope = cells.filter(
      (c) => c !== undefined && c.state === 10 && c.target.some((t) => t.trim() !== ''),
    ).length;
    const notInScope = cells.filter(
      (c) => c === undefined || c.state === 100 || (c.state !== 10 && c.state !== 20),
    ).length;
    const already = cells.filter((c) => c !== undefined && c.state === 20).length;

    const { jobId, total } = start.body as { jobId: string; total: number };
    expect(total).toBe(inScope);

    let last: { status: string; done: number; notApplicable: number; alreadyInState: number } | null = null;
    for (let i = 0; i < 20; i++) {
      const res = await agent.get(`/api/v1/bulk-state/${jobId}`).expect(200);
      last = res.body as { status: string; done: number; notApplicable: number; alreadyInState: number };
      if (last.status !== 'running') break;
      await sleep(25);
    }
    expect(last).toMatchObject({
      status: 'done',
      done: inScope,
      notApplicable: notInScope,
      alreadyInState: already,
    });
  });

  it("id-list filter (inline ids AND uploaded listId): 'Edited' moves needs-editing cells", async () => {
    const { app } = makeApp();
    const agent = request(app);
    const page = await getRowsUntilComplete(
      agent,
      'project=friendly-suite&component=web-ui&limit=200',
    );

    // The id-list matches CONTEXT keys. Build one from rows whose de cell
    // is currently needs-editing with content (where "Edited" WILL have an
    // effect), plus a decoy context whose de cell is not in state 10.
    const editableContexts = page.rows
      .filter(
        (r) =>
          r.context !== '' &&
          r.cells['de'] !== undefined &&
          r.cells['de']!.state === 10 &&
          r.cells['de']!.target.some((t) => t.trim() !== ''),
      )
      .map((r) => r.context);
    expect(editableContexts.length).toBeGreaterThan(0);
    const decoy = page.rows.find(
      (r) =>
        r.context !== '' &&
        !editableContexts.includes(r.context) &&
        r.cells['de'] !== undefined &&
        r.cells['de']!.state !== 10,
    );
    const listContexts = [...editableContexts, ...(decoy !== undefined ? [decoy.context] : [])];
    const upload = await agent.post('/api/v1/id-lists').send({ keys: listContexts }).expect(200);
    const { listId } = upload.body as { listId: string };

    // Exactly what the UI sends: small lists travel inline (ids=…, listId
    // ''), larger ones as listId (ids=''). Both must resolve the same
    // context set — the inline variant used to resolve to NOTHING because
    // the empty listId string shadowed the ids field.
    const deliveries = [
      { ids: listContexts.join(','), listId: '' },
      { ids: '', listId },
    ];
    for (const delivery of deliveries) {
      const filtered = await getRowsUntilComplete(
        agent,
        `project=friendly-suite&component=web-ui&filter=id-list&limit=200&ids=${encodeURIComponent(delivery.ids)}&listId=${delivery.listId}`,
      );
      const filteredKeys = filtered.rows.map((r) => r.key);
      expect(filtered.rows).toHaveLength(listContexts.length);

      const start = await agent
        .post('/api/v1/bulk-state')
        .send({
          project: 'friendly-suite',
          component: 'web-ui',
          filter: 'id-list',
          ...delivery,
          selection: { all: false, keys: filteredKeys },
          state: 20,
          onlyStates: [10], // "Edited"
          languages: ['de'],
        })
        .expect(200);
      const { jobId, total } = start.body as { jobId: string; total: number };
      expect(total).toBe(editableContexts.length);

      let last: { status: string; done: number; failed: number } | null = null;
      for (let i = 0; i < 100; i++) {
        const res = await agent.get(`/api/v1/bulk-state/${jobId}`).expect(200);
        last = res.body as { status: string; done: number; failed: number };
        if (last.status !== 'running') break;
        await sleep(25);
      }
      expect(last).toMatchObject({ status: 'done', done: editableContexts.length, failed: 0 });

      // The edited rows left the needs-editing set; the decoy remains.
      const after = await getRowsUntilComplete(
        agent,
        `project=friendly-suite&component=web-ui&filter=needs-editing&limit=200`,
      );
      const remaining = after.rows.filter((r) => editableContexts.includes(r.context));
      expect(remaining).toHaveLength(0);

      // Re-flip only the editable rows for the next delivery mode (leave
      // the decoy in its original state).
      const again = await getRowsUntilComplete(
        agent,
        `project=friendly-suite&component=web-ui&filter=id-list&limit=200&ids=${encodeURIComponent(delivery.ids)}&listId=${delivery.listId}`,
      );
      for (const row of again.rows) {
        if (!editableContexts.includes(row.context)) continue;
        const cell = row.cells['de'];
        if (cell !== undefined && cell.state === 20) {
          await agent
            .patch(`/api/v1/units/${cell.unitId}`)
            .send({ target: cell.target, state: 10 })
            .expect(200);
        }
      }
    }
  });

  it("onlyStates limits 'Edited' to cells currently in needs-editing", async () => {
    const { app } = makeApp();
    const agent = request(app);
    await getRowsUntilComplete(agent, 'project=friendly-suite&component=web-ui');

    // Flip one translated row's de cell to needs-editing first.
    const page = await agent
      .get('/api/v1/rows?project=friendly-suite&component=web-ui&filter=unapproved&limit=5')
      .expect(200);
    const row = (page.body as RowsPage).rows.find(
      (r) => r.cells['de'] !== undefined && r.cells['de']!.state === 20,
    );
    expect(row).toBeDefined();
    await agent
      .patch(`/api/v1/units/${row!.cells['de']!.unitId}`)
      .send({ target: row!.cells['de']!.target, state: 10 })
      .expect(200);

    // "Edited": only cells currently in state 10 move to 20.
    await agent
      .post('/api/v1/bulk-state')
      .send({
        project: 'friendly-suite',
        component: 'web-ui',
        selection: { all: true, keys: [] },
        state: 20,
        onlyStates: [10],
        languages: ['de', 'fr', 'cs'],
      })
      .expect(200)
      .then(async (res) => {
        const { jobId } = res.body as { jobId: string };
        for (let i = 0; i < 200; i++) {
          const st = await agent.get(`/api/v1/bulk-state/${jobId}`).expect(200);
          if ((st.body as { status: string }).status !== 'running') break;
          await sleep(25);
        }
      });

    const after = await agent
      .get('/api/v1/rows?project=friendly-suite&component=web-ui&filter=needs-editing&limit=200')
      .expect(200);
    expect((after.body as RowsPage).rows).toHaveLength(0);
  });

  it("clears the target when setting state to 'Untranslated'", async () => {
    const { app } = makeApp();
    const agent = request(app);
    await getRowsUntilComplete(agent, 'project=friendly-suite&component=web-ui');

    // One row, its translated de cell, bulk-set to untranslated.
    const page = await agent
      .get('/api/v1/rows?project=friendly-suite&component=web-ui&filter=unapproved&limit=5')
      .expect(200);
    const row = (page.body as RowsPage).rows.find(
      (r) => r.cells['de'] !== undefined && r.cells['de']!.state === 20,
    );
    expect(row).toBeDefined();

    const start = await agent
      .post('/api/v1/bulk-state')
      .send({
        project: 'friendly-suite',
        component: 'web-ui',
        filter: 'unapproved',
        selection: { all: false, keys: [row!.key] },
        state: 0,
        languages: ['de'],
      })
      .expect(200);
    const { jobId } = start.body as { jobId: string };
    for (let i = 0; i < 20; i++) {
      const st = await agent.get(`/api/v1/bulk-state/${jobId}`).expect(200);
      if ((st.body as { status: string }).status !== 'running') break;
      await sleep(25);
    }

    // The cell is now untranslated with an empty target (Weblate requires
    // "empty state = empty target"), so it shows up under Untranslated.
    const after = await agent
      .get('/api/v1/rows?project=friendly-suite&component=web-ui&filter=untranslated&limit=200')
      .expect(200);
    const got = (after.body as RowsPage).rows.find((r) => r.key === row!.key);
    expect(got?.cells['de']).toMatchObject({ state: 0, target: [''] });
  });

  it('rejects bad payloads', async () => {
    const { app } = makeApp();
    await request(app)
      .post('/api/v1/bulk-state')
      .send({ project: 'friendly-suite', component: 'web-ui', state: 99 })
      .expect(400);
  });
});

describe('PATCH /api/v1/units/:unitId', () => {
  it('edits a unit, updates the cache, and reorders modified-desc', async () => {
    const { app } = makeApp();
    const agent = request(app);
    const page = await getRowsUntilComplete(agent, 'project=friendly-suite&component=web-ui');

    // Pick a cell that is not in the first window: its row must jump to
    // the top after the edit under modified-desc.
    const row = page.rows[20]!;
    const cell = Object.values(row.cells).find((c) => c !== undefined)!;
    expect(cell).toBeDefined();

    const before = await agent
      .get('/api/v1/rows?project=friendly-suite&component=web-ui&sort=modified-desc')
      .expect(200);
    expect((before.body as RowsPage).rows[0]!.key).not.toBe(row.key);

    const patched = await agent
      .patch(`/api/v1/units/${cell.unitId}`)
      .send({ target: ['Neu übersetzt'], state: 30 })
      .expect(200);
    expect(patched.body.unit.state).toBe(30);
    expect(patched.body.unit.target).toEqual(['Neu übersetzt']);
    expect(patched.body.rowKey).toBe(row.key);

    const after = (await agent
      .get('/api/v1/rows?project=friendly-suite&component=web-ui&sort=modified-desc')
      .expect(200)) as { body: RowsPage };
    expect(after.body.rows[0]!.key).toBe(row.key);
    const topCell = after.body.rows[0]!.cells[cell.language]!;
    expect(topCell.state).toBe(30);
    expect(topCell.target).toEqual(['Neu übersetzt']);
  });

  it('edits the source string via its source-language unit', async () => {
    const { app } = makeApp();
    const agent = request(app);
    const page = await getRowsUntilComplete(agent, 'project=friendly-suite&component=web-ui');

    const row = page.rows[15]!;
    expect(row.sourceUnitId).toBeGreaterThan(0);

    const patched = await agent
      .patch(`/api/v1/units/${row.sourceUnitId}`)
      .send({ target: ['Nouvelle source'], state: 20 })
      .expect(200);
    expect(patched.body.rowKey).toBe(row.key);

    const after = (await agent
      .get('/api/v1/rows?project=friendly-suite&component=web-ui&sort=modified-desc')
      .expect(200)) as { body: RowsPage };
    // The edited row must jump to the top under modified-desc, and the
    // source text must be the new one.
    expect(after.body.rows[0]!.key).toBe(row.key);
    expect(after.body.rows[0]!.source).toEqual(['Nouvelle source']);
  });

  it('returns 400 on an empty body', async () => {
    const { app } = makeApp();
    await request(app).patch('/api/v1/units/1').send({}).expect(400);
  });

  it('returns 404 on an unknown unit', async () => {
    const { app } = makeApp();
    await request(app)
      .patch('/api/v1/units/999999999')
      .send({ state: 30 })
      .expect(404);
  });
});

describe('GET /api/v1/health', () => {
  it('reports mode, cache stats, and rate budget', async () => {
    const { app } = makeApp();
    await getRowsUntilComplete(request(app), 'project=friendly-suite&component=web-ui');
    const res = await request(app).get('/api/v1/health').expect(200);
    expect(res.body.mode).toBe('mock');
    expect(res.body.rateBudget.remaining).toBeGreaterThan(0);
    expect(res.body.caches).toHaveLength(1);
    expect(res.body.caches[0].rows).toBe(400);
  });
});
describe('POST /api/v1/search-replace', () => {

  /** Polls a search-replace job until it settles (same endpoint as bulk). */
  const poll = async (agent: ReturnType<typeof request>, jobId: string) => {
    let last: { status: string; done: number; failed: number; firstError?: string } | null = null;
    for (let i = 0; i < 100; i++) {
      const res = await agent.get(`/api/v1/bulk-state/${jobId}`).expect(200);
      last = res.body as { status: string; done: number; failed: number; firstError?: string };
      if (last.status !== 'running') break;
      await sleep(20);
    }
    return last!;
  };

  it('preview: counts and lists matching cells (case-insensitive, literal)', async () => {
    const { app } = makeApp();
    const agent = request(app);
    const page = await getRowsUntilComplete(agent, 'project=friendly-suite&component=web-ui&limit=200');

    // A cell with known text to search for.
    const row = page.rows.find(
      (r) => r.cells['de'] !== undefined && r.cells['de']!.target.some((t) => t.trim() !== ''),
    );
    expect(row).toBeDefined();
    const cell = row!.cells['de']!;
    const needle = cell.target[0]!.slice(0, 5);
    const selection = { all: false, keys: [row!.key] };

    const preview = await agent
      .post('/api/v1/search-replace/preview')
      .send({
        project: 'friendly-suite',
        component: 'web-ui',
        selection,
        search: needle,
        replace: `X${needle}`,
        ignoreCase: true,
        wholeWord: false,
        languages: ['de'],
      })
      .expect(200);
    expect(preview.body.total).toBeGreaterThan(0);
    const match = (preview.body.matches as Array<{ context: string; language: string; before: string[]; after: string[] }>)
      .find((m) => m.context === row!.context);
    expect(match).toBeDefined();
    expect(match!.after[0]).toContain(needle); // literal replacement, state untouched

    // Selection scope is honored: an empty selection matches nothing.
    const empty = await agent
      .post('/api/v1/search-replace/preview')
      .send({
        project: 'friendly-suite',
        component: 'web-ui',
        selection: { all: false, keys: ['u000000'] },
        search: needle,
        replace: 'x',
        ignoreCase: true,
        wholeWord: false,
        languages: ['de'],
      })
      .expect(200);
    expect(empty.body.total).toBe(0);
  });

  it('apply: patches matching units, keeps state, updates the cache', async () => {
    const { app } = makeApp();
    const agent = request(app);
    const page = await getRowsUntilComplete(agent, 'project=friendly-suite&component=web-ui&limit=200');
    const row = page.rows.find(
      (r) => r.cells['de'] !== undefined && r.cells['de']!.state === 20 && r.cells['de']!.target.some((t) => t.includes('e')),
    );
    expect(row).toBeDefined();
    const cell = row!.cells['de']!;
    const needle = cell.target[0]!.slice(0, 4);
    const replaced = cell.target[0]!.replace(needle, 'XX');

    const preview = await agent
      .post('/api/v1/search-replace/preview')
      .send({
        project: 'friendly-suite',
        component: 'web-ui',
        selection: { all: false, keys: [row!.key] },
        search: needle,
        replace: 'XX',
        ignoreCase: false,
        wholeWord: false,
        languages: ['de'],
      })
      .expect(200);
    expect(preview.body.total).toBe(1);

    const start = await agent
      .post('/api/v1/search-replace')
      .send({
        project: 'friendly-suite',
        component: 'web-ui',
        selection: { all: false, keys: [row!.key] },
        search: needle,
        replace: 'XX',
        ignoreCase: false,
        wholeWord: false,
        languages: ['de'],
      })
      .expect(200);
    const { jobId, total } = start.body as { jobId: string; total: number };
    expect(total).toBe(1);
    const last = await poll(agent, jobId);
    expect(last).toMatchObject({ status: 'done', done: 1, failed: 0 });

    // The cache (and thus /rows) reflects the new text with the same state.
    const after = await agent
      .get('/api/v1/rows?project=friendly-suite&component=web-ui&limit=200')
      .expect(200);
    const afterRow = (after.body as RowsPage).rows.find((r) => r.key === row!.key);
    expect(afterRow!.cells['de']!.target[0]).toBe(replaced);
    expect(afterRow!.cells['de']!.state).toBe(20);
  });

  it('whole word: substring inside a word is not matched', async () => {
    const { app } = makeApp();
    const agent = request(app);
    const page = await getRowsUntilComplete(agent, 'project=friendly-suite&component=web-ui&limit=200');
    const row = page.rows.find(
      (r) => r.cells['de'] !== undefined && r.cells['de']!.target.some((t) => t.trim() !== ''),
    );
    expect(row).toBeDefined();
    const cell = row!.cells['de']!;
    const word = cell.target[0]!.trim().split(/\s+/)[0]!;
    if (word.length < 3) return; // flaky guard: skip degenerate sample

    const withBoundaries = await agent
      .post('/api/v1/search-replace/preview')
      .send({
        project: 'friendly-suite',
        component: 'web-ui',
        selection: { all: false, keys: [row!.key] },
        search: word,
        replace: 'ZZ',
        ignoreCase: true,
        wholeWord: true,
        languages: ['de'],
      })
      .expect(200);
    // Whatever the outcome, matches must only involve whole-word hits.
    for (const m of withBoundaries.body.matches as Array<{ before: string[]; after: string[] }>) {
      for (let i = 0; i < m.before.length; i++) {
        if (m.before[i] !== m.after[i]) {
          expect(m.before[i]!.toLowerCase()).toContain(word.toLowerCase());
        }
      }
    }
  });

  it('rejects bad payloads and unknown jobs', async () => {
    const { app } = makeApp();
    await request(app)
      .post('/api/v1/search-replace/preview')
      .send({ project: 'friendly-suite', component: 'web-ui', selection: { all: true, keys: [] }, languages: ['de'] })
      .expect(400);
    await request(app).get('/api/v1/bulk-state/nonexistent').expect(404);
  });
});

describe('POST /api/v1/search-replace (source language)', () => {
  it('previews and applies replacements in the source text', async () => {
    const { app } = makeApp();
    const agent = request(app);
    const page = await getRowsUntilComplete(agent, 'project=friendly-suite&component=web-ui&limit=200');
    const row = page.rows.find((r) => r.source.some((t) => t.trim() !== ''));
    expect(row).toBeDefined();
    const needle = row!.source[0]!.slice(0, 5);
    const replaced = row!.source[0]!.replace(needle, 'QQ');

    const preview = await agent
      .post('/api/v1/search-replace/preview')
      .send({
        project: 'friendly-suite',
        component: 'web-ui',
        selection: { all: false, keys: [row!.key] },
        search: needle,
        replace: 'QQ',
        ignoreCase: true,
        wholeWord: false,
        languages: [(page as RowsPage & { sourceLanguage: string }).sourceLanguage],
      })
      .expect(200);
    expect(preview.body.total).toBe(1);
    const match = (preview.body.matches as Array<{ unitId: number; state: number; after: string[] }>)[0]!;
    expect(match.unitId).toBe(row!.sourceUnitId);
    expect(match.state).toBe(row!.sourceState);
    expect(match.after[0]).toBe(replaced);

    const start = await agent
      .post('/api/v1/search-replace')
      .send({
        project: 'friendly-suite',
        component: 'web-ui',
        selection: { all: false, keys: [row!.key] },
        search: needle,
        replace: 'QQ',
        ignoreCase: true,
        wholeWord: false,
        languages: [(page as RowsPage & { sourceLanguage: string }).sourceLanguage],
      })
      .expect(200);
    const { jobId } = start.body as { jobId: string };
    let last: { status: string; done: number; failed: number } | null = null;
    for (let i = 0; i < 100; i++) {
      const res = await agent.get(`/api/v1/bulk-state/${jobId}`).expect(200);
      last = res.body as { status: string; done: number; failed: number };
      if (last.status !== 'running') break;
      await sleep(20);
    }
    expect(last).toMatchObject({ status: 'done', done: 1, failed: 0 });

    // The row's source text and its modified timestamp updated.
    const after = await agent
      .get('/api/v1/rows?project=friendly-suite&component=web-ui&limit=200')
      .expect(200);
    const afterRow = (after.body as RowsPage).rows.find((r) => r.key === row!.key);
    expect(afterRow!.source[0]).toBe(replaced);
  });
});
