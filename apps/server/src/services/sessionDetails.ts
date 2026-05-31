import { lstat, readdir } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

import type {
  ConversationTimelineEvent,
  LinkedPlanSummary,
  LinkedTaskSummary,
  ProjectSummary,
  SessionDetails,
  SessionDetailsResponse,
  SessionFileHistoryEntry,
} from '@openclaude-studio/shared';

import type { OpenClaudePaths } from './paths.js';
import { redactTextSecrets } from './redaction.js';
import { readBoundedTextFile } from './safeFile.js';
import {
  type ParsedToolResult,
  type ParsedToolUse,
  type ParsedTranscriptEntry,
  findTranscriptFilesForProject,
  parseTranscriptFilesForProject,
} from './sessions.js';
import { isUnambiguousSessionArtifactScope } from './sessionArtifacts.js';

type SessionProject = Pick<ProjectSummary, 'path' | 'usage'>;

const TOOL_TIMELINE_MAX_LENGTH = 6_000;
const TEXT_TIMELINE_MAX_LENGTH = 16_000;
const TASK_FILE_MAX_BYTES = 256 * 1024;
const PLAN_TITLE_MAX_BYTES = 64 * 1024;
const FILE_HISTORY_TRANSCRIPT_MAX_BYTES = 10 * 1024 * 1024;

const mutationTools = new Set(['Edit', 'MultiEdit', 'NotebookEdit', 'Write']);

export async function readSessionDetails(
  paths: OpenClaudePaths,
  project: SessionProject,
  sessionId: string,
): Promise<SessionDetailsResponse | null> {
  const files = await findTranscriptFilesForProject(paths.projectsDir, project.path);
  const allEntries = await parseTranscriptFilesForProject(files, project.path);

  const entries = allEntries.filter((entry) => entry.sessionId === sessionId);
  if (entries.length === 0) {
    return null;
  }

  const sorted = entries.slice().sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  const session = await buildSessionDetails(sessionId, sorted, project, paths);

  return {
    session,
    timeline: buildTimeline(sorted),
  };
}

async function buildSessionDetails(
  sessionId: string,
  entries: ParsedTranscriptEntry[],
  project: SessionProject,
  paths: OpenClaudePaths,
): Promise<SessionDetails> {
  const firstTimestamp = entries[0]?.timestamp ?? new Date(0).toISOString();
  const lastTimestamp = entries.at(-1)?.timestamp ?? firstTimestamp;
  const explicitTitle = entries.map((row) => row.title).find((title): title is string => Boolean(title));
  const userTitle = entries
    .filter((row) => row.role === 'user')
    .map((row) => cleanDetailTitle(row.text))
    .find(Boolean);
  const sourcePaths = unique(
    entries.map((entry) => entry.sourcePath).filter((path): path is string => Boolean(path)),
  );
  const linkedPlans = await readLinkedPlans(entries, paths.plansDir);
  const artifactScopeIsUnambiguous = await isUnambiguousSessionArtifactScope(
    paths.projectsDir,
    project.path,
    sessionId,
  );
  const [linkedTasks, fileHistory, fileHistoryAvailable]: [LinkedTaskSummary[], SessionFileHistoryEntry[], boolean] =
    artifactScopeIsUnambiguous
      ? await Promise.all([
          readLinkedTasks(paths.tasksDir, sessionId),
          readFileHistory(paths.fileHistoryDir, sessionId, sourcePaths),
          hasSafeSessionDirectoryEntries(paths.fileHistoryDir, sessionId),
        ])
      : [[], [], false];
  const changedFiles = unique(
    entries
      .flatMap((row) => row.toolUses)
      .filter((tool) => mutationTools.has(tool.name))
      .map((tool) => tool.filePath)
      .filter((filePath): filePath is string => Boolean(filePath)),
  ).sort((left, right) => left.localeCompare(right));
  const toolsUsed = countTools(entries);

  return {
    id: sessionId,
    title: truncateText(explicitTitle ?? userTitle ?? `Session ${sessionId}`, 80),
    status: entries.some((row) => row.failed) ? 'failed' : 'completed',
    firstTimestamp,
    lastTimestamp,
    modelSet: unique(entries.map((row) => row.model).filter((model): model is string => Boolean(model))).sort(
      (left, right) => left.localeCompare(right),
    ),
    changedFiles,
    tokens: {
      input: sum(entries, (row) => row.inputTokens),
      output: sum(entries, (row) => row.outputTokens),
      cacheRead: sum(entries, (row) => row.cacheReadTokens),
      cacheWrite: sum(entries, (row) => row.cacheWriteTokens),
    },
    costUsd: project.usage.lastSessionId === sessionId ? project.usage.costUsd : 0,
    linkedPlanCount: linkedPlans.length,
    linkedTaskCount: linkedTasks.length,
    messageCount: entries.filter(isDisplayMessage).length,
    toolsUsed,
    fileHistoryAvailable: fileHistory.length > 0 || fileHistoryAvailable,
    fileHistory,
    linkedTasks,
    linkedPlans,
  };
}

function buildTimeline(entries: ParsedTranscriptEntry[]): ConversationTimelineEvent[] {
  const events: ConversationTimelineEvent[] = [];
  const toolCallsById = new Map<string, ParsedToolUse>();
  let latestToolCall: ParsedToolUse | null = null;

  for (const [rowIndex, row] of entries.entries()) {
    if (row.failed && row.role !== 'tool') {
      events.push({
        id: `${row.sessionId}-${rowIndex}-error`,
        timestamp: row.timestamp,
        kind: 'error',
        title: 'Error',
        content: sanitizeTimelineContent(row.text.trim() || 'Error event recorded without details.', TEXT_TIMELINE_MAX_LENGTH),
      });
    } else if (row.role === 'user' || row.role === 'assistant') {
      const content = sanitizeTimelineContent(row.text.trim(), TEXT_TIMELINE_MAX_LENGTH);
      if (content) {
        events.push({
          id: `${row.sessionId}-${rowIndex}-${row.role}`,
          timestamp: row.timestamp,
          kind: row.role,
          title: row.role === 'user' ? 'User message' : row.model ?? 'Assistant message',
          content,
        });
      }
    } else if (row.role === 'tool') {
      const resultEvent = buildToolResultEvent(row, rowIndex, toolCallsById, latestToolCall);
      if (resultEvent) {
        events.push(resultEvent);
      }
    } else if (row.role === 'system' && row.text.trim()) {
      events.push({
        id: `${row.sessionId}-${rowIndex}-system`,
        timestamp: row.timestamp,
        kind: 'system',
        title: 'System',
        content: sanitizeTimelineContent(row.text.trim(), TEXT_TIMELINE_MAX_LENGTH),
      });
    }

    for (const [toolIndex, tool] of row.toolUses.entries()) {
      if (tool.id) {
        toolCallsById.set(tool.id, tool);
      }
      latestToolCall = tool;
      events.push(buildToolCallEvent(row, rowIndex, toolIndex, tool));
    }
  }

  return events.filter(isMeaningfulTimelineEvent);
}

function buildToolCallEvent(
  row: ParsedTranscriptEntry,
  rowIndex: number,
  toolIndex: number,
  tool: ParsedToolUse,
): ConversationTimelineEvent {
  const command = tool.command ? sanitizeTimelineContent(tool.command, TOOL_TIMELINE_MAX_LENGTH) : null;
  const filePath = tool.filePath ? sanitizeTimelineContent(tool.filePath, TOOL_TIMELINE_MAX_LENGTH) : null;
  const outputType: NonNullable<ConversationTimelineEvent['tool']>['outputType'] = command
    ? 'command'
    : filePath
      ? 'file'
      : 'text';
  const rawContent = command ?? filePath ?? tool.details ?? tool.displayLabel ?? tool.name;

  return {
    id: `${row.sessionId}-${rowIndex}-tool-${toolIndex}`,
    timestamp: row.timestamp,
    kind: 'tool',
    title: toolCallTitle(tool),
    content: sanitizeTimelineContent(rawContent, TOOL_TIMELINE_MAX_LENGTH),
    tool: {
      phase: 'call',
      name: tool.name,
      status: 'unknown',
      command,
      filePath,
      outputType,
    },
  };
}

function buildToolResultEvent(
  row: ParsedTranscriptEntry,
  rowIndex: number,
  toolCallsById: Map<string, ParsedToolUse>,
  latestToolCall: ParsedToolUse | null,
): ConversationTimelineEvent | null {
  const result = row.toolResult;
  if (!result) {
    const content = sanitizeTimelineContent(row.text, TOOL_TIMELINE_MAX_LENGTH);
    return content.trim()
      ? {
          id: `${row.sessionId}-${rowIndex}-tool-result`,
          timestamp: row.timestamp,
          kind: 'tool',
          title: 'Tool result',
          content,
        }
      : null;
  }

  const sourceTool = result.toolUseId ? toolCallsById.get(result.toolUseId) ?? latestToolCall : latestToolCall;
  const command = sourceTool?.command ? sanitizeTimelineContent(sourceTool.command, TOOL_TIMELINE_MAX_LENGTH) : null;
  const filePath = result.filePath ?? sourceTool?.filePath ?? null;
  const safeFilePath = filePath ? sanitizeTimelineContent(filePath, TOOL_TIMELINE_MAX_LENGTH) : null;
  const outputType = normalizeToolResultOutputType(result, sourceTool);
  const content = toolResultContent({ ...result, outputType }, safeFilePath);

  if (!content.trim() && result.status !== 'error') {
    return null;
  }

  return {
    id: `${row.sessionId}-${rowIndex}-tool-result`,
    timestamp: row.timestamp,
    kind: 'tool',
    title: toolResultTitle({ ...result, outputType }, sourceTool),
    content: sanitizeTimelineContent(content, TOOL_TIMELINE_MAX_LENGTH),
    tool: {
      phase: 'result',
      name: sourceTool?.name ?? null,
      status: result.status,
      command,
      filePath: safeFilePath,
      outputType,
    },
  };
}

function normalizeToolResultOutputType(
  result: ParsedToolResult,
  sourceTool: ParsedToolUse | null,
): NonNullable<ConversationTimelineEvent['tool']>['outputType'] {
  if (result.outputType === 'text' && /^Bash$/i.test(sourceTool?.name ?? '')) {
    return result.status === 'error' ? 'stderr' : 'stdout';
  }
  return result.outputType;
}

function toolCallTitle(tool: ParsedToolUse): string {
  if (/^Bash$/i.test(tool.name)) return 'Run command';
  if (/^Write$/i.test(tool.name)) return 'Write file';
  if (/^(Edit|MultiEdit|NotebookEdit)$/i.test(tool.name)) return 'Edit file';
  if (/^(Read|NotebookRead)$/i.test(tool.name)) return 'Read file';
  if (/^Skill$/i.test(tool.name) && tool.displayLabel) {
    return `Skill: ${truncateText(redactTextSecrets(tool.displayLabel), 100)}`;
  }
  if (/^TaskCreate$/i.test(tool.name) && tool.displayLabel) {
    return `Task: ${truncateText(redactTextSecrets(tool.displayLabel), 100)}`;
  }
  if (/^Agent$/i.test(tool.name) && tool.displayLabel) {
    return `Agent: ${truncateText(redactTextSecrets(tool.displayLabel), 100)}`;
  }
  return `${tool.name} call`;
}

function toolResultTitle(result: ParsedToolResult, sourceTool: ParsedToolUse | null): string {
  if (result.status === 'error') {
    if (result.outputType === 'stderr' || /^Bash$/i.test(sourceTool?.name ?? '')) return 'Command error';
    return 'Tool error';
  }
  if (result.outputType === 'stdout') return 'Command output';
  if (result.outputType === 'stderr') return 'Command output';
  if (result.outputType === 'image') return 'Image output';
  if (result.outputType === 'text' && result.filePath) return 'File content';
  if (result.outputType === 'file') {
    if (result.resultType === 'create') return 'File created';
    if (result.resultType === 'delete') return 'File deleted';
    if (result.resultType === 'update' || result.resultType === 'edit') return 'File edited';
    return 'File result';
  }
  return 'Tool result';
}

function toolResultContent(result: ParsedToolResult, filePath: string | null): string {
  if (result.outputType === 'stdout') return result.stdout ?? result.text ?? '';
  if (result.outputType === 'stderr') return result.stderr ?? result.text ?? '';
  if (result.outputType === 'file') return filePath ?? result.text ?? '';
  if (result.outputType === 'text') return result.text ?? '';
  if (result.outputType === 'image') return result.text ?? 'Image output produced.';
  return result.text ?? '';
}

async function readLinkedTasks(tasksDir: string, sessionId: string): Promise<LinkedTaskSummary[]> {
  const sessionTasksDir = await safeExistingDirectory(tasksDir, sessionId);
  if (!sessionTasksDir) {
    return [];
  }

  let entries;
  try {
    entries = await readdir(sessionTasksDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const tasks: LinkedTaskSummary[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json') || entry.name.startsWith('.')) {
      continue;
    }

    const taskPath = safeChildPath(sessionTasksDir, entry.name);
    if (!taskPath) {
      continue;
    }

    try {
      const stats = await lstat(taskPath);
      if (!stats.isFile() || stats.isSymbolicLink()) {
        continue;
      }
      const taskFile = await readBoundedTextFile(taskPath, { maxBytes: TASK_FILE_MAX_BYTES });
      if (!taskFile.exists) {
        continue;
      }
      const parsed = JSON.parse(taskFile.content) as unknown;
      const taskId = entry.name.slice(0, -'.json'.length);
      const task = linkedTaskFromUnknown(parsed, taskId);
      if (task) {
        tasks.push(task);
      }
    } catch {
      continue;
    }
  }

  return tasks.sort((left, right) => compareTaskIds(left.id, right.id));
}

function linkedTaskFromUnknown(value: unknown, taskId: string): LinkedTaskSummary | null {
  if (!isRecord(value)) {
    return null;
  }

  const id = stringFromUnknown(value.id) ?? taskId;
  const title = stringFromUnknown(value.subject) ?? stringFromUnknown(value.title) ?? `Task ${taskId}`;
  if (!id) {
    return null;
  }

  return {
    id,
    title: truncateText(redactTextSecrets(title), 140),
    status: stringFromUnknown(value.status) ?? 'unknown',
    description: truncateText(redactTextSecrets(stringFromUnknown(value.description) ?? ''), 500),
    activeForm: stringFromUnknown(value.activeForm)
      ? truncateText(redactTextSecrets(String(value.activeForm)), 140)
      : null,
  };
}

async function readLinkedPlans(
  entries: ParsedTranscriptEntry[],
  plansDir: string,
): Promise<LinkedPlanSummary[]> {
  const slugs = planSlugsFromRows(entries);
  const plans = await Promise.all(slugs.map((slug) => resolveLinkedPlan(plansDir, slug)));
  return plans.filter((plan): plan is LinkedPlanSummary => plan !== null && plan.exists);
}

function planSlugsFromRows(rows: ParsedTranscriptEntry[]): string[] {
  return unique(rows.map((row) => row.slug).filter((slug): slug is string => typeof slug === 'string' && isSafePlanSlug(slug)));
}

function isSafePlanSlug(slug: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(slug) && !slug.includes('..');
}

async function resolveLinkedPlan(plansDir: string, slug: string): Promise<LinkedPlanSummary | null> {
  const planPath = safeChildPath(plansDir, `${slug}.md`);
  if (!planPath) {
    return null;
  }

  try {
    const stats = await lstat(planPath);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      return { slug, title: slug, exists: false };
    }

    const planFile = await readBoundedTextFile(planPath, { maxBytes: PLAN_TITLE_MAX_BYTES });
    if (!planFile.exists) {
      return { slug, title: slug, exists: false };
    }
    return {
      slug,
      title: markdownTitle(planFile.content) ?? slug,
      exists: true,
    };
  } catch {
    return { slug, title: slug, exists: false };
  }
}

function markdownTitle(content: string): string | null {
  for (const line of content.split(/\r?\n/)) {
    const match = /^#\s+(.+?)\s*$/.exec(line);
    if (match?.[1]) {
      return truncateText(redactTextSecrets(match[1]), 140);
    }
  }
  return null;
}

async function readFileHistory(
  fileHistoryDir: string,
  sessionId: string,
  transcriptPaths: string[],
): Promise<SessionFileHistoryEntry[]> {
  const sessionHistoryDir = safeChildPath(fileHistoryDir, sessionId);
  if (!sessionHistoryDir || transcriptPaths.length === 0) {
    return [];
  }

  const historyEntries: Array<Omit<SessionFileHistoryEntry, 'backupExists'>> = [];
  for (const transcriptPath of transcriptPaths) {
    let content = '';
    try {
      const transcript = await readBoundedTextFile(transcriptPath, { maxBytes: FILE_HISTORY_TRANSCRIPT_MAX_BYTES });
      if (!transcript.exists) {
        continue;
      }
      content = transcript.content;
    } catch {
      continue;
    }

    for (const line of content.split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }

      try {
        const parsed = JSON.parse(line) as unknown;
        historyEntries.push(...fileHistoryEntriesFromUnknown(parsed));
      } catch {
        continue;
      }
    }
  }

  const dedupedHistoryEntries = dedupeFileHistoryEntries(historyEntries);
  const entries = await Promise.all(
    dedupedHistoryEntries.map(async (entry) => ({
      ...entry,
      backupExists: entry.backupFileName
        ? await safeBackupExists(sessionHistoryDir, entry.backupFileName)
        : false,
    })),
  );

  return entries.sort((left, right) => left.filePath.localeCompare(right.filePath) || compareFileHistoryEntries(left, right));
}

function dedupeFileHistoryEntries(
  entries: Array<Omit<SessionFileHistoryEntry, 'backupExists'>>,
): Array<Omit<SessionFileHistoryEntry, 'backupExists'>> {
  const byBackupIdentity = new Map<string, Omit<SessionFileHistoryEntry, 'backupExists'>>();

  for (const entry of entries) {
    const key = [
      entry.filePath,
      entry.backupFileName ?? 'new-file',
      entry.version,
    ].join('\0');
    const existing = byBackupIdentity.get(key);
    if (!existing || isEarlierFileHistoryEntry(entry, existing)) {
      byBackupIdentity.set(key, entry);
    }
  }

  return [...byBackupIdentity.values()];
}

function isEarlierFileHistoryEntry(
  candidate: Omit<SessionFileHistoryEntry, 'backupExists'>,
  existing: Omit<SessionFileHistoryEntry, 'backupExists'>,
): boolean {
  if (!candidate.backupTime) {
    return false;
  }
  if (!existing.backupTime) {
    return true;
  }
  return candidate.backupTime < existing.backupTime;
}

function fileHistoryEntriesFromUnknown(value: unknown): Array<Omit<SessionFileHistoryEntry, 'backupExists'>> {
  if (!isRecord(value) || value.type !== 'file-history-snapshot') {
    return [];
  }

  const snapshot = isRecord(value.snapshot) ? value.snapshot : null;
  const trackedFileBackups = isRecord(snapshot?.trackedFileBackups) ? snapshot.trackedFileBackups : null;
  if (!trackedFileBackups) {
    return [];
  }

  const snapshotTimestamp = normalizeTimestamp(snapshot?.timestamp);
  const entries: Array<Omit<SessionFileHistoryEntry, 'backupExists'>> = [];
  for (const [filePath, rawBackup] of Object.entries(trackedFileBackups)) {
    if (!isRecord(rawBackup) || !filePath.trim()) {
      continue;
    }

    const backupFileName =
      rawBackup.backupFileName === null ? null : stringFromUnknown(rawBackup.backupFileName);
    entries.push({
      filePath: redactTextSecrets(filePath),
      backupFileName,
      version: intFromUnknown(rawBackup.version),
      backupTime: normalizeTimestamp(rawBackup.backupTime) ?? snapshotTimestamp,
    });
  }

  return entries;
}

async function hasSafeSessionDirectoryEntries(root: string, sessionId: string): Promise<boolean> {
  const sessionDir = await safeExistingDirectory(root, sessionId);
  if (!sessionDir) {
    return false;
  }

  try {
    const entries = await readdir(sessionDir, { withFileTypes: true });
    return entries.some((entry) => entry.isFile() && !entry.name.startsWith('.'));
  } catch {
    return false;
  }
}

async function safeExistingDirectory(root: string, child: string): Promise<string | null> {
  const path = safeChildPath(root, child);
  if (!path) {
    return null;
  }

  try {
    const stats = await lstat(path);
    return stats.isDirectory() && !stats.isSymbolicLink() ? path : null;
  } catch {
    return null;
  }
}

async function safeBackupExists(sessionHistoryDir: string, backupFileName: string): Promise<boolean> {
  const backupPath = safeChildPath(sessionHistoryDir, backupFileName);
  if (!backupPath) {
    return false;
  }

  try {
    const stats = await lstat(backupPath);
    return stats.isFile() && !stats.isSymbolicLink();
  } catch {
    return false;
  }
}

function safeChildPath(root: string, child: string): string | null {
  if (!child || child.includes('/') || child.includes('\\') || child.includes('..')) {
    return null;
  }

  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(resolvedRoot, child);
  if (resolvedPath === resolvedRoot || !resolvedPath.startsWith(`${resolvedRoot}${sep}`)) {
    return null;
  }

  return resolvedPath;
}

function isMeaningfulTimelineEvent(event: ConversationTimelineEvent): boolean {
  if (event.kind === 'tool') {
    return Boolean(event.content.trim() || event.tool?.command || event.tool?.filePath || event.tool?.name);
  }
  return Boolean(event.content.trim());
}

function isDisplayMessage(row: ParsedTranscriptEntry): boolean {
  return (row.role === 'user' || row.role === 'assistant') && row.text.trim().length > 0;
}

function countTools(entries: ParsedTranscriptEntry[]): { name: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    for (const tool of entry.toolUses) {
      counts.set(tool.name, (counts.get(tool.name) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));
}

function compareTaskIds(left: string, right: string): number {
  const leftNumber = Number.parseInt(left, 10);
  const rightNumber = Number.parseInt(right, 10);
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber) && leftNumber !== rightNumber) {
    return leftNumber - rightNumber;
  }
  return left.localeCompare(right);
}

function compareFileHistoryEntries(
  left: Omit<SessionFileHistoryEntry, 'backupExists'>,
  right: Omit<SessionFileHistoryEntry, 'backupExists'>,
): number {
  if (left.backupTime && right.backupTime && left.backupTime !== right.backupTime) {
    return left.backupTime.localeCompare(right.backupTime);
  }
  return left.version - right.version;
}

function cleanDetailTitle(value: string): string {
  const normalized = redactTextSecrets(
    value
      .replace(/<command-message>[\s\S]*?(?:<\/command-message>|$)/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim();

  return normalized.startsWith('/') ? '' : normalized;
}

function sanitizeTimelineContent(content: string, maxLength: number): string {
  return truncateText(redactTextSecrets(content), maxLength);
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  if (maxLength <= 3) return '.'.repeat(Math.max(0, maxLength));
  return `${value.slice(0, maxLength - 3)}...`;
}

function normalizeTimestamp(value: unknown): string | null {
  let timestamp: number;
  if (typeof value === 'number') {
    timestamp = value;
  } else if (typeof value === 'string') {
    timestamp = Date.parse(value);
  } else {
    return null;
  }

  if (!Number.isFinite(timestamp)) {
    return null;
  }

  return new Date(timestamp).toISOString();
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function sum<T>(items: T[], selector: (item: T) => number): number {
  return items.reduce((total, item) => total + selector(item), 0);
}

function intFromUnknown(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function stringFromUnknown(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
