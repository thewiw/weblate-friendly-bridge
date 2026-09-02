import { describe, expect, it } from 'vitest';
import {
  emptySelection,
  isSelected,
  selectionCount,
  setKeysState,
  toggleKey,
} from '../../client/state/selection.js';

describe('selection model', () => {
  it('tracks explicit keys when all=false', () => {
    let s = emptySelection();
    s = toggleKey(s, 'a');
    s = toggleKey(s, 'b');
    expect(isSelected(s, 'a')).toBe(true);
    expect(isSelected(s, 'b')).toBe(true);
    expect(isSelected(s, 'c')).toBe(false);
    expect(selectionCount(s, 100)).toBe(2);

    // Toggling again deselects.
    s = toggleKey(s, 'a');
    expect(isSelected(s, 'a')).toBe(false);
    expect(selectionCount(s, 100)).toBe(1);
  });

  it('select-all keeps exceptions: keys are the DEselected rows', () => {
    let s: ReturnType<typeof emptySelection> = { all: true, keys: new Set() };
    expect(selectionCount(s, 20000)).toBe(20000);
    expect(isSelected(s, 'x')).toBe(true);

    // Deselect one row of the "all" set.
    s = toggleKey(s, 'x');
    expect(isSelected(s, 'x')).toBe(false);
    expect(isSelected(s, 'y')).toBe(true);
    expect(selectionCount(s, 20000)).toBe(19999);

    // Re-selecting it returns to plain select-all.
    s = toggleKey(s, 'x');
    expect(selectionCount(s, 20000)).toBe(20000);
    expect(s.keys.size).toBe(0);
  });

  it('flips ranges and pages in both modes', () => {
    let s = emptySelection();
    s = setKeysState(s, ['a', 'b', 'c'], true);
    expect([s.keys.has('a'), s.keys.has('b'), s.keys.has('c')]).toEqual([true, true, true]);

    // Page deselect under all=true: adds every page key as an exception.
    s = { all: true, keys: new Set<string>() };
    s = setKeysState(s, ['a', 'b'], false);
    expect(selectionCount(s, 10)).toBe(8);
    expect(isSelected(s, 'c')).toBe(true);

    // Page reselect removes the exceptions.
    s = setKeysState(s, ['a', 'b'], true);
    expect(s.keys.size).toBe(0);
    expect(selectionCount(s, 10)).toBe(10);
  });

  it('keeps explicit keys consistent when switching to select-all', () => {
    let s = emptySelection();
    // Keys selected under a previous view linger in the set.
    s = setKeysState(s, ['a', 'b'], true);
    s = { all: true, keys: s.keys };
    // Those keys are now treated as deselected exceptions.
    expect(isSelected(s, 'a')).toBe(false);
    // Re-selecting them restores plain select-all.
    s = setKeysState(s, ['a'], true);
    expect(isSelected(s, 'a')).toBe(true);
  });
});