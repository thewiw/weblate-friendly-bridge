import { describe, expect, it } from 'vitest';
import { parseHiddenLangs, parseView } from '../../client/state/url-state.js';

describe('parseView: hiddenLangs', () => {
  it('defaults to all languages visible when the param is absent', () => {
    expect(parseView('').hiddenLangs).toBe('');
  });

  it('reads a comma-separated list of hidden codes', () => {
    expect(parseView('?hiddenLangs=de,fr').hiddenLangs).toBe('de,fr');
    expect(parseHiddenLangs('de,fr')).toEqual(new Set(['de', 'fr']));
  });

  it('decodes URL-encoded commas', () => {
    // URLSearchParams serializes 'de,fr' as hiddenLangs=de%2Cfr.
    expect(parseView('?hiddenLangs=de%2Cfr').hiddenLangs).toBe('de,fr');
  });

  it('ignores empty segments', () => {
    expect(parseHiddenLangs('')).toEqual(new Set());
    expect(parseHiddenLangs('de,,fr,')).toEqual(new Set(['de', 'fr']));
  });

  it('round-trips the key setParams writes (URL key = field name)', () => {
    // Regression: setParams serializes the patch key as the URL param, so
    // parseView must read the same key or writes are silently dropped.
    const written = new URLSearchParams({ hiddenLangs: 'de,fr' });
    expect(parseView(`?${written}`).hiddenLangs).toBe('de,fr');
  });
});