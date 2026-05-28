import { lstat, readdir } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { join } from 'node:path';

import type {
  Diagnostic,
  LogEntry,
  LogFileSummary,
  LogsFilesResponse,
  LogsSearchResponse,
  LogsWindowResponse,
} from '@openclaude-studio/shared';

import type { OpenClaudePaths } from './paths.js';
import { redactTextSecrets } from './redaction.js';
import { readContainedBoundedTextFile } from './safeFile.js';

type InternalLogFile = LogFileSummary & {
  path: string;
};

export type LogWindowRequest = {
  start?: number;
  count?: number;
};

export type LogSearchRequest = LogWindowRequest & {
  query?: string;
  level?: LogEntry['level'] | 'all';
};

const maxLogBytes = 1024 * 1024;
const defaultWindowCount = 250;
const maxWindowCount = 1000;
const timestampPattern = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z)\s+(.*)$/;
const leadingLevelPattern = /^(?:\[(info|warn|warning|error|debug)\]|(info|warn|warning|error|debug))[:\s-]+/i;

export async function listLogFiles(paths: OpenClaudePaths): Promise<LogsFilesResponse> {
  const result = await listInternalLogFiles(paths.debugDir);
  return {
    files: result.files.map(toPublicLogFile),
    diagnostics: result.diagnostics,
  };
}

export async function readLogWindow(
  paths: OpenClaudePaths,
  fileName?: string,
  request: LogWindowRequest = {},
): Promise<LogsWindowResponse> {
  const listed = await listInternalLogFiles(paths.debugDir);
  const diagnostics = [...listed.diagnostics];
  const start = normalizeStart(request.start);
  const count = normalizeCount(request.count);

  const selected = selectLogFile(listed.files, fileName, diagnostics);
  if (!selected) {
    return emptyWindow(listed.files, null, diagnostics, start, count);
  }

  const read = await readSelectedLog(paths.debugDir, selected, diagnostics);
  if (!read) {
    return emptyWindow(listed.files, selected, diagnostics, start, count);
  }

  const lines = splitLogLines(read);
  const safeStart = Math.min(start, lines.length);
  const entries = lines
    .slice(safeStart, safeStart + count)
    .map((line, index) => parseLogLine(line, selected.name, safeStart + index + 1));

  return {
    files: listed.files.map(toPublicLogFile),
    selectedFile: toPublicLogFile(selected),
    entries,
    start: safeStart,
    count,
    totalLines: lines.length,
    diagnostics,
  };
}

export async function searchLogs(
  paths: OpenClaudePaths,
  fileName?: string,
  request: LogSearchRequest = {},
): Promise<LogsSearchResponse> {
  const listed = await listInternalLogFiles(paths.debugDir);
  const diagnostics = [...listed.diagnostics];
  const start = normalizeStart(request.start);
  const count = normalizeCount(request.count);
  const query = (request.query ?? '').trim();
  const level = request.level ?? 'all';

  const selected = selectLogFile(listed.files, fileName, diagnostics);
  if (!selected) {
    return {
      ...emptyWindow(listed.files, null, diagnostics, start, count),
      query,
      totalMatches: 0,
    };
  }

  const read = await readSelectedLog(paths.debugDir, selected, diagnostics);
  if (!read) {
    return {
      ...emptyWindow(listed.files, selected, diagnostics, start, count),
      query,
      totalMatches: 0,
    };
  }

  const allEntries = splitLogLines(read).map((line, index) =>
    parseLogLine(line, selected.name, index + 1),
  );
  const matches = allEntries.filter((entry) => matchesSearch(entry, query, level));
  const safeStart = Math.min(start, matches.length);

  return {
    files: listed.files.map(toPublicLogFile),
    selectedFile: toPublicLogFile(selected),
    entries: matches.slice(safeStart, safeStart + count),
    start: safeStart,
    count,
    totalLines: allEntries.length,
    diagnostics,
    query,
    totalMatches: matches.length,
  };
}

async function listInternalLogFiles(debugDir: string): Promise<{
  files: InternalLogFile[];
  diagnostics: Diagnostic[];
}> {
  let entries;
  try {
    entries = await readdir(debugDir, { withFileTypes: true });
  } catch (error) {
    if (isNodeFileError(error, 'ENOENT') || isNodeFileError(error, 'ENOTDIR')) {
      return {
        files: [],
        diagnostics: [{ level: 'warn', message: `Debug directory does not exist: ${debugDir}`, path: debugDir }],
      };
    }
    throw error;
  }

  const files: InternalLogFile[] = [];
  for (const entry of entries) {
    if (!isLogFileName(entry.name)) {
      continue;
    }

    const path = join(debugDir, entry.name);
    const stats = await safeLstat(path);
    if (!stats || !stats.isFile() || stats.isSymbolicLink()) {
      continue;
    }

    files.push({
      name: entry.name,
      path,
      sizeBytes: stats.size,
      modifiedAt: stats.mtime.toISOString(),
      sessionId: sessionIdFromLogName(entry.name),
    });
  }

  return {
    files: files.sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt)),
    diagnostics: [],
  };
}

function selectLogFile(
  files: InternalLogFile[],
  fileName: string | undefined,
  diagnostics: Diagnostic[],
): InternalLogFile | null {
  if (fileName && isUnsafeFileName(fileName)) {
    diagnostics.push({ level: 'warn', message: `Log file name "${fileName}" is not allowed.` });
    return null;
  }

  const selected = fileName ? files.find((file) => file.name === fileName) : files[0];
  if (!selected && fileName) {
    diagnostics.push({ level: 'warn', message: `Log file "${fileName}" was not found.` });
  }
  return selected ?? null;
}

async function readSelectedLog(
  debugDir: string,
  selected: InternalLogFile,
  diagnostics: Diagnostic[],
): Promise<string | null> {
  const result = await readContainedBoundedTextFile(debugDir, selected.path, { maxBytes: maxLogBytes });
  diagnostics.push(...result.diagnostics);
  return result.exists ? result.content : null;
}

function parseLogLine(line: string, fileName: string, lineNumber: number): LogEntry {
  const timestampMatch = line.match(timestampPattern);
  const timestamp = timestampMatch?.[1] ?? null;
  const body = timestampMatch?.[2] ?? line;
  const leadingLevel = body.match(leadingLevelPattern);
  const inferredLevel = inferLevel(body);
  const message = leadingLevel
    ? body.slice(leadingLevel[0].length).trim()
    : body.trim();

  return {
    id: `${fileName}:${lineNumber}`,
    lineNumber,
    timestamp,
    level: normalizeLevel(leadingLevel?.[1] ?? leadingLevel?.[2] ?? inferredLevel),
    message: redactTextSecrets(message),
  };
}

function matchesSearch(entry: LogEntry, query: string, level: LogSearchRequest['level']): boolean {
  if (level && level !== 'all' && entry.level !== level) {
    return false;
  }
  if (!query) {
    return true;
  }
  return entry.message.toLowerCase().includes(query.toLowerCase());
}

function emptyWindow(
  files: InternalLogFile[],
  selectedFile: InternalLogFile | null,
  diagnostics: Diagnostic[],
  start: number,
  count: number,
): LogsWindowResponse {
  return {
    files: files.map(toPublicLogFile),
    selectedFile: selectedFile ? toPublicLogFile(selectedFile) : null,
    entries: [],
    start,
    count,
    totalLines: 0,
    diagnostics,
  };
}

function splitLogLines(content: string): string[] {
  const lines = content.split(/\r?\n/);
  if (lines.at(-1) === '') {
    lines.pop();
  }
  return lines;
}

function normalizeStart(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function normalizeCount(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
    return defaultWindowCount;
  }
  return Math.min(Math.floor(value), maxWindowCount);
}

function normalizeLevel(value: string | undefined): LogEntry['level'] {
  if (!value) {
    return 'info';
  }

  const lower = value.toLowerCase();
  if (lower === 'warning') return 'warn';
  if (lower === 'warn' || lower === 'error' || lower === 'debug' || lower === 'info') {
    return lower;
  }
  return 'info';
}

function inferLevel(value: string): LogEntry['level'] {
  if (/\berror\b/i.test(value)) return 'error';
  if (/\bwarn(?:ing)?\b/i.test(value)) return 'warn';
  if (/\bdebug\b/i.test(value)) return 'debug';
  return 'info';
}

function isLogFileName(name: string): boolean {
  return name === 'latest' || name.endsWith('.txt') || name.endsWith('.log');
}

function isUnsafeFileName(name: string): boolean {
  return name.length === 0 || name.includes('/') || name.includes('\\') || name.includes('..');
}

function sessionIdFromLogName(name: string): string | null {
  if (name === 'latest') {
    return null;
  }
  return name.replace(/\.(?:txt|log)$/i, '') || null;
}

function toPublicLogFile(file: InternalLogFile): LogFileSummary {
  return {
    name: file.name,
    sizeBytes: file.sizeBytes,
    modifiedAt: file.modifiedAt,
    sessionId: file.sessionId,
  };
}

async function safeLstat(path: string): Promise<Stats | null> {
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
