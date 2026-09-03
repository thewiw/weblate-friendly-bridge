import { describe, expect, it } from 'vitest';
import { openApiSpec } from '../../server/rest/openapi.js';

/**
 * Lightweight structural sanity check (no full OpenAPI validator): every
 * operation must have at least one response, and every local $ref must
 * point at an existing component schema.
 */
describe('OpenAPI spec', () => {
  const spec = openApiSpec as unknown as {
    openapi: string;
    paths: Record<string, Record<string, { responses?: Record<string, unknown> }>>;
    components: { schemas: Record<string, unknown> };
  };

  it('is an OpenAPI 3 document with paths', () => {
    expect(spec.openapi).toMatch(/^3\.\d+\.\d+$/);
    expect(Object.keys(spec.paths).length).toBeGreaterThanOrEqual(5);
  });

  it('gives every operation at least one response', () => {
    for (const [path, methods] of Object.entries(spec.paths)) {
      for (const [method, op] of Object.entries(methods)) {
        const responses = Object.keys(op.responses ?? {});
        expect(responses.length, `${method.toUpperCase()} ${path}`).toBeGreaterThan(0);
        expect(responses).toContain('200');
      }
    }
  });

  it('resolves all local schema $refs', () => {
    const refs: string[] = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) {
        node.forEach(walk);
      } else if (node !== null && typeof node === 'object') {
        for (const [key, value] of Object.entries(node)) {
          if (key === '$ref' && typeof value === 'string') refs.push(value);
          else walk(value);
        }
      }
    };
    walk(spec.paths);
    for (const r of refs) {
      expect(r, 'local ref').toMatch(/^#\/components\/schemas\//);
      const name = r.split('/').pop()!;
      expect(spec.components.schemas[name], r).toBeDefined();
    }
  });
});