import type { Dirent } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { basename, resolve, sep } from 'node:path';

import type {
  Diagnostic,
  ProjectSummary,
  TaskDetailsResponse,
  TaskSummary,
  TasksResponse,
} from '@openclaude-studio/shared';

import { ApiError, invalidRequest } from '../http/errors.js';
import { type OpenClaudePaths } from './paths.js';
import { redactSecrets, redactTextSecrets } from './redaction.js';
import { readContainedBoundedTextFile } from './safeFile.js';
import { findAmbiguousSessionArtifactIds } from './sessionArtifacts.js';
import {
  findTranscriptFilesForProject,
  parseTranscriptFilesForProject,
  type ParsedTranscriptEntry,
} from './sessions.js';

type ProjectInput = Pick<ProjectSummary, 'id' | 'name' | 'path' | 'exists'>;

const TASK_MAX_BYTES = 256 * 1024;
type TaskCandidate = {
  entries: Dirent[];
  session: SessionRef;
  sessionDir: string;
};

export async function listProjectTasks(
  paths: OpenClaudePaths,
  project: ProjectInput,
): Promise<TasksResponse> {
  const diagnostics: Diagnostic[] = [];
  const exists = await directoryExists(paths.tasksDir);

  if (!exists) {
    diagnostics.push({
      level: 'info',
      message: 'Tasks directory does not exist yet.',
      path: paths.tasksDir,
    });
    return {
      project: { id: project.id, name: project.name, path: project.path, exists: project.exists },
      tasksDir: paths.tasksDir,
      exists: false,
      tasks: [],
      diagnostics,
    };
  }

  const sessionRefs = await readTaskSessionReferences(paths, project.path);
  const candidates: TaskCandidate[] = [];
  for (const session of sessionRefs) {
    const sessionDir = safeChildPath(paths.tasksDir, session.id);
    if (!sessionDir) continue;

    let sessionDirStat;
    try {
      sessionDirStat = await lstat(sessionDir);
    } catch {
      continue;
    }
    if (!sessionDirStat.isDirectory() || sessionDirStat.isSymbolicLink()) {
      diagnostics.push(diagnostic('warn', 'Task session directory is not a regular directory.', sessionDir));
      continue;
    }

    let entries;
    try {
      entries = await readdir(sessionDir, { withFileTypes: true });
    } catch {
      continue;
    }
    const taskEntries = entries.filter((entry) => entry.isFile() && !entry.name.startsWith('.') && entry.name.endsWith('.json'));
    if (taskEntries.length === 0) continue;

    candidates.push({ entries: taskEntries, session, sessionDir });
  }

  const ambiguousSessionIds = await findAmbiguousSessionArtifactIds(
    paths.projectsDir,
    project.path,
    candidates.map((candidate) => candidate.session.id),
  );

  const tasks: TaskSummary[] = [];
  for (const candidate of candidates) {
    if (ambiguousSessionIds.has(candidate.session.id)) {
      diagnostics.push(diagnostic(
        'warn',
        'Task artifacts are hidden because this session ID also appears in another project.',
        candidate.sessionDir,
      ));
      continue;
    }

    for (const entry of candidate.entries) {
      const taskId = basename(entry.name, '.json');
      const taskPath = safeTaskPath(paths.tasksDir, candidate.session.id, taskId);
      if (!taskPath) continue;

      const task = await readTaskFile(paths.tasksDir, taskPath, candidate.session, taskId);
      if (!task) continue;
      diagnostics.push(...task.diagnostics);
      tasks.push(task.summary);
    }
  }

  tasks.sort(compareTasks);

  return {
    project: { id: project.id, name: project.name, path: project.path, exists: project.exists },
    tasksDir: paths.tasksDir,
    exists: true,
    tasks,
    diagnostics,
  };
}

export async function readProjectTask(
  paths: OpenClaudePaths,
  project: ProjectInput,
  sessionId: string,
  taskId: string,
): Promise<TaskDetailsResponse> {
  const taskPath = safeTaskPath(paths.tasksDir, sessionId, taskId);
  if (!taskPath) {
    throw invalidRequest('Invalid task path.');
  }

  const listed = await listProjectTasks(paths, project);
  const task = listed.tasks.find(
    (item) => item.sessionId === sessionId && item.taskId === taskId,
  );
  if (!task) {
    throw taskNotFound(taskPath);
  }

  const file = await readContainedBoundedTextFile(paths.tasksDir, taskPath, { maxBytes: TASK_MAX_BYTES });
  if (!file.exists) {
    throw taskNotFound(taskPath);
  }

  const parsed = parseTaskJson(file.content, taskPath);

  return {
    task: {
      ...task,
      content: redactTaskContent(file.content, parsed.data),
    },
    diagnostics: [...file.diagnostics, ...parsed.diagnostics],
  };
}

// --- Internal helpers ---

type SessionRef = {
  id: string;
  title: string;
  lastTimestamp: string;
};

type TaskRead = {
  summary: TaskSummary;
  diagnostics: Diagnostic[];
};

async function readTaskSessionReferences(
  paths: OpenClaudePaths,
  projectPath: string,
): Promise<SessionRef[]> {
  let files: string[];
  try {
    files = await findTranscriptFilesForProject(paths.projectsDir, projectPath);
  } catch {
    return [];
  }

  const allEntries: ParsedTranscriptEntry[] = await parseTranscriptFilesForProject(files, projectPath);

  const bySession = new Map<string, ParsedTranscriptEntry[]>();
  for (const entry of allEntries) {
    const rows = bySession.get(entry.sessionId) ?? [];
    rows.push(entry);
    bySession.set(entry.sessionId, rows);
  }

  const refs: SessionRef[] = [];
  for (const [sessionId, rows] of bySession) {
    if (!isSafeId(sessionId)) continue;
    const sorted = rows.slice().sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    const userTitle = sorted
      .filter((r) => r.role === 'user')
      .map((r) => redactTextSecrets(r.text?.replace(/\s+/g, ' ').trim() ?? ''))
      .find((t) => t.length > 0);
    refs.push({
      id: sessionId,
      title: truncateText(userTitle ?? `Session ${sessionId.slice(0, 8)}`, 80),
      lastTimestamp: sorted.at(-1)?.timestamp ?? sorted[0]?.timestamp ?? new Date(0).toISOString(),
    });
  }

  return refs.sort((a, b) => b.lastTimestamp.localeCompare(a.lastTimestamp));
}

async function readTaskFile(
  tasksDir: string,
  path: string,
  session: SessionRef,
  taskId: string,
): Promise<TaskRead | null> {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;

    const file = await readContainedBoundedTextFile(tasksDir, path, { maxBytes: TASK_MAX_BYTES });
    if (!file.exists) return null;

    const parsed = parseTaskJson(file.content, path);
    const fields = taskFieldsFromData(parsed.data, taskId);
    return {
      summary: {
        id: `${session.id}:${taskId}`,
        taskId,
        title: fields.title,
        status: fields.status,
        description: fields.description,
        activeForm: fields.activeForm,
        sessionId: session.id,
        sessionTitle: session.title,
        modifiedAt: stat.mtime.toISOString(),
        sizeBytes: stat.size,
      },
      diagnostics: [...file.diagnostics, ...parsed.diagnostics],
    };
  } catch {
    return null;
  }
}

function taskFieldsFromData(
  data: Record<string, unknown> | null,
  taskId: string,
): { title: string; status: string; description: string; activeForm: string | null } {
  const title = stringFromUnknown(data?.subject) ?? stringFromUnknown(data?.title) ?? `Task ${taskId}`;
  return {
    title: truncateText(redactTextSecrets(title), 140),
    status: normalizeTaskStatus(stringFromUnknown(data?.status) ?? 'unknown'),
    description: truncateText(redactTextSecrets(stringFromUnknown(data?.description) ?? ''), 500),
    activeForm: stringFromUnknown(data?.activeForm)
      ? truncateText(redactTextSecrets(String(data?.activeForm)), 140)
      : null,
  };
}

function parseTaskJson(
  content: string,
  path?: string,
): { data: Record<string, unknown> | null; diagnostics: Diagnostic[] } {
  try {
    const parsed = content.trim() ? (JSON.parse(content) as unknown) : null;
    if (!isRecord(parsed)) {
      return {
        data: null,
        diagnostics: [diagnostic('error', 'Task content must be a JSON object.', path)],
      };
    }
    return { data: parsed, diagnostics: [] };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown parser error';
    return {
      data: null,
      diagnostics: [diagnostic('error', `Invalid task JSON: ${message}`, path)],
    };
  }
}

function redactTaskContent(content: string, data: Record<string, unknown> | null): string {
  if (!data) {
    return redactTextSecrets(content);
  }
  return `${JSON.stringify(redactSecrets(data), null, 2)}\n`;
}

function compareTasks(left: TaskSummary, right: TaskSummary): number {
  const leftOrder = statusOrder(left.status);
  const rightOrder = statusOrder(right.status);
  if (leftOrder !== rightOrder) return leftOrder - rightOrder;
  return right.modifiedAt.localeCompare(left.modifiedAt) || left.title.localeCompare(right.title);
}

function statusOrder(status: string): number {
  switch (normalizeTaskStatus(status)) {
    case 'in_progress':
      return 0;
    case 'pending':
    case 'todo':
      return 1;
    case 'blocked':
      return 2;
    case 'completed':
      return 3;
    default:
      return 4;
  }
}

function normalizeTaskStatus(status: string): string {
  return status.trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function truncateText(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + '\u2026';
}

function isSafeId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) && !id.includes('..');
}

function safeChildPath(root: string, child: string): string | null {
  if (!isSafeId(child)) return null;
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(resolvedRoot, child);
  if (resolvedPath === resolvedRoot || !resolvedPath.startsWith(`${resolvedRoot}${sep}`)) return null;
  return resolvedPath;
}

function safeTaskPath(tasksDir: string, sessionId: string, taskId: string): string | null {
  if (!isSafeId(sessionId) || !isSafeId(taskId)) return null;
  const root = resolve(tasksDir);
  const path = resolve(root, sessionId, `${taskId}.json`);
  if (path === root || !path.startsWith(`${root}${sep}`)) return null;
  return path;
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    const stat = await lstat(path);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function taskNotFound(path?: string): ApiError {
  return new ApiError(404, 'TASK_NOT_FOUND', 'Task not found', [
    diagnostic('error', 'Task not found for the selected project.', path),
  ]);
}

function stringFromUnknown(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function diagnostic(level: Diagnostic['level'], message: string, path?: string): Diagnostic {
  return path ? { level, message, path } : { level, message };
}
