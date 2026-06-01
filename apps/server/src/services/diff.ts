import type { SessionChangeDiffHunk, SessionChangeDiffLine } from '@openclaude-studio/shared';

export type UnifiedDiffResult = {
  hunks: SessionChangeDiffHunk[];
  additions: number;
  deletions: number;
};

type DiffOptions = {
  contextLines?: number;
};

type DiffOperation = SessionChangeDiffLine;

export function createUnifiedDiff(before: string, after: string, options: DiffOptions = {}): UnifiedDiffResult {
  const contextLines = Math.max(0, Math.floor(options.contextLines ?? 3));
  const oldLines = splitDiffLines(before);
  const newLines = splitDiffLines(after);
  const operations = diffOperations(oldLines, newLines);
  const additions = operations.filter((operation) => operation.kind === 'add').length;
  const deletions = operations.filter((operation) => operation.kind === 'remove').length;

  return {
    hunks: buildHunks(operations, contextLines),
    additions,
    deletions,
  };
}

function splitDiffLines(value: string): string[] {
  const normalized = value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (!normalized) {
    return [];
  }

  const lines = normalized.split('\n');
  if (lines.at(-1) === '') {
    lines.pop();
  }
  return lines;
}

function diffOperations(oldLines: string[], newLines: string[]): DiffOperation[] {
  const table = longestCommonSubsequenceTable(oldLines, newLines);
  const operations: DiffOperation[] = [];
  let oldIndex = 0;
  let newIndex = 0;

  while (oldIndex < oldLines.length || newIndex < newLines.length) {
    if (oldIndex < oldLines.length && newIndex < newLines.length && oldLines[oldIndex] === newLines[newIndex]) {
      operations.push({
        kind: 'context',
        oldLine: oldIndex + 1,
        newLine: newIndex + 1,
        text: oldLines[oldIndex]!,
      });
      oldIndex += 1;
      newIndex += 1;
      continue;
    }

    if (
      newIndex >= newLines.length ||
      (oldIndex < oldLines.length && table[oldIndex + 1]![newIndex]! >= table[oldIndex]![newIndex + 1]!)
    ) {
      operations.push({
        kind: 'remove',
        oldLine: oldIndex + 1,
        newLine: null,
        text: oldLines[oldIndex]!,
      });
      oldIndex += 1;
      continue;
    }

    operations.push({
      kind: 'add',
      oldLine: null,
      newLine: newIndex + 1,
      text: newLines[newIndex]!,
    });
    newIndex += 1;
  }

  return operations;
}

function longestCommonSubsequenceTable(oldLines: string[], newLines: string[]): number[][] {
  const table = Array.from({ length: oldLines.length + 1 }, () => Array<number>(newLines.length + 1).fill(0));

  for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex -= 1) {
      table[oldIndex]![newIndex] =
        oldLines[oldIndex] === newLines[newIndex]
          ? table[oldIndex + 1]![newIndex + 1]! + 1
          : Math.max(table[oldIndex + 1]![newIndex]!, table[oldIndex]![newIndex + 1]!);
    }
  }

  return table;
}

function buildHunks(operations: DiffOperation[], contextLines: number): SessionChangeDiffHunk[] {
  const ranges: Array<{ start: number; end: number }> = [];

  for (const [index, operation] of operations.entries()) {
    if (operation.kind === 'context') {
      continue;
    }

    const start = Math.max(0, index - contextLines);
    const end = Math.min(operations.length, index + contextLines + 1);
    const previous = ranges.at(-1);
    if (previous && start <= previous.end) {
      previous.end = Math.max(previous.end, end);
    } else {
      ranges.push({ start, end });
    }
  }

  return ranges.map(({ start, end }) => {
    const lines = operations.slice(start, end);
    const oldLines = lines.filter((line) => line.kind !== 'add').length;
    const newLines = lines.filter((line) => line.kind !== 'remove').length;
    return {
      oldStart: firstLineNumber(lines, 'oldLine'),
      oldLines,
      newStart: firstLineNumber(lines, 'newLine'),
      newLines,
      lines,
    };
  });
}

function firstLineNumber(lines: DiffOperation[], key: 'oldLine' | 'newLine'): number {
  const line = lines.find((item) => item[key] !== null)?.[key];
  return line ?? 0;
}
