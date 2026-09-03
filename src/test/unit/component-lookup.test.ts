import { describe, expect, it } from 'vitest';
import { isNotFound, unknownComponentError } from '../../server/component-lookup.js';
import { MockWeblateClient } from '../../server/weblate/mock/mock-client.js';
import { UpstreamError } from '../../server/http-errors.js';

const api = new MockWeblateClient();

describe('unknownComponentError', () => {
  it('suggests the slug when the requested name only differs in punctuation', async () => {
    const err = await unknownComponentError(api, 'friendly-suite', 'v4.2.0'.replace('v4.2.0', 'Web.UI'));
    expect(err).toBeInstanceOf(UpstreamError);
    expect(err.status).toBe(404);
    expect(err.message).toContain('did you mean the slug "web-ui"');
  });

  it('lists the available slugs when nothing matches', async () => {
    const err = await unknownComponentError(api, 'friendly-suite', 'does-not-exist');
    expect(err.status).toBe(404);
    expect(err.message).toContain('Available components in "friendly-suite"');
    expect(err.message).toContain('web-ui');
  });

  it('answers "unknown project" when the project does not exist', async () => {
    const err = await unknownComponentError(api, 'no-such-project', 'web-ui');
    expect(err.status).toBe(404);
    expect(err.message).toBe('Unknown project: no-such-project');
  });
});

describe('isNotFound', () => {
  it('matches upstream 404s and mock "Unknown" errors, nothing else', () => {
    expect(isNotFound(new UpstreamError(404, 'Not found'))).toBe(true);
    expect(isNotFound(new UpstreamError(502, 'network'))).toBe(false);
    expect(isNotFound(new Error('Unknown component: mock://x'))).toBe(true);
    expect(isNotFound(new Error('connection refused'))).toBe(false);
    expect(isNotFound('nope')).toBe(false);
  });
});