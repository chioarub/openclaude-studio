import { constants, type Stats } from 'node:fs';
import { lstat, open, readdir, type FileHandle } from 'node:fs/promises';
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

type InternalLogFile = LogFileSummary & {
  path: string;
};

type LogFileIdentity = Pick<Stats, 'dev' | 'ino' | 'mtimeMs' | 'size'>;

type LogFileRevision = LogFileIdentity & {
  key: string;
};

type LogLineIndex = {
  cacheKey: string;
  file: InternalLogFile;
  lineOffsets: number[];
  lineCount: number;
  revision: LogFileRevision;
  sizeBytes: number;
  modifiedAt: string;
};

export type LogFileScope = {
  sessionIds?: ReadonlySet<string>;
};

export type LogWindowRequest = {
  start?: number;
  count?: number;
};

export type LogSearchRequest = LogWindowRequest & {
  query?: string;
  level?: LogEntry['level'] | 'all';
};

const defaultWindowCount = 250;
const maxWindowCount = 1000;
const maxLogIndexCacheEntries = 16;
const timestampPattern = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z)\s+(.*)$/;
const leadingLevelPattern = /^(?:\[(info|warn|warning|error|debug)\]|(info|warn|warning|error|debug))[:\s-]+/i;
const logIndexCache = new Map<string, LogLineIndex>();

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
  scope: LogFileScope = {},
): Promise<LogsWindowResponse> {
  const listed = await listInternalLogFiles(paths.debugDir);
  const files = scopeLogFiles(listed.files, scope);
  const diagnostics = [...listed.diagnostics];
  const start = normalizeStart(request.start);
  const count = normalizeCount(request.count);

  const selected = selectLogFile(files, fileName, diagnostics);
  if (!selected) {
    return emptyWindow(files, null, diagnostics, start, count);
  }

  const index = await getOrBuildLogIndex(selected, diagnostics);
  if (!index) {
    return emptyWindow(files, selected, diagnostics, start, count);
  }

  const entries = await readIndexedEntries(index, start, count, diagnostics);
  const safeStart = Math.min(start, index.lineCount);

  return {
    files: files.map(toPublicLogFile),
    selectedFile: toPublicLogFile(selected),
    entries,
    start: safeStart,
    count,
    totalLines: index.lineCount,
    diagnostics,
  };
}

export async function searchLogs(
  paths: OpenClaudePaths,
  fileName?: string,
  request: LogSearchRequest = {},
  scope: LogFileScope = {},
): Promise<LogsSearchResponse> {
  const listed = await listInternalLogFiles(paths.debugDir);
  const files = scopeLogFiles(listed.files, scope);
  const diagnostics = [...listed.diagnostics];
  const start = normalizeStart(request.start);
  const count = normalizeCount(request.count);
  const query = (request.query ?? '').trim();
  const level = request.level ?? 'all';

  const selected = selectLogFile(files, fileName, diagnostics);
  if (!selected) {
    return {
      ...emptyWindow(files, null, diagnostics, start, count),
      query,
      totalMatches: 0,
    };
  }

  const index = await getOrBuildLogIndex(selected, diagnostics);
  if (!index) {
    return {
      ...emptyWindow(files, selected, diagnostics, start, count),
      query,
      totalMatches: 0,
    };
  }

  let totalMatches = 0;
  const entries: LogEntry[] = [];
  const handle = await openIndexedLogHandle(index, diagnostics);
  if (handle) {
    try {
      for (let line = 0; line < index.lineCount; line += maxWindowCount) {
        const windowEntries = await readIndexedEntriesFromHandle(
          handle,
          index,
          line,
          Math.min(maxWindowCount, index.lineCount - line),
        );
        for (const entry of windowEntries) {
          if (!matchesSearch(entry, query, level)) continue;
          if (totalMatches >= start && entries.length < count) {
            entries.push(entry);
          }
          totalMatches += 1;
        }
      }
    } finally {
      await handle.close().catch(() => undefined);
    }
  }
  const safeStart = Math.min(start, totalMatches);

  return {
    files: files.map(toPublicLogFile),
    selectedFile: toPublicLogFile(selected),
    entries,
    start: safeStart,
    count,
    totalLines: index.lineCount,
    diagnostics,
    query,
    totalMatches,
  };
}

function scopeLogFiles(files: InternalLogFile[], scope: LogFileScope): InternalLogFile[] {
  if (!scope.sessionIds) {
    return files;
  }

  return files.filter((file) => file.sessionId !== null && scope.sessionIds?.has(file.sessionId));
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

  const sortedFiles = files.sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt));

  return {
    files: sortedFiles,
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

  const selected = fileName ? files.find((file) => file.name === fileName) : files.find((file) => file.name === 'latest') ?? files[0];
  if (!selected && fileName) {
    diagnostics.push({ level: 'warn', message: `Log file "${fileName}" was not found.` });
  }
  return selected ?? null;
}

async function getOrBuildLogIndex(
  selected: InternalLogFile,
  diagnostics: Diagnostic[],
): Promise<LogLineIndex | null> {
  const opened = await openLogFile(selected, diagnostics);
  if (!opened.handle || !opened.identity) {
    return null;
  }

  try {
    const revision = toLogFileRevision(opened.identity);
    const cacheKey = `${selected.path}:${revision.dev}:${revision.ino}`;
    const cached = logIndexCache.get(cacheKey);
    if (cached && cached.revision.size === revision.size && cached.revision.mtimeMs === revision.mtimeMs) {
      return cached;
    }

    const index = await buildLogLineIndex(opened.handle, selected, cacheKey, revision);
    logIndexCache.set(cacheKey, index);
    pruneLogIndexCache();
    return index;
  } finally {
    await opened.handle.close().catch(() => undefined);
  }
}

async function openLogFile(
  selected: InternalLogFile,
  diagnostics: Diagnostic[],
): Promise<{
  handle: FileHandle | null;
  identity: LogFileIdentity | null;
}> {
  let beforeOpen;
  try {
    beforeOpen = await lstat(selected.path);
  } catch (error) {
    diagnostics.push({
      level: 'warn',
      message: `Unable to inspect log file "${selected.name}": ${errorMessage(error)}`,
      path: selected.path,
    });
    return { handle: null, identity: null };
  }

  if (beforeOpen.isSymbolicLink() || !beforeOpen.isFile()) {
    diagnostics.push({
      level: 'warn',
      message: `Log file "${selected.name}" is not a regular file.`,
      path: selected.path,
    });
    return { handle: null, identity: null };
  }

  const noFollowFlag = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
  let handle: FileHandle | null = null;
  try {
    handle = await open(selected.path, constants.O_RDONLY | noFollowFlag);
    const afterOpen = await handle.stat();
    if (!sameLogFileIdentity(beforeOpen, afterOpen)) {
      await handle.close();
      return { handle: null, identity: null };
    }
    return { handle, identity: toLogFileIdentity(afterOpen) };
  } catch (error) {
    if (handle) {
      await handle.close().catch(() => undefined);
    }
    diagnostics.push({
      level: 'warn',
      message: `Unable to safely open log file "${selected.name}": ${errorMessage(error)}`,
      path: selected.path,
    });
    return { handle: null, identity: null };
  }
}

async function buildLogLineIndex(
  handle: FileHandle,
  selected: InternalLogFile,
  cacheKey: string,
  revision: LogFileRevision,
): Promise<LogLineIndex> {
  const lineOffsets: number[] = revision.size > 0 ? [0] : [];
  const chunkSize = 64 * 1024;
  const buffer = Buffer.allocUnsafe(chunkSize);
  let position = 0;

  while (position < revision.size) {
    const length = Math.min(chunkSize, revision.size - position);
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    if (bytesRead === 0) break;

    for (let index = 0; index < bytesRead; index += 1) {
      if (buffer[index] !== 10) continue;
      const nextLineOffset = position + index + 1;
      if (nextLineOffset < revision.size) {
        lineOffsets.push(nextLineOffset);
      }
    }
    position += bytesRead;
  }

  return {
    cacheKey,
    file: selected,
    lineOffsets,
    lineCount: lineOffsets.length,
    revision,
    sizeBytes: revision.size,
    modifiedAt: new Date(revision.mtimeMs).toISOString(),
  };
}

async function readIndexedEntries(
  index: LogLineIndex,
  requestedStart: number,
  requestedCount: number,
  diagnostics: Diagnostic[],
): Promise<LogEntry[]> {
  const handle = await openIndexedLogHandle(index, diagnostics);
  if (!handle) {
    return [];
  }

  try {
    return await readIndexedEntriesFromHandle(handle, index, requestedStart, requestedCount);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function openIndexedLogHandle(
  index: LogLineIndex,
  diagnostics: Diagnostic[],
): Promise<FileHandle | null> {
  const opened = await openLogFile(index.file, diagnostics);
  if (!opened.handle || !opened.identity) {
    return null;
  }

  const revision = toLogFileRevision(opened.identity);
  if (revision.dev !== index.revision.dev || revision.ino !== index.revision.ino || revision.size < index.revision.size) {
    await opened.handle.close().catch(() => undefined);
    diagnostics.push({
      level: 'warn',
      message: `Log file "${index.file.name}" changed before the requested window could be read.`,
      path: index.file.path,
    });
    return null;
  }

  return opened.handle;
}

async function readIndexedEntriesFromHandle(
  handle: FileHandle,
  index: LogLineIndex,
  requestedStart: number,
  requestedCount: number,
): Promise<LogEntry[]> {
  const start = Math.min(normalizeStart(requestedStart), index.lineCount);
  const count = normalizeCount(requestedCount);
  const end = Math.min(index.lineCount, start + count);
  if (start >= end) {
    return [];
  }

  const startByte = index.lineOffsets[start] ?? 0;
  const endByte = end < index.lineCount ? index.lineOffsets[end] ?? index.revision.size : index.revision.size;
  const length = Math.max(0, endByte - startByte);
  if (length === 0) {
    return [];
  }
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, startByte);
  const raw = buffer.subarray(0, bytesRead).toString('utf8');
  return splitLogLines(raw)
    .slice(0, end - start)
    .map((line, offset) => parseLogLine(line, index.file.name, start + offset + 1));
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
  const normalizedQuery = query.toLowerCase();
  return (
    entry.message.toLowerCase().includes(normalizedQuery) ||
    entry.level.toLowerCase().includes(normalizedQuery)
  );
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

function pruneLogIndexCache() {
  while (logIndexCache.size > maxLogIndexCacheEntries) {
    const oldestKey = logIndexCache.keys().next().value;
    if (!oldestKey) {
      return;
    }
    logIndexCache.delete(oldestKey);
  }
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

function sameLogFileIdentity(before: LogFileIdentity, after: LogFileIdentity): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs
  );
}

function toLogFileIdentity(stats: Stats): LogFileIdentity {
  return {
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
  };
}

function toLogFileRevision(identity: LogFileIdentity): LogFileRevision {
  return {
    ...identity,
    key: `${identity.dev}:${identity.ino}:${identity.size}:${identity.mtimeMs}`,
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}
