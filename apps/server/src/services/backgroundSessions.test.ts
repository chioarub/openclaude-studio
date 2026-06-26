import { chmod, mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { createOpenClaudePaths } from './paths.js';
import { listBackgroundSessions, readBackgroundSessionLogs } from './backgroundSessions.js';

function bgRoot(paths: ReturnType<typeof createOpenClaudePaths>): string {
  return join(paths.openClaudeHome, 'bg-sessions');
}

function sessionsDir(paths: ReturnType<typeof createOpenClaudePaths>): string {
  return join(bgRoot(paths), 'sessions');
}

function logsDir(paths: ReturnType<typeof createOpenClaudePaths>): string {
  return join(bgRoot(paths), 'logs');
}

async function writeSession(
  paths: ReturnType<typeof createOpenClaudePaths>,
  id: string,
  record: Record<string, unknown>,
): Promise<void> {
  await mkdir(sessionsDir(paths), { recursive: true });
  await writeFile(join(sessionsDir(paths), `${id}.json`), JSON.stringify(record), 'utf8');
}

function validSessionFixture(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'abc12345',
    name: 'my-task',
    pid: 12345,
    cwd: '/home/user/project',
    status: 'running',
    provider: 'anthropic',
    model: 'claude-sonnet-4',
    sessionId: 'sess-001',
    startedAt: '2026-06-01T10:00:00.000Z',
    updatedAt: '2026-06-01T10:05:00.000Z',
    command: ['openclaude', '--print', '--model', 'claude-sonnet-4'],
    ...overrides,
  };
}

describe('listBackgroundSessions', () => {
  test('returns an empty list with an info diagnostic when the sessions directory is missing', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ocs-bg-'));
    const paths = createOpenClaudePaths({ home, env: {} });

    const result = await listBackgroundSessions(paths);

    expect(result.sessions).toEqual([]);
    expect(result.statusCounts).toEqual({
      running: 0,
      unknown: 0,
      exited: 0,
      failed: 0,
      stale: 0,
      killed: 0,
    });
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ level: 'info' }),
    ]);
  });

  test('parses a valid session metadata file into a summary', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ocs-bg-'));
    const paths = createOpenClaudePaths({ home, env: {} });
    await writeSession(paths, 'abc12345', validSessionFixture());

    const result = await listBackgroundSessions(paths);

    expect(result.sessions).toHaveLength(1);
    const summary = result.sessions[0];
    expect(summary).toEqual(
      expect.objectContaining({
        id: 'abc12345',
        shortId: 'abc12345',
        name: 'my-task',
        pid: 12345,
        cwd: '/home/user/project',
        recordedStatus: 'running',
        terminal: false,
        processPresence: 'unknown',
        provider: 'anthropic',
        model: 'claude-sonnet-4',
        sessionId: 'sess-001',
        startedAt: '2026-06-01T10:00:00.000Z',
        updatedAt: '2026-06-01T10:05:00.000Z',
        durationMs: 5 * 60 * 1000,
        stdoutLogAvailable: false,
        stderrLogAvailable: false,
      }),
    );
    expect(summary?.commandSummary).toEqual({ binary: 'openclaude', flagCount: 2, truncated: false });
    expect(summary?.project).toBeNull();
    expect(summary?.sessionLink).toBeNull();
    expect(result.statusCounts.running).toBe(1);
    expect(result.diagnostics).toEqual([]);
  });

  test('marks terminal statuses', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ocs-bg-'));
    const paths = createOpenClaudePaths({ home, env: {} });
    await writeSession(paths, 'term-exited', validSessionFixture({ id: 'term-exited', status: 'exited' }));
    await writeSession(paths, 'term-failed', validSessionFixture({ id: 'term-failed', status: 'failed' }));
    await writeSession(paths, 'term-stale', validSessionFixture({ id: 'term-stale', status: 'stale' }));
    await writeSession(paths, 'term-killed', validSessionFixture({ id: 'term-killed', status: 'killed' }));
    await writeSession(paths, 'nonterm-running', validSessionFixture({ id: 'nonterm-running', status: 'running' }));
    await writeSession(paths, 'nonterm-unknown', validSessionFixture({ id: 'nonterm-unknown', status: 'unknown' }));

    const result = await listBackgroundSessions(paths);

    const byId = new Map(result.sessions.map((s) => [s.id, s]));
    expect(byId.get('term-exited')?.terminal).toBe(true);
    expect(byId.get('term-failed')?.terminal).toBe(true);
    expect(byId.get('term-stale')?.terminal).toBe(true);
    expect(byId.get('term-killed')?.terminal).toBe(true);
    expect(byId.get('nonterm-running')?.terminal).toBe(false);
    expect(byId.get('nonterm-unknown')?.terminal).toBe(false);
  });

  test('normalizes records with an unrecognized status and reports a diagnostic', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ocs-bg-'));
    const paths = createOpenClaudePaths({ home, env: {} });
    await writeSession(paths, 'bad-status', validSessionFixture({ id: 'bad-status', status: 'zombie' }));

    const result = await listBackgroundSessions(paths);

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]).toMatchObject({
      id: 'bad-status',
      recordedStatus: 'unknown',
      terminal: false,
    });
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ level: 'warn', message: expect.stringContaining('normalized to unknown') }),
    ]);
  });

  test('skips metadata files with overlong ids', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ocs-bg-'));
    const paths = createOpenClaudePaths({ home, env: {} });
    const overlongId = 'a'.repeat(129);
    await writeSession(paths, overlongId, validSessionFixture({ id: overlongId }));

    const result = await listBackgroundSessions(paths);

    expect(result.sessions).toEqual([]);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ level: 'warn', message: expect.stringContaining('unsafe id') }),
    );
  });

  test('skips malformed JSON files and reports a diagnostic', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ocs-bg-'));
    const paths = createOpenClaudePaths({ home, env: {} });
    await mkdir(sessionsDir(paths), { recursive: true });
    await writeFile(join(sessionsDir(paths), 'broken.json'), '{ this is not json', 'utf8');

    const result = await listBackgroundSessions(paths);

    expect(result.sessions).toEqual([]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ level: 'warn', message: expect.stringContaining('malformed') }),
    ]);
  });

  test('skips metadata files with unsafe ids', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ocs-bg-'));
    const paths = createOpenClaudePaths({ home, env: {} });
    await mkdir(sessionsDir(paths), { recursive: true });
    // Filenames that pass the .json extension filter but fail SAFE_ID_PATTERN:
    // leading dash, leading dot, and path traversal are all rejected.
    await writeFile(
      join(sessionsDir(paths), '-unsafe.json'),
      JSON.stringify(validSessionFixture({ id: '-unsafe' })),
      'utf8',
    );
    await writeFile(
      join(sessionsDir(paths), '.hidden.json'),
      JSON.stringify(validSessionFixture({ id: '.hidden' })),
      'utf8',
    );

    const result = await listBackgroundSessions(paths);

    expect(result.sessions).toEqual([]);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ level: 'warn', message: expect.stringContaining('unsafe id') }),
    );
  });

  test('skips symlinked metadata files', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ocs-bg-'));
    const paths = createOpenClaudePaths({ home, env: {} });
    await writeSession(paths, 'real-session', validSessionFixture({ id: 'real-session' }));
    await symlink(
      join(sessionsDir(paths), 'real-session.json'),
      join(sessionsDir(paths), 'linked.json'),
    );

    const result = await listBackgroundSessions(paths);

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]?.id).toBe('real-session');
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ level: 'warn', message: expect.stringContaining('not a regular file') }),
    );
  });

  test('skips oversized metadata files', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ocs-bg-'));
    const paths = createOpenClaudePaths({ home, env: {} });
    await mkdir(sessionsDir(paths), { recursive: true });
    const big = { ...validSessionFixture(), padding: 'x'.repeat(300 * 1024) };
    await writeFile(join(sessionsDir(paths), 'huge.json'), JSON.stringify(big), 'utf8');

    const result = await listBackgroundSessions(paths);

    expect(result.sessions).toEqual([]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ level: 'warn', message: expect.stringContaining('oversized') }),
    ]);
  });

  test('skips unreadable metadata files and continues with a diagnostic', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ocs-bg-'));
    const paths = createOpenClaudePaths({ home, env: {} });
    const metaPath = join(sessionsDir(paths), 'unreadable.json');
    await writeSession(paths, 'unreadable', validSessionFixture({ id: 'unreadable' }));
    await chmod(metaPath, 0);

    try {
      const result = await listBackgroundSessions(paths);

      expect(result.sessions).toEqual([]);
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({ level: 'warn', message: expect.stringContaining('could not be read') }),
      );
    } finally {
      await chmod(metaPath, 0o600).catch(() => undefined);
    }
  });

  test('does not add a non-regular diagnostic when metadata stat is unavailable', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ocs-bg-'));
    const paths = createOpenClaudePaths({ home, env: {} });
    await writeSession(paths, 'blocked', validSessionFixture({ id: 'blocked' }));
    await chmod(sessionsDir(paths), 0o400);

    try {
      const result = await listBackgroundSessions(paths);

      expect(result.sessions).toEqual([]);
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({ level: 'warn', message: expect.stringContaining('could not be read') }),
      );
      expect(result.diagnostics).not.toContainEqual(
        expect.objectContaining({ message: expect.stringContaining('not a regular file') }),
      );
    } finally {
      await chmod(sessionsDir(paths), 0o700).catch(() => undefined);
    }
  });

  test('reports a diagnostic when the project index cannot be loaded', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ocs-bg-'));
    const paths = createOpenClaudePaths({ home, env: {} });
    await writeSession(paths, 'abc12345', validSessionFixture({ cwd: join(home, 'project-a') }));
    await writeFile(paths.openClaudeConfig, '{}', 'utf8');
    await chmod(paths.openClaudeConfig, 0);

    try {
      const result = await listBackgroundSessions(paths);

      expect(result.sessions).toHaveLength(1);
      expect(result.sessions[0]?.project).toBeNull();
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({ level: 'warn', message: expect.stringContaining('project index') }),
      );
    } finally {
      await chmod(paths.openClaudeConfig, 0o600).catch(() => undefined);
    }
  });

  test('normalizes missing optional fields to null', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ocs-bg-'));
    const paths = createOpenClaudePaths({ home, env: {} });
    await writeSession(
      paths,
      'partial',
      {
        id: 'partial',
        pid: 99,
        cwd: '/tmp',
        status: 'running',
        startedAt: '2026-06-01T10:00:00.000Z',
      },
    );

    const result = await listBackgroundSessions(paths);

    expect(result.sessions).toHaveLength(1);
    const summary = result.sessions[0];
    expect(summary?.name).toBeNull();
    expect(summary?.provider).toBeNull();
    expect(summary?.model).toBeNull();
    expect(summary?.sessionId).toBeNull();
    expect(summary?.updatedAt).toBeNull();
    expect(summary?.durationMs).toBeNull();
    expect(summary?.commandSummary).toEqual({ binary: null, flagCount: 0, truncated: false });
  });

  test('accepts records from older upstream versions with fewer fields', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ocs-bg-'));
    const paths = createOpenClaudePaths({ home, env: {} });
    await writeSession(paths, 'legacy', {
      id: 'legacy',
      pid: 1,
      status: 'exited',
      startedAt: '2026-01-01T00:00:00.000Z',
    });

    const result = await listBackgroundSessions(paths);

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]?.recordedStatus).toBe('exited');
  });

  test('sorts sessions newest-first by updatedAt', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ocs-bg-'));
    const paths = createOpenClaudePaths({ home, env: {} });
    await writeSession(paths, 'old', validSessionFixture({
      id: 'old',
      startedAt: '2026-06-01T10:00:00.000Z',
      updatedAt: '2026-06-01T10:00:00.000Z',
    }));
    await writeSession(paths, 'new', validSessionFixture({
      id: 'new',
      startedAt: '2026-06-02T10:00:00.000Z',
      updatedAt: '2026-06-02T10:00:00.000Z',
    }));

    const result = await listBackgroundSessions(paths);

    expect(result.sessions.map((s) => s.id)).toEqual(['new', 'old']);
  });

  test('reports stdout/stderr log availability based on canonical paths only', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ocs-bg-'));
    const paths = createOpenClaudePaths({ home, env: {} });
    await writeSession(paths, 'with-logs', validSessionFixture({ id: 'with-logs' }));
    await mkdir(logsDir(paths), { recursive: true });
    await writeFile(join(logsDir(paths), 'with-logs.out.log'), 'stdout line\n', 'utf8');

    const result = await listBackgroundSessions(paths);

    const summary = result.sessions[0];
    expect(summary?.stdoutLogAvailable).toBe(true);
    expect(summary?.stderrLogAvailable).toBe(false);
  });

  test('refuses to enumerate symlinked background session directories', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ocs-bg-'));
    const paths = createOpenClaudePaths({ home, env: {} });
    const externalSessions = join(home, 'external-sessions');
    await mkdir(externalSessions, { recursive: true });
    await writeFile(
      join(externalSessions, 'leaked.json'),
      JSON.stringify(validSessionFixture({ id: 'leaked' })),
      'utf8',
    );
    await mkdir(bgRoot(paths), { recursive: true });
    await symlink(externalSessions, sessionsDir(paths));

    const result = await listBackgroundSessions(paths);

    expect(result.sessions).toEqual([]);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ level: 'warn', message: expect.stringContaining('symlink') }),
    );
  });

  test('warns when the embedded log path points outside the logs root', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ocs-bg-'));
    const paths = createOpenClaudePaths({ home, env: {} });
    await writeSession(paths, 'sneaky', validSessionFixture({
      id: 'sneaky',
      stdoutLogPath: '/etc/passwd',
    }));

    const result = await listBackgroundSessions(paths);

    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        message: expect.stringContaining('points outside the expected logs root'),
      }),
    );
  });
});

describe('readBackgroundSessionLogs', () => {
  test('returns a bounded, redacted stdout window', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ocs-bg-'));
    const paths = createOpenClaudePaths({ home, env: {} });
    await mkdir(logsDir(paths), { recursive: true });
    await writeFile(
      join(logsDir(paths), 'sess.out.log'),
      [
        'starting up',
        'OPENAI_API_KEY=sk-deadbeefcafe calling api',
        'Authorization: Bearer abc123def456',
      ].join('\n'),
      'utf8',
    );

    const result = await readBackgroundSessionLogs(paths, 'sess', { stream: 'stdout', start: 0, count: 10 });

    expect(result.stream).toBe('stdout');
    expect(result.totalLines).toBe(3);
    expect(result.entries).toHaveLength(3);
    expect(result.entries[1]?.text).toBe('OPENAI_API_KEY=<redacted> calling api');
    expect(result.entries[2]?.text).toBe('Authorization: <redacted>');
  });

  test('returns a bounded stderr window', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ocs-bg-'));
    const paths = createOpenClaudePaths({ home, env: {} });
    await mkdir(logsDir(paths), { recursive: true });
    await writeFile(join(logsDir(paths), 'sess.err.log'), 'error line\n', 'utf8');

    const result = await readBackgroundSessionLogs(paths, 'sess', { stream: 'stderr' });

    expect(result.stream).toBe('stderr');
    expect(result.entries[0]?.text).toBe('error line');
  });

  test('returns empty entries with an info diagnostic when the log file is missing', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ocs-bg-'));
    const paths = createOpenClaudePaths({ home, env: {} });

    const result = await readBackgroundSessionLogs(paths, 'nope', {});

    expect(result.entries).toEqual([]);
    expect(result.totalLines).toBe(0);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ level: 'info' }),
    ]);
  });

  test('rejects unsafe session ids', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ocs-bg-'));
    const paths = createOpenClaudePaths({ home, env: {} });

    await expect(readBackgroundSessionLogs(paths, '../etc/passwd', {})).rejects.toThrow(
      'Invalid background session id.',
    );
    await expect(readBackgroundSessionLogs(paths, 'a'.repeat(129), {})).rejects.toThrow(
      'Invalid background session id.',
    );
  });

  test('refuses to read symlinked log files', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ocs-bg-'));
    const paths = createOpenClaudePaths({ home, env: {} });
    await mkdir(logsDir(paths), { recursive: true });
    await writeFile(join(home, 'secret.log'), 'top secret\n', 'utf8');
    await symlink(join(home, 'secret.log'), join(logsDir(paths), 'sym.out.log'));

    const result = await readBackgroundSessionLogs(paths, 'sym', {});

    expect(result.entries).toEqual([]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ level: 'warn', message: expect.stringContaining('symlink') }),
    ]);
  });

  test('refuses to read through a symlinked logs directory', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ocs-bg-'));
    const paths = createOpenClaudePaths({ home, env: {} });
    const externalLogs = join(home, 'external-logs');
    await mkdir(bgRoot(paths), { recursive: true });
    await mkdir(externalLogs, { recursive: true });
    await writeFile(join(externalLogs, 'sess.out.log'), 'top secret\n', 'utf8');
    await symlink(externalLogs, logsDir(paths));

    const result = await readBackgroundSessionLogs(paths, 'sess', {});

    expect(result.entries).toEqual([]);
    expect(result.totalLines).toBe(0);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ level: 'warn', message: expect.stringContaining('symlink') }),
    );
  });

  test('truncates oversized log files', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ocs-bg-'));
    const paths = createOpenClaudePaths({ home, env: {} });
    await mkdir(logsDir(paths), { recursive: true });
    const lines = Array.from({ length: 6000 }, () => 'x'.repeat(512));
    await writeFile(join(logsDir(paths), 'big.out.log'), lines.join('\n'), 'utf8');

    const result = await readBackgroundSessionLogs(paths, 'big', {});

    expect(result.truncated).toBe(true);
    expect(result.totalLines).toBeLessThan(6000);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ level: 'warn', message: expect.stringContaining('truncated') }),
    );
  });

  test('honors tail semantics', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ocs-bg-'));
    const paths = createOpenClaudePaths({ home, env: {} });
    await mkdir(logsDir(paths), { recursive: true });
    const lines = Array.from({ length: 10 }, (_, i) => `line-${i}`);
    await writeFile(join(logsDir(paths), 'tail.out.log'), lines.join('\n'), 'utf8');

    const result = await readBackgroundSessionLogs(paths, 'tail', { tail: true, count: 3 });

    expect(result.entries.map((e) => e.text)).toEqual(['line-7', 'line-8', 'line-9']);
    expect(result.start).toBe(7);
  });

  test('reads oversized tail windows from the file end (most recent output)', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ocs-bg-'));
    const paths = createOpenClaudePaths({ home, env: {} });
    await mkdir(logsDir(paths), { recursive: true });
    // ~3MB of content: 3000 lines of 1KB each. Each line ends with a unique
    // marker so we can assert the tail reflects the newest output.
    const lines = Array.from({ length: 3000 }, (_, i) => `L${String(i).padStart(4, '0')}`.padEnd(1024, 'x'));
    await writeFile(join(logsDir(paths), 'bigtail.out.log'), lines.join('\n'), 'utf8');

    const result = await readBackgroundSessionLogs(paths, 'bigtail', { tail: true, count: 3 });

    expect(result.truncated).toBe(true);
    expect(result.entries).toHaveLength(3);
    // The newest lines are L2997..L2999. If the read started at offset 0
    // (the old bug), the tail would be from the first ~2MB of the file
    // instead (around L1998). Line numbers are relative to the read tail
    // window because the original file's line count is not knowable without
    // reading the entire oversized file.
    expect(result.entries[2]?.text.startsWith('L2999')).toBe(true);
    expect(result.totalLines).toBe(result.entries[2]?.lineNumber);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ level: 'warn', message: expect.stringContaining('line numbers are relative') }),
    );
  });

  test('returns empty entries with a diagnostic when a log file is unreadable', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ocs-bg-'));
    const paths = createOpenClaudePaths({ home, env: {} });
    const logPath = join(logsDir(paths), 'unreadable.out.log');
    await mkdir(logsDir(paths), { recursive: true });
    await writeFile(logPath, 'secret output\n', 'utf8');
    await chmod(logPath, 0);

    try {
      const result = await readBackgroundSessionLogs(paths, 'unreadable', {});

      expect(result.entries).toEqual([]);
      expect(result.totalLines).toBe(0);
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({ level: 'warn', message: expect.stringContaining('could not be read') }),
      );
    } finally {
      await chmod(logPath, 0o600).catch(() => undefined);
    }
  });

  test('reports line-limit truncation and preserves original line numbers', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ocs-bg-'));
    const paths = createOpenClaudePaths({ home, env: {} });
    await mkdir(logsDir(paths), { recursive: true });
    // 6000 short lines — under the byte cap but over the 5000-line cap.
    const lines = Array.from({ length: 6000 }, (_, i) => `n${i}`);
    await writeFile(join(logsDir(paths), 'manylines.out.log'), lines.join('\n'), 'utf8');

    const result = await readBackgroundSessionLogs(paths, 'manylines', { tail: true, count: 3 });

    expect(result.truncated).toBe(true);
    expect(result.totalLines).toBe(6000);
    expect(result.entries).toHaveLength(3);
    // Line numbers are relative to the original file (we read all lines, just
    // dropped the oldest 1000 to honor the line cap).
    expect(result.entries[0]?.text).toBe('n5997');
    expect(result.entries[0]?.lineNumber).toBe(5998);
    expect(result.entries[2]?.lineNumber).toBe(6000);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ level: 'warn', message: expect.stringContaining('truncated') }),
    );
  });

  test('translates explicit start into the retained window after line-cap truncation', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ocs-bg-'));
    const paths = createOpenClaudePaths({ home, env: {} });
    await mkdir(logsDir(paths), { recursive: true });
    // 6000 short lines — the oldest 1000 are dropped to honor MAX_LOG_LINES.
    const lines = Array.from({ length: 6000 }, (_, i) => `n${i}`);
    await writeFile(join(logsDir(paths), 'manylines.out.log'), lines.join('\n'), 'utf8');

    // A start in the retained window's original-coordinate space must return the
    // matching lines, not an empty slice. Previously `start` was clamped to the
    // retained window length (5000), so start:5500 returned nothing.
    const result = await readBackgroundSessionLogs(paths, 'manylines', {
      start: 5500,
      count: 2,
    });

    expect(result.truncated).toBe(true);
    expect(result.totalLines).toBe(6000);
    expect(result.start).toBe(5500);
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0]?.text).toBe('n5500');
    expect(result.entries[0]?.lineNumber).toBe(5501);
    expect(result.entries[1]?.lineNumber).toBe(5502);
  });

  test('returns empty entries when start is before the retained window after truncation', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ocs-bg-'));
    const paths = createOpenClaudePaths({ home, env: {} });
    await mkdir(logsDir(paths), { recursive: true });
    const lines = Array.from({ length: 6000 }, (_, i) => `n${i}`);
    await writeFile(join(logsDir(paths), 'manylines.out.log'), lines.join('\n'), 'utf8');

    // start:100 refers to a line that was dropped (the oldest 1000 are gone).
    // The client should see an empty window with the original totalLines so it
    // can decide to page forward.
    const result = await readBackgroundSessionLogs(paths, 'manylines', {
      start: 100,
      count: 5,
    });

    expect(result.entries).toEqual([]);
    expect(result.totalLines).toBe(6000);
    expect(result.start).toBe(100);
  });
});
