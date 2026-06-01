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
});
