/**
 * Regression: Weblate's `context:<key>` search matches substrings
 * ("context:truc" also finds "…INSTRUCTION…"). findUnitByContext must
 * verify the hit's context equals the requested key, or operations
 * (create/patch/delete) silently hit the wrong string.
 */
import { describe, expect, it } from 'vitest';
import { patchTranslations } from '../../server/rest/operations.js';
import { CacheRegistry } from '../../server/cache/cache-registry.js';
import { MockWeblateClient } from '../../server/weblate/mock/mock-client.js';

async function seed(api: MockWeblateClient): Promise<void> {
  // One context that CONTAINS the other (like 'truc' inside '…INSTRUCTION…').
  await api.createUnit(api.unitsUrlFor('friendly-suite', 'web-ui', 'en'), {
    key: 'INSTRUCTION_WHAT_NEXT',
    source: ['the instruction'],
    target: ['the instruction'],
    state: 20,
  });
  await api.createUnit(api.unitsUrlFor('friendly-suite', 'web-ui', 'en'), {
    key: 'WHAT_NEXT',
    source: ['what next'],
    target: ['what next'],
    state: 20,
  });
}

describe('findUnitByContext exact matching', () => {
  it('patches the exact context, not a substring hit', async () => {
    const api = new MockWeblateClient();
    await seed(api);
    const res = await patchTranslations(
      api,
      new CacheRegistry(api),
      'friendly-suite',
      'web-ui',
      'WHAT_NEXT',
      { de: { target: 'richtig' } },
    );
    expect(res.translations.de).toBeDefined();
    const patched = await api.getUnit((res.translations.de as { unitId: number }).unitId);
    expect(patched.context).toBe('WHAT_NEXT');
    expect(patched.target).toEqual(['richtig']);
    // The substring-matching sibling must be untouched.
    const untouched = await findUnit(api, 'INSTRUCTION_WHAT_NEXT', 'de');
    expect(untouched?.target).toEqual(['']);
  });

  it('answers unknown context when only a substring match exists', async () => {
    const api = new MockWeblateClient();
    await seed(api);
    // 'WHAT_NEXT' exists but the requested key only exists as a substring
    // of 'INSTRUCTION_WHAT_NEXT'… reversed: request the containing key's
    // own absence via a context that is a substring of it.
    await expect(
      patchTranslations(
        api,
        new CacheRegistry(api),
        'friendly-suite',
        'web-ui',
        'WHAT_NEX', // substring of both — but no exact match
        { de: { target: 'x' } },
      ),
    ).rejects.toThrow(/Unknown context/);
  });
});

/** Looks up a unit by exact context in the de translation. */
async function findUnit(
  api: MockWeblateClient,
  context: string,
  lang: string,
): Promise<WeblateUnitLike | null> {
  for await (const unit of api.listUnits(api.unitsUrlFor('friendly-suite', 'web-ui', lang), `context:${context}`)) {
    if (unit.context === context) return unit;
  }
  return null;
}

interface WeblateUnitLike {
  id: number;
  context: string;
  target: string[];
}