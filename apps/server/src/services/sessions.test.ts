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

  test('keeps selected project rows from OpenClaude worktree sessions', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ocs-sessions-'));
    const projectPath = join(home, 'project-a');
    const worktreePath = join(projectPath, '.claude', 'worktrees', 'feature-a');
    const paths = createOpenClaudePaths({ home, env: {} });
    const projectDir = join(paths.projectsDir, encodeProjectPath(projectPath));
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(projectDir, 'session-worktree.jsonl'),
      [
        jsonl({
          type: 'user',
          sessionId: 'session-worktree',
          timestamp: '2026-05-28T09:00:00.000Z',
          cwd: projectPath,
          message: { role: 'user', content: 'Use a worktree' },
        }),
        jsonl({
          type: 'assistant',
          sessionId: 'session-worktree',
          timestamp: '2026-05-28T09:01:00.000Z',
          cwd: worktreePath,
          message: {
            role: 'assistant',
            usage: { input_tokens: 3, output_tokens: 5 },
            content: [
              { type: 'text', text: 'Updated from the worktree.' },
              { type: 'tool_use', name: 'Write', input: { file_path: 'src/worktree.ts' } },
            ],
          },
        }),
      ].join('\n'),
      'utf8',
    );

    const sessions = await readSessionSummaries(paths, projectSummary(projectPath));

    expect(sessions[0]).toMatchObject({
      id: 'session-worktree',
      changedFiles: ['src/worktree.ts'],
      tokens: expect.objectContaining({ input: 3, output: 5 }),
    });
  });

  test('finds transcript files in selected project worktree directories', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ocs-sessions-'));
    const projectPath = join(home, 'project-a');
    const worktreePath = join(projectPath, '.claude', 'worktrees', 'feature-a');
    const paths = createOpenClaudePaths({ home, env: {} });
    const projectDir = join(paths.projectsDir, encodeProjectPath(projectPath));
    const worktreeDir = join(paths.projectsDir, encodeProjectPath(worktreePath));
    await mkdir(projectDir, { recursive: true });
    await mkdir(worktreeDir, { recursive: true });
    await writeFile(join(projectDir, 'session-root.jsonl'), '', 'utf8');
    await writeFile(join(worktreeDir, 'session-worktree.jsonl'), '', 'utf8');

    const files = await findTranscriptFilesForProject(paths.projectsDir, projectPath);

    expect(files.map((file) => file.slice(paths.projectsDir.length + 1)).sort()).toEqual([
      `${encodeProjectPath(worktreePath)}/session-worktree.jsonl`,
      `${encodeProjectPath(projectPath)}/session-root.jsonl`,
    ]);
  });

  test('does not include sibling project directories that only share an encoded prefix', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ocs-sessions-'));
    const projectPath = join(home, 'openclaude');
    const siblingProjectPath = join(home, 'openclaude-studio');
    const paths = createOpenClaudePaths({ home, env: {} });
    const siblingDir = join(paths.projectsDir, encodeProjectPath(siblingProjectPath));
    await mkdir(siblingDir, { recursive: true });
    await writeFile(join(siblingDir, 'session-sibling.jsonl'), '', 'utf8');

    await expect(findTranscriptFilesForProject(paths.projectsDir, projectPath)).resolves.toEqual([]);
  });

  test('keeps pathless rows after a session is proven to belong to the selected project', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ocs-sessions-'));
    const projectPath = join(home, 'project-a');
    const paths = createOpenClaudePaths({ home, env: {} });
    const projectDir = join(paths.projectsDir, encodeProjectPath(projectPath));
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(projectDir, 'session-pathless.jsonl'),
      [
        jsonl({
          type: 'user',
          sessionId: 'session-pathless',
          timestamp: '2026-05-28T09:00:00.000Z',
          cwd: projectPath,
          message: { role: 'user', content: 'Keep the follow-up' },
        }),
        jsonl({
          type: 'assistant',
          sessionId: 'session-pathless',
          timestamp: '2026-05-28T09:01:00.000Z',
          message: {
            role: 'assistant',
            usage: { output_tokens: 7 },
            content: 'Follow-up without cwd.',
          },
        }),
      ].join('\n'),
      'utf8',
    );

    const sessions = await readSessionSummaries(paths, projectSummary(projectPath));

    expect(sessions[0]).toMatchObject({
      id: 'session-pathless',
      lastTimestamp: '2026-05-28T09:01:00.000Z',
      tokens: expect.objectContaining({ output: 7 }),
    });
  });

  test('keeps pathless rows from split transcript files after the session is scoped to the project', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ocs-sessions-'));
    const projectPath = join(home, 'project-a');
    const paths = createOpenClaudePaths({ home, env: {} });
    const projectDir = join(paths.projectsDir, encodeProjectPath(projectPath));
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(projectDir, 'session-split-root.jsonl'),
      jsonl({
        type: 'user',
        sessionId: 'session-split',
        timestamp: '2026-05-28T09:00:00.000Z',
        cwd: projectPath,
        message: { role: 'user', content: 'Keep all transcript chunks' },
      }),
      'utf8',
    );
    await writeFile(
      join(projectDir, 'agent-session-split.jsonl'),
      jsonl({
        type: 'assistant',
        sessionId: 'session-split',
        timestamp: '2026-05-28T09:01:00.000Z',
        message: {
          role: 'assistant',
          usage: { input_tokens: 5, output_tokens: 11 },
          content: 'Pathless split chunk.',
        },
      }),
      'utf8',
    );

    const sessions = await readSessionSummaries(paths, projectSummary(projectPath));

    expect(sessions[0]).toMatchObject({
      id: 'session-split',
      lastTimestamp: '2026-05-28T09:01:00.000Z',
      tokens: expect.objectContaining({ input: 5, output: 11 }),
    });
  });

  test('drops pathless rows when encoded project path collisions make the session ambiguous', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ocs-sessions-'));
    const projectPath = join(home, 'project-a');
    const collidingProjectPath = join(home, 'project', 'a');
    const paths = createOpenClaudePaths({ home, env: {} });
    const projectDir = join(paths.projectsDir, encodeProjectPath(projectPath));
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(projectDir, 'session-collision.jsonl'),
      [
        jsonl({
          type: 'user',
          sessionId: 'session-collision',
          timestamp: '2026-05-28T09:00:00.000Z',
          cwd: projectPath,
          message: { role: 'user', content: 'Selected project message' },
        }),
        jsonl({
          type: 'assistant',
          sessionId: 'session-collision',
          timestamp: '2026-05-28T09:01:00.000Z',
          message: {
            role: 'assistant',
            usage: { output_tokens: 99 },
            content: 'Ambiguous pathless row.',
          },
        }),
        jsonl({
          type: 'user',
          sessionId: 'session-collision',
          timestamp: '2026-05-28T09:02:00.000Z',
          cwd: collidingProjectPath,
          message: { role: 'user', content: 'Other project message' },
        }),
      ].join('\n'),
      'utf8',
    );

    const sessions = await readSessionSummaries(paths, projectSummary(projectPath));

    expect(sessions[0]).toMatchObject({
      id: 'session-collision',
      lastTimestamp: '2026-05-28T09:00:00.000Z',
      title: 'Selected project message',
      tokens: expect.objectContaining({ output: 0 }),
    });
  });

  test('does not use command wrapper payloads as titles', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ocs-sessions-'));
    const projectPath = join(home, 'project-a');
    const paths = createOpenClaudePaths({ home, env: {} });
    const projectDir = join(paths.projectsDir, encodeProjectPath(projectPath));
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(projectDir, 'session-4.jsonl'),
      jsonl({
        type: 'user',
        sessionId: 'session-4',
        timestamp: '2026-05-28T09:00:00.000Z',
        cwd: projectPath,
        message: { role: 'user', content: '<command-message>internal command payload' },
      }),
      'utf8',
    );

    const sessions = await readSessionSummaries(paths, projectSummary(projectPath));

    expect(sessions[0]?.title).toBe('Session session-4');
  });

  test('does not use slash command payloads as titles', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ocs-sessions-'));
    const projectPath = join(home, 'project-a');
    const paths = createOpenClaudePaths({ home, env: {} });
    const projectDir = join(paths.projectsDir, encodeProjectPath(projectPath));
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(projectDir, 'session-5.jsonl'),
      jsonl({
        type: 'user',
        sessionId: 'session-5',
        timestamp: '2026-05-28T09:00:00.000Z',
        cwd: projectPath,
        message: { role: 'user', content: '/internal-command with payload' },
      }),
      'utf8',
    );

    const sessions = await readSessionSummaries(paths, projectSummary(projectPath));

    expect(sessions[0]?.title).toBe('Session session-5');
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
