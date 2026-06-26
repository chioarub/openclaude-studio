import { lstat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import type {
  Diagnostic,
  SessionReplayErrorStep,
  SessionReplayResponse,
  SessionReplayRetryStep,
  SessionReplayStep,
  SessionReplaySummary,
  SessionReplayToolStep,
  SessionReplayUserStep,
} from '@openclaude-studio/shared';

import { invalidRequest } from '../http/errors.js';
import { redactTextSecrets } from './redaction.js';
import { readBoundedTextFile } from './safeFile.js';
import {
  findTranscriptFilesForProject,
  parseTranscriptFilesForProjectWithDiagnostics,
} from './sessions.js';

type SessionProject = { path: string };

const SUPPORTED_VERSIONS = new Set<number>([1]);

const MAX_REPLAY_BYTES = 1024 * 1024;
const MAX_STEPS = 500;
const MAX_TOOL_BREAKDOWN_KEYS = 50;
const MAX_FILES_MODIFIED = 50;
const MAX_FILE_PATH_LENGTH = 512;
const MAX_INPUT_SUMMARY_LENGTH = 240;
const MAX_RESULT_PREVIEW_LENGTH = 240;
const MAX_USER_CONTENT_LENGTH = 1000;
const MAX_REASON_LENGTH = 480;
const MAX_COMMAND_LENGTH = 480;
const MAX_COMMANDS = 10;
const MAX_CREATED_AT_LENGTH = 64;

const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const MISSING_SESSION_TRANSCRIPT_MESSAGE = 'No project-scoped transcript found for this session.';

/**
 * Read the replay sidecar for a session, if present.
 *
 * Replay files are derived from a validated session ID and an already-authorized
 * transcript directory. The browser never supplies a path; paths embedded in
 * replay JSON are never used as authorization to read.
 */
export async function readSessionReplay(
  projectsDir: string,
  project: SessionProject,
  sessionId: string,
): Promise<SessionReplayResponse> {
  validateSessionId(sessionId);

  const transcriptFiles = await findTranscriptFilesForProject(projectsDir, project.path);
  const transcriptResult = await parseTranscriptFilesForProjectWithDiagnostics(
    transcriptFiles,
    project.path,
  );
  const sessionEntries = transcriptResult.entries.filter((entry) => entry.sessionId === sessionId);
  if (sessionEntries.length === 0) {
    const diagnostics = diagnosticsForSessionTranscript(transcriptResult.diagnostics, sessionId);
    if (diagnostics.length > 0) {
      return unavailableWithDiagnostics(sessionId, diagnostics);
    }
    return unavailable(sessionId, MISSING_SESSION_TRANSCRIPT_MESSAGE);
  }

  const candidateRoots = uniqueRoots(sessionEntries.map((entry) => dirname(entry.sourcePath)));

  const candidates: { path: string; stats: { mtimeMs: number; size: number } }[] = [];
  for (const root of candidateRoots) {
    const replayPath = join(root, `${sessionId}.replay.json`);
    const fileState = await classifyReplayFile(replayPath);
    if (fileState.kind === 'symlink') {
      return malformed(sessionId, null, 'Replay file is a symlink and cannot be read.');
    }
    if (fileState.kind === 'regular') {
      candidates.push({ path: replayPath, stats: fileState.stats });
    }
  }

  if (candidates.length === 0) {
    return unavailable(sessionId, 'No replay file found for this session.');
  }

  if (candidates.length > 1) {
    return conflict(sessionId, candidates.map((c) => c.path));
  }

  const replayPath = candidates[0]?.path;
  if (!replayPath) {
    return conflict(sessionId, candidates.map((c) => c.path));
  }
  let read: Awaited<ReturnType<typeof readBoundedTextFile>>;
  try {
    read = await readBoundedTextFile(replayPath, { maxBytes: MAX_REPLAY_BYTES });
  } catch (error) {
    if (isNodeError(error, 'EACCES') || isNodeError(error, 'EPERM')) {
      return unavailableWithDiagnostics(sessionId, [
        { level: 'warn', message: 'Replay file could not be read.' },
      ]);
    }
    throw error;
  }

  if (!read.exists) {
    return unavailable(sessionId, 'Replay file does not exist.');
  }

  if (read.truncated) {
    return malformed(
      sessionId,
      null,
      `Replay file exceeds the maximum supported size of ${MAX_REPLAY_BYTES} bytes.`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(read.content);
  } catch {
    return malformed(sessionId, null, 'Replay file is not valid JSON.');
  }

  return parseReplayIndex(sessionId, parsed);
}

export function isReplaySessionMissing(response: SessionReplayResponse): boolean {
  return (
    response.status === 'unavailable' &&
    response.diagnostics.some(
      (diagnostic) =>
        diagnostic.level === 'info' &&
        diagnostic.message === MISSING_SESSION_TRANSCRIPT_MESSAGE,
    )
  );
}

function validateSessionId(sessionId: string): void {
  if (!sessionId || typeof sessionId !== 'string') {
    throw invalidRequest('Session ID is required.');
  }
  if (!SESSION_ID_PATTERN.test(sessionId) || sessionId.includes('..')) {
    throw invalidRequest('Session ID contains invalid characters.');
  }
}

type ReplayFileState =
  | { kind: 'regular'; stats: { mtimeMs: number; size: number } }
  | { kind: 'symlink' }
  | { kind: 'absent' };

async function classifyReplayFile(path: string): Promise<ReplayFileState> {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink()) {
      return { kind: 'symlink' };
    }
    if (!stats.isFile()) {
      return { kind: 'absent' };
    }
    return { kind: 'regular', stats: { mtimeMs: stats.mtimeMs, size: stats.size } };
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) {
      return { kind: 'absent' };
    }
    throw error;
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === code
  );
}

function uniqueRoots(roots: string[]): string[] {
  return [...new Set(roots)].sort((a, b) => a.localeCompare(b));
}

function diagnosticsForSessionTranscript(
  diagnostics: Diagnostic[],
  sessionId: string,
): Diagnostic[] {
  const expectedFile = `${sessionId}.jsonl`;
  return diagnostics.flatMap((diagnostic) => {
    if (!diagnostic.path || basename(diagnostic.path) !== expectedFile) {
      return [];
    }
    return [{ level: diagnostic.level, message: diagnostic.message }];
  });
}

function parseReplayIndex(sessionId: string, raw: unknown): SessionReplayResponse {
  if (!isObject(raw)) {
    return malformed(sessionId, null, 'Replay root is not an object.');
  }

  const version = typeof raw.version === 'number' ? raw.version : null;

  if (version === null) {
    return malformed(sessionId, null, 'Replay file is missing a numeric version.');
  }

  if (!SUPPORTED_VERSIONS.has(version)) {
    return {
      status: 'unsupported_version',
      supported: false,
      available: true,
      sessionId,
      version,
      diagnostics: [
        {
          level: 'info',
          message: `Replay schema version ${version} is not supported by this server.`,
        },
      ],
    };
  }

  if (typeof raw.sessionId === 'string' && raw.sessionId !== sessionId) {
    return malformed(
      sessionId,
      version,
      'Replay file sessionId does not match the requested session.',
    );
  }

  const summaryRaw = raw.summary;
  if (!isObject(summaryRaw)) {
    return malformed(sessionId, version, 'Replay summary is missing or not an object.');
  }

  const stepsRaw = raw.steps;
  if (!Array.isArray(stepsRaw)) {
    return malformed(sessionId, version, 'Replay steps is missing or not an array.');
  }

  const diagnostics: Diagnostic[] = [];
  const summaryResult = parseSummary(summaryRaw, diagnostics);
  if ('diagnostic' in summaryResult) {
    return malformed(sessionId, version, summaryResult.diagnostic);
  }

  const stepResults = stepsRaw.map((step, index) => parseStep(step, index, diagnostics));
  const failedStepParse = stepResults.find((r) => r === null);
  if (failedStepParse !== undefined && failedStepParse === null) {
    return malformed(sessionId, version, 'One or more replay steps are malformed.');
  }

  const steps = stepResults as SessionReplayStep[];
  const truncated = steps.length > MAX_STEPS;
  const boundedSteps = truncated ? steps.slice(0, MAX_STEPS) : steps;

  return {
    status: 'available',
    supported: true,
    available: true,
    sessionId,
    version,
    createdAt: parseCreatedAt(raw.createdAt),
    summary: summaryResult.summary,
    steps: boundedSteps,
    stepsTruncated: truncated,
    diagnostics: [
      ...diagnostics,
      ...(truncated
        ? [
            {
              level: 'warn' as const,
              message: `Replay truncated to the first ${MAX_STEPS} steps.`,
            },
          ]
        : []),
    ],
  };
}

function parseSummary(
  raw: Record<string, unknown>,
  diagnostics: Diagnostic[],
):
  | { summary: SessionReplaySummary }
  | { diagnostic: string } {
  const totalSteps = parseNonNegativeInt(raw.totalSteps);
  if (totalSteps === null) {
    return { diagnostic: 'Replay summary.totalSteps is invalid.' };
  }

  const toolBreakdownRaw = raw.toolBreakdown;
  if (!isObject(toolBreakdownRaw)) {
    return { diagnostic: 'Replay summary.toolBreakdown is invalid.' };
  }

  const toolBreakdown = parseToolBreakdown(toolBreakdownRaw);

  const filesModifiedResult = parseReplayFilePathArray(
    raw.filesModified,
    MAX_FILES_MODIFIED,
    MAX_FILE_PATH_LENGTH,
    diagnostics,
  );
  if (!filesModifiedResult) {
    return { diagnostic: 'Replay summary.filesModified is invalid.' };
  }

  const durationMs = parseNonNegativeInt(raw.durationMs);
  if (durationMs === null) {
    return { diagnostic: 'Replay summary.durationMs is invalid.' };
  }

  const userRequests = parseNonNegativeInt(raw.userRequests);
  if (userRequests === null) {
    return { diagnostic: 'Replay summary.userRequests is invalid.' };
  }

  const retryAttempts = optionalNonNegativeInt(raw.retryAttempts);
  const repeatedAttempts = optionalNonNegativeInt(raw.repeatedAttempts);

  return {
    summary: {
      totalSteps,
      toolBreakdown,
      filesModified: filesModifiedResult.items,
      filesModifiedTruncated: filesModifiedResult.truncated,
      durationMs,
      startTimestamp: parseTimestamp(raw.startTimestamp),
      endTimestamp: parseTimestamp(raw.endTimestamp),
      userRequests,
      retryAttempts,
      repeatedAttempts,
    },
  };
}

function parseToolBreakdown(
  raw: Record<string, unknown>,
): { tool: string; count: number }[] {
  const entries: { tool: string; count: number }[] = [];
  for (const [tool, count] of Object.entries(raw)) {
    if (entries.length >= MAX_TOOL_BREAKDOWN_KEYS) {
      break;
    }
    const normalized = parseNonNegativeInt(count);
    if (normalized !== null) {
      entries.push({ tool: redactTextSecrets(tool), count: normalized });
    }
  }
  return entries;
}

function parseStep(
  raw: unknown,
  index: number,
  diagnostics: Diagnostic[],
): SessionReplayStep | null {
  if (!isObject(raw)) {
    return null;
  }

  const stepNumber = parseNonNegativeInt(raw.stepNumber) ?? index + 1;
  const timestamp = parseTimestamp(raw.timestamp);
  const type = raw.type;

  if (type === 'tool') {
    return parseToolStep(raw, stepNumber, timestamp, diagnostics);
  }
  if (type === 'user') {
    return parseUserStep(raw, stepNumber, timestamp);
  }
  if (type === 'retry') {
    return parseRetryStep(raw, stepNumber, timestamp);
  }
  if (type === 'error') {
    return parseErrorStep(raw, stepNumber, timestamp);
  }
  return null;
}

function parseToolStep(
  raw: Record<string, unknown>,
  stepNumber: number,
  timestamp: string | null,
  diagnostics: Diagnostic[],
): SessionReplayToolStep | null {
  const toolName = typeof raw.toolName === 'string' ? raw.toolName : null;
  if (!toolName) {
    return null;
  }

  const inputSummary = truncateRedactedString(
    typeof raw.inputSummary === 'string' ? raw.inputSummary : '',
    MAX_INPUT_SUMMARY_LENGTH,
  );

  const resultStatus = parseResultStatus(raw.resultStatus);

  const resultPreview = typeof raw.resultPreview === 'string'
    ? truncateRedactedString(raw.resultPreview, MAX_RESULT_PREVIEW_LENGTH)
    : null;

  const filesModifiedResult = parseReplayFilePathArray(
    raw.filesModified,
    MAX_FILES_MODIFIED,
    MAX_FILE_PATH_LENGTH,
    diagnostics,
  );

  const durationMs = parseNonNegativeInt(raw.durationMs) ?? 0;
  const toolUseId = typeof raw.toolUseId === 'string' ? raw.toolUseId : null;
  const repeatedAttemptNumber = optionalNonNegativeInt(raw.repeatedAttemptNumber);
  const isRepeatedAttempt = raw.isRepeatedAttempt === true;

  return {
    type: 'tool',
    stepNumber,
    toolName: redactTextSecrets(toolName),
    toolUseId: toolUseId ? redactTextSecrets(toolUseId) : null,
    inputSummary: inputSummary.value,
    inputSummaryTruncated: inputSummary.truncated,
    resultStatus,
    resultPreview: resultPreview ? resultPreview.value : null,
    resultPreviewTruncated: resultPreview ? resultPreview.truncated : false,
    durationMs,
    timestamp,
    filesModified: filesModifiedResult ? filesModifiedResult.items : [],
    filesModifiedTruncated: filesModifiedResult ? filesModifiedResult.truncated : false,
    repeatedAttemptNumber,
    isRepeatedAttempt,
  };
}

function parseUserStep(
  raw: Record<string, unknown>,
  stepNumber: number,
  timestamp: string | null,
): SessionReplayUserStep | null {
  const content = typeof raw.content === 'string' ? raw.content : null;
  if (content === null) {
    return null;
  }
  const bounded = truncateRedactedString(content, MAX_USER_CONTENT_LENGTH);
  return {
    type: 'user',
    stepNumber,
    content: bounded.value,
    contentTruncated: bounded.truncated,
    timestamp,
  };
}

function parseRetryStep(
  raw: Record<string, unknown>,
  stepNumber: number,
  timestamp: string | null,
): SessionReplayRetryStep | null {
  const reason = typeof raw.reason === 'string' ? raw.reason : null;
  if (reason === null) {
    return null;
  }
  const boundedReason = truncateRedactedString(reason, MAX_REASON_LENGTH);

  const retryType =
    raw.retryType === 'api' || raw.retryType === 'permission'
      ? (raw.retryType as 'api' | 'permission')
      : 'unknown';

  const commandsResult = parseStringArray(raw.commands, MAX_COMMANDS, MAX_COMMAND_LENGTH);

  return {
    type: 'retry',
    stepNumber,
    retryType,
    attempt: optionalNonNegativeInt(raw.attempt),
    maxRetries: optionalNonNegativeInt(raw.maxRetries),
    retryDelayMs: optionalNonNegativeInt(raw.retryDelayMs),
    reason: boundedReason.value,
    reasonTruncated: boundedReason.truncated,
    commands: commandsResult ? commandsResult.items : [],
    commandsTruncated: commandsResult ? commandsResult.truncated : false,
    timestamp,
  };
}

function parseErrorStep(
  raw: Record<string, unknown>,
  stepNumber: number,
  timestamp: string | null,
): SessionReplayErrorStep | null {
  const error = typeof raw.error === 'string' ? raw.error : null;
  if (error === null) {
    return null;
  }
  const bounded = truncateRedactedString(error, MAX_REASON_LENGTH);
  return {
    type: 'error',
    stepNumber,
    error: bounded.value,
    errorTruncated: bounded.truncated,
    timestamp,
  };
}

function parseResultStatus(
  value: unknown,
): SessionReplayToolStep['resultStatus'] {
  if (
    value === 'success' ||
    value === 'error' ||
    value === 'cancelled' ||
    value === 'permission_denied'
  ) {
    return value;
  }
  return 'unknown';
}

function parseStringArray(
  value: unknown,
  maxItems: number,
  maxLength: number,
): { items: string[]; truncated: boolean } | null {
  if (!Array.isArray(value)) {
    if (value === undefined || value === null) {
      return { items: [], truncated: false };
    }
    return null;
  }
  const valid = value.filter((item): item is string => typeof item === 'string');
  if (valid.length !== value.length) {
    return null;
  }
  let truncated = valid.length > maxItems;
  const bounded = truncated ? valid.slice(0, maxItems) : valid;
  const mapped: string[] = [];
  for (const item of bounded) {
    const normalized = truncateRedactedString(item, maxLength);
    if (normalized.truncated) {
      truncated = true;
    }
    mapped.push(normalized.value);
  }
  return { items: mapped, truncated };
}

function parseReplayFilePathArray(
  value: unknown,
  maxItems: number,
  maxLength: number,
  diagnostics: Diagnostic[],
): { items: string[]; truncated: boolean } | null {
  if (!Array.isArray(value)) {
    if (value === undefined || value === null) {
      return { items: [], truncated: false };
    }
    return null;
  }
  const valid = value.filter((item): item is string => typeof item === 'string');
  if (valid.length !== value.length) {
    return null;
  }
  let truncated = valid.length > maxItems;
  const bounded = truncated ? valid.slice(0, maxItems) : valid;
  const mapped: string[] = [];
  for (const item of bounded) {
    const normalized = normalizeReplayFilePath(item, maxLength);
    if (!normalized) {
      truncated = true;
      diagnostics.push({
        level: 'warn',
        message: 'Unsafe replay file path was omitted from the response.',
      });
      continue;
    }
    if (normalized.truncated) {
      truncated = true;
    }
    mapped.push(normalized.value);
  }
  return { items: mapped, truncated };
}

function parseNonNegativeInt(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    return null;
  }
  return value;
}

function optionalNonNegativeInt(value: unknown): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  return parseNonNegativeInt(value);
}

function parseTimestamp(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) {
    return null;
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return null;
  }
  return value;
}

function parseCreatedAt(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  return truncateRedactedString(value, MAX_CREATED_AT_LENGTH).value;
}

function truncateRedactedString(
  value: string,
  maxLength: number,
): { value: string; truncated: boolean } {
  const redacted = redactTextSecrets(value);
  const truncated = value.length > maxLength || redacted.length > maxLength;
  if (redacted.length <= maxLength) {
    return { value: redacted, truncated };
  }

  return {
    value: trimPartialRedactionMarker(redacted.slice(0, maxLength)),
    truncated,
  };
}

function trimPartialRedactionMarker(value: string): string {
  const redactionMarker = '<redacted>';
  for (let length = redactionMarker.length - 1; length > 0; length -= 1) {
    if (value.endsWith(redactionMarker.slice(0, length))) {
      return value.slice(0, -length);
    }
  }
  return value;
}

function normalizeReplayFilePath(
  value: string,
  maxLength: number,
): { value: string; truncated: boolean } | null {
  const normalizedSeparators = value.replace(/\\/g, '/');
  if (!isSafeReplayFilePath(normalizedSeparators)) {
    return null;
  }
  const redacted = truncateRedactedString(normalizedSeparators, maxLength);
  if (!isSafeReplayFilePath(redacted.value)) {
    return null;
  }
  return redacted;
}

function isSafeReplayFilePath(value: string): boolean {
  if (!value || value.startsWith('/') || /^[A-Za-z]:\//.test(value) || value.includes('\0')) {
    return false;
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    return false;
  }
  return value.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function unavailable(sessionId: string, message: string): SessionReplayResponse {
  return {
    status: 'unavailable',
    supported: true,
    available: false,
    sessionId,
    diagnostics: [{ level: 'info', message }],
  };
}

function unavailableWithDiagnostics(
  sessionId: string,
  diagnostics: Diagnostic[],
): SessionReplayResponse {
  return {
    status: 'unavailable',
    supported: true,
    available: false,
    sessionId,
    diagnostics,
  };
}

function malformed(
  sessionId: string,
  version: number | null,
  message: string,
): SessionReplayResponse {
  return {
    status: 'malformed',
    supported: true,
    available: true,
    sessionId,
    version,
    diagnostics: [{ level: 'warn', message }],
  };
}

function conflict(sessionId: string, paths: string[]): SessionReplayResponse {
  return {
    status: 'conflict',
    supported: true,
    available: true,
    sessionId,
    diagnostics: [
      {
        level: 'warn',
        message: `Multiple conflicting replay files found (${paths.length}). Refusing to pick one.`,
      },
    ],
  };
}
