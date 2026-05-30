import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import type { ProjectSummary } from '@openclaude-studio/shared';

import { createOpenClaudePaths, encodeProjectPath } from './paths.js';
import { listProjectTasks, readProjectTask } from './tasks.js';
import { isUnsupportedSymlinkError } from '../test-support/symlink.js';

type ProjectInput = Pick<ProjectSummary, 'id' | 'name' | 'path' | 'exists'>;

describe('project tasks', () => {
  test('returns an empty scoped list when the tasks directory does not exist', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ocs-tasks-'));
    const paths = createOpenClaudePaths({ home, env: {} });
    const project = projectFixture(home);

    const result = await listProjectTasks(paths, project);

    expect(result.exists).toBe(false);
    expect(result.tasks).toEqual([]);
    expect(result.diagnostics).toEqual([
      { level: 'info', message: 'Tasks directory does not exist yet.', path: paths.tasksDir },
    ]);
  });

  test('lists only tasks linked to selected-project sessions', async () => {
    const { paths, project, otherProjectPath } = await makeTasksHome();
    await writeTask(paths, 'session-selected', '1', {
      subject: 'Selected task',
      status: 'in_progress',
      description: 'Selected description',
      activeForm: 'Implementing',
    });
    await writeTask(paths, 'session-other', '1', {
      subject: 'Other task',
      status: 'completed',
      description: 'Other description',
    });
    await writeTranscript(paths, project.path, 'session-selected', 'Use selected task');
    await writeTranscript(paths, otherProjectPath, 'session-other', 'Use other task');

    const result = await listProjectTasks(paths, project);

    expect(result.project).toEqual(project);
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]).toMatchObject({
      id: 'session-selected:1',
      sessionId: 'session-selected',
      taskId: '1',
      title: 'Selected task',
      status: 'in_progress',
      description: 'Selected description',
      activeForm: 'Implementing',
      sessionTitle: 'Use selected task',
    });
    expect(JSON.stringify(result.tasks)).not.toContain('Other task');
  });

  test('lists tasks linked to selected-project worktree sessions', async () => {
    const { paths, project } = await makeTasksHome();
    const worktreePath = join(project.path, '.claude', 'worktrees', 'feature-a');
    await writeTask(paths, 'session-worktree', '1', {
      subject: 'Worktree task',
      status: 'in_progress',
      description: 'Task created from a project worktree.',
    });
    await writeTranscriptRows(paths, worktreePath, 'session-worktree', [
      {
        type: 'user',
        timestamp: '2026-05-16T10:00:00.000Z',
        sessionId: 'session-worktree',
        cwd: worktreePath,
        message: { role: 'user', content: 'Use worktree task' },
      },
    ]);

    const result = await listProjectTasks(paths, project);

    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]).toMatchObject({
      id: 'session-worktree:1',
      title: 'Worktree task',
      sessionTitle: 'Use worktree task',
    });
    expect(result.diagnostics).toEqual([]);
  });

  test('restricts task details to selected-project session tasks', async () => {
    const { paths, project, otherProjectPath } = await makeTasksHome();
    await writeTask(paths, 'session-selected', '1', { subject: 'Selected task', status: 'pending' });
    await writeTask(paths, 'session-other', '1', { subject: 'Other task', status: 'pending' });
    await writeTranscript(paths, project.path, 'session-selected', 'Use selected task');
    await writeTranscript(paths, otherProjectPath, 'session-other', 'Use other task');

    const details = await readProjectTask(paths, project, 'session-selected', '1');

    expect(details.task.id).toBe('session-selected:1');
    expect(details.task.content).toContain('Selected task');
    await expect(readProjectTask(paths, project, 'session-other', '1')).rejects.toThrow('Task not found');
    await expect(readProjectTask(paths, project, 'session-selected', '../1')).rejects.toThrow('Invalid task path');
  });

  test('reports invalid JSON while keeping the task visible with a safe fallback title', async () => {
    const { paths, project } = await makeTasksHome();
    const taskPath = await writeRawTask(paths, 'session-selected', 'broken', '{not json');
    await writeTranscript(paths, project.path, 'session-selected', 'Use broken task');

    const result = await listProjectTasks(paths, project);

    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]).toMatchObject({
      id: 'session-selected:broken',
      title: 'Task broken',
      status: 'unknown',
    });
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({
      level: 'error',
      path: taskPath,
    });
    expect(result.diagnostics[0]?.message).toContain('Invalid task JSON');
  });

  test('normalizes statuses and sorts active work before completed work', async () => {
    const { paths, project } = await makeTasksHome();
    await writeTranscript(paths, project.path, 'session-selected', 'Use selected tasks');
    await writeTask(paths, 'session-selected', 'completed', { subject: 'Completed', status: 'completed' });
    await writeTask(paths, 'session-selected', 'blocked', { subject: 'Blocked', status: 'Blocked' });
    await writeTask(paths, 'session-selected', 'todo', { subject: 'Todo', status: 'todo' });
    await writeTask(paths, 'session-selected', 'active', { subject: 'Active', status: 'In Progress' });

    const result = await listProjectTasks(paths, project);

    expect(result.tasks.map((task) => [task.taskId, task.status])).toEqual([
      ['active', 'in_progress'],
      ['todo', 'todo'],
      ['blocked', 'blocked'],
      ['completed', 'completed'],
    ]);
  });

  test('does not list or read hidden task files', async () => {
    const { paths, project } = await makeTasksHome();
    await writeTranscript(paths, project.path, 'session-selected', 'Use selected task');
    await writeTask(paths, 'session-selected', '.hidden', { subject: 'Hidden task', status: 'pending' });

    const result = await listProjectTasks(paths, project);

    expect(result.tasks).toEqual([]);
    await expect(readProjectTask(paths, project, 'session-selected', '.hidden')).rejects.toThrow(
      'Invalid task path',
    );
  });

  test('does not read tasks through symlinked session directories', async () => {
    const { paths, project, home } = await makeTasksHome();
    const outsideTasksDir = join(home, 'outside-tasks');
    const symlinkSessionDir = join(paths.tasksDir, 'session-selected');
    await mkdir(paths.tasksDir, { recursive: true });
    await mkdir(outsideTasksDir, { recursive: true });
    await writeFile(
      join(outsideTasksDir, 'leak.json'),
      `${JSON.stringify({ subject: 'Leaked task', status: 'in_progress' })}\n`,
    );
    try {
      await symlink(outsideTasksDir, symlinkSessionDir, 'dir');
    } catch (error) {
      if (isUnsupportedSymlinkError(error)) return;
      throw error;
    }
    await writeTranscript(paths, project.path, 'session-selected', 'Use selected task');

    const result = await listProjectTasks(paths, project);

    expect(result.tasks).toEqual([]);
    expect(result.diagnostics).toEqual([
      {
        level: 'warn',
        message: 'Task session directory is not a regular directory.',
        path: symlinkSessionDir,
      },
    ]);
    await expect(readProjectTask(paths, project, 'session-selected', 'leak')).rejects.toThrow(
      'Task not found',
    );
  });

  test('does not expose task artifacts when a session id is shared by another project', async () => {
    const { paths, project, otherProjectPath } = await makeTasksHome();
    await writeTask(paths, 'session-collision', '1', {
      subject: 'Ambiguous task',
      status: 'pending',
    });
    await writeTranscript(paths, project.path, 'session-collision', 'Selected project session');
    await writeTranscript(paths, otherProjectPath, 'session-collision', 'Other project session');

    const result = await listProjectTasks(paths, project);

    expect(result.tasks).toEqual([]);
    expect(result.diagnostics).toEqual([
      {
        level: 'warn',
        message: 'Task artifacts are hidden because this session ID also appears in another project.',
        path: join(paths.tasksDir, 'session-collision'),
      },
    ]);
    await expect(readProjectTask(paths, project, 'session-collision', '1')).rejects.toThrow(
      'Task not found',
    );
  });

  test('does not expose task artifacts when encoded project path collisions share a session id', async () => {
    const { paths, project, home } = await makeTasksHome();
    const collidingProjectPath = join(home, 'selected', 'project');
    await writeTask(paths, 'session-collision', '1', {
      subject: 'Ambiguous task',
      status: 'pending',
    });
    await writeTranscript(paths, project.path, 'session-collision', 'Selected project session');
    await writeTranscriptRows(paths, collidingProjectPath, 'other-session-collision', [
      {
        type: 'user',
        timestamp: '2026-05-16T10:01:00.000Z',
        sessionId: 'session-collision',
        cwd: collidingProjectPath,
        message: { role: 'user', content: 'Other project session' },
      },
    ]);

    const result = await listProjectTasks(paths, project);

    expect(encodeProjectPath(collidingProjectPath)).toBe(encodeProjectPath(project.path));
    expect(result.tasks).toEqual([]);
    expect(result.diagnostics).toEqual([
      {
        level: 'warn',
        message: 'Task artifacts are hidden because this session ID also appears in another project.',
        path: join(paths.tasksDir, 'session-collision'),
      },
    ]);
  });

  test('detects ambiguous task artifacts when another project stores the session in a differently named transcript', async () => {
    const { paths, project, otherProjectPath } = await makeTasksHome();
    await writeTask(paths, 'session-collision', '1', {
      subject: 'Ambiguous task',
      status: 'pending',
    });
    await writeTranscript(paths, project.path, 'session-collision', 'Selected project session');
    await writeTranscriptRows(paths, otherProjectPath, 'renamed-transcript', [
      {
        type: 'user',
        timestamp: '2026-05-16T10:00:00.000Z',
        sessionId: 'session-collision',
        cwd: otherProjectPath,
        message: { role: 'user', content: 'Other project session' },
      },
    ]);

    const result = await listProjectTasks(paths, project);

    expect(result.tasks).toEqual([]);
    expect(result.diagnostics).toEqual([
      {
        level: 'warn',
        message: 'Task artifacts are hidden because this session ID also appears in another project.',
        path: join(paths.tasksDir, 'session-collision'),
      },
    ]);
    await expect(readProjectTask(paths, project, 'session-collision', '1')).rejects.toThrow(
      'Task not found',
    );
  });

  test('redacts structured secrets in task detail content', async () => {
    const { paths, project } = await makeTasksHome();
    await writeTask(paths, 'session-selected', 'secret', {
      subject: 'Secret task',
      status: 'pending',
      apiKey: 'plain-secret-value',
      nested: { token: 'nested-secret-value' },
    });
    await writeTranscript(paths, project.path, 'session-selected', 'Use secret task');

    const details = await readProjectTask(paths, project, 'session-selected', 'secret');

    expect(details.task.content).toContain('"apiKey": "<redacted>"');
    expect(details.task.content).toContain('"token": "<redacted>"');
    expect(details.task.content).not.toContain('plain-secret-value');
    expect(details.task.content).not.toContain('nested-secret-value');
  });

  test('reports truncated oversized task files in list and detail flows', async () => {
    const { paths, project } = await makeTasksHome();
    const taskPath = await writeRawTask(
      paths,
      'session-selected',
      'large',
      `${JSON.stringify({ subject: 'Large task', status: 'pending' })}\n${' '.repeat(300_000)}`,
    );
    await writeTranscript(paths, project.path, 'session-selected', 'Use large task');

    const result = await listProjectTasks(paths, project);

    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]).toMatchObject({
      id: 'session-selected:large',
      title: 'Large task',
      status: 'pending',
    });
    expect(result.diagnostics).toContainEqual({
      level: 'warn',
      message: 'File was truncated to 262144 bytes.',
      path: taskPath,
    });

    const details = await readProjectTask(paths, project, 'session-selected', 'large');

    expect(details.task.title).toBe('Large task');
    expect(details.task.content).toContain('"subject": "Large task"');
    expect(details.diagnostics).toContainEqual({
      level: 'warn',
      message: 'File was truncated to 262144 bytes.',
      path: taskPath,
    });
  });
});

async function makeTasksHome() {
  const home = await mkdtemp(join(tmpdir(), 'ocs-tasks-'));
  const paths = createOpenClaudePaths({ home, env: {} });
  const project = projectFixture(home);
  const otherProjectPath = join(home, 'other-project');
  return { home, paths, project, otherProjectPath };
}

function projectFixture(home: string): ProjectInput {
  return {
    id: 'project-1',
    name: 'selected-project',
    path: join(home, 'selected-project'),
    exists: true,
  };
}

async function writeTask(
  paths: ReturnType<typeof createOpenClaudePaths>,
  sessionId: string,
  taskId: string,
  content: Record<string, unknown>,
) {
  return writeRawTask(paths, sessionId, taskId, `${JSON.stringify(content, null, 2)}\n`);
}

async function writeRawTask(
  paths: ReturnType<typeof createOpenClaudePaths>,
  sessionId: string,
  taskId: string,
  content: string,
) {
  const sessionDir = join(paths.tasksDir, sessionId);
  await mkdir(sessionDir, { recursive: true });
  const taskPath = join(sessionDir, `${taskId}.json`);
  await writeFile(taskPath, content);
  return taskPath;
}

async function writeTranscript(
  paths: ReturnType<typeof createOpenClaudePaths>,
  projectPath: string,
  sessionId: string,
  content: string,
) {
  return writeTranscriptRows(paths, projectPath, sessionId, [
    {
      type: 'user',
      timestamp: '2026-05-16T10:00:00.000Z',
      sessionId,
      cwd: projectPath,
      message: { role: 'user', content },
    },
  ]);
}

async function writeTranscriptRows(
  paths: ReturnType<typeof createOpenClaudePaths>,
  projectPath: string,
  fileName: string,
  rows: unknown[],
) {
  const transcriptDir = join(paths.projectsDir, encodeProjectPath(projectPath));
  await mkdir(transcriptDir, { recursive: true });
  await writeFile(
    join(transcriptDir, `${fileName}.jsonl`),
    `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`,
  );
}
