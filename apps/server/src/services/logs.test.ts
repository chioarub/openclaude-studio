import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { createOpenClaudePaths } from './paths.js';
import { listLogFiles, readLogWindow, searchLogs } from './logs.js';

describe('logs', () => {
  test('lists regular OpenClaude log files and ignores symlinks', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ocs-logs-'));
    const paths = createOpenClaudePaths({ home, env: {} });
    await mkdir(paths.debugDir, { recursive: true });
    await writeFile(join(paths.debugDir, 'session-1.txt'), 'line\n', 'utf8');
    await writeFile(join(paths.debugDir, 'ignored.json'), '{}\n', 'utf8');
    await symlink(join(paths.debugDir, 'session-1.txt'), join(paths.debugDir, 'latest'));

    const result = await listLogFiles(paths);

    expect(result.files).toEqual([
      expect.objectContaining({ name: 'session-1.txt', sessionId: 'session-1' }),
    ]);
    expect(result.diagnostics).toEqual([]);
  });

  test('lists every log file so project scoping does not hide older session logs', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ocs-logs-'));
    const paths = createOpenClaudePaths({ home, env: {} });
    await mkdir(paths.debugDir, { recursive: true });
    for (let index = 0; index < 205; index += 1) {
      await writeFile(join(paths.debugDir, `session-${String(index).padStart(3, '0')}.txt`), 'line\n', 'utf8');
    }

    const result = await listLogFiles(paths);

    expect(result.files).toHaveLength(205);
    expect(result.diagnostics).toEqual([]);
  });

  test('reads a bounded parsed log window with redacted messages', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ocs-logs-'));
    const paths = createOpenClaudePaths({ home, env: {} });
    await mkdir(paths.debugDir, { recursive: true });
    await writeFile(
      join(paths.debugDir, 'session-1.txt'),
      [
        '2026-05-28T08:00:00.000Z INFO starting',
        '2026-05-28T08:01:00.000Z ERROR OPENAI_API_KEY=secret-value failed',
        'plain debug line',
      ].join('\n'),
      'utf8',
    );

    const result = await readLogWindow(paths, 'session-1.txt', { start: 1, count: 2 });

    expect(result.selectedFile?.name).toBe('session-1.txt');
    expect(result.start).toBe(1);
    expect(result.count).toBe(2);
    expect(result.totalLines).toBe(3);
    expect(result.entries).toEqual([
      {
        id: 'session-1.txt:2',
        lineNumber: 2,
        timestamp: '2026-05-28T08:01:00.000Z',
        level: 'error',
        message: 'OPENAI_API_KEY=<redacted> failed',
      },
      {
        id: 'session-1.txt:3',
        lineNumber: 3,
        timestamp: null,
        level: 'debug',
        message: 'plain debug line',
      },
    ]);
  });

  test('scopes log windows to selected project session ids', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ocs-logs-'));
    const paths = createOpenClaudePaths({ home, env: {} });
    await mkdir(paths.debugDir, { recursive: true });
    await writeFile(join(paths.debugDir, 'session-a.txt'), '2026-05-28T08:00:00.000Z INFO selected\n', 'utf8');
    await writeFile(join(paths.debugDir, 'session-b.txt'), '2026-05-28T08:00:00.000Z INFO other\n', 'utf8');

    const result = await readLogWindow(paths, undefined, { count: 10 }, { sessionIds: new Set(['session-a']) });

    expect(result.files.map((file) => file.name)).toEqual(['session-a.txt']);
    expect(result.selectedFile?.name).toBe('session-a.txt');
    expect(result.entries[0]?.message).toBe('selected');
  });

  test('returns arbitrary windows from large logs without truncating to the first preview', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ocs-logs-'));
    const paths = createOpenClaudePaths({ home, env: {} });
    await mkdir(paths.debugDir, { recursive: true });
    const lines = Array.from(
      { length: 1200 },
      (_, index) => `2026-05-28T08:00:00.000Z INFO line-${index}`,
    );
    await writeFile(join(paths.debugDir, 'session-large.txt'), `${lines.join('\n')}\n`, 'utf8');

    const result = await readLogWindow(paths, 'session-large.txt', { start: 1050, count: 3 });

    expect(result.totalLines).toBe(1200);
    expect(result.start).toBe(1050);
    expect(result.entries.map((entry) => entry.message)).toEqual(['line-1050', 'line-1051', 'line-1052']);
  });

  test('rejects unsafe log file names', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ocs-logs-'));
    const paths = createOpenClaudePaths({ home, env: {} });
    await mkdir(paths.debugDir, { recursive: true });
    await writeFile(join(paths.debugDir, 'session-1.txt'), 'line\n', 'utf8');

    const result = await readLogWindow(paths, '../session-1.txt');

    expect(result.selectedFile).toBeNull();
    expect(result.entries).toEqual([]);
    expect(result.diagnostics[0]?.level).toBe('warn');
  });

  test('searches log entries by query and level', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ocs-logs-'));
    const paths = createOpenClaudePaths({ home, env: {} });
    await mkdir(paths.debugDir, { recursive: true });
    await writeFile(
      join(paths.debugDir, 'session-1.txt'),
      [
        '2026-05-28T08:00:00.000Z INFO cache warm',
        '2026-05-28T08:01:00.000Z WARN cache miss',
        '2026-05-28T08:02:00.000Z ERROR cache failed',
      ].join('\n'),
      'utf8',
    );

    const result = await searchLogs(paths, 'session-1.txt', {
      query: 'cache',
      level: 'warn',
      start: 0,
      count: 5,
    });

    expect(result.query).toBe('cache');
    expect(result.totalLines).toBe(3);
    expect(result.totalMatches).toBe(1);
    expect(result.entries[0]?.level).toBe('warn');
  });
});
