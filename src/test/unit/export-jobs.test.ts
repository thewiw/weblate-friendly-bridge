import { describe, expect, it } from 'vitest';
import { ExportJobStore } from '../../server/export/export-jobs.js';
import { MockWeblateClient } from '../../server/weblate/mock/mock-client.js';
import type { ExportRequest } from '../../shared/export.js';

const params: ExportRequest = {
  scope: [{ project: 'friendly-suite', component: 'web-ui' }],
  languages: ['de'],
  format: 'i18next',
  fileName: '[language].json',
  grouping: 'per-component',
  packaging: 'json',
};

const waitFor = async (
  store: ExportJobStore,
  jobId: string,
): Promise<'done' | 'error'> => {
  for (let i = 0; i < 100; i++) {
    const job = store.get(jobId);
    if (job === undefined) throw new Error('Job vanished');
    if (job.status !== 'running') return job.status;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Job did not finish');
};

describe('ExportJobStore', () => {
  it('runs an export in the background and stores the payload', async () => {
    const store = new ExportJobStore();
    const jobId = store.create();
    store.start(jobId, new MockWeblateClient(), params);
    expect(store.get(jobId)?.status).toBe('running');

    expect(await waitFor(store, jobId)).toBe('done');
    const job = store.get(jobId);
    expect(job?.result).not.toBeNull();
    expect(job?.total).toBeGreaterThan(0);
    expect(job?.loaded).toBe(job?.total);
    expect(job?.finishedAt).not.toBeNull();
  });

  it('turns export failures into status error (never throws)', async () => {
    const store = new ExportJobStore();
    const jobId = store.create();
    store.start(jobId, new MockWeblateClient(), {
      ...params,
      scope: [{ project: 'friendly-suite', component: 'nope' }],
    });

    expect(await waitFor(store, jobId)).toBe('error');
    const job = store.get(jobId)!;
    expect(job.error).toContain('nope');
    expect(job.result).toBeNull();
  });

  it('evicts the oldest job at capacity', () => {
    const store = new ExportJobStore();
    const first = store.create();
    for (let i = 0; i < 19; i++) store.create();
    expect(store.get(first)).toBeDefined();
    store.create(); // 21st → the first job is dropped
    expect(store.get(first)).toBeUndefined();
  });

  it('drops finished jobs past the TTL', async () => {
    const store = new ExportJobStore();
    const jobId = store.create();
    store.start(jobId, new MockWeblateClient(), params);
    await waitFor(store, jobId);

    // Simulate age: finishedAt is set by the runner on completion.
    store.get(jobId)!.finishedAt = Date.now() - 11 * 60_000;
    expect(store.get(jobId)).toBeUndefined();
  });
});