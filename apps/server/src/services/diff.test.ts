import { describe, expect, test } from 'vitest';

import { createUnifiedDiff } from './diff.js';

describe('createUnifiedDiff', () => {
  test('builds deterministic structured hunks with additions and deletions', () => {
    const diff = createUnifiedDiff(
      ['alpha', 'bravo', 'charlie', 'delta', 'echo'].join('\n'),
      ['alpha', 'bravo', 'CHARLIE', 'delta', 'echo', 'foxtrot'].join('\n'),
      { contextLines: 1 },
    );

    expect(diff.additions).toBe(2);
    expect(diff.deletions).toBe(1);
    expect(diff.hunks).toEqual([
      {
        oldStart: 2,
        oldLines: 4,
        newStart: 2,
        newLines: 5,
        lines: [
          { kind: 'context', oldLine: 2, newLine: 2, text: 'bravo' },
          { kind: 'remove', oldLine: 3, newLine: null, text: 'charlie' },
          { kind: 'add', oldLine: null, newLine: 3, text: 'CHARLIE' },
          { kind: 'context', oldLine: 4, newLine: 4, text: 'delta' },
          { kind: 'context', oldLine: 5, newLine: 5, text: 'echo' },
          { kind: 'add', oldLine: null, newLine: 6, text: 'foxtrot' },
        ],
      },
    ]);
  });

  test('returns no hunks for empty or identical inputs', () => {
    expect(createUnifiedDiff('', '')).toEqual({ additions: 0, deletions: 0, hunks: [] });
    expect(createUnifiedDiff('same\ncontent', 'same\ncontent')).toEqual({ additions: 0, deletions: 0, hunks: [] });
  });

  test('builds add-only and delete-only hunks without phantom line numbers', () => {
    expect(createUnifiedDiff('', 'one\ntwo')).toEqual({
      additions: 2,
      deletions: 0,
      hunks: [
        {
          oldStart: 0,
          oldLines: 0,
          newStart: 1,
          newLines: 2,
          lines: [
            { kind: 'add', oldLine: null, newLine: 1, text: 'one' },
            { kind: 'add', oldLine: null, newLine: 2, text: 'two' },
          ],
        },
      ],
    });

    expect(createUnifiedDiff('one\ntwo', '')).toEqual({
      additions: 0,
      deletions: 2,
      hunks: [
        {
          oldStart: 1,
          oldLines: 2,
          newStart: 0,
          newLines: 0,
          lines: [
            { kind: 'remove', oldLine: 1, newLine: null, text: 'one' },
            { kind: 'remove', oldLine: 2, newLine: null, text: 'two' },
          ],
        },
      ],
    });
  });

  test('caps oversized context at file boundaries', () => {
    const diff = createUnifiedDiff('alpha\nbravo\ncharlie', 'alpha\nBRAVO\ncharlie', { contextLines: 99 });

    expect(diff.hunks).toEqual([
      {
        oldStart: 1,
        oldLines: 3,
        newStart: 1,
        newLines: 3,
        lines: [
          { kind: 'context', oldLine: 1, newLine: 1, text: 'alpha' },
          { kind: 'remove', oldLine: 2, newLine: null, text: 'bravo' },
          { kind: 'add', oldLine: null, newLine: 2, text: 'BRAVO' },
          { kind: 'context', oldLine: 3, newLine: 3, text: 'charlie' },
        ],
      },
    ]);
  });
});
