import { lstat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type {
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
import { findTranscriptFilesForProject } from './sessions.js';

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

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

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
  const candidateRoots = uniqueRoots(transcriptFiles.map((file) => dirname(file)));

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
  const read = await readBoundedTextFile(replayPath, { maxBytes: MAX_REPLAY_BYTES });

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

function validateSessionId(sessionId: string): void {
  if (!sessionId || typeof sessionId !== 'string') {
    throw invalidRequest('Session ID is required.');
  }
  if (!SESSION_ID_PATTERN.test(sessionId)) {
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

  const summaryResult = parseSummary(summaryRaw);
  if ('diagnostic' in summaryResult) {
    return malformed(sessionId, version, summaryResult.diagnostic);
  }

  const stepResults = stepsRaw.map((step, index) => parseStep(step, index));
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
    diagnostics: truncated
      ? [
          {
            level: 'warn',
            message: `Replay truncated to the first ${MAX_STEPS} steps.`,
          },
        ]
      : [],
  };
}

function parseSummary(raw: Record<string, unknown>):
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

  const filesModifiedResult = parseStringArray(
    raw.filesModified,
    MAX_FILES_MODIFIED,
    MAX_FILE_PATH_LENGTH,
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
      filesModified: redactEach(filesModifiedResult.items),
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

function parseStep(raw: unknown, index: number): SessionReplayStep | null {
  if (!isObject(raw)) {
    return null;
  }

  const stepNumber = parseNonNegativeInt(raw.stepNumber) ?? index + 1;
  const timestamp = parseTimestamp(raw.timestamp);
  const type = raw.type;

  if (type === 'tool') {
    return parseToolStep(raw, stepNumber, timestamp);
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
): SessionReplayToolStep | null {
  const toolName = typeof raw.toolName === 'string' ? raw.toolName : null;
  if (!toolName) {
    return null;
  }

  const inputSummary =
    typeof raw.inputSummary === 'string' ? raw.inputSummary : '';
  const truncatedInput = inputSummary.length > MAX_INPUT_SUMMARY_LENGTH;
  const boundedInput = truncatedInput
    ? inputSummary.slice(0, MAX_INPUT_SUMMARY_LENGTH)
    : inputSummary;

  const resultStatus = parseResultStatus(raw.resultStatus);

  const resultPreviewRaw = typeof raw.resultPreview === 'string' ? raw.resultPreview : null;
  const resultPreviewTruncated =
    resultPreviewRaw !== null && resultPreviewRaw.length > MAX_RESULT_PREVIEW_LENGTH;
  const resultPreview = resultPreviewRaw
    ? resultPreviewRaw.slice(0, MAX_RESULT_PREVIEW_LENGTH)
    : null;

  const filesModifiedResult = parseStringArray(
    raw.filesModified,
    MAX_FILES_MODIFIED,
    MAX_FILE_PATH_LENGTH,
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
    inputSummary: redactTextSecrets(boundedInput),
    inputSummaryTruncated: truncatedInput,
    resultStatus,
    resultPreview: resultPreview ? redactTextSecrets(resultPreview) : null,
    resultPreviewTruncated,
    durationMs,
    timestamp,
    filesModified: redactEach(filesModifiedResult ? filesModifiedResult.items : []),
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
  const truncated = content.length > MAX_USER_CONTENT_LENGTH;
  const bounded = truncated ? content.slice(0, MAX_USER_CONTENT_LENGTH) : content;
  return {
    type: 'user',
    stepNumber,
    content: redactTextSecrets(bounded),
    contentTruncated: truncated,
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
  const reasonTruncated = reason.length > MAX_REASON_LENGTH;
  const boundedReason = reasonTruncated ? reason.slice(0, MAX_REASON_LENGTH) : reason;

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
    reason: redactTextSecrets(boundedReason),
    reasonTruncated,
    commands: redactEach(commandsResult ? commandsResult.items : []),
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
  const truncated = error.length > MAX_REASON_LENGTH;
  const bounded = truncated ? error.slice(0, MAX_REASON_LENGTH) : error;
  return {
    type: 'error',
    stepNumber,
    error: redactTextSecrets(bounded),
    errorTruncated: truncated,
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
  const truncated = valid.length > maxItems;
  const bounded = truncated ? valid.slice(0, maxItems) : valid;
  const mapped = bounded.map((item) =>
    item.length > maxLength ? item.slice(0, maxLength) : item,
  );
  return { items: mapped, truncated };
}

function parseNonNegativeInt(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return Math.floor(value);
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
  const bounded =
    value.length > MAX_CREATED_AT_LENGTH ? value.slice(0, MAX_CREATED_AT_LENGTH) : value;
  return redactTextSecrets(bounded);
}

function redactEach(items: string[]): string[] {
  return items.map((item) => redactTextSecrets(item));
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
