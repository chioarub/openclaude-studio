import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import type { ProjectSummary } from '@openclaude-studio/shared';

import { createOpenClaudePaths, encodeProjectPath } from './paths.js';
import { findTranscriptFilesForProject, readSessionSummaries } from './sessions.js';

describe('session summaries', () => {
  test('summarizes OpenClaude JSONL sessions without exposing transcript content', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ocs-sessions-'));
    const projectPath = join(home, 'project-a');
    const paths = createOpenClaudePaths({ home, env: {} });
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
              input_tokens: 10,
              output_tokens: 20,
              cache_read_input_tokens: 30,
              cache_creation_input_tokens: 40,
            },
            content: [
              { type: 'text', text: 'Done' },
              { type: 'tool_use', name: 'Write', input: { file_path: 'src/api.ts' } },
            ],
          },
        }),
      ].join('\n'),
      'utf8',
    );

    const sessions = await readSessionSummaries(paths, projectSummary(projectPath));

    expect(sessions).toEqual([
      expect.objectContaining({
        id: 'session-1',
        title: 'Build the API',
        status: 'completed',
        firstTimestamp: '2026-05-28T08:00:00.000Z',
        lastTimestamp: '2026-05-28T08:01:00.000Z',
        modelSet: ['claude-sonnet'],
        changedFiles: ['src/api.ts'],
        tokens: {
          input: 10,
          output: 20,
          cacheRead: 30,
          cacheWrite: 40,
        },
        costUsd: 0.25,
        linkedPlanCount: 0,
        linkedTaskCount: 0,
      }),
    ]);
  });

  test('marks sessions with system errors as failed', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ocs-sessions-'));
    const projectPath = join(home, 'project-a');
    const paths = createOpenClaudePaths({ home, env: {} });
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
          message: { role: 'user', content: 'OPENAI_API_KEY=secret-value failed task' },
        }),
        jsonl({
          type: 'system',
          level: 'error',
          sessionId: 'session-2',
          timestamp: '2026-05-28T09:01:00.000Z',
          cwd: projectPath,
          message: 'Request failed',
        }),
      ].join('\n'),
      'utf8',
    );

    const sessions = await readSessionSummaries(paths, projectSummary(projectPath));

    expect(sessions[0]).toMatchObject({
      id: 'session-2',
      title: 'OPENAI_API_KEY=<redacted> failed task',
      status: 'failed',
    });
  });

  test('ignores sessions from other project paths', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ocs-sessions-'));
    const projectPath = join(home, 'project-a');
    const otherPath = join(home, 'project-b');
    const paths = createOpenClaudePaths({ home, env: {} });
    const projectDir = join(paths.projectsDir, encodeProjectPath(projectPath));
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(projectDir, 'session-3.jsonl'),
      jsonl({
        type: 'user',
        sessionId: 'session-3',
        timestamp: '2026-05-28T09:00:00.000Z',
        cwd: otherPath,
        message: { role: 'user', content: 'Wrong project' },
      }),
      'utf8',
    );

    await expect(readSessionSummaries(paths, projectSummary(projectPath))).resolves.toEqual([]);
  });

  test('does not traverse symlinked transcript directories', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ocs-sessions-'));
    const projectPath = join(home, 'project-a');
    const paths = createOpenClaudePaths({ home, env: {} });
    const projectDir = join(paths.projectsDir, encodeProjectPath(projectPath));
    const outside = join(home, 'outside');
    await mkdir(projectDir, { recursive: true });
    await mkdir(outside);
    await writeFile(join(outside, 'leaked.jsonl'), '', 'utf8');
    await symlink(outside, join(projectDir, 'linked'));

    await expect(findTranscriptFilesForProject(paths.projectsDir, projectPath)).resolves.toEqual([]);
  });
});

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

function jsonl(value: unknown): string {
  return JSON.stringify(value);
}
