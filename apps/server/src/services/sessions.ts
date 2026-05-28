import { lstat, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type { ProjectSummary, SessionSummary } from '@openclaude-studio/shared';

import { encodeProjectPath, type OpenClaudePaths } from './paths.js';
import { redactTextSecrets } from './redaction.js';
import { readBoundedTextFile } from './safeFile.js';

type UnknownRecord = Record<string, unknown>;

type SessionProject = Pick<ProjectSummary, 'path' | 'usage'>;

type ParsedTranscriptEntry = {
  sessionId: string;
  timestamp: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  text: string;
  title: string | null;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  changedFiles: string[];
  failed: boolean;
};

const maxTranscriptBytes = 10 * 1024 * 1024;
const mutationTools = new Set(['Edit', 'MultiEdit', 'NotebookEdit', 'Write']);

export async function readSessionSummaries(
  paths: OpenClaudePaths,
  project: SessionProject,
): Promise<SessionSummary[]> {
  const files = await findTranscriptFilesForProject(paths.projectsDir, project.path);
  const entries: ParsedTranscriptEntry[] = [];
  for (const file of files) {
    entries.push(...(await parseTranscriptFile(file, project.path)));
  }

  return summarizeSessions(entries, project).sort((left, right) =>
    right.lastTimestamp.localeCompare(left.lastTimestamp),
  );
}

export async function findTranscriptFilesForProject(
  projectsDir: string,
  projectPath: string,
): Promise<string[]> {
  const projectDir = join(projectsDir, encodeProjectPath(projectPath));
  return collectJsonlFiles(projectDir);
}

async function collectJsonlFiles(root: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isNodeFileError(error, 'ENOENT') || isNodeFileError(error, 'ENOTDIR')) {
      return [];
    }
    throw error;
  }

  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = join(root, entry.name);
    const stats = await safeLstat(entryPath);
    if (!stats || stats.isSymbolicLink()) {
      continue;
    }

    if (stats.isDirectory()) {
      files.push(...(await collectJsonlFiles(entryPath)));
    } else if (stats.isFile() && entry.name.endsWith('.jsonl')) {
      files.push(entryPath);
    }
  }

  return files.sort((left, right) => left.localeCompare(right));
}

async function parseTranscriptFile(
  filePath: string,
  projectPath: string,
): Promise<ParsedTranscriptEntry[]> {
  const result = await readBoundedTextFile(filePath, { maxBytes: maxTranscriptBytes });
  if (!result.exists) {
    return [];
  }

  const entries: ParsedTranscriptEntry[] = [];
  for (const line of result.content.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }

    try {
      const parsed = JSON.parse(line) as unknown;
      const entry = transcriptEntryFromUnknown(parsed, projectPath);
      if (entry) {
        entries.push(entry);
      }
    } catch {
      continue;
    }
  }

  return entries;
}

function transcriptEntryFromUnknown(
  value: unknown,
  projectPath: string,
): ParsedTranscriptEntry | null {
  if (!isRecord(value) || value.isMeta === true) {
    return null;
  }

  const sessionId = stringFromUnknown(value.sessionId);
  const timestamp = normalizeTimestamp(value.timestamp);
  const cwd = stringFromUnknown(value.cwd);
  if (!sessionId || !timestamp || !cwd || resolve(cwd) !== resolve(projectPath)) {
    return null;
  }

  const type = stringFromUnknown(value.type) ?? 'system';
  const message = isRecord(value.message) ? value.message : null;
  const role = readRole(type, stringFromUnknown(message?.role));
  const content = message?.content;
  const usage = isRecord(message?.usage) ? message.usage : null;
  const text = message ? extractText(content) : stringFromUnknown(value.message) ?? '';
  const toolUses = extractToolUses(content);

  return {
    sessionId,
    timestamp,
    role,
    text,
    title: extractTitle(value),
    model: stringFromUnknown(message?.model),
    inputTokens: intFromUnknown(usage?.input_tokens),
    outputTokens: intFromUnknown(usage?.output_tokens),
    cacheReadTokens: intFromUnknown(usage?.cache_read_input_tokens),
    cacheWriteTokens: intFromUnknown(usage?.cache_creation_input_tokens),
    changedFiles: toolUses
      .filter((tool) => mutationTools.has(tool.name))
      .map((tool) => tool.filePath)
      .filter((filePath): filePath is string => Boolean(filePath)),
    failed:
      (type === 'system' && stringFromUnknown(value.level) === 'error') ||
      value.isApiErrorMessage === true ||
      Boolean(stringFromUnknown(value.error)),
  };
}

function summarizeSessions(
  entries: ParsedTranscriptEntry[],
  project: SessionProject,
): SessionSummary[] {
  const bySession = new Map<string, ParsedTranscriptEntry[]>();
  for (const entry of entries) {
    const rows = bySession.get(entry.sessionId) ?? [];
    rows.push(entry);
    bySession.set(entry.sessionId, rows);
  }

  return [...bySession.entries()].map(([sessionId, rows]) =>
    summarizeSession(sessionId, rows, project),
  );
}

function summarizeSession(
  sessionId: string,
  rows: ParsedTranscriptEntry[],
  project: SessionProject,
): SessionSummary {
  const sortedRows = rows.slice().sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  const firstTimestamp = sortedRows[0]?.timestamp ?? new Date(0).toISOString();
  const lastTimestamp = sortedRows.at(-1)?.timestamp ?? firstTimestamp;
  const explicitTitle = sortedRows.map((row) => row.title).find((title): title is string => Boolean(title));
  const userTitle = sortedRows
    .filter((row) => row.role === 'user')
    .map((row) => cleanTitle(row.text))
    .find(Boolean);

  return {
    id: sessionId,
    title: truncateText(explicitTitle ?? userTitle ?? `Session ${sessionId.slice(0, 8)}`, 80),
    status: sortedRows.some((row) => row.failed) ? 'failed' : 'completed',
    firstTimestamp,
    lastTimestamp,
    modelSet: unique(sortedRows.map((row) => row.model).filter((model): model is string => Boolean(model))),
    changedFiles: unique(sortedRows.flatMap((row) => row.changedFiles)).sort((left, right) =>
      left.localeCompare(right),
    ),
    tokens: {
      input: sum(sortedRows, (row) => row.inputTokens),
      output: sum(sortedRows, (row) => row.outputTokens),
      cacheRead: sum(sortedRows, (row) => row.cacheReadTokens),
      cacheWrite: sum(sortedRows, (row) => row.cacheWriteTokens),
    },
    costUsd: project.usage.lastSessionId === sessionId ? project.usage.costUsd : 0,
    linkedPlanCount: 0,
    linkedTaskCount: 0,
  };
}

function extractTitle(value: UnknownRecord): string | null {
  const type = stringFromUnknown(value.type);
  if (type !== 'custom-title' && type !== 'session-title' && type !== 'summary') {
    return null;
  }

  return cleanTitle(
    stringFromUnknown(value.title) ?? stringFromUnknown(value.name) ?? stringFromUnknown(value.summary) ?? '',
  );
}

function readRole(
  type: string,
  messageRole: string | null,
): ParsedTranscriptEntry['role'] {
  if (messageRole === 'user' || messageRole === 'assistant' || messageRole === 'system') {
    return messageRole;
  }
  if (type === 'user' || type === 'assistant' || type === 'system') {
    return type;
  }
  return 'tool';
}

function extractText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .map((block) => {
      if (!isRecord(block) || block.type !== 'text') {
        return '';
      }
      return stringFromUnknown(block.text) ?? '';
    })
    .filter(Boolean)
    .join('\n');
}

function extractToolUses(content: unknown): Array<{ name: string; filePath: string | null }> {
  if (!Array.isArray(content)) {
    return [];
  }

  const tools: Array<{ name: string; filePath: string | null }> = [];
  for (const block of content) {
    if (!isRecord(block) || block.type !== 'tool_use') {
      continue;
    }

    const name = stringFromUnknown(block.name);
    if (!name) {
      continue;
    }

    const input = isRecord(block.input) ? block.input : {};
    tools.push({
      name,
      filePath:
        stringFromUnknown(input.file_path) ??
        stringFromUnknown(input.path) ??
        stringFromUnknown(input.notebook_path),
    });
  }
  return tools;
}

function cleanTitle(value: string): string {
  return redactTextSecrets(value).replace(/\s+/g, ' ').trim();
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength - 1)}...`;
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

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function safeLstat(path: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(path);
  } catch (error) {
    if (isNodeFileError(error, 'ENOENT')) {
      return null;
    }
    throw error;
  }
}

function isNodeFileError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}
