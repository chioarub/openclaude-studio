import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path';

import type {
  Diagnostic,
  ProjectSummary,
  SessionChangeFileReview,
  SessionChangeRelatedEvent,
  SessionChangeReviewResponse,
  SessionChangeRiskFlag,
  SessionChangeStatus,
} from '@openclaude-studio/shared';

import { createUnifiedDiff } from './diff.js';
import type { OpenClaudePaths } from './paths.js';
import { redactTextSecrets } from './redaction.js';
import { type BoundedTextRead, readBoundedTextFile, readContainedBoundedTextFile } from './safeFile.js';
import { isUnambiguousSessionArtifactScope } from './sessionArtifacts.js';
import {
  findTranscriptFilesForProject,
  parseTranscriptFilesForProjectWithDiagnostics,
  type ParsedToolUse,
  type ParsedTranscriptEntry,
} from './sessions.js';

type SessionProject = Pick<ProjectSummary, 'path'>;

type PathResolution = {
  kind: 'inside' | 'outside';
  key: string;
  displayPath: string;
  absolutePath: string;
};

type ChangedFile = {
  path: PathResolution;
  firstToolName: string;
  relatedEvents: SessionChangeRelatedEvent[];
};

type RawFileHistoryEntry = {
  key: string;
  backupFileName: string | null;
  version: number | null;
  backupTime: string | null;
};

type BackupSelection = {
  entry: RawFileHistoryEntry | null;
  read: BoundedTextRead | null;
  diagnostics: Diagnostic[];
};

type StatusDiffResult = {
  status: SessionChangeStatus;
  additions: number;
  deletions: number;
  hunks: NonNullable<SessionChangeFileReview['diff']>['hunks'] | null;
};

const mutationTools = new Set(['Edit', 'MultiEdit', 'NotebookEdit', 'Write']);
const maxChangeFileBytes = 512 * 1024;
const maxTranscriptBytes = 10 * 1024 * 1024;
const maxDiffLines = 2_000;
const maxDiffCells = 2_000_000;

export async function readSessionChangeReview(
  paths: OpenClaudePaths,
  project: SessionProject,
  sessionId: string,
): Promise<SessionChangeReviewResponse | null> {
  const files = await findTranscriptFilesForProject(paths.projectsDir, project.path);
  const parsed = await parseTranscriptFilesForProjectWithDiagnostics(files, project.path);
  const entries = parsed.entries
    .filter((entry) => entry.sessionId === sessionId)
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp));

  if (entries.length === 0) {
    return null;
  }

  const diagnostics = parsed.diagnostics.map(redactDiagnosticPath);
  const sourcePaths = unique(entries.map((entry) => entry.sourcePath).filter(Boolean));
  const artifactScopeIsUnambiguous = await isUnambiguousSessionArtifactScope(
    paths.projectsDir,
    project.path,
    sessionId,
  );
  if (!artifactScopeIsUnambiguous) {
    diagnostics.push({
      level: 'warn',
      message: 'Session file-history artifacts are ambiguous across projects, so backup files were not read.',
    });
  }

  const historyByKey = await readFileHistoryByChangedFile(project.path, sourcePaths);
  const changedFiles = collectChangedFiles(entries, project.path);
  const reviews = await Promise.all(
    changedFiles.map((change, index) =>
      buildFileReview({
        paths,
        project,
        sessionId,
        change,
        index,
        historyEntries: historyByKey.get(change.path.key) ?? [],
        artifactScopeIsUnambiguous,
      }),
    ),
  );

  return {
    sessionId,
    files: reviews,
    totals: {
      fileCount: reviews.length,
      additions: sum(reviews, (file) => file.additions),
      deletions: sum(reviews, (file) => file.deletions),
      backupCount: reviews.filter((file) => file.backupExists).length,
      riskFlagCount: sum(reviews, (file) => file.riskFlags.length),
    },
    diagnostics,
  };
}

function collectChangedFiles(entries: ParsedTranscriptEntry[], projectPath: string): ChangedFile[] {
  const byKey = new Map<string, ChangedFile>();

  for (const [rowIndex, row] of entries.entries()) {
    for (const [toolIndex, tool] of row.toolUses.entries()) {
      if (!mutationTools.has(tool.name) || !tool.filePath) {
        continue;
      }

      const path = resolveChangedPath(projectPath, tool.filePath);
      const existing = byKey.get(path.key);
      const relatedEvent = buildRelatedEvent(row, rowIndex, toolIndex, tool);
      if (existing) {
        existing.relatedEvents.push(relatedEvent);
        continue;
      }

      byKey.set(path.key, {
        path,
        firstToolName: tool.name,
        relatedEvents: [relatedEvent],
      });
    }
  }

  return [...byKey.values()];
}

function buildRelatedEvent(
  row: ParsedTranscriptEntry,
  rowIndex: number,
  toolIndex: number,
  tool: ParsedToolUse,
): SessionChangeRelatedEvent {
  return {
    id: `${row.sessionId}-${rowIndex}-tool-${toolIndex}`,
    timestamp: row.timestamp,
    title: toolTitle(tool.name),
    toolName: tool.name,
    command: tool.command ? redactTextSecrets(tool.command) : null,
  };
}

function toolTitle(toolName: string): string {
  if (toolName === 'Write') return 'Write file';
  if (toolName === 'Edit' || toolName === 'MultiEdit' || toolName === 'NotebookEdit') return 'Edit file';
  return `${toolName} call`;
}

async function readFileHistoryByChangedFile(
  projectPath: string,
  transcriptPaths: string[],
): Promise<Map<string, RawFileHistoryEntry[]>> {
  const entries: RawFileHistoryEntry[] = [];

  for (const transcriptPath of transcriptPaths) {
    let transcript: BoundedTextRead;
    try {
      transcript = await readBoundedTextFile(transcriptPath, { maxBytes: maxTranscriptBytes });
    } catch {
      continue;
    }
    if (!transcript.exists) {
      continue;
    }

    for (const line of transcript.content.split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }
      try {
        const parsed = JSON.parse(line) as unknown;
        for (const entry of rawFileHistoryEntriesFromUnknown(parsed, projectPath)) {
          entries.push(entry);
        }
      } catch {
        continue;
      }
    }
  }

  const byIdentity = new Map<string, RawFileHistoryEntry>();
  for (const entry of entries) {
    const identity = [entry.key, entry.backupFileName ?? 'new-file', entry.version ?? 0].join('\0');
    const existing = byIdentity.get(identity);
    if (!existing || compareHistoryEntries(entry, existing) < 0) {
      byIdentity.set(identity, entry);
    }
  }

  const byChangedFile = new Map<string, RawFileHistoryEntry[]>();
  for (const entry of byIdentity.values()) {
    byChangedFile.set(entry.key, [...(byChangedFile.get(entry.key) ?? []), entry]);
  }
  for (const [key, values] of byChangedFile.entries()) {
    byChangedFile.set(key, values.sort(compareHistoryEntries));
  }
  return byChangedFile;
}

function rawFileHistoryEntriesFromUnknown(value: unknown, projectPath: string): RawFileHistoryEntry[] {
  if (!isRecord(value) || value.type !== 'file-history-snapshot') {
    return [];
  }

  const snapshot = isRecord(value.snapshot) ? value.snapshot : null;
  const trackedFileBackups = isRecord(snapshot?.trackedFileBackups) ? snapshot.trackedFileBackups : null;
  if (!trackedFileBackups) {
    return [];
  }

  const snapshotTimestamp = normalizeTimestamp(snapshot?.timestamp) ?? normalizeTimestamp(value.timestamp);
  const entries: RawFileHistoryEntry[] = [];
  for (const [filePath, rawBackup] of Object.entries(trackedFileBackups)) {
    if (!filePath.trim() || !isRecord(rawBackup)) {
      continue;
    }

    const resolved = resolveChangedPath(projectPath, filePath);
    entries.push({
      key: resolved.key,
      backupFileName: rawBackup.backupFileName === null ? null : stringFromUnknown(rawBackup.backupFileName),
      version: intFromUnknown(rawBackup.version),
      backupTime: normalizeTimestamp(rawBackup.backupTime) ?? snapshotTimestamp,
    });
  }
  return entries;
}

async function buildFileReview({
  paths,
  project,
  sessionId,
  change,
  index,
  historyEntries,
  artifactScopeIsUnambiguous,
}: {
  paths: OpenClaudePaths;
  project: SessionProject;
  sessionId: string;
  change: ChangedFile;
  index: number;
  historyEntries: RawFileHistoryEntry[];
  artifactScopeIsUnambiguous: boolean;
}): Promise<SessionChangeFileReview> {
  const diagnostics: Diagnostic[] = [];
  let currentRead: BoundedTextRead | null = null;

  if (change.path.kind === 'outside') {
    diagnostics.push({
      level: 'warn',
      message: 'Changed file path is outside the selected project and was not read.',
      path: change.path.displayPath,
    });
  } else {
    currentRead = await readContainedBoundedTextFile(project.path, change.path.absolutePath, {
      maxBytes: maxChangeFileBytes,
    });
    diagnostics.push(...currentRead.diagnostics.map((diagnostic) => displayDiagnostic(diagnostic, change.path.displayPath)));
  }

  const backupSelection = artifactScopeIsUnambiguous
    ? await selectBackup(paths.fileHistoryDir, sessionId, historyEntries, change.path.displayPath)
    : { entry: historyEntries[0] ?? null, read: null, diagnostics: [] };
  diagnostics.push(...backupSelection.diagnostics);

  const statusAndDiff = buildStatusAndDiff({
    change,
    backupRead: backupSelection.read,
    currentRead,
    diagnostics,
  });
  const riskFlags = buildRiskFlags(change.path.displayPath, statusAndDiff.status, statusAndDiff.additions, statusAndDiff.deletions);

  return {
    id: `${sessionId}-change-${index}`,
    filePath: change.path.displayPath,
    status: statusAndDiff.status,
    language: languageFromPath(change.path.displayPath),
    backupFileName: displayBackupFileName(backupSelection.entry?.backupFileName ?? null),
    backupExists: Boolean(backupSelection.read?.exists),
    backupVersion: backupSelection.entry?.version ?? null,
    backupTime: backupSelection.entry?.backupTime ?? null,
    beforeTruncated: Boolean(backupSelection.read?.truncated),
    afterTruncated: Boolean(currentRead?.truncated),
    additions: statusAndDiff.additions,
    deletions: statusAndDiff.deletions,
    riskFlags,
    relatedEvents: change.relatedEvents,
    diff: statusAndDiff.hunks ? { hunks: statusAndDiff.hunks } : null,
    diagnostics,
  };
}

async function selectBackup(
  fileHistoryDir: string,
  sessionId: string,
  entries: RawFileHistoryEntry[],
  displayPath: string,
): Promise<BackupSelection> {
  const diagnostics: Diagnostic[] = [];
  const entriesWithBackups = entries.filter((entry) => entry.backupFileName);

  for (const entry of entriesWithBackups) {
    const backupPath = safeSessionBackupPath(fileHistoryDir, sessionId, entry.backupFileName);
    if (!backupPath) {
      diagnostics.push({
        level: 'warn',
        message: 'Backup file name was unsafe and was not read.',
        path: displayPath,
      });
      continue;
    }

    const backup = await readBoundedTextFile(backupPath, { maxBytes: maxChangeFileBytes });
    if (backup.exists) {
      return {
        entry,
        read: backup,
        diagnostics: backup.diagnostics.map((diagnostic) => displayDiagnostic(diagnostic, displayPath)),
      };
    }
    diagnostics.push(...backup.diagnostics.map((diagnostic) => displayDiagnostic(diagnostic, displayPath)));
  }

  return {
    entry: entriesWithBackups[0] ?? entries[0] ?? null,
    read: null,
    diagnostics,
  };
}

function buildStatusAndDiff({
  change,
  backupRead,
  currentRead,
  diagnostics,
}: {
  change: ChangedFile;
  backupRead: BoundedTextRead | null;
  currentRead: BoundedTextRead | null;
  diagnostics: Diagnostic[];
}): StatusDiffResult {
  if (change.path.kind === 'outside') {
    return noDiff('unavailable');
  }

  const hasBackup = Boolean(backupRead?.exists);
  const hasCurrent = Boolean(currentRead?.exists);
  if (!hasBackup && !hasCurrent) {
    return noDiff('unavailable');
  }
  if ((backupRead?.exists && backupRead.truncated) || (currentRead?.exists && currentRead.truncated)) {
    return noDiff('too-large');
  }

  if (!hasBackup) {
    if (hasCurrent && change.firstToolName === 'Write') {
      return diffTexts('', currentRead!.content, 'created', diagnostics);
    }
    return noDiff('missing-backup');
  }

  if (!hasCurrent) {
    if (currentRead && isPlainMissingFile(currentRead)) {
      return diffTexts(backupRead!.content, '', 'deleted', diagnostics);
    }
    return noDiff('missing-current');
  }

  return diffTexts(backupRead!.content, currentRead!.content, null, diagnostics);
}

function diffTexts(
  before: string,
  after: string,
  forcedStatus: SessionChangeStatus | null,
  diagnostics: Diagnostic[],
): StatusDiffResult {
  if (looksBinary(before) || looksBinary(after)) {
    return noDiff('binary');
  }

  const beforeLineCount = countLines(before);
  const afterLineCount = countLines(after);
  if (
    beforeLineCount > maxDiffLines ||
    afterLineCount > maxDiffLines ||
    beforeLineCount * afterLineCount > maxDiffCells
  ) {
    diagnostics.push({
      level: 'warn',
      message: `Diff was skipped because file content exceeded ${maxDiffLines} lines or ${maxDiffCells} comparison cells.`,
    });
    return noDiff('too-large');
  }

  const diff = createUnifiedDiff(redactTextSecrets(before), redactTextSecrets(after));
  const status = forcedStatus ?? (diff.additions === 0 && diff.deletions === 0 ? 'unchanged' : 'modified');
  return {
    status,
    additions: diff.additions,
    deletions: diff.deletions,
    hunks: diff.hunks,
  };
}

function noDiff(status: SessionChangeStatus): {
  status: SessionChangeStatus;
  additions: number;
  deletions: number;
  hunks: null;
} {
  return { status, additions: 0, deletions: 0, hunks: null };
}

function resolveChangedPath(projectPath: string, rawPath: string): PathResolution {
  const root = resolve(projectPath);
  const absolutePath = isAbsolute(rawPath) ? resolve(rawPath) : resolve(root, rawPath);
  if (isSameOrChildPath(absolutePath, root)) {
    const relativePath = toPosixPath(relative(root, absolutePath)) || '.';
    return {
      kind: 'inside',
      key: relativePath,
      displayPath: redactTextSecrets(relativePath),
      absolutePath,
    };
  }

  return {
    kind: 'outside',
    key: `outside:${absolutePath}`,
    displayPath: `outside-project:${redactTextSecrets(basename(absolutePath) || 'file')}`,
    absolutePath,
  };
}

function safeSessionBackupPath(fileHistoryDir: string, sessionId: string, backupFileName: string | null): string | null {
  if (!backupFileName || backupFileName.includes('/') || backupFileName.includes('\\') || backupFileName.includes('..')) {
    return null;
  }

  const sessionDir = safeChildPath(fileHistoryDir, sessionId);
  return sessionDir ? safeChildPath(sessionDir, backupFileName) : null;
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

function displayBackupFileName(backupFileName: string | null): string | null {
  if (!backupFileName || backupFileName.includes('/') || backupFileName.includes('\\') || backupFileName.includes('..')) {
    return null;
  }
  return redactTextSecrets(backupFileName);
}

function buildRiskFlags(
  filePath: string,
  status: SessionChangeStatus,
  additions: number,
  deletions: number,
): SessionChangeRiskFlag[] {
  const flags: SessionChangeRiskFlag[] = [];
  const normalized = filePath.toLowerCase();
  const name = basename(normalized);

  if (isSecretLikePath(normalized, name)) {
    flags.push({
      level: 'error',
      label: 'Secret-like file',
      message: 'This path commonly stores credentials or authentication material. Review the redacted diff carefully.',
    });
  }

  if (normalized === '.openclaude/settings.json' || normalized === '.openclaude/settings.local.json') {
    flags.push({
      level: 'warn',
      label: 'OpenClaude settings',
      message: 'OpenClaude settings can affect model, tool, hook, or permission behavior.',
    });
  }

  if (normalized.includes('.openclaude/hooks') || normalized.includes('permission')) {
    flags.push({
      level: 'warn',
      label: 'Hooks or permissions',
      message: 'Hook and permission configuration changes can alter future OpenClaude behavior.',
    });
  }

  if (isPackageManifestOrLockfile(name)) {
    flags.push({
      level: 'warn',
      label: 'Dependency manifest',
      message: 'Package manifests and lockfiles can alter installed dependencies or scripts.',
    });
  }

  if (isDeploymentOrAutomationPath(normalized, name)) {
    flags.push({
      level: 'warn',
      label: 'Automation or deployment',
      message: 'CI, shell, Docker, and deployment changes can affect build or runtime behavior.',
    });
  }

  if (additions + deletions > 250) {
    flags.push({
      level: 'info',
      label: 'Large change',
      message: 'This file changed more than 250 lines in the selected session.',
    });
  }

  if (status === 'missing-backup') {
    flags.push({
      level: 'warn',
      label: 'Missing backup',
      message: 'No readable file-history backup was available, so Studio cannot show a before/after diff.',
    });
  }

  if (status === 'missing-current' || status === 'unavailable') {
    flags.push({
      level: 'warn',
      label: 'Unavailable content',
      message: 'Studio could not safely read one side of this change.',
    });
  }

  return flags;
}

function isSecretLikePath(normalized: string, name: string): boolean {
  if (name === '.env' || name.startsWith('.env.') || name === '.npmrc' || name === '.pypirc') {
    return true;
  }
  return /(^|[._/-])(secret|token|credential|auth|api[_-]?key|private[_-]?key|id_rsa)([._/-]|$)/i.test(normalized);
}

function isPackageManifestOrLockfile(name: string): boolean {
  return [
    'package.json',
    'package-lock.json',
    'pnpm-lock.yaml',
    'yarn.lock',
    'bun.lockb',
    'composer.lock',
    'poetry.lock',
    'requirements.txt',
  ].includes(name);
}

function isDeploymentOrAutomationPath(normalized: string, name: string): boolean {
  return (
    normalized.startsWith('.github/workflows/') ||
    name === '.gitlab-ci.yml' ||
    name === 'dockerfile' ||
    normalized.includes('docker-compose') ||
    normalized.includes('deploy') ||
    name.endsWith('.sh') ||
    name.endsWith('.ps1')
  );
}

function languageFromPath(filePath: string): string | null {
  const extension = extname(filePath).toLowerCase();
  const languages: Record<string, string> = {
    '.js': 'javascript',
    '.jsx': 'javascript',
    '.ts': 'typescript',
    '.tsx': 'typescript',
    '.json': 'json',
    '.md': 'markdown',
    '.css': 'css',
    '.html': 'html',
    '.yml': 'yaml',
    '.yaml': 'yaml',
    '.sh': 'shell',
    '.py': 'python',
    '.rs': 'rust',
    '.go': 'go',
  };
  if (filePath.endsWith('.env') || basename(filePath).startsWith('.env.')) {
    return 'dotenv';
  }
  return languages[extension] ?? null;
}

function displayDiagnostic(diagnostic: Diagnostic, displayPath: string): Diagnostic {
  return {
    ...diagnostic,
    message: redactTextSecrets(diagnostic.message),
    path: displayPath,
  };
}

function redactDiagnosticPath(diagnostic: Diagnostic): Diagnostic {
  const redacted: Diagnostic = {
    ...diagnostic,
    message: redactTextSecrets(diagnostic.message),
  };
  if (diagnostic.path) {
    redacted.path = redactTextSecrets(diagnostic.path);
  }
  return redacted;
}

function isPlainMissingFile(read: BoundedTextRead): boolean {
  return read.diagnostics.some((diagnostic) => diagnostic.message === 'File does not exist.');
}

function looksBinary(content: string): boolean {
  if (!content) {
    return false;
  }
  if (content.includes('\u0000')) {
    return true;
  }

  let controlCharacters = 0;
  for (const char of content) {
    const code = char.charCodeAt(0);
    if (code < 32 && char !== '\n' && char !== '\r' && char !== '\t') {
      controlCharacters += 1;
    }
  }
  return controlCharacters / content.length > 0.05;
}

function countLines(value: string): number {
  if (!value) {
    return 0;
  }
  return value.split(/\r\n|\r|\n/).length;
}

function compareHistoryEntries(left: RawFileHistoryEntry, right: RawFileHistoryEntry): number {
  if (left.backupTime && right.backupTime && left.backupTime !== right.backupTime) {
    return left.backupTime.localeCompare(right.backupTime);
  }
  if (left.backupTime && !right.backupTime) {
    return -1;
  }
  if (!left.backupTime && right.backupTime) {
    return 1;
  }
  return (left.version ?? 0) - (right.version ?? 0);
}

function toPosixPath(value: string): string {
  return value.split(sep).join('/');
}

function isSameOrChildPath(candidate: string, parent: string): boolean {
  const relativePath = relative(parent, candidate);
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
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

function intFromUnknown(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}

function stringFromUnknown(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function sum<T>(items: T[], selector: (item: T) => number): number {
  return items.reduce((total, item) => total + selector(item), 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
