import { describe, expect, it } from 'vitest';
import { parseIdList } from '../../client/components/Toolbar.js';

describe('parseIdList', () => {
  it('uses newline when an ID follows the first line', () => {
    expect(parseIdList('3062\n3070\n3071')).toEqual({ ids: ['3062', '3070', '3071'], invalid: 0 });
    // CRLF + blank lines tolerated.
    expect(parseIdList('3062\r\n\r\n3070')).toEqual({ ids: ['3062', '3070'], invalid: 0 });
    // Mixed input: the newline separator wins; the comma line is invalid.
    expect(parseIdList('3062\n3070,3071')).toEqual({ ids: ['3062'], invalid: 1 });
    // A header line before a column of IDs still parses (it becomes an
    // extra, non-matching context key).
    expect(parseIdList('ID\n3062\n3070')).toEqual({
      ids: ['ID', '3062', '3070'],
      invalid: 0,
    });
  });

  it('ignores line breaks when no ID follows the first line', () => {
    // Single ID with a trailing newline: not a multi-line list.
    expect(parseIdList('3062\n')).toEqual({ ids: ['3062'], invalid: 0 });
    // One-line list ending with a newline: comma still applies.
    expect(parseIdList('3062,3070\n')).toEqual({ ids: ['3062', '3070'], invalid: 0 });
  });

  it('picks the first comma or semicolon that yields at least two keys', () => {
    expect(parseIdList('3062,3070,3071')).toEqual({ ids: ['3062', '3070', '3071'], invalid: 0 });
    expect(parseIdList('3062;3070;3071')).toEqual({ ids: ['3062', '3070', '3071'], invalid: 0 });
    // Comma comes first -> it is the separator; the rest is one token
    // containing a separator, hence invalid.
    expect(parseIdList('3062,3070;3071')).toEqual({ ids: ['3062'], invalid: 1 });
    // A separator with no key after it does not qualify — single key, and
    // a trailing separator is tolerated.
    expect(parseIdList('3062,')).toEqual({ ids: ['3062'], invalid: 0 });
    expect(parseIdList('3062;')).toEqual({ ids: ['3062'], invalid: 0 });
    expect(parseIdList('3062')).toEqual({ ids: ['3062'], invalid: 0 });
    expect(parseIdList('  ID0002  ')).toEqual({ ids: ['ID0002'], invalid: 0 });
  });

  it('dedupes in order and counts invalid tokens', () => {
    expect(parseIdList('ID0002,ID0002,ab;cd,ID0003')).toEqual({
      ids: ['ID0002', 'ID0003'],
      invalid: 1,
    });
    // Keys without whitespace/separator characters are all valid.
    expect(parseIdList('abc\ndef')).toEqual({ ids: ['abc', 'def'], invalid: 0 });
    expect(parseIdList('')).toEqual({ ids: [], invalid: 0 });
  });
});