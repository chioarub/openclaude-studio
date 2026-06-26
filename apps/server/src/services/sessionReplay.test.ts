import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { createOpenClaudePaths, encodeProjectPath } from './paths.js';
import { readSessionReplay } from './sessionReplay.js';

type Setup = {
  projectPath: string;
  paths: ReturnType<typeof createOpenClaudePaths>;
  projectDir: string;
  root: string;
  cleanup: () => Promise<void>;
};

async function setup(): Promise<Setup> {
  const root = await mkdtemp(join(tmpdir(), 'studio-replay-'));
  const projectPath = join(root, 'my-project');
  const paths = createOpenClaudePaths({ home: root });
  const projectDir = join(paths.projectsDir, encodeProjectPath(projectPath));
  await mkdir(projectDir, { recursive: true });
  return {
    projectPath,
    paths,
    projectDir,
    root,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

function validReplay(sessionId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionId,
    version: 1,
    createdAt: '2026-06-01T00:00:00.000Z',
    summary: {
      totalSteps: 3,
      toolBreakdown: { Read: 1, Write: 1 },
      filesModified: ['src/api.ts'],
      durationMs: 5000,
      startTimestamp: '2026-06-01T00:00:00.000Z',
      endTimestamp: '2026-06-01T00:00:05.000Z',
      userRequests: 1,
      retryAttempts: 0,
      repeatedAttempts: 0,
    },
    steps: [
      {
        type: 'user',
        stepNumber: 1,
        content: 'Create the API',
        timestamp: '2026-06-01T00:00:00.000Z',
      },
      {
        type: 'tool',
        stepNumber: 2,
        toolName: 'Write',
        toolUseId: 'tool-1',
        inputSummary: 'Write src/api.ts',
        resultStatus: 'success',
        resultPreview: 'File written successfully',
        durationMs: 100,
        timestamp: '2026-06-01T00:00:02.000Z',
        filesModified: ['src/api.ts'],
      },
      {
        type: 'tool',
        stepNumber: 3,
        toolName: 'Read',
        toolUseId: 'tool-2',
        inputSummary: 'Read src/api.ts',
        resultStatus: 'error',
        resultPreview: 'File not found',
        durationMs: 50,
        timestamp: '2026-06-01T00:00:03.000Z',
      },
    ],
    ...overrides,
  };
}

async function writeReplay(
  projectDir: string,
  projectPath: string,
  sessionId: string,
  data: unknown,
): Promise<void> {
  await writeTranscript(projectDir, projectPath, sessionId);
  await writeFile(
    join(projectDir, `${sessionId}.replay.json`),
    JSON.stringify(data),
    'utf8',
  );
}

async function writeTranscript(
  projectDir: string,
  projectPath: string,
  sessionId: string,
): Promise<void> {
  await writeFile(
    join(projectDir, `${sessionId}.jsonl`),
    `${JSON.stringify({
      type: 'user',
      sessionId,
      timestamp: '2026-06-01T00:00:00.000Z',
      cwd: projectPath,
      message: { role: 'user', content: `Session ${sessionId}` },
    })}\n`,
    'utf8',
  );
}

describe('readSessionReplay', () => {
  test('returns available with parsed summary and steps for a valid v1 replay', async () => {
    const { projectPath, projectDir, paths, cleanup } = await setup();
    try {
      await writeReplay(projectDir, projectPath, 'session-1', validReplay('session-1'));

      const result = await readSessionReplay(paths.projectsDir, { path: projectPath }, 'session-1');

      expect(result.status).toBe('available');
      if (result.status !== 'available') return;
      expect(result.version).toBe(1);
      expect(result.summary.totalSteps).toBe(3);
      expect(result.summary.toolBreakdown).toEqual([
        { tool: 'Read', count: 1 },
        { tool: 'Write', count: 1 },
      ]);
      expect(result.summary.filesModified).toEqual(['src/api.ts']);
      expect(result.steps).toHaveLength(3);
      expect(result.steps[1]).toMatchObject({
        type: 'tool',
        toolName: 'Write',
        resultStatus: 'success',
      });
    } finally {
      await cleanup();
    }
  });

  test('returns unavailable when no replay file exists', async () => {
    const { projectPath, projectDir, paths, cleanup } = await setup();
    try {
      await writeTranscript(projectDir, projectPath, 'session-1');
      const result = await readSessionReplay(paths.projectsDir, { path: projectPath }, 'session-1');
      expect(result.status).toBe('unavailable');
    } finally {
      await cleanup();
    }
  });

  test('does not read a replay sidecar without a project-scoped session transcript', async () => {
    const { projectPath, projectDir, paths, cleanup } = await setup();
    try {
      await writeTranscript(projectDir, projectPath, 'session-1');
      await writeFile(
        join(projectDir, 'orphan-session.replay.json'),
        JSON.stringify(validReplay('orphan-session')),
        'utf8',
      );

      const result = await readSessionReplay(
        paths.projectsDir,
        { path: projectPath },
        'orphan-session',
      );

      expect(result.status).toBe('unavailable');
      expect(result.diagnostics[0]?.message).toContain('transcript');
    } finally {
      await cleanup();
    }
  });

  test('does not read a same-session replay sidecar when the transcript belongs to another project', async () => {
    const { projectPath, projectDir, paths, root, cleanup } = await setup();
    try {
      const otherProjectPath = join(root, 'other-project');
      await writeTranscript(projectDir, otherProjectPath, 'session-1');
      await writeFile(
        join(projectDir, 'session-1.replay.json'),
        JSON.stringify(validReplay('session-1')),
        'utf8',
      );

      const result = await readSessionReplay(paths.projectsDir, { path: projectPath }, 'session-1');

      expect(result.status).toBe('unavailable');
      expect(result.diagnostics[0]?.message).toContain('transcript');
    } finally {
      await cleanup();
    }
  });

  test.runIf(process.platform !== 'win32' && process.getuid?.() !== 0)(
    'surfaces transcript read diagnostics before reading a replay sidecar',
    async () => {
      const { projectPath, projectDir, paths, cleanup } = await setup();
      const transcriptPath = join(projectDir, 'session-1.jsonl');
      try {
        await writeTranscript(projectDir, projectPath, 'session-1');
        await writeFile(
          join(projectDir, 'session-1.replay.json'),
          JSON.stringify(validReplay('session-1')),
          'utf8',
        );
        await chmod(transcriptPath, 0);

        const result = await readSessionReplay(paths.projectsDir, { path: projectPath }, 'session-1');

        expect(result.status).toBe('unavailable');
        expect(result.diagnostics).toContainEqual(expect.objectContaining({
          level: 'warn',
          message: 'Transcript file could not be read.',
        }));
        expect(result.diagnostics[0]).not.toHaveProperty('path');
      } finally {
        await chmod(transcriptPath, 0o600).catch(() => undefined);
        await cleanup();
      }
    },
  );

  test('returns unsupported_version for an unknown schema version', async () => {
    const { projectPath, projectDir, paths, cleanup } = await setup();
    try {
      await writeReplay(projectDir, projectPath, 'session-1', {
        ...validReplay('session-1'),
        version: 99,
      });
      const result = await readSessionReplay(paths.projectsDir, { path: projectPath }, 'session-1');
      expect(result.status).toBe('unsupported_version');
      if (result.status !== 'unsupported_version') return;
      expect(result.version).toBe(99);
      expect(result.supported).toBe(false);
    } finally {
      await cleanup();
    }
  });

  test('returns malformed for invalid JSON', async () => {
    const { projectPath, projectDir, paths, cleanup } = await setup();
    try {
      await writeTranscript(projectDir, projectPath, 'session-1');
      await writeFile(
        join(projectDir, 'session-1.replay.json'),
        '{ not json',
        'utf8',
      );
      const result = await readSessionReplay(paths.projectsDir, { path: projectPath }, 'session-1');
      expect(result.status).toBe('malformed');
    } finally {
      await cleanup();
    }
  });

  test('returns malformed when sessionId inside file does not match', async () => {
    const { projectPath, projectDir, paths, cleanup } = await setup();
    try {
      await writeReplay(projectDir, projectPath, 'session-1', validReplay('different-session'));
      const result = await readSessionReplay(paths.projectsDir, { path: projectPath }, 'session-1');
      expect(result.status).toBe('malformed');
    } finally {
      await cleanup();
    }
  });

  test('returns malformed for an invalid step discriminant', async () => {
    const { projectPath, projectDir, paths, cleanup } = await setup();
    try {
      const data = validReplay('session-1');
      (data.steps as unknown[]).push({ type: 'unknown-type', stepNumber: 99 });
      await writeReplay(projectDir, projectPath, 'session-1', data);
      const result = await readSessionReplay(paths.projectsDir, { path: projectPath }, 'session-1');
      expect(result.status).toBe('malformed');
    } finally {
      await cleanup();
    }
  });

  test('returns malformed for fractional summary counters', async () => {
    const { projectPath, projectDir, paths, cleanup } = await setup();
    try {
      const data = validReplay('session-1');
      (data.summary as Record<string, unknown>).totalSteps = 1.5;
      await writeReplay(projectDir, projectPath, 'session-1', data);
      const result = await readSessionReplay(paths.projectsDir, { path: projectPath }, 'session-1');
      expect(result.status).toBe('malformed');
      expect(result.diagnostics[0]?.message).toContain('totalSteps');
    } finally {
      await cleanup();
    }
  });

  test('normalizes invalid timestamps to null while keeping the replay available', async () => {
    const { projectPath, projectDir, paths, cleanup } = await setup();
    try {
      const data = validReplay('session-1');
      (data.summary as Record<string, unknown>).startTimestamp = 'not-a-date';
      await writeReplay(projectDir, projectPath, 'session-1', data);
      const result = await readSessionReplay(paths.projectsDir, { path: projectPath }, 'session-1');
      expect(result.status).toBe('available');
      if (result.status !== 'available') return;
      expect(result.summary.startTimestamp).toBeNull();
      expect(result.summary.endTimestamp).toBe('2026-06-01T00:00:05.000Z');
    } finally {
      await cleanup();
    }
  });

  test('returns malformed for an oversized file', async () => {
    const { projectPath, projectDir, paths, cleanup } = await setup();
    try {
      const large = { ...validReplay('session-1'), padding: 'x'.repeat(1024 * 1024 + 10) };
      await writeReplay(projectDir, projectPath, 'session-1', large);
      const result = await readSessionReplay(paths.projectsDir, { path: projectPath }, 'session-1');
      expect(result.status).toBe('malformed');
    } finally {
      await cleanup();
    }
  });

  test('truncates steps when there are too many', async () => {
    const { projectPath, projectDir, paths, cleanup } = await setup();
    try {
      const data = validReplay('session-1');
      const manySteps = Array.from({ length: 600 }, (_, i) => ({
        type: 'user',
        stepNumber: i + 10,
        content: `step ${i}`,
        timestamp: '2026-06-01T00:00:00.000Z',
      }));
      data.steps = manySteps;
      (data.summary as Record<string, unknown>).totalSteps = 600;
      await writeReplay(projectDir, projectPath, 'session-1', data);
      const result = await readSessionReplay(paths.projectsDir, { path: projectPath }, 'session-1');
      expect(result.status).toBe('available');
      if (result.status !== 'available') return;
      expect(result.steps.length).toBeLessThanOrEqual(500);
      expect(result.stepsTruncated).toBe(true);
    } finally {
      await cleanup();
    }
  });

  test('rejects a symlinked replay file', async () => {
    const { projectPath, projectDir, paths, root, cleanup } = await setup();
    try {
      const target = join(root, 'evil.json');
      await writeFile(target, JSON.stringify(validReplay('session-1')), 'utf8');
      await writeTranscript(projectDir, projectPath, 'session-1');
      await symlink(target, join(projectDir, 'session-1.replay.json'));
      const result = await readSessionReplay(paths.projectsDir, { path: projectPath }, 'session-1');
      // Symlink is explicitly rejected as malformed, not silently unavailable
      expect(result.status).toBe('malformed');
    } finally {
      await cleanup();
    }
  });

  test('rejects a traversal-like session ID', async () => {
    const { projectPath, paths, cleanup } = await setup();
    try {
      await expect(
        readSessionReplay(paths.projectsDir, { path: projectPath }, '../../etc/passwd'),
      ).rejects.toThrow();
    } finally {
      await cleanup();
    }
  });

  test('accepts dotted session IDs while rejecting dot-dot traversal markers', async () => {
    const { projectPath, projectDir, paths, cleanup } = await setup();
    try {
      await writeReplay(projectDir, projectPath, 'session.v1', validReplay('session.v1'));

      const result = await readSessionReplay(paths.projectsDir, { path: projectPath }, 'session.v1');

      expect(result.status).toBe('available');
      expect(result.sessionId).toBe('session.v1');
      await expect(
        readSessionReplay(paths.projectsDir, { path: projectPath }, 'session..v1'),
      ).rejects.toThrow('Session ID contains invalid characters.');
    } finally {
      await cleanup();
    }
  });

  test('returns conflict when conflicting replay files exist in multiple roots', async () => {
    const { projectPath, paths, projectDir, cleanup } = await setup();
    try {
      await writeReplay(projectDir, projectPath, 'session-1', validReplay('session-1'));
      const aliasDir = join(
        paths.projectsDir,
        encodeProjectPath(join(projectPath, '.claude', 'worktrees', 'feature-a')),
      );
      await mkdir(aliasDir, { recursive: true });
      await writeReplay(aliasDir, projectPath, 'session-1', validReplay('session-1'));
      const result = await readSessionReplay(paths.projectsDir, { path: projectPath }, 'session-1');
      expect(result.status).toBe('conflict');
      expect(result.diagnostics[0]?.message).toContain('Multiple conflicting replay files');
    } finally {
      await cleanup();
    }
  });

  test('redacts secrets in tool input summary, user content, and error messages', async () => {
    const { projectPath, projectDir, paths, cleanup } = await setup();
    try {
      const data = validReplay('session-1');
      data.steps = [
        {
          type: 'user',
          stepNumber: 1,
          content: 'My key is sk-abcd1234efgh5678',
          timestamp: '2026-06-01T00:00:00.000Z',
        },
        {
          type: 'tool',
          stepNumber: 2,
          toolName: 'Bash',
          toolUseId: 'tool-1',
          inputSummary: 'Run command with token=secret123',
          resultStatus: 'success',
          durationMs: 10,
          timestamp: '2026-06-01T00:00:01.000Z',
        },
        {
          type: 'error',
          stepNumber: 3,
          error: 'Auth failed with bearer abcdef1234567890',
          timestamp: '2026-06-01T00:00:02.000Z',
        },
      ];
      await writeReplay(projectDir, projectPath, 'session-1', data);
      const result = await readSessionReplay(paths.projectsDir, { path: projectPath }, 'session-1');
      expect(result.status).toBe('available');
      if (result.status !== 'available') return;
      const userStep = result.steps[0];
      if (userStep.type !== 'user') throw new Error('expected user step');
      expect(userStep.content).not.toContain('sk-abcd1234efgh5678');
      const toolStep = result.steps[1];
      if (toolStep.type !== 'tool') throw new Error('expected tool step');
      expect(toolStep.inputSummary).not.toContain('secret123');
      const errorStep = result.steps[2];
      if (errorStep.type !== 'error') throw new Error('expected error step');
      expect(errorStep.error).not.toContain('abcdef1234567890');
    } finally {
      await cleanup();
    }
  });

  test('omits unsafe modified file paths before returning replay data', async () => {
    const { projectPath, projectDir, paths, cleanup } = await setup();
    try {
      const data = validReplay('session-1');
      (data.summary as Record<string, unknown>).filesModified = [
        'src/api.ts',
        '/home/user/.openclaude/session.json',
        '../outside.ts',
        'C:\\Users\\me\\secret.ts',
        'src/token=secret-value.ts',
        `src/${'a'.repeat(260)}/../secret.ts`,
      ];
      data.steps = [
        {
          type: 'tool',
          stepNumber: 1,
          toolName: 'Write',
          toolUseId: 'tool-1',
          inputSummary: 'Write files',
          resultStatus: 'success',
          durationMs: 10,
          timestamp: '2026-06-01T00:00:00.000Z',
          filesModified: [
            'src/ok.ts',
            '/private/path.ts',
            '..\\outside.ts',
            'src/password=private.ts',
            `src/${'b'.repeat(260)}/../secret.ts`,
          ],
        },
      ];
      await writeReplay(projectDir, projectPath, 'session-1', data);
      const result = await readSessionReplay(paths.projectsDir, { path: projectPath }, 'session-1');
      expect(result.status).toBe('available');
      if (result.status !== 'available') return;

      expect(result.summary.filesModified).toEqual(['src/api.ts', 'src/token=<redacted>']);
      const step = result.steps[0];
      if (step.type !== 'tool') throw new Error('expected tool step');
      expect(step.filesModified).toEqual(['src/ok.ts', 'src/password=<redacted>']);
      expect(result.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            level: 'warn',
            message: 'Unsafe replay file path was omitted from the response.',
          }),
        ]),
      );
    } finally {
      await cleanup();
    }
  });

  test('redacts replay strings before applying length caps', async () => {
    const { projectPath, projectDir, paths, cleanup } = await setup();
    try {
      const secret = `sk-${'a'.repeat(24)}`;
      const nearInputLimit = `${'x'.repeat(232)}${secret}`;
      const nearReasonLimit = `${'y'.repeat(472)}${secret}`;
      const data = validReplay('session-1');
      data.steps = [
        {
          type: 'tool',
          stepNumber: 1,
          toolName: 'Bash',
          toolUseId: secret,
          inputSummary: nearInputLimit,
          resultStatus: 'success',
          resultPreview: nearInputLimit,
          durationMs: 10,
          timestamp: '2026-06-01T00:00:00.000Z',
        },
        {
          type: 'user',
          stepNumber: 2,
          content: `${'u'.repeat(992)}${secret}`,
          timestamp: '2026-06-01T00:00:01.000Z',
        },
        {
          type: 'retry',
          stepNumber: 3,
          retryType: 'api',
          reason: nearReasonLimit,
          commands: [nearReasonLimit],
          timestamp: '2026-06-01T00:00:02.000Z',
        },
        {
          type: 'error',
          stepNumber: 4,
          error: nearReasonLimit,
          timestamp: '2026-06-01T00:00:03.000Z',
        },
      ];
      (data.summary as Record<string, unknown>).totalSteps = 4;
      await writeReplay(projectDir, projectPath, 'session-1', data);
      const result = await readSessionReplay(paths.projectsDir, { path: projectPath }, 'session-1');
      expect(result.status).toBe('available');
      if (result.status !== 'available') return;

      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(secret.slice(0, 8));
      expect(serialized).toContain('<redacted>');
      expect(serialized).not.toContain('<redacte"');
    } finally {
      await cleanup();
    }
  });

  test('truncates result preview and file list', async () => {
    const { projectPath, projectDir, paths, cleanup } = await setup();
    try {
      const data = validReplay('session-1');
      data.steps = [
        {
          type: 'tool',
          stepNumber: 1,
          toolName: 'Bash',
          toolUseId: 'tool-1',
          inputSummary: 'Run',
          resultStatus: 'success',
          resultPreview: 'x'.repeat(500),
          durationMs: 10,
          timestamp: '2026-06-01T00:00:00.000Z',
          filesModified: Array.from({ length: 100 }, (_, i) => `file-${i}.ts`),
        },
      ];
      await writeReplay(projectDir, projectPath, 'session-1', data);
      const result = await readSessionReplay(paths.projectsDir, { path: projectPath }, 'session-1');
      expect(result.status).toBe('available');
      if (result.status !== 'available') return;
      const step = result.steps[0];
      if (step.type !== 'tool') throw new Error('expected tool step');
      expect(step.resultPreview!.length).toBeLessThanOrEqual(240);
      expect(step.resultPreviewTruncated).toBe(true);
      expect(step.filesModified.length).toBeLessThanOrEqual(50);
      expect(step.filesModifiedTruncated).toBe(true);
    } finally {
      await cleanup();
    }
  });

  test('parses retry and repeated-attempt metadata', async () => {
    const { projectPath, projectDir, paths, cleanup } = await setup();
    try {
      const data = validReplay('session-1');
      data.steps = [
        {
          type: 'tool',
          stepNumber: 1,
          toolName: 'Bash',
          toolUseId: 'tool-1',
          inputSummary: 'Run cmd',
          resultStatus: 'success',
          durationMs: 10,
          timestamp: '2026-06-01T00:00:00.000Z',
          repeatedAttemptNumber: 2,
          isRepeatedAttempt: true,
        },
        {
          type: 'retry',
          stepNumber: 2,
          retryType: 'api',
          attempt: 2,
          maxRetries: 3,
          retryDelayMs: 500,
          reason: 'Rate limited',
          timestamp: '2026-06-01T00:00:01.000Z',
        },
      ];
      await writeReplay(projectDir, projectPath, 'session-1', data);
      const result = await readSessionReplay(paths.projectsDir, { path: projectPath }, 'session-1');
      expect(result.status).toBe('available');
      if (result.status !== 'available') return;
      const toolStep = result.steps[0];
      if (toolStep.type !== 'tool') throw new Error('expected tool step');
      expect(toolStep.isRepeatedAttempt).toBe(true);
      expect(toolStep.repeatedAttemptNumber).toBe(2);
      const retryStep = result.steps[1];
      if (retryStep.type !== 'retry') throw new Error('expected retry step');
      expect(retryStep.retryType).toBe('api');
      expect(retryStep.attempt).toBe(2);
      expect(retryStep.retryDelayMs).toBe(500);
    } finally {
      await cleanup();
    }
  });
});
