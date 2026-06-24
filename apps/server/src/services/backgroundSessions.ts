import { constants, type Dirent } from 'node:fs';
import { lstat, open, readdir, type FileHandle } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';

import type {
  BackgroundSessionCommandSummary,
  BackgroundSessionLogEntry,
  BackgroundSessionLogStream,
  BackgroundSessionLogsResponse,
  BackgroundSessionProcessPresence,
  BackgroundSessionProjectLink,
  BackgroundSessionSessionLink,
  BackgroundSessionStatus,
  BackgroundSessionSummary,
  BackgroundSessionsResponse,
  Diagnostic,
} from '@openclaude-studio/shared';

import { readProjectSummariesWithDiagnostics } from './openclaudeData.js';
import type { OpenClaudePaths } from './paths.js';
import { isProjectTranscriptCwd } from './paths.js';
import { redactTextSecrets } from './redaction.js';
import { invalidRequest } from '../http/errors.js';

const ALL_STATUSES: readonly BackgroundSessionStatus[] = [
  'running',
  'unknown',
  'exited',
  'failed',
  'stale',
  'killed',
];

const TERMINAL_STATUSES: ReadonlySet<BackgroundSessionStatus> = new Set([
  'exited',
  'failed',
  'stale',
  'killed',
]);

const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_SESSION_ID_LENGTH = 128;
const MAX_SESSION_METADATA_BYTES = 256 * 1024;
const MAX_LOG_BYTES = 2 * 1024 * 1024;
const MAX_LOG_LINES = 5_000;
const DEFAULT_LOG_COUNT = 250;
const MAX_LOG_COUNT = 1_000;
const MAX_COMMAND_BINARY_LENGTH = 64;
const MAX_COMMAND_FLAG_COUNT = 32;
const NOFOLLOW_OPEN_FLAG = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
const NONBLOCK_OPEN_FLAG = typeof constants.O_NONBLOCK === 'number' ? constants.O_NONBLOCK : 0;

function isSafeSessionId(value: string): boolean {
  return value.length <= MAX_SESSION_ID_LENGTH && SAFE_ID_PATTERN.test(value);
}

export type BackgroundLogWindowRequest = {
  stream?: BackgroundSessionLogStream;
  start?: number;
  count?: number;
  tail?: boolean;
};

type RawBackgroundSessionRecord = {
  id: unknown;
  name: unknown;
  pid: unknown;
  cwd: unknown;
  status: unknown;
  provider: unknown;
  model: unknown;
  sessionId: unknown;
  startedAt: unknown;
  updatedAt: unknown;
  command: unknown;
  stdoutLogPath: unknown;
  stderrLogPath: unknown;
};

type ProjectIndex = {
  byId: Map<string, { id: string; name: string; path: string }>;
  byPath: Map<string, { id: string; name: string; path: string }>;
};

/**
 * Lists every safe background-session metadata record under the resolved
 * OpenClaude config root, sorted by `updatedAt` (newest first). Each summary
 * is derived field-by-field from the raw JSON; fields that are missing,
 * malformed, or out of range are normalized to nulls rather than dropping the
 * whole record.
 *
 * Safety guarantees:
 * - Reads only `<root>/bg-sessions/sessions/<id>.json` and bounded windows of
 *   `<root>/bg-sessions/logs/<id>.{out,err}.log`. Never trusts the embedded
 *   `stdoutLogPath` / `stderrLogPath` values for read authorization.
 * - Refuses symlinks and non-regular files for both metadata and logs.
 * - Opens files with `O_NOFOLLOW` to defeat TOCTOU swaps to symlinks.
 * - Bounds metadata reads to `MAX_SESSION_METADATA_BYTES`.
 * - Bounds log windows to `MAX_LOG_BYTES` and `MAX_LOG_LINES`.
 * - Redacts stdout/stderr lines before returning them to the browser.
 * - Returns `processPresence: 'unknown'` always. This server does not probe
 *   processes; recorded statuses are displayed as-is.
 */
export async function listBackgroundSessions(
  paths: OpenClaudePaths,
): Promise<BackgroundSessionsResponse> {
  const sessionsRoot = join(paths.openClaudeHome, 'bg-sessions');
  const sessionsDir = join(sessionsRoot, 'sessions');
  const logsDir = join(sessionsRoot, 'logs');

  const diagnostics: Diagnostic[] = [];
  const projects = await loadProjectIndex(paths, diagnostics);

  const sessionsDirSafe = await isSafeDirectoryChain(
    paths.openClaudeHome,
    ['bg-sessions', 'sessions'],
    'Background sessions directory',
    diagnostics,
  );
  const logsDirSafe = await isSafeDirectoryChain(
    paths.openClaudeHome,
    ['bg-sessions', 'logs'],
    'Background session logs directory',
    diagnostics,
  );
  const entries = sessionsDirSafe ? await readSessionsDir(sessionsDir, diagnostics) : [];
  const summaries: BackgroundSessionSummary[] = [];

  for (const entry of entries) {
    const name = String(entry.name);
    if (!name.endsWith('.json')) {
      continue;
    }

    const id = name.slice(0, -5);
    const metaPath = join(sessionsDir, name);
    if (!isSafeSessionId(id)) {
      diagnostics.push({
        level: 'warn',
        message: `Skipped background session metadata file with an unsafe id.`,
        path: metaPath,
      });
      continue;
    }

    const statResult = await safeLstat(metaPath, diagnostics);
    if (!statResult) {
      continue;
    }
    if (statResult.isSymbolicLink() || !statResult.isFile()) {
      diagnostics.push({
        level: 'warn',
        message: `Skipped background session metadata file that is not a regular file.`,
        path: metaPath,
      });
      continue;
    }

    const parsed = await readSessionMetadata(metaPath, diagnostics);
    if (!parsed) {
      continue;
    }

    const summary = await buildSummary(id, parsed, logsDirSafe ? logsDir : null, projects, diagnostics);
    if (summary) {
      summaries.push(summary);
    }
  }

  const sorted = summaries.sort((a, b) => {
    const left = a.updatedAt ?? a.startedAt ?? '';
    const right = b.updatedAt ?? b.startedAt ?? '';
    return right.localeCompare(left);
  });

  return {
    sessions: sorted,
    statusCounts: countStatuses(sorted),
    diagnostics,
  };
}

async function safeLstat(
  path: string,
  diagnostics: Diagnostic[],
): Promise<{ isFile: () => boolean; isSymbolicLink: () => boolean } | null> {
  try {
    const stats = await lstat(path);
    return {
      isFile: () => stats.isFile(),
      isSymbolicLink: () => stats.isSymbolicLink(),
    };
  } catch (error) {
    if (isUnavailableFileError(error)) {
      diagnostics.push({
        level: 'warn',
        message: 'Background session metadata file could not be read.',
        path,
      });
      return null;
    }
    throw error;
  }
}

/**
 * Returns a bounded, redacted window of stdout or stderr for the session with
 * the given validated id. The log path is ALWAYS derived from the id and the
 * trusted logs root — the embedded `stdoutLogPath` / `stderrLogPath` in the
 * metadata file are never consulted for read authorization.
 */
export async function readBackgroundSessionLogs(
  paths: OpenClaudePaths,
  sessionId: string,
  request: BackgroundLogWindowRequest = {},
): Promise<BackgroundSessionLogsResponse> {
  if (!isSafeSessionId(sessionId)) {
    throw invalidRequest('Invalid background session id.');
  }

  const stream: BackgroundSessionLogStream =
    request.stream === 'stderr' ? 'stderr' : 'stdout';
  const requestedCount = normalizeCount(request.count);
  const requestedStart = normalizeStart(request.start);

  const logsDir = join(paths.openClaudeHome, 'bg-sessions', 'logs');
  const diagnostics: Diagnostic[] = [];
  const logsDirSafe = await isSafeDirectoryChain(
    paths.openClaudeHome,
    ['bg-sessions', 'logs'],
    'Background session logs directory',
    diagnostics,
  );
  if (!logsDirSafe) {
    return {
      sessionId,
      stream,
      entries: [],
      start: requestedStart,
      count: requestedCount,
      totalLines: 0,
      truncated: false,
      diagnostics,
    };
  }

  const logPath = join(logsDir, `${sessionId}.${stream === 'stderr' ? 'err' : 'out'}.log`);

  const { lines, byteTruncated, lineTruncated, originalLineCount } = await readBoundedLogLines(
    logPath,
    diagnostics,
  );

  const truncated = byteTruncated || lineTruncated;

  if (lineTruncated && !byteTruncated) {
    diagnostics.push({
      level: 'warn',
      message: `Log was truncated to the most recent ${MAX_LOG_LINES} lines.`,
      path: logPath,
    });
  }

  // If lines were dropped to honor MAX_LOG_LINES, the kept lines are the most
  // recent `lines.length` of the original file. Compute line numbers relative
  // to the original file so clients see where each line actually lives.
  const lineOffset = originalLineCount - lines.length;

  // For non-tail requests, translate the client's start from the original
  // coordinate space into the retained window. If start falls before the
  // retained window (oldest lines were dropped), there is nothing to return
  // at that position — surface an empty window with the original totalLines so
  // clients can decide to page forward.
  let start: number;
  if (request.tail) {
    start = Math.max(0, lines.length - requestedCount);
  } else if (requestedStart < lineOffset) {
    start = lines.length;
  } else {
    start = Math.min(requestedStart - lineOffset, lines.length);
  }

  const end = Math.min(lines.length, start + requestedCount);
  const slice = lines.slice(start, end);

  const entries: BackgroundSessionLogEntry[] = slice.map((text, index) => {
    const lineNumber = lineOffset + start + index + 1;
    return {
      id: `${sessionId}:${stream}:${lineNumber}`,
      lineNumber,
      text,
    };
  });

  // Report start in the original coordinate space. When the client asked for a
  // position before the retained window, honor their request rather than
  // reporting a confusing end-of-file position.
  const reportedStart = entries.length === 0 && !request.tail ? requestedStart : start + lineOffset;

  return {
    sessionId,
    stream,
    entries,
    start: reportedStart,
    count: requestedCount,
    totalLines: originalLineCount,
    truncated,
    diagnostics,
  };
}

async function readSessionsDir(
  sessionsDir: string,
  diagnostics: Diagnostic[],
): Promise<Dirent[]> {
  try {
    return await readdir(sessionsDir, { withFileTypes: true });
  } catch (error) {
    if (isNodeFileError(error, 'ENOENT') || isNodeFileError(error, 'ENOTDIR')) {
      diagnostics.push({
        level: 'info',
        message: 'No background sessions directory was found at the expected location.',
        path: sessionsDir,
      });
      return [];
    }
    if (isNodeFileError(error, 'EACCES', 'EPERM')) {
      diagnostics.push({
        level: 'warn',
        message: 'Background sessions directory could not be read.',
        path: sessionsDir,
      });
      return [];
    }
    throw error;
  }
}

async function isSafeDirectoryChain(
  root: string,
  segments: string[],
  label: string,
  diagnostics: Diagnostic[],
): Promise<boolean> {
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    let stats;
    try {
      stats = await lstat(current);
    } catch (error) {
      if (isNodeFileError(error, 'ENOENT')) {
        return true;
      }
      if (isNodeFileError(error, 'ENOTDIR')) {
        diagnostics.push({
          level: 'warn',
          message: `${label} parent is not a directory and will not be read.`,
          path: current,
        });
        return false;
      }
      if (isNodeFileError(error, 'EACCES', 'EPERM')) {
        diagnostics.push({
          level: 'warn',
          message: `${label} could not be inspected for symlinks.`,
          path: current,
        });
        return false;
      }
      throw error;
    }

    if (stats.isSymbolicLink()) {
      diagnostics.push({
        level: 'warn',
        message: `${label} contains a symlink and will not be read.`,
        path: current,
      });
      return false;
    }

    if (!stats.isDirectory()) {
      diagnostics.push({
        level: 'warn',
        message: `${label} is not a directory and will not be read.`,
        path: current,
      });
      return false;
    }
  }
  return true;
}

async function readSessionMetadata(
  metaPath: string,
  diagnostics: Diagnostic[],
): Promise<RawBackgroundSessionRecord | null> {
  let handle;
  try {
    handle = await open(metaPath, constants.O_RDONLY | NOFOLLOW_OPEN_FLAG | NONBLOCK_OPEN_FLAG);
  } catch (error) {
    if (isNodeFileError(error, 'ELOOP') || isNodeFileError(error, 'EMLINK')) {
      diagnostics.push({
        level: 'warn',
        message: 'Skipped symlinked background session metadata file.',
        path: metaPath,
      });
      return null;
    }
    if (isUnavailableFileError(error)) {
      diagnostics.push({
        level: 'warn',
        message: 'Background session metadata file could not be read.',
        path: metaPath,
      });
      return null;
    }
    throw error;
  }

  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      diagnostics.push({
        level: 'warn',
        message: `Skipped background session metadata file that is not a regular file.`,
        path: metaPath,
      });
      return null;
    }

    if (stats.size > MAX_SESSION_METADATA_BYTES) {
      diagnostics.push({
        level: 'warn',
        message: `Skipped oversized background session metadata file (${stats.size} bytes).`,
        path: metaPath,
      });
      return null;
    }

    const size = stats.size;
    const buffer = Buffer.alloc(size);
    const bytesRead = await readIntoBuffer(handle, buffer, 0);
    const text = buffer.subarray(0, bytesRead).toString('utf8');

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      diagnostics.push({
        level: 'warn',
        message: 'Skipped malformed background session metadata file.',
        path: metaPath,
      });
      return null;
    }

    return normalizeRawRecord(parsed);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function normalizeRawRecord(value: unknown): RawBackgroundSessionRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return emptyRawRecord();
  }

  const record = value as Record<string, unknown>;
  return {
    id: record.id,
    name: record.name,
    pid: record.pid,
    cwd: record.cwd,
    status: record.status,
    provider: record.provider,
    model: record.model,
    sessionId: record.sessionId,
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
    command: record.command,
    stdoutLogPath: record.stdoutLogPath,
    stderrLogPath: record.stderrLogPath,
  };
}

function emptyRawRecord(): RawBackgroundSessionRecord {
  return {
    id: undefined,
    name: undefined,
    pid: undefined,
    cwd: undefined,
    status: undefined,
    provider: undefined,
    model: undefined,
    sessionId: undefined,
    startedAt: undefined,
    updatedAt: undefined,
    command: undefined,
    stdoutLogPath: undefined,
    stderrLogPath: undefined,
  };
}

async function buildSummary(
  id: string,
  raw: RawBackgroundSessionRecord,
  logsDir: string | null,
  projects: ProjectIndex,
  diagnostics: Diagnostic[],
): Promise<BackgroundSessionSummary | null> {
  const parsedStatus = readStatus(raw.status);
  if (!parsedStatus) {
    diagnostics.push({
      level: 'warn',
      message: `Background session "${id}" has an unrecognized status; normalized to unknown.`,
    });
  }
  const recordedStatus: BackgroundSessionStatus = parsedStatus ?? 'unknown';

  const name = readNonEmptyString(raw.name);
  const pid = readPid(raw.pid);
  const cwd = readNonEmptyString(raw.cwd);
  const provider = readNonEmptyString(raw.provider);
  const model = readNonEmptyString(raw.model);
  const sessionId = readNonEmptyString(raw.sessionId);
  const startedAt = readTimestamp(raw.startedAt);
  const updatedAt = readTimestamp(raw.updatedAt);

  const stdoutLogAvailable = logsDir
    ? await logsAvailable(logsDir, id, 'stdout', raw.stdoutLogPath, diagnostics)
    : false;
  const stderrLogAvailable = logsDir
    ? await logsAvailable(logsDir, id, 'stderr', raw.stderrLogPath, diagnostics)
    : false;

  const commandSummary = summarizeCommand(raw.command);
  const projectLink = cwd ? linkProject(cwd, projects) : null;
  const sessionLink = linkSession(projectLink, sessionId, projects);

  return {
    id,
    shortId: id.slice(0, 8),
    name,
    pid,
    cwd,
    recordedStatus,
    terminal: TERMINAL_STATUSES.has(recordedStatus),
    processPresence: 'unknown' satisfies BackgroundSessionProcessPresence,
    provider,
    model,
    sessionId,
    startedAt,
    updatedAt,
    durationMs: durationMsBetween(startedAt, updatedAt),
    commandSummary,
    project: projectLink,
    sessionLink,
    stdoutLogAvailable,
    stderrLogAvailable,
  };
}

function readStatus(value: unknown): BackgroundSessionStatus | null {
  if (typeof value !== 'string') {
    return null;
  }
  return (ALL_STATUSES as readonly string[]).includes(value)
    ? (value as BackgroundSessionStatus)
    : null;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readPid(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return Math.floor(value);
}

function readTimestamp(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) {
    return null;
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return new Date(parsed).toISOString();
}

function durationMsBetween(startedAt: string | null, updatedAt: string | null): number | null {
  if (!startedAt || !updatedAt) {
    return null;
  }
  const start = Date.parse(startedAt);
  const end = Date.parse(updatedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return null;
  }
  const duration = end - start;
  return duration >= 0 ? duration : null;
}

function summarizeCommand(command: unknown): BackgroundSessionCommandSummary {
  if (!Array.isArray(command)) {
    return { binary: null, flagCount: 0, truncated: false };
  }

  const elements = command.filter((item): item is string => typeof item === 'string' && item.length > 0);
  if (elements.length === 0) {
    return { binary: null, flagCount: 0, truncated: false };
  }

  const binary = basename(elements[0] ?? '').slice(0, MAX_COMMAND_BINARY_LENGTH) || null;
  const flags = elements.slice(1).filter((item) => item.startsWith('-'));
  const truncated = flags.length > MAX_COMMAND_FLAG_COUNT;

  return {
    binary,
    flagCount: Math.min(flags.length, MAX_COMMAND_FLAG_COUNT),
    truncated,
  };
}

async function loadProjectIndex(paths: OpenClaudePaths, diagnostics: Diagnostic[]): Promise<ProjectIndex> {
  let projects;
  try {
    const response = await readProjectSummariesWithDiagnostics(paths);
    projects = response.projects;
    if (response.diagnostics.some((diagnostic) => diagnostic.level !== 'info')) {
      diagnostics.push({
        level: 'warn',
        message: 'Background session project index could not be fully loaded; linked project fields may be unavailable.',
      });
    }
  } catch {
    diagnostics.push({
      level: 'warn',
      message: 'Background session project index could not be loaded; linked project fields are unavailable.',
    });
    return { byId: new Map(), byPath: new Map() };
  }

  const byId = new Map<string, { id: string; name: string; path: string }>();
  const byPath = new Map<string, { id: string; name: string; path: string }>();

  for (const project of projects) {
    const entry = {
      id: project.id,
      name: project.name,
      path: resolve(project.path),
    };
    byId.set(entry.id, entry);
    byPath.set(entry.path, entry);
  }

  return { byId, byPath };
}

function linkProject(
  cwd: string,
  projects: ProjectIndex,
): BackgroundSessionProjectLink | null {
  const resolvedCwd = resolve(cwd);
  const matches: { id: string; name: string; path: string }[] = [];

  for (const project of projects.byPath.values()) {
    if (isProjectTranscriptCwd(project.path, resolvedCwd)) {
      matches.push(project);
    }
  }

  if (matches.length !== 1) {
    return null;
  }

  const match = matches[0];
  if (!match) {
    return null;
  }

  return {
    projectId: match.id,
    projectName: match.name,
  };
}

function linkSession(
  projectLink: BackgroundSessionProjectLink | null,
  sessionId: string | null,
  projects: ProjectIndex,
): BackgroundSessionSessionLink | null {
  if (!projectLink || !sessionId) {
    return null;
  }

  const project = projects.byId.get(projectLink.projectId);
  if (!project) {
    return null;
  }

  return {
    projectId: project.id,
    sessionId,
  };
}

/**
 * Reports whether the canonical log file (`<logsDir>/<id>.{out,err}.log`)
 * exists and is a regular file. The embedded `embeddedLogPath` is inspected
 * only to detect the suspicious case where it points outside the logs root
 * (a defensive signal, not a read authorization).
 */
async function logsAvailable(
  logsDir: string,
  id: string,
  stream: BackgroundSessionLogStream,
  embeddedLogPath: unknown,
  diagnostics: Diagnostic[],
): Promise<boolean> {
  const canonicalPath = join(
    logsDir,
    `${id}.${stream === 'stderr' ? 'err' : 'out'}.log`,
  );

  if (typeof embeddedLogPath === 'string' && embeddedLogPath.length > 0) {
    const resolvedEmbedded = resolve(embeddedLogPath);
    const resolvedCanonical = resolve(canonicalPath);
    if (resolvedEmbedded !== resolvedCanonical && !isInside(logsDir, resolvedEmbedded)) {
      diagnostics.push({
        level: 'warn',
        message: `Background session "${id}" ${stream} log path in metadata points outside the expected logs root; using the canonical path instead.`,
      });
    }
  }

  try {
    const stats = await lstat(canonicalPath);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      return false;
    }
    return true;
  } catch (error) {
    if (isNodeFileError(error, 'ENOENT', 'ENOTDIR')) {
      return false;
    }
    if (isNodeFileError(error, 'EACCES', 'EPERM')) {
      diagnostics.push({
        level: 'warn',
        message: `Background session "${id}" ${stream} log file could not be read.`,
        path: canonicalPath,
      });
      return false;
    }
    throw error;
  }
}

function isInside(root: string, target: string): boolean {
  const rootPrefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return target === root || target.startsWith(rootPrefix);
}

type BoundedLogResult = {
  lines: string[];
  byteTruncated: boolean;
  lineTruncated: boolean;
  originalLineCount: number;
};

const emptyLogResult: BoundedLogResult = {
  lines: [],
  byteTruncated: false,
  lineTruncated: false,
  originalLineCount: 0,
};

async function readBoundedLogLines(
  logPath: string,
  diagnostics: Diagnostic[],
): Promise<BoundedLogResult> {
  let stats;
  try {
    stats = await lstat(logPath);
  } catch (error) {
    if (isNodeFileError(error, 'ENOENT', 'ENOTDIR')) {
      diagnostics.push({
        level: 'info',
        message: 'Log file does not exist.',
        path: logPath,
      });
      return emptyLogResult;
    }
    if (isNodeFileError(error, 'EACCES', 'EPERM')) {
      diagnostics.push({
        level: 'warn',
        message: 'Log file could not be read.',
        path: logPath,
      });
      return emptyLogResult;
    }
    throw error;
  }

  if (stats.isSymbolicLink()) {
    diagnostics.push({
      level: 'warn',
      message: 'Log file is a symlink and will not be read.',
      path: logPath,
    });
    return emptyLogResult;
  }

  if (!stats.isFile()) {
    diagnostics.push({
      level: 'warn',
      message: 'Log path is not a regular file.',
      path: logPath,
    });
    return emptyLogResult;
  }

  let handle;
  try {
    handle = await open(logPath, constants.O_RDONLY | NOFOLLOW_OPEN_FLAG | NONBLOCK_OPEN_FLAG);
  } catch (error) {
    if (isNodeFileError(error, 'ELOOP') || isNodeFileError(error, 'EMLINK')) {
      diagnostics.push({
        level: 'warn',
        message: 'Log file is a symlink and will not be read.',
        path: logPath,
      });
      return emptyLogResult;
    }
    if (isUnavailableFileError(error)) {
      diagnostics.push({
        level: 'warn',
        message: 'Log file could not be read.',
        path: logPath,
      });
      return emptyLogResult;
    }
    throw error;
  }

  try {
    const openedStats = await handle.stat();
    if (!openedStats.isFile()) {
      diagnostics.push({
        level: 'warn',
        message: 'Log path is not a regular file.',
        path: logPath,
      });
      return emptyLogResult;
    }

    const byteTruncated = openedStats.size > MAX_LOG_BYTES;
    const bytesToRead = Math.min(openedStats.size, MAX_LOG_BYTES);
    // When the file exceeds the byte cap, read the tail of the file (the most
    // recent output) so tail windows reflect current activity instead of the
    // oldest bytes. Logs are append-only.
    const readOffset = byteTruncated ? openedStats.size - MAX_LOG_BYTES : 0;
    const buffer = Buffer.alloc(bytesToRead);
    const bytesRead = await readIntoBuffer(handle, buffer, readOffset);
    const text = buffer.subarray(0, bytesRead).toString('utf8');

    if (byteTruncated) {
      diagnostics.push({
        level: 'warn',
        message: `Log file was truncated to the most recent ${MAX_LOG_BYTES} bytes; line numbers are relative to that retained byte window.`,
        path: logPath,
      });
    }

    const { lines, lineTruncated, originalLineCount } = splitAndRedact(text, byteTruncated);
    return { lines, byteTruncated, lineTruncated, originalLineCount };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function readIntoBuffer(handle: FileHandle, buffer: Buffer, position: number): Promise<number> {
  let totalBytesRead = 0;
  while (totalBytesRead < buffer.length) {
    const { bytesRead } = await handle.read(
      buffer,
      totalBytesRead,
      buffer.length - totalBytesRead,
      position + totalBytesRead,
    );
    if (bytesRead === 0) {
      break;
    }
    totalBytesRead += bytesRead;
  }
  return totalBytesRead;
}

function splitAndRedact(
  content: string,
  startedMidFile: boolean,
): {
  lines: string[];
  lineTruncated: boolean;
  originalLineCount: number;
} {
  let lines = content.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }

  // When the read started at a non-zero offset (byte-truncated tail), the
  // first element is a partial line fragment — drop it so we never report a
  // fragment as a complete log entry. Only applies when there is more than
  // one line; a single surviving fragment is all we have.
  if (startedMidFile && lines.length > 1) {
    lines = lines.slice(1);
  }

  const originalLineCount = lines.length;
  const lineTruncated = lines.length > MAX_LOG_LINES;
  const limited = lineTruncated ? lines.slice(lines.length - MAX_LOG_LINES) : lines;
  return {
    lines: limited.map((line) => redactTextSecrets(line)),
    lineTruncated,
    originalLineCount,
  };
}

function countStatuses(
  summaries: BackgroundSessionSummary[],
): Record<BackgroundSessionStatus, number> {
  const counts: Record<BackgroundSessionStatus, number> = {
    running: 0,
    unknown: 0,
    exited: 0,
    failed: 0,
    stale: 0,
    killed: 0,
  };

  for (const summary of summaries) {
    counts[summary.recordedStatus] += 1;
  }

  return counts;
}

function normalizeStart(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

function normalizeCount(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
    return DEFAULT_LOG_COUNT;
  }
  return Math.min(Math.floor(value), MAX_LOG_COUNT);
}

function isUnavailableFileError(error: unknown): error is NodeJS.ErrnoException {
  return isNodeFileError(error, 'ENOENT', 'ENOTDIR', 'EACCES', 'EPERM');
}

function isNodeFileError(error: unknown, ...codes: string[]): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && codes.includes(String(error.code));
}
