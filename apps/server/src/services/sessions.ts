import { lstat, readdir } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { join, resolve } from 'node:path';

import type { ProjectSummary, SessionSummary } from '@openclaude-studio/shared';

import { encodeProjectPath, type OpenClaudePaths } from './paths.js';
import { redactTextSecrets } from './redaction.js';
import { readBoundedTextFile } from './safeFile.js';

type UnknownRecord = Record<string, unknown>;

type SessionProject = Pick<ProjectSummary, 'path' | 'usage'>;

export type ParsedToolUse = {
  id: string | null;
  name: string;
  filePath: string | null;
  command: string | null;
  displayLabel: string | null;
  details: string | null;
};

export type ParsedToolResult = {
  toolUseId: string | null;
  resultType: string | null;
  status: 'success' | 'error' | 'unknown';
  outputType: 'command' | 'stdout' | 'stderr' | 'file' | 'text' | 'image' | 'none';
  filePath: string | null;
  stdout: string | null;
  stderr: string | null;
  text: string | null;
};

export type ParsedTranscriptEntry = {
  sessionId: string;
  timestamp: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  text: string;
  title: string | null;
  slug: string | null;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  changedFiles: string[];
  failed: boolean;
  toolUses: ParsedToolUse[];
  toolResult: ParsedToolResult | null;
  sourcePath: string;
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

export async function parseTranscriptFile(
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
        entries.push({ ...entry, sourcePath: filePath });
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
  const content = message?.content;
  const toolResult = extractToolResult(value, content);
  const role = toolResult ? 'tool' : readRole(type, stringFromUnknown(message?.role));
  const usage = isRecord(message?.usage) ? message.usage : null;
  const toolUses = extractToolUses(content);
  const systemMessage =
    typeof value.message === 'string'
      ? value.message
      : stringFromUnknown(value.content) ?? '';
  const rawText = message ? extractText(content) : systemMessage;
  const localCommandText = localCommandDisplayText(rawText);
  const text = stripTranscriptNoise(localCommandText === null ? '' : localCommandText ?? rawText);
  const failed =
    (type === 'system' && stringFromUnknown(value.level) === 'error') ||
    value.isApiErrorMessage === true ||
    Boolean(stringFromUnknown(value.error)) ||
    toolResult?.status === 'error';

  if (type === 'system' && !failed && !text.trim()) {
    return null;
  }

  return {
    sessionId,
    timestamp,
    role,
    text,
    title: extractTitle(value),
    slug: stringFromUnknown(value.slug),
    model: stringFromUnknown(message?.model),
    inputTokens: intFromUnknown(usage?.input_tokens),
    outputTokens: intFromUnknown(usage?.output_tokens),
    cacheReadTokens: intFromUnknown(usage?.cache_read_input_tokens),
    cacheWriteTokens: intFromUnknown(usage?.cache_creation_input_tokens),
    changedFiles: toolUses
      .filter((tool) => mutationTools.has(tool.name))
      .map((tool) => tool.filePath)
      .filter((filePath): filePath is string => Boolean(filePath)),
    toolUses,
    toolResult,
    failed,
    sourcePath: '',
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
    title: truncateText(explicitTitle ?? userTitle ?? `Session ${sessionId}`, 80),
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
  if (type === 'tool' || type === 'tool_result') {
    return 'tool';
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
        if (isRecord(block) && Array.isArray(block.content)) {
          return extractText(block.content);
        }
        if (isRecord(block) && typeof block.content === 'string') {
          return block.content;
        }
        return '';
      }
      return stringFromUnknown(block.text) ?? '';
    })
    .filter(Boolean)
    .join('\n');
}

function extractToolUses(content: unknown): ParsedToolUse[] {
  if (!Array.isArray(content)) {
    return [];
  }

  const tools: ParsedToolUse[] = [];
  for (const block of content) {
    if (!isRecord(block) || block.type !== 'tool_use') {
      continue;
    }

    const name = stringFromUnknown(block.name);
    if (!name) {
      continue;
    }

    const input = isRecord(block.input) ? block.input : {};
    const summary = summarizeToolUseInput(name, input);
    tools.push({
      id: stringFromUnknown(block.id),
      name,
      filePath:
        stringFromUnknown(input.file_path) ??
        stringFromUnknown(input.path) ??
        stringFromUnknown(input.notebook_path),
      command: stringFromUnknown(input.command),
      displayLabel: summary.displayLabel,
      details: summary.details,
    });
  }
  return tools;
}

function summarizeToolUseInput(
  name: string,
  input: UnknownRecord,
): Pick<ParsedToolUse, 'displayLabel' | 'details'> {
  if (/^Skill$/i.test(name)) {
    const skill = stringFromUnknown(input.skill);
    const args = stringFromUnknown(input.args);
    return {
      displayLabel: skill,
      details: labeledToolDetails([
        ['Skill', skill],
        ['Arguments', args],
      ]),
    };
  }

  if (/^TaskCreate$/i.test(name)) {
    const subject = stringFromUnknown(input.subject);
    const activeForm = stringFromUnknown(input.activeForm);
    const description = stringFromUnknown(input.description);
    return {
      displayLabel: subject,
      details: labeledToolDetails([
        ['Task', subject],
        ['State', activeForm],
        ['Description', description],
      ]),
    };
  }

  if (/^Agent$/i.test(name)) {
    const description = stringFromUnknown(input.description);
    const subagentType = stringFromUnknown(input.subagent_type);
    const prompt = stringFromUnknown(input.prompt);
    return {
      displayLabel: description,
      details: labeledToolDetails([
        ['Agent', description],
        ['Type', subagentType],
        ['Prompt', prompt],
      ]),
    };
  }

  const subject =
    stringFromUnknown(input.subject) ??
    stringFromUnknown(input.description) ??
    stringFromUnknown(input.prompt) ??
    stringFromUnknown(input.args);
  return {
    displayLabel: subject,
    details: labeledToolDetails([
      ['Subject', stringFromUnknown(input.subject)],
      ['Description', stringFromUnknown(input.description)],
      ['Prompt', stringFromUnknown(input.prompt)],
      ['Arguments', stringFromUnknown(input.args)],
    ]),
  };
}

function labeledToolDetails(fields: Array<[string, string | null]>): string | null {
  const blockLabels = new Set(['Arguments', 'Description', 'Prompt']);
  const lines = fields
    .filter((field): field is [string, string] => Boolean(field[1]?.trim()))
    .map(([label, value]) =>
      value.includes('\n') || blockLabels.has(label) ? `${label}:\n${value}` : `${label}: ${value}`,
    );
  return lines.length > 0 ? lines.join('\n') : null;
}

function extractToolResult(row: UnknownRecord, content: unknown): ParsedToolResult | null {
  const resultRecord = isRecord(row.toolUseResult) ? row.toolUseResult : null;
  const messageRecord = isRecord(row.message) ? row.message : null;
  const toolResultItem = Array.isArray(content)
    ? content.find((item): item is UnknownRecord => isRecord(item) && item.type === 'tool_result') ?? null
    : null;

  if (!resultRecord && !toolResultItem && stringFromUnknown(row.type) !== 'tool') {
    return null;
  }

  const rawText = stripTranscriptNoise(extractText(content));
  const nestedFile = resultRecord && isRecord(resultRecord.file) ? resultRecord.file : null;
  const stdout = resultRecord ? stringFromUnknown(resultRecord.stdout) : null;
  const stderr = resultRecord ? stringFromUnknown(resultRecord.stderr) : null;
  const filePath =
    (resultRecord ? stringFromUnknown(resultRecord.filePath) : null) ??
    stringFromUnknown(nestedFile?.filePath) ??
    filePathFromToolResultText(rawText);
  const resultType = resultRecord ? stringFromUnknown(resultRecord.type) : null;
  const isError =
    toolResultItem?.is_error === true ||
    resultRecord?.is_error === true ||
    resultRecord?.interrupted === true ||
    row.isApiErrorMessage === true;
  const hasResultPayload = Boolean(resultRecord || rawText.trim() || stdout || stderr || filePath);
  const status: ParsedToolResult['status'] = isError ? 'error' : hasResultPayload ? 'success' : 'unknown';
  const outputType = inferToolResultOutputType({
    isError,
    resultRecord,
    rawText,
    stdout,
    stderr,
    filePath,
  });

  return {
    toolUseId:
      stringFromUnknown(toolResultItem?.tool_use_id) ??
      stringFromUnknown(messageRecord?.tool_use_id) ??
      stringFromUnknown(row.tool_use_id),
    resultType,
    status,
    outputType,
    filePath,
    stdout,
    stderr,
    text: rawText.trim() ? rawText : null,
  };
}

function inferToolResultOutputType({
  isError,
  resultRecord,
  rawText,
  stdout,
  stderr,
  filePath,
}: {
  isError: boolean;
  resultRecord: UnknownRecord | null;
  rawText: string;
  stdout: string | null;
  stderr: string | null;
  filePath: string | null;
}): ParsedToolResult['outputType'] {
  if (isError && stderr) return 'stderr';
  if (stdout) return 'stdout';
  if (stderr) return 'stderr';
  if (resultRecord?.isImage === true) return 'image';
  if (rawText.trim() && !isGenericFileResultText(rawText, filePath)) return 'text';
  if (filePath) return 'file';
  if (rawText.trim()) return 'text';
  return 'none';
}

function filePathFromToolResultText(value: string): string | null {
  const match = value.match(/^File \w+ successfully at:\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

function isGenericFileResultText(value: string, filePath: string | null): boolean {
  const trimmed = value.trim();
  if (filePath && trimmed === filePath) return true;
  return /^File \w+ successfully at:\s+.+$/i.test(trimmed);
}

function cleanTitle(value: string): string {
  const normalized = redactTextSecrets(
    value
      .replace(/<command-message>[\s\S]*?(?:<\/command-message>|$)/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim();

  return normalized.startsWith('/') ? '' : normalized;
}

function localCommandDisplayText(content: string): string | null | undefined {
  if (!isLocalCommandMarkup(content)) {
    return undefined;
  }

  if (/<(?:local-command-caveat|local-command-stdout|local-command-stderr)\b/i.test(content)) {
    return null;
  }

  const commandName = tagContent(content, 'command-name');
  const commandMessage = tagContent(content, 'command-message');
  if (isHiddenLocalCommand(commandName ?? commandMessage)) {
    return null;
  }

  return tagContent(content, 'command-args')?.trim() || null;
}

function isLocalCommandMarkup(content: string): boolean {
  return /<(?:command-name|command-message|command-args|local-command-caveat|local-command-stdout|local-command-stderr)\b/i.test(
    content,
  );
}

function isHiddenLocalCommand(command: string | null | undefined): boolean {
  if (!command) {
    return false;
  }

  const commandName = command.trim().split(/\s+/)[0]?.replace(/^\/+/, '').split(':').pop()?.toLowerCase();
  return Boolean(commandName && ['clear', 'cost', 'doctor', 'export', 'help', 'login', 'logout', 'model'].includes(commandName));
}

function tagContent(content: string, tagName: string): string | null {
  const escapedTagName = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = content.match(new RegExp(`<${escapedTagName}\\b[^>]*>([\\s\\S]*?)<\\/${escapedTagName}>`, 'i'));
  return match?.[1] ?? null;
}

function stripTranscriptNoise(content: string): string {
  return content.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '').trim();
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
