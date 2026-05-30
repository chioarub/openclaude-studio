import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import type { ProjectSummary } from '@openclaude-studio/shared';

import { createOpenClaudePaths, encodeProjectPath } from './paths.js';
import { readSessionDetails } from './sessionDetails.js';

describe('readSessionDetails', () => {
  test('returns session details with timeline for an existing session', async () => {
    const { projectPath, paths, cleanup } = await setup();
    try {
      const projectDir = join(paths.projectsDir, encodeProjectPath(projectPath));
      await mkdir(projectDir, { recursive: true });
      await writeFile(
        join(projectDir, 'session-1.jsonl'),
        [
          jsonl({
            type: 'user',
            sessionId: 'session-1',
            timestamp: '2026-05-28T08:00:00.000Z',
            cwd: projectPath,
            message: { role: 'user', content: 'Build the API' },
          }),
          jsonl({
            type: 'assistant',
            sessionId: 'session-1',
            timestamp: '2026-05-28T08:01:00.000Z',
            cwd: projectPath,
            message: {
              role: 'assistant',
              model: 'claude-sonnet',
              usage: {
                input_tokens: 100,
                output_tokens: 200,
                cache_read_input_tokens: 50,
                cache_creation_input_tokens: 25,
              },
              content: [
                { type: 'text', text: 'I will create the API file.' },
                { type: 'tool_use', name: 'Write', id: 'tool-1', input: { file_path: 'src/api.ts' } },
              ],
            },
          }),
        ].join('\n'),
        'utf8',
      );

      const result = await readSessionDetails(paths, projectSummary(projectPath), 'session-1');

      expect(result).not.toBeNull();
      expect(result!.session).toMatchObject({
        id: 'session-1',
        title: 'Build the API',
        status: 'completed',
        tokens: {
          input: 100,
          output: 200,
          cacheRead: 50,
          cacheWrite: 25,
        },
      });
      // Expect: 1 user event, 1 assistant text event, 1 tool call event
      expect(result!.timeline).toHaveLength(3);
      expect(result!.timeline[0]).toMatchObject({
        kind: 'user',
        title: 'User message',
        content: 'Build the API',
      });
      expect(result!.timeline[1]).toMatchObject({
        kind: 'assistant',
        title: 'claude-sonnet',
        content: 'I will create the API file.',
      });
      expect(result!.timeline[2]).toMatchObject({
        kind: 'tool',
        title: 'Write file',
        tool: {
          phase: 'call',
          name: 'Write',
          filePath: 'src/api.ts',
          outputType: 'file',
        },
      });
    } finally {
      await cleanup();
    }
  });

  test('returns null when session ID does not exist', async () => {
    const { projectPath, paths, cleanup } = await setup();
    try {
      const projectDir = join(paths.projectsDir, encodeProjectPath(projectPath));
      await mkdir(projectDir, { recursive: true });

      const result = await readSessionDetails(paths, projectSummary(projectPath), 'nonexistent');

      expect(result).toBeNull();
    } finally {
      await cleanup();
    }
  });

  test('parses tool call events from assistant entry toolUses', async () => {
    const { projectPath, paths, cleanup } = await setup();
    try {
      const projectDir = join(paths.projectsDir, encodeProjectPath(projectPath));
      await mkdir(projectDir, { recursive: true });
      await writeFile(
        join(projectDir, 'session-2.jsonl'),
        [
          jsonl({
            type: 'user',
            sessionId: 'session-2',
            timestamp: '2026-05-28T09:00:00.000Z',
            cwd: projectPath,
            message: { role: 'user', content: 'Edit the file' },
          }),
          jsonl({
            type: 'assistant',
            sessionId: 'session-2',
            timestamp: '2026-05-28T09:01:00.000Z',
            cwd: projectPath,
            message: {
              role: 'assistant',
              model: 'claude-sonnet',
              usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
              content: [
                { type: 'text', text: 'Editing now.' },
                { type: 'tool_use', name: 'Edit', id: 'tool-e1', input: { file_path: 'src/api.ts' } },
                { type: 'tool_use', name: 'Edit', id: 'tool-e2', input: { file_path: 'src/utils.ts' } },
              ],
            },
          }),
        ].join('\n'),
        'utf8',
      );

      const result = await readSessionDetails(paths, projectSummary(projectPath), 'session-2');

      expect(result).not.toBeNull();
      // 1 user + 1 assistant text + 2 tool calls
      const toolCallEvents = result!.timeline.filter((e) => e.kind === 'tool' && e.tool?.phase === 'call');
      expect(toolCallEvents).toHaveLength(2);
      expect(toolCallEvents[0]).toMatchObject({
        kind: 'tool',
        title: 'Edit file',
        tool: { name: 'Edit', filePath: 'src/api.ts', phase: 'call' },
      });
      expect(toolCallEvents[1]).toMatchObject({
        tool: { name: 'Edit', filePath: 'src/utils.ts' },
      });
      // changedFiles should include both
      expect(result!.session.changedFiles).toEqual(
        expect.arrayContaining(['src/api.ts', 'src/utils.ts']),
      );
    } finally {
      await cleanup();
    }
  });

  test('handles tool result entries', async () => {
    const { projectPath, paths, cleanup } = await setup();
    try {
      const projectDir = join(paths.projectsDir, encodeProjectPath(projectPath));
      await mkdir(projectDir, { recursive: true });
      await writeFile(
        join(projectDir, 'session-tool-result.jsonl'),
        [
          jsonl({
            type: 'user',
            sessionId: 'session-tr',
            timestamp: '2026-05-28T10:00:00.000Z',
            cwd: projectPath,
            message: { role: 'user', content: 'Read the file' },
          }),
          jsonl({
            type: 'tool',
            sessionId: 'session-tr',
            timestamp: '2026-05-28T10:01:00.000Z',
            cwd: projectPath,
            message: {
              role: 'tool',
              tool_use_id: 'tool-1',
              content: 'export function hello() { return "world"; }',
            },
          }),
        ].join('\n'),
        'utf8',
      );

      const result = await readSessionDetails(paths, projectSummary(projectPath), 'session-tr');

      expect(result).not.toBeNull();
      const resultEvents = result!.timeline.filter((e) => e.kind === 'tool' && e.tool?.phase === 'result');
      expect(resultEvents).toHaveLength(1);
      expect(resultEvents[0]).toMatchObject({
        kind: 'tool',
        title: 'Tool result',
        content: 'export function hello() { return "world"; }',
        tool: {
          phase: 'result',
          status: 'success',
        },
      });
    } finally {
      await cleanup();
    }
  });

  test('creates error events for failed system entries', async () => {
    const { projectPath, paths, cleanup } = await setup();
    try {
      const projectDir = join(paths.projectsDir, encodeProjectPath(projectPath));
      await mkdir(projectDir, { recursive: true });
      await writeFile(
        join(projectDir, 'session-3.jsonl'),
        [
          jsonl({
            type: 'user',
            sessionId: 'session-3',
            timestamp: '2026-05-28T10:00:00.000Z',
            cwd: projectPath,
            message: { role: 'user', content: 'Do something' },
          }),
          jsonl({
            type: 'system',
            level: 'error',
            sessionId: 'session-3',
            timestamp: '2026-05-28T10:01:00.000Z',
            cwd: projectPath,
            message: 'API rate limit exceeded',
          }),
        ].join('\n'),
        'utf8',
      );

      const result = await readSessionDetails(paths, projectSummary(projectPath), 'session-3');

      expect(result).not.toBeNull();
      expect(result!.session.status).toBe('failed');
      const errorEvents = result!.timeline.filter((e) => e.kind === 'error');
      expect(errorEvents).toHaveLength(1);
      expect(errorEvents[0]).toMatchObject({
        kind: 'error',
        title: 'Error',
        content: 'API rate limit exceeded',
      });
    } finally {
      await cleanup();
    }
  });

  test('keeps non-error system events in the conversation timeline', async () => {
    const { projectPath, paths, cleanup } = await setup();
    try {
      const projectDir = join(paths.projectsDir, encodeProjectPath(projectPath));
      await mkdir(projectDir, { recursive: true });
      await writeFile(
        join(projectDir, 'session-system.jsonl'),
        [
          jsonl({
            type: 'system',
            sessionId: 'session-system',
            timestamp: '2026-05-28T10:02:00.000Z',
            cwd: projectPath,
            content: 'Working directory changed.',
          }),
          jsonl({
            type: 'system',
            sessionId: 'session-system',
            timestamp: '2026-05-28T10:03:00.000Z',
            cwd: projectPath,
            content: '   ',
          }),
        ].join('\n'),
        'utf8',
      );

      const result = await readSessionDetails(paths, projectSummary(projectPath), 'session-system');

      expect(result).not.toBeNull();
      expect(result!.timeline).toEqual([
        expect.objectContaining({
          kind: 'system',
          title: 'System',
          content: 'Working directory changed.',
        }),
      ]);
    } finally {
      await cleanup();
    }
  });

  test('redacts sensitive content from timeline events', async () => {
    const { projectPath, paths, cleanup } = await setup();
    try {
      const projectDir = join(paths.projectsDir, encodeProjectPath(projectPath));
      await mkdir(projectDir, { recursive: true });
      await writeFile(
        join(projectDir, 'session-4.jsonl'),
        [
          jsonl({
            type: 'user',
            sessionId: 'session-4',
            timestamp: '2026-05-28T11:00:00.000Z',
            cwd: projectPath,
            message: { role: 'user', content: 'My API key is sk-1234567890abcdef1234567890abcdef' },
          }),
        ].join('\n'),
        'utf8',
      );

      const result = await readSessionDetails(paths, projectSummary(projectPath), 'session-4');

      expect(result).not.toBeNull();
      const userEvent = result!.timeline.find((e) => e.kind === 'user');
      expect(userEvent?.content).toContain('<redacted>');
      expect(userEvent?.content).not.toContain('sk-1234567890abcdef1234567890abcdef');
    } finally {
      await cleanup();
    }
  });

  test('counts tools from structured toolUses array', async () => {
    const { projectPath, paths, cleanup } = await setup();
    try {
      const projectDir = join(paths.projectsDir, encodeProjectPath(projectPath));
      await mkdir(projectDir, { recursive: true });
      await writeFile(
        join(projectDir, 'session-5.jsonl'),
        [
          jsonl({
            type: 'user',
            sessionId: 'session-5',
            timestamp: '2026-05-28T12:00:00.000Z',
            cwd: projectPath,
            message: { role: 'user', content: 'Multi-edit task' },
          }),
          jsonl({
            type: 'assistant',
            sessionId: 'session-5',
            timestamp: '2026-05-28T12:01:00.000Z',
            cwd: projectPath,
            message: {
              role: 'assistant',
              model: 'claude-sonnet',
              usage: { input_tokens: 50, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
              content: [
                { type: 'text', text: 'Working on it.' },
                { type: 'tool_use', name: 'Edit', id: 't1', input: { file_path: 'src/a.ts' } },
                { type: 'tool_use', name: 'Edit', id: 't2', input: { file_path: 'src/b.ts' } },
                { type: 'tool_use', name: 'Write', id: 't3', input: { file_path: 'src/c.ts' } },
              ],
            },
          }),
        ].join('\n'),
        'utf8',
      );

      const result = await readSessionDetails(paths, projectSummary(projectPath), 'session-5');

      expect(result).not.toBeNull();
      expect(result!.session.toolsUsed).toEqual(
        expect.arrayContaining([
          { name: 'Edit', count: 2 },
          { name: 'Write', count: 1 },
        ]),
      );
      expect(result!.session.changedFiles).toEqual(
        expect.arrayContaining(['src/a.ts', 'src/b.ts', 'src/c.ts']),
      );
    } finally {
      await cleanup();
    }
  });

  test('resolves linked tasks from .openclaude/tasks directory', async () => {
    const { projectPath, paths, cleanup } = await setup();
    try {
      const projectDir = join(paths.projectsDir, encodeProjectPath(projectPath));
      await mkdir(projectDir, { recursive: true });
      const tasksDir = join(paths.tasksDir, 'session-6');
      await mkdir(tasksDir, { recursive: true });
      await writeFile(
        join(tasksDir, '1.json'),
        JSON.stringify({
          subject: 'Implement auth',
          status: 'in_progress',
          description: 'Add authentication flow',
        }),
        'utf8',
      );
      await writeFile(
        join(projectDir, 'session-6.jsonl'),
        [
          jsonl({
            type: 'user',
            sessionId: 'session-6',
            timestamp: '2026-05-28T13:00:00.000Z',
            cwd: projectPath,
            message: { role: 'user', content: 'Work on tasks' },
          }),
        ].join('\n'),
        'utf8',
      );

      const result = await readSessionDetails(paths, projectSummary(projectPath), 'session-6');

      expect(result).not.toBeNull();
      expect(result!.session.linkedTasks).toHaveLength(1);
      expect(result!.session.linkedTasks[0]).toMatchObject({
        id: '1',
        title: 'Implement auth',
        status: 'in_progress',
      });
      expect(result!.session.linkedTasks[0]).not.toHaveProperty('path');
    } finally {
      await cleanup();
    }
  });

  test('pairs structured tool calls with command and file results', async () => {
    const { projectPath, paths, cleanup } = await setup();
    try {
      const projectDir = join(paths.projectsDir, encodeProjectPath(projectPath));
      const editedFile = join(projectPath, 'src/App.tsx');
      await mkdir(projectDir, { recursive: true });
      await writeFile(
        join(projectDir, 'session-tools.jsonl'),
        [
          jsonl({
            type: 'assistant',
            sessionId: 'session-tools',
            timestamp: '2026-05-28T16:00:00.000Z',
            cwd: projectPath,
            message: {
              role: 'assistant',
              content: [{ type: 'tool_use', id: 'call-write', name: 'Write', input: { file_path: editedFile } }],
            },
          }),
          jsonl({
            type: 'user',
            sessionId: 'session-tools',
            timestamp: '2026-05-28T16:00:05.000Z',
            cwd: projectPath,
            message: {
              role: 'user',
              content: [{ type: 'tool_result', tool_use_id: 'call-write', content: `File created successfully at: ${editedFile}` }],
            },
            toolUseResult: { type: 'create', filePath: editedFile },
          }),
          jsonl({
            type: 'assistant',
            sessionId: 'session-tools',
            timestamp: '2026-05-28T16:01:00.000Z',
            cwd: projectPath,
            message: {
              role: 'assistant',
              content: [{ type: 'tool_use', id: 'call-bash', name: 'Bash', input: { command: 'npm test' } }],
            },
          }),
          jsonl({
            type: 'user',
            sessionId: 'session-tools',
            timestamp: '2026-05-28T16:01:05.000Z',
            cwd: projectPath,
            message: {
              role: 'user',
              content: [{ type: 'tool_result', tool_use_id: 'call-bash', content: 'ok\n', is_error: false }],
            },
            toolUseResult: { stdout: 'ok\n', stderr: '', interrupted: false },
          }),
        ].join('\n'),
        'utf8',
      );

      const result = await readSessionDetails(paths, projectSummary(projectPath), 'session-tools');

      expect(result).not.toBeNull();
      expect(result!.timeline.map((event) => ({
        title: event.title,
        content: event.content,
        tool: event.tool,
      }))).toEqual([
        {
          title: 'Write file',
          content: editedFile,
          tool: {
            phase: 'call',
            name: 'Write',
            status: 'unknown',
            command: null,
            filePath: editedFile,
            outputType: 'file',
          },
        },
        {
          title: 'File created',
          content: editedFile,
          tool: {
            phase: 'result',
            name: 'Write',
            status: 'success',
            command: null,
            filePath: editedFile,
            outputType: 'file',
          },
        },
        {
          title: 'Run command',
          content: 'npm test',
          tool: {
            phase: 'call',
            name: 'Bash',
            status: 'unknown',
            command: 'npm test',
            filePath: null,
            outputType: 'command',
          },
        },
        {
          title: 'Command output',
          content: 'ok\n',
          tool: {
            phase: 'result',
            name: 'Bash',
            status: 'success',
            command: 'npm test',
            filePath: null,
            outputType: 'stdout',
          },
        },
      ]);
    } finally {
      await cleanup();
    }
  });

  test('prefers stderr for failed command results that also include stdout', async () => {
    const { projectPath, paths, cleanup } = await setup();
    try {
      const projectDir = join(paths.projectsDir, encodeProjectPath(projectPath));
      await mkdir(projectDir, { recursive: true });
      await writeFile(
        join(projectDir, 'session-stderr.jsonl'),
        [
          jsonl({
            type: 'assistant',
            sessionId: 'session-stderr',
            timestamp: '2026-05-28T16:10:00.000Z',
            cwd: projectPath,
            message: {
              role: 'assistant',
              content: [{ type: 'tool_use', id: 'call-bash', name: 'Bash', input: { command: 'npm test' } }],
            },
          }),
          jsonl({
            type: 'user',
            sessionId: 'session-stderr',
            timestamp: '2026-05-28T16:10:05.000Z',
            cwd: projectPath,
            message: {
              role: 'user',
              content: [{ type: 'tool_result', tool_use_id: 'call-bash', content: 'stdout fallback', is_error: true }],
            },
            toolUseResult: {
              stdout: 'stdout fallback',
              stderr: 'test failed',
              interrupted: false,
            },
          }),
        ].join('\n'),
        'utf8',
      );

      const result = await readSessionDetails(paths, projectSummary(projectPath), 'session-stderr');

      expect(result).not.toBeNull();
      const resultEvent = result!.timeline.find((event) => event.tool?.phase === 'result');
      expect(resultEvent).toMatchObject({
        title: 'Command error',
        content: 'test failed',
        tool: {
          status: 'error',
          outputType: 'stderr',
        },
      });
    } finally {
      await cleanup();
    }
  });

  test('pairs legacy tool rows by message tool_use_id instead of latest call fallback', async () => {
    const { projectPath, paths, cleanup } = await setup();
    try {
      const projectDir = join(paths.projectsDir, encodeProjectPath(projectPath));
      await mkdir(projectDir, { recursive: true });
      await writeFile(
        join(projectDir, 'session-legacy-tools.jsonl'),
        [
          jsonl({
            type: 'assistant',
            sessionId: 'session-legacy-tools',
            timestamp: '2026-05-28T18:00:00.000Z',
            cwd: projectPath,
            message: {
              role: 'assistant',
              content: [
                { type: 'tool_use', id: 'call-read', name: 'Read', input: { file_path: 'src/readme.md' } },
                { type: 'tool_use', id: 'call-bash', name: 'Bash', input: { command: 'npm test' } },
              ],
            },
          }),
          jsonl({
            type: 'tool',
            sessionId: 'session-legacy-tools',
            timestamp: '2026-05-28T18:00:05.000Z',
            cwd: projectPath,
            message: {
              role: 'tool',
              tool_use_id: 'call-read',
              content: 'README contents',
            },
          }),
        ].join('\n'),
        'utf8',
      );

      const result = await readSessionDetails(paths, projectSummary(projectPath), 'session-legacy-tools');

      expect(result).not.toBeNull();
      const resultEvent = result!.timeline.find((event) => event.tool?.phase === 'result');
      expect(resultEvent).toMatchObject({
        title: 'Tool result',
        content: 'README contents',
        tool: {
          phase: 'result',
          name: 'Read',
          status: 'success',
          outputType: 'text',
        },
      });
    } finally {
      await cleanup();
    }
  });

  test('links plan slugs and file-history snapshots from global OpenClaude artifacts', async () => {
    const { projectPath, paths, cleanup } = await setup();
    try {
      const projectDir = join(paths.projectsDir, encodeProjectPath(projectPath));
      await mkdir(projectDir, { recursive: true });
      await mkdir(paths.plansDir, { recursive: true });
      await mkdir(join(paths.fileHistoryDir, 'session-artifacts'), { recursive: true });
      await writeFile(join(paths.plansDir, 'existing-plan.md'), '# Existing Plan\n\nShip it.\n', 'utf8');
      await writeFile(join(paths.fileHistoryDir, 'session-artifacts', 'abc123@v1'), 'old content\n', 'utf8');
      await writeFile(
        join(projectDir, 'session-artifacts.jsonl'),
        [
          jsonl({
            type: 'user',
            sessionId: 'session-artifacts',
            timestamp: '2026-05-28T17:00:00.000Z',
            cwd: projectPath,
            slug: 'existing-plan',
            message: { role: 'user', content: 'Follow the plan' },
          }),
          jsonl({
            type: 'user',
            sessionId: 'session-artifacts',
            timestamp: '2026-05-28T17:01:00.000Z',
            cwd: projectPath,
            slug: 'missing-plan',
            message: { role: 'user', content: 'Reference stale plan' },
          }),
          jsonl({
            type: 'user',
            sessionId: 'session-artifacts',
            timestamp: '2026-05-28T17:01:30.000Z',
            cwd: projectPath,
            slug: '../unsafe-plan',
            message: { role: 'user', content: 'Ignore unsafe plan slug' },
          }),
          jsonl({
            type: 'file-history-snapshot',
            messageId: 'message-1',
            snapshot: {
              messageId: 'message-1',
              timestamp: '2026-05-28T17:02:00.000Z',
              trackedFileBackups: {
                'src/App.tsx': {
                  backupFileName: 'abc123@v1',
                  version: 1,
                  backupTime: '2026-05-28T17:02:00.000Z',
                },
                'src/NewPanel.tsx': {
                  backupFileName: null,
                  version: 1,
                  backupTime: '2026-05-28T17:03:00.000Z',
                },
              },
            },
            isSnapshotUpdate: false,
          }),
        ].join('\n'),
        'utf8',
      );

      const result = await readSessionDetails(paths, projectSummary(projectPath), 'session-artifacts');

      expect(result).not.toBeNull();
      expect(result!.session.linkedPlans).toEqual([
        {
          slug: 'existing-plan',
          title: 'Existing Plan',
          exists: true,
        },
      ]);
      expect(result!.session).not.toHaveProperty('sourcePath');
      expect(result!.session.linkedPlans[0]).not.toHaveProperty('path');
      expect(result!.session.linkedPlanCount).toBe(1);
      expect(result!.session.fileHistoryAvailable).toBe(true);
      expect(result!.session.fileHistory.map((entry) => ({
        filePath: entry.filePath,
        backupFileName: entry.backupFileName,
        version: entry.version,
        backupExists: entry.backupExists,
      }))).toEqual([
        { filePath: 'src/App.tsx', backupFileName: 'abc123@v1', version: 1, backupExists: true },
        { filePath: 'src/NewPanel.tsx', backupFileName: null, version: 1, backupExists: false },
      ]);
    } finally {
      await cleanup();
    }
  });

  test('skips global session artifacts when a session id is ambiguous across projects', async () => {
    const { projectPath, paths, cleanup } = await setup();
    try {
      const otherProjectPath = join(projectPath, '..', 'project-b');
      const projectDir = join(paths.projectsDir, encodeProjectPath(projectPath));
      const otherProjectDir = join(paths.projectsDir, encodeProjectPath(otherProjectPath));
      await mkdir(projectDir, { recursive: true });
      await mkdir(otherProjectDir, { recursive: true });
      await mkdir(join(paths.tasksDir, 'session-collision'), { recursive: true });
      await mkdir(join(paths.fileHistoryDir, 'session-collision'), { recursive: true });
      await writeFile(
        join(paths.tasksDir, 'session-collision', '1.json'),
        JSON.stringify({
          id: '1',
          subject: 'Task from another project',
          status: 'pending',
          description: 'This must not be exposed when the artifact scope is ambiguous.',
        }),
        'utf8',
      );
      await writeFile(join(paths.fileHistoryDir, 'session-collision', 'abc123@v1'), 'old content\n', 'utf8');
      await writeFile(
        join(projectDir, 'session-collision.jsonl'),
        [
          jsonl({
            type: 'user',
            sessionId: 'session-collision',
            timestamp: '2026-05-28T17:10:00.000Z',
            cwd: projectPath,
            message: { role: 'user', content: 'Selected project session' },
          }),
          jsonl(fileHistorySnapshot({
            timestamp: '2026-05-28T17:11:00.000Z',
            trackedFileBackups: {
              'src/App.tsx': {
                backupFileName: 'abc123@v1',
                version: 1,
                backupTime: '2026-05-28T17:11:00.000Z',
              },
            },
          })),
        ].join('\n'),
        'utf8',
      );
      await writeFile(
        join(otherProjectDir, 'session-collision.jsonl'),
        jsonl({
          type: 'user',
          sessionId: 'session-collision',
          timestamp: '2026-05-28T17:12:00.000Z',
          cwd: otherProjectPath,
          message: { role: 'user', content: 'Other project session' },
        }),
        'utf8',
      );

      const result = await readSessionDetails(paths, projectSummary(projectPath), 'session-collision');

      expect(result).not.toBeNull();
      expect(result!.session.linkedTasks).toEqual([]);
      expect(result!.session.fileHistory).toEqual([]);
      expect(result!.session.fileHistoryAvailable).toBe(false);
    } finally {
      await cleanup();
    }
  });

  test('deduplicates repeated cumulative file-history snapshots by backup identity', async () => {
    const { projectPath, paths, cleanup } = await setup();
    try {
      const projectDir = join(paths.projectsDir, encodeProjectPath(projectPath));
      await mkdir(projectDir, { recursive: true });
      await mkdir(join(paths.fileHistoryDir, 'session-repeated-history'), { recursive: true });
      await writeFile(join(paths.fileHistoryDir, 'session-repeated-history', 'abc123@v1'), 'old content v1\n', 'utf8');
      await writeFile(join(paths.fileHistoryDir, 'session-repeated-history', 'abc123@v2'), 'old content v2\n', 'utf8');
      await writeFile(
        join(projectDir, 'session-repeated-history.jsonl'),
        [
          jsonl({
            type: 'user',
            sessionId: 'session-repeated-history',
            timestamp: '2026-05-28T19:00:00.000Z',
            cwd: projectPath,
            message: { role: 'user', content: 'Edit the design spec' },
          }),
          jsonl(fileHistorySnapshot({
            timestamp: '2026-05-28T19:01:00.000Z',
            trackedFileBackups: {
              'docs/specs/design.md': {
                backupFileName: 'abc123@v1',
                version: 1,
                backupTime: '2026-05-28T19:01:00.000Z',
              },
            },
          })),
          jsonl(fileHistorySnapshot({
            timestamp: '2026-05-28T19:02:00.000Z',
            trackedFileBackups: {
              'docs/specs/design.md': {
                backupFileName: 'abc123@v2',
                version: 2,
                backupTime: '2026-05-28T19:02:00.000Z',
              },
            },
          })),
          jsonl(fileHistorySnapshot({
            timestamp: '2026-05-28T19:03:00.000Z',
            trackedFileBackups: {
              'docs/specs/design.md': {
                backupFileName: 'abc123@v2',
                version: 2,
                backupTime: '2026-05-28T19:02:00.000Z',
              },
            },
          })),
        ].join('\n'),
        'utf8',
      );

      const result = await readSessionDetails(paths, projectSummary(projectPath), 'session-repeated-history');

      expect(result).not.toBeNull();
      expect(result!.session.fileHistory.map((entry) => ({
        filePath: entry.filePath,
        backupFileName: entry.backupFileName,
        version: entry.version,
        backupTime: entry.backupTime,
      }))).toEqual([
        {
          filePath: 'docs/specs/design.md',
          backupFileName: 'abc123@v1',
          version: 1,
          backupTime: '2026-05-28T19:01:00.000Z',
        },
        {
          filePath: 'docs/specs/design.md',
          backupFileName: 'abc123@v2',
          version: 2,
          backupTime: '2026-05-28T19:02:00.000Z',
        },
      ]);
    } finally {
      await cleanup();
    }
  });

  test('skips empty user messages', async () => {
    const { projectPath, paths, cleanup } = await setup();
    try {
      const projectDir = join(paths.projectsDir, encodeProjectPath(projectPath));
      await mkdir(projectDir, { recursive: true });
      await writeFile(
        join(projectDir, 'session-empty.jsonl'),
        [
          jsonl({
            type: 'user',
            sessionId: 'session-empty',
            timestamp: '2026-05-28T14:00:00.000Z',
            cwd: projectPath,
            message: { role: 'user', content: '   ' },
          }),
          jsonl({
            type: 'assistant',
            sessionId: 'session-empty',
            timestamp: '2026-05-28T14:01:00.000Z',
            cwd: projectPath,
            message: {
              role: 'assistant',
              model: 'claude-sonnet',
              usage: { input_tokens: 0, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
              content: [{ type: 'text', text: 'Hello.' }],
            },
          }),
        ].join('\n'),
        'utf8',
      );

      const result = await readSessionDetails(paths, projectSummary(projectPath), 'session-empty');

      expect(result).not.toBeNull();
      // Empty user message should be skipped, only assistant event
      expect(result!.timeline).toHaveLength(1);
      expect(result!.timeline[0]).toMatchObject({ kind: 'assistant' });
    } finally {
      await cleanup();
    }
  });

  test('handles tool result with failed status', async () => {
    const { projectPath, paths, cleanup } = await setup();
    try {
      const projectDir = join(paths.projectsDir, encodeProjectPath(projectPath));
      await mkdir(projectDir, { recursive: true });
      await writeFile(
        join(projectDir, 'session-failed-tool.jsonl'),
        [
          jsonl({
            type: 'user',
            sessionId: 'session-ft',
            timestamp: '2026-05-28T15:00:00.000Z',
            cwd: projectPath,
            message: { role: 'user', content: 'Do a thing' },
          }),
          jsonl({
            type: 'tool',
            sessionId: 'session-ft',
            timestamp: '2026-05-28T15:01:00.000Z',
            cwd: projectPath,
            isApiErrorMessage: true,
            message: {
              role: 'tool',
              tool_use_id: 'tool-1',
              content: 'Permission denied',
            },
          }),
        ].join('\n'),
        'utf8',
      );

      const result = await readSessionDetails(paths, projectSummary(projectPath), 'session-ft');

      expect(result).not.toBeNull();
      const failedResults = result!.timeline.filter((e) => e.kind === 'tool' && e.tool?.status === 'error');
      expect(failedResults).toHaveLength(1);
      expect(failedResults[0]!.content).toBe('Permission denied');
    } finally {
      await cleanup();
    }
  });

  test('handles malformed JSONL lines gracefully', async () => {
    const { projectPath, paths, cleanup } = await setup();
    try {
      const projectDir = join(paths.projectsDir, encodeProjectPath(projectPath));
      await mkdir(projectDir, { recursive: true });
      await writeFile(
        join(projectDir, 'session-malformed.jsonl'),
        [
          'this is not json\n',
          jsonl({
            type: 'user',
            sessionId: 'session-mf',
            timestamp: '2026-05-28T16:00:00.000Z',
            cwd: projectPath,
            message: { role: 'user', content: 'Valid message' },
          }),
          '\n',
          '{ broken json\n',
          jsonl({
            type: 'assistant',
            sessionId: 'session-mf',
            timestamp: '2026-05-28T16:01:00.000Z',
            cwd: projectPath,
            message: {
              role: 'assistant',
              model: 'claude-sonnet',
              usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
              content: [{ type: 'text', text: 'Valid response' }],
            },
          }),
        ].join('\n'),
        'utf8',
      );

      const result = await readSessionDetails(paths, projectSummary(projectPath), 'session-mf');

      expect(result).not.toBeNull();
      expect(result!.timeline).toHaveLength(2);
      expect(result!.session.status).toBe('completed');
    } finally {
      await cleanup();
    }
  });
});

// Test helpers

async function setup() {
  const home = await mkdtemp(join(tmpdir(), 'ocs-detail-'));
  const projectPath = join(home, 'project-a');
  const paths = createOpenClaudePaths({ home, env: {} });
  const cleanup = async () => {
    try {
      await rm(home, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors in tests
    }
  };
  return { home, projectPath, paths, cleanup };
}

function projectSummary(projectPath: string): ProjectSummary {
  return {
    id: 'project-1',
    name: 'project-a',
    path: projectPath,
    exists: true,
    active: true,
    branch: 'main',
    lastUpdated: 'just now',
    diagnostics: [],
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0.25,
      lastSessionId: 'session-1',
    },
  };
}

function fileHistorySnapshot(input: {
  timestamp: string;
  trackedFileBackups: Record<string, unknown>;
}) {
  return {
    type: 'file-history-snapshot',
    snapshot: {
      messageId: 'message-1',
      timestamp: input.timestamp,
      trackedFileBackups: input.trackedFileBackups,
    },
    isSnapshotUpdate: false,
  };
}

function jsonl(value: unknown): string {
  return JSON.stringify(value);
}
