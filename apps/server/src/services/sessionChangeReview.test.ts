import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, test } from 'vitest';

import type { ProjectSummary } from '@openclaude-studio/shared';

import { isUnsupportedSymlinkError } from '../test-support/symlink.js';
import { createOpenClaudePaths, encodeProjectPath, type OpenClaudePaths } from './paths.js';
import { readSessionChangeReview } from './sessionChangeReview.js';

describe('readSessionChangeReview', () => {
  test('returns a redacted diff for a modified file with a backup and current content', async () => {
    const { paths, projectPath, cleanup } = await setup();
    try {
      await writeProjectFile(projectPath, 'src/api.ts', 'export const token = "old";\nexport const value = 1;\n');
      await writeBackup(paths, 'session-1', 'api@v1', 'export const token = "old";\nexport const value = 0;\n');
      await writeTranscript(paths, projectPath, 'session-1', [
        toolUseRow({ sessionId: 'session-1', projectPath, timestamp: '2026-05-28T08:00:00.000Z', toolName: 'Edit', filePath: 'src/api.ts' }),
        fileHistorySnapshot({
          timestamp: '2026-05-28T08:00:01.000Z',
          trackedFileBackups: {
            'src/api.ts': { backupFileName: 'api@v1', version: 1, backupTime: '2026-05-28T08:00:01.000Z' },
          },
        }),
      ]);

      const result = await readSessionChangeReview(paths, projectSummary(projectPath), 'session-1');

      expect(result).not.toBeNull();
      expect(result!.totals).toMatchObject({ fileCount: 1, additions: 1, deletions: 1, backupCount: 1 });
      expect(result!.files[0]).toMatchObject({
        filePath: 'src/api.ts',
        status: 'modified',
        language: 'typescript',
        backupFileName: 'api@v1',
        backupExists: true,
        backupVersion: 1,
        additions: 1,
        deletions: 1,
        relatedEvents: [{ id: 'session-1-0-tool-0', title: 'Edit file', toolName: 'Edit' }],
      });
      expect(result!.files[0]!.diff?.hunks[0]?.lines).toEqual(
        expect.arrayContaining([
          { kind: 'remove', oldLine: 2, newLine: null, text: 'export const value = 0;' },
          { kind: 'add', oldLine: null, newLine: 2, text: 'export const value = 1;' },
        ]),
      );
      expect(JSON.stringify(result)).not.toContain('"old"');
    } finally {
      await cleanup();
    }
  });

  test('uses the most recent readable backup for a changed file', async () => {
    const { paths, projectPath, cleanup } = await setup();
    try {
      await writeProjectFile(projectPath, 'src/api.ts', 'export const value = 3;\n');
      await writeBackup(paths, 'session-latest-backup', 'api@v1', 'export const value = 1;\n');
      await writeBackup(paths, 'session-latest-backup', 'api@v2', 'export const value = 2;\n');
      await writeTranscript(paths, projectPath, 'session-latest-backup', [
        toolUseRow({ sessionId: 'session-latest-backup', projectPath, timestamp: '2026-05-28T08:05:00.000Z', toolName: 'Edit', filePath: 'src/api.ts' }),
        fileHistorySnapshot({
          timestamp: '2026-05-28T08:05:01.000Z',
          trackedFileBackups: {
            'src/api.ts': { backupFileName: 'api@v1', version: 1, backupTime: '2026-05-28T08:05:01.000Z' },
          },
        }),
        fileHistorySnapshot({
          timestamp: '2026-05-28T08:05:02.000Z',
          trackedFileBackups: {
            'src/api.ts': { backupFileName: 'api@v2', version: 2, backupTime: '2026-05-28T08:05:02.000Z' },
          },
        }),
      ]);

      const result = await readSessionChangeReview(paths, projectSummary(projectPath), 'session-latest-backup');

      expect(result).not.toBeNull();
      expect(result!.files[0]).toMatchObject({
        filePath: 'src/api.ts',
        backupFileName: 'api@v2',
        backupVersion: 2,
        backupExists: true,
      });
      expect(result!.files[0]!.diff?.hunks[0]?.lines).toEqual(
        expect.arrayContaining([
          { kind: 'remove', oldLine: 1, newLine: null, text: 'export const value = 2;' },
          { kind: 'add', oldLine: null, newLine: 1, text: 'export const value = 3;' },
        ]),
      );
      expect(JSON.stringify(result)).not.toContain('export const value = 1;');
    } finally {
      await cleanup();
    }
  });

  test('treats a Write tool without a backup as a created file when current content exists', async () => {
    const { paths, projectPath, cleanup } = await setup();
    try {
      await writeProjectFile(projectPath, 'src/new-panel.tsx', 'export function NewPanel() {\n  return null;\n}\n');
      await writeTranscript(paths, projectPath, 'session-created', [
        toolUseRow({ sessionId: 'session-created', projectPath, timestamp: '2026-05-28T09:00:00.000Z', toolName: 'Write', filePath: 'src/new-panel.tsx' }),
      ]);

      const result = await readSessionChangeReview(paths, projectSummary(projectPath), 'session-created');

      expect(result).not.toBeNull();
      expect(result!.files[0]).toMatchObject({
        filePath: 'src/new-panel.tsx',
        status: 'created',
        backupExists: false,
        additions: 3,
        deletions: 0,
      });
      expect(result!.files[0]!.diff?.hunks[0]?.oldStart).toBe(0);
    } finally {
      await cleanup();
    }
  });

  test('returns a deletion diff when a backup exists and the current file is missing', async () => {
    const { paths, projectPath, cleanup } = await setup();
    try {
      await writeBackup(paths, 'session-deleted', 'removed@v1', 'one\ntwo\n');
      await writeTranscript(paths, projectPath, 'session-deleted', [
        toolUseRow({ sessionId: 'session-deleted', projectPath, timestamp: '2026-05-28T10:00:00.000Z', toolName: 'Edit', filePath: 'src/removed.ts' }),
        fileHistorySnapshot({
          timestamp: '2026-05-28T10:00:01.000Z',
          trackedFileBackups: {
            'src/removed.ts': { backupFileName: 'removed@v1', version: 1, backupTime: '2026-05-28T10:00:01.000Z' },
          },
        }),
      ]);

      const result = await readSessionChangeReview(paths, projectSummary(projectPath), 'session-deleted');

      expect(result).not.toBeNull();
      expect(result!.files[0]).toMatchObject({
        filePath: 'src/removed.ts',
        status: 'deleted',
        additions: 0,
        deletions: 2,
      });
      expect(result!.files[0]!.diff?.hunks[0]?.lines.every((line) => line.kind === 'remove')).toBe(true);
    } finally {
      await cleanup();
    }
  });

  test('marks edited files without a readable backup as missing-backup with a risk flag', async () => {
    const { paths, projectPath, cleanup } = await setup();
    try {
      await writeProjectFile(projectPath, 'src/settings.ts', 'export const enabled = true;\n');
      await writeTranscript(paths, projectPath, 'session-missing-backup', [
        toolUseRow({ sessionId: 'session-missing-backup', projectPath, timestamp: '2026-05-28T11:00:00.000Z', toolName: 'Edit', filePath: 'src/settings.ts' }),
      ]);

      const result = await readSessionChangeReview(paths, projectSummary(projectPath), 'session-missing-backup');

      expect(result).not.toBeNull();
      expect(result!.files[0]).toMatchObject({
        filePath: 'src/settings.ts',
        status: 'missing-backup',
        diff: null,
      });
      expect(result!.files[0]!.riskFlags).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ level: 'warn', label: 'Missing backup' }),
        ]),
      );
    } finally {
      await cleanup();
    }
  });

  test('rejects unsafe backup file names without echoing them to the browser', async () => {
    const { paths, projectPath, cleanup } = await setup();
    try {
      await writeProjectFile(projectPath, 'src/settings.ts', 'export const enabled = true;\n');
      await writeTranscript(paths, projectPath, 'session-unsafe-backup', [
        toolUseRow({ sessionId: 'session-unsafe-backup', projectPath, timestamp: '2026-05-28T11:30:00.000Z', toolName: 'Edit', filePath: 'src/settings.ts' }),
        fileHistorySnapshot({
          timestamp: '2026-05-28T11:30:01.000Z',
          trackedFileBackups: {
            'src/settings.ts': { backupFileName: '../secret-backup', version: 1, backupTime: '2026-05-28T11:30:01.000Z' },
          },
        }),
      ]);

      const result = await readSessionChangeReview(paths, projectSummary(projectPath), 'session-unsafe-backup');

      expect(result).not.toBeNull();
      expect(result!.files[0]).toMatchObject({
        filePath: 'src/settings.ts',
        status: 'missing-backup',
        backupFileName: null,
        diff: null,
      });
      expect(result!.files[0]!.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ message: expect.stringContaining('unsafe') }),
        ]),
      );
      expect(JSON.stringify(result)).not.toContain('../secret-backup');
    } finally {
      await cleanup();
    }
  });

  test('does not read paths outside the selected project root', async () => {
    const { paths, projectPath, home, cleanup } = await setup();
    try {
      const outsidePath = join(home, 'outside-secret.txt');
      await writeFile(outsidePath, 'outside content that must not be returned\n', 'utf8');
      await writeTranscript(paths, projectPath, 'session-outside', [
        toolUseRow({ sessionId: 'session-outside', projectPath, timestamp: '2026-05-28T12:00:00.000Z', toolName: 'Write', filePath: outsidePath }),
      ]);

      const result = await readSessionChangeReview(paths, projectSummary(projectPath), 'session-outside');

      expect(result).not.toBeNull();
      expect(result!.files[0]).toMatchObject({
        filePath: 'outside-project:outside-secret.txt',
        status: 'unavailable',
        diff: null,
      });
      expect(result!.files[0]!.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ level: 'warn', message: expect.stringContaining('outside the selected project') }),
        ]),
      );
      expect(JSON.stringify(result)).not.toContain('outside content that must not be returned');
    } finally {
      await cleanup();
    }
  });

  test('redacts likely secrets before building diff lines', async () => {
    const { paths, projectPath, cleanup } = await setup();
    try {
      await writeProjectFile(projectPath, '.env', 'OPENAI_API_KEY=sk-newsecret123\nMODE=new\n');
      await writeBackup(paths, 'session-secret', 'env@v1', 'OPENAI_API_KEY=sk-oldsecret123\nMODE=old\n');
      await writeTranscript(paths, projectPath, 'session-secret', [
        toolUseRow({ sessionId: 'session-secret', projectPath, timestamp: '2026-05-28T13:00:00.000Z', toolName: 'Edit', filePath: '.env' }),
        fileHistorySnapshot({
          timestamp: '2026-05-28T13:00:01.000Z',
          trackedFileBackups: {
            '.env': { backupFileName: 'env@v1', version: 1, backupTime: '2026-05-28T13:00:01.000Z' },
          },
        }),
      ]);

      const result = await readSessionChangeReview(paths, projectSummary(projectPath), 'session-secret');

      expect(result).not.toBeNull();
      expect(result!.files[0]!.riskFlags).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ level: 'error', label: 'Secret-like file' }),
        ]),
      );
      expect(JSON.stringify(result)).toContain('OPENAI_API_KEY=<redacted>');
      expect(JSON.stringify(result)).not.toContain('sk-newsecret123');
      expect(JSON.stringify(result)).not.toContain('sk-oldsecret123');
    } finally {
      await cleanup();
    }
  });

  test('skips huge diffs when a bounded read is truncated', async () => {
    const { paths, projectPath, cleanup } = await setup();
    try {
      await writeProjectFile(projectPath, 'src/large.ts', `${'x'.repeat(600 * 1024)}\n`);
      await writeBackup(paths, 'session-large', 'large@v1', 'small\n');
      await writeTranscript(paths, projectPath, 'session-large', [
        toolUseRow({ sessionId: 'session-large', projectPath, timestamp: '2026-05-28T14:00:00.000Z', toolName: 'Edit', filePath: 'src/large.ts' }),
        fileHistorySnapshot({
          timestamp: '2026-05-28T14:00:01.000Z',
          trackedFileBackups: {
            'src/large.ts': { backupFileName: 'large@v1', version: 1, backupTime: '2026-05-28T14:00:01.000Z' },
          },
        }),
      ]);

      const result = await readSessionChangeReview(paths, projectSummary(projectPath), 'session-large');

      expect(result).not.toBeNull();
      expect(result!.files[0]).toMatchObject({
        filePath: 'src/large.ts',
        status: 'too-large',
        afterTruncated: true,
        diff: null,
      });
    } finally {
      await cleanup();
    }
  });

  test('does not read session backups when artifact scope is ambiguous across projects', async () => {
    const { paths, projectPath, home, cleanup } = await setup();
    try {
      const otherProjectPath = join(home, 'project-b');
      await mkdir(join(paths.projectsDir, encodeProjectPath(otherProjectPath)), { recursive: true });
      await writeFile(
        join(paths.projectsDir, encodeProjectPath(otherProjectPath), 'session-ambiguous.jsonl'),
        jsonl(toolUseRow({ sessionId: 'session-ambiguous', projectPath: otherProjectPath, timestamp: '2026-05-28T15:00:00.000Z', toolName: 'Edit', filePath: 'src/other.ts' })),
        'utf8',
      );
      await writeProjectFile(projectPath, 'src/api.ts', 'new content\n');
      await writeBackup(paths, 'session-ambiguous', 'api@v1', 'old content\n');
      await writeTranscript(paths, projectPath, 'session-ambiguous', [
        toolUseRow({ sessionId: 'session-ambiguous', projectPath, timestamp: '2026-05-28T15:00:00.000Z', toolName: 'Edit', filePath: 'src/api.ts' }),
        fileHistorySnapshot({
          timestamp: '2026-05-28T15:00:01.000Z',
          trackedFileBackups: {
            'src/api.ts': { backupFileName: 'api@v1', version: 1, backupTime: '2026-05-28T15:00:01.000Z' },
          },
        }),
      ]);

      const result = await readSessionChangeReview(paths, projectSummary(projectPath), 'session-ambiguous');

      expect(result).not.toBeNull();
      expect(result!.files[0]).toMatchObject({
        filePath: 'src/api.ts',
        status: 'missing-backup',
        backupExists: false,
        diff: null,
      });
      expect(result!.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ level: 'warn', message: expect.stringContaining('ambiguous across projects') }),
        ]),
      );
      expect(JSON.stringify(result)).not.toContain('old content');
    } finally {
      await cleanup();
    }
  });

  test('marks binary-looking content as binary without returning diff lines', async () => {
    const { paths, projectPath, cleanup } = await setup();
    try {
      await writeProjectFile(projectPath, 'assets/data.bin', 'after\u0000content\n');
      await writeBackup(paths, 'session-binary', 'data@v1', 'before\u0000content\n');
      await writeTranscript(paths, projectPath, 'session-binary', [
        toolUseRow({ sessionId: 'session-binary', projectPath, timestamp: '2026-05-28T15:30:00.000Z', toolName: 'Edit', filePath: 'assets/data.bin' }),
        fileHistorySnapshot({
          timestamp: '2026-05-28T15:30:01.000Z',
          trackedFileBackups: {
            'assets/data.bin': { backupFileName: 'data@v1', version: 1, backupTime: '2026-05-28T15:30:01.000Z' },
          },
        }),
      ]);

      const result = await readSessionChangeReview(paths, projectSummary(projectPath), 'session-binary');

      expect(result).not.toBeNull();
      expect(result!.files[0]).toMatchObject({
        filePath: 'assets/data.bin',
        status: 'binary',
        backupExists: true,
        diff: null,
      });
    } finally {
      await cleanup();
    }
  });

  test('does not follow symlinked current files or symlinked backup files', async () => {
    const { paths, projectPath, cleanup } = await setup();
    try {
      await mkdir(join(projectPath, 'src'), { recursive: true });
      await writeProjectFile(projectPath, 'src/target.ts', 'symlink target\n');
      await writeProjectFile(projectPath, 'src/current.ts', 'current content\n');
      await writeBackup(paths, 'session-symlink-current', 'current@v1', 'old content\n');
      await writeTranscript(paths, projectPath, 'session-symlink-current', [
        toolUseRow({ sessionId: 'session-symlink-current', projectPath, timestamp: '2026-05-28T16:00:00.000Z', toolName: 'Edit', filePath: 'src/link.ts' }),
        fileHistorySnapshot({
          timestamp: '2026-05-28T16:00:01.000Z',
          trackedFileBackups: {
            'src/link.ts': { backupFileName: 'current@v1', version: 1, backupTime: '2026-05-28T16:00:01.000Z' },
          },
        }),
      ]);
      await symlink(join(projectPath, 'src/target.ts'), join(projectPath, 'src/link.ts'));

      await mkdir(join(paths.fileHistoryDir, 'session-symlink-backup'), { recursive: true });
      await symlink(join(projectPath, 'src/target.ts'), join(paths.fileHistoryDir, 'session-symlink-backup', 'backup@v1'));
      await writeTranscript(paths, projectPath, 'session-symlink-backup', [
        toolUseRow({ sessionId: 'session-symlink-backup', projectPath, timestamp: '2026-05-28T17:00:00.000Z', toolName: 'Edit', filePath: 'src/current.ts' }),
        fileHistorySnapshot({
          timestamp: '2026-05-28T17:00:01.000Z',
          trackedFileBackups: {
            'src/current.ts': { backupFileName: 'backup@v1', version: 1, backupTime: '2026-05-28T17:00:01.000Z' },
          },
        }),
      ]);

      const currentResult = await readSessionChangeReview(paths, projectSummary(projectPath), 'session-symlink-current');
      const backupResult = await readSessionChangeReview(paths, projectSummary(projectPath), 'session-symlink-backup');

      expect(currentResult!.files[0]).toMatchObject({
        filePath: 'src/link.ts',
        status: 'missing-current',
        diff: null,
      });
      expect(currentResult!.files[0]!.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ message: expect.stringContaining('Symlinked files are not read') }),
        ]),
      );
      expect(backupResult!.files[0]).toMatchObject({
        filePath: 'src/current.ts',
        status: 'missing-backup',
        backupExists: false,
        diff: null,
      });
      expect(JSON.stringify(backupResult)).not.toContain('symlink target');
    } catch (error) {
      if (!isUnsupportedSymlinkError(error)) {
        throw error;
      }
    } finally {
      await cleanup();
    }
  });
});

async function setup() {
  const home = await mkdtemp(join(tmpdir(), 'ocs-change-review-'));
  const paths = createOpenClaudePaths({ home, env: {} });
  const projectPath = join(home, 'project-a');
  await mkdir(projectPath, { recursive: true });
  return {
    home,
    paths,
    projectPath,
    cleanup: () => rm(home, { recursive: true, force: true }),
  };
}

async function writeProjectFile(projectPath: string, relativePath: string, content: string): Promise<void> {
  const filePath = join(projectPath, relativePath);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf8');
}

async function writeBackup(paths: OpenClaudePaths, sessionId: string, backupFileName: string, content: string): Promise<void> {
  const sessionDir = join(paths.fileHistoryDir, sessionId);
  await mkdir(sessionDir, { recursive: true });
  await writeFile(join(sessionDir, backupFileName), content, 'utf8');
}

async function writeTranscript(
  paths: OpenClaudePaths,
  projectPath: string,
  sessionId: string,
  rows: unknown[],
): Promise<void> {
  const projectDir = join(paths.projectsDir, encodeProjectPath(projectPath));
  await mkdir(projectDir, { recursive: true });
  await writeFile(join(projectDir, `${sessionId}.jsonl`), rows.map(jsonl).join('\n'), 'utf8');
}

function toolUseRow(input: {
  sessionId: string;
  projectPath: string;
  timestamp: string;
  toolName: 'Edit' | 'MultiEdit' | 'NotebookEdit' | 'Write';
  filePath: string;
}) {
  return {
    type: 'assistant',
    sessionId: input.sessionId,
    timestamp: input.timestamp,
    cwd: input.projectPath,
    message: {
      role: 'assistant',
      model: 'claude-sonnet',
      content: [
        {
          type: 'tool_use',
          id: `${input.toolName}-${input.timestamp}`,
          name: input.toolName,
          input: { file_path: input.filePath },
        },
      ],
    },
  };
}

function fileHistorySnapshot(input: {
  timestamp: string;
  trackedFileBackups: Record<string, unknown>;
}) {
  return {
    type: 'file-history-snapshot',
    timestamp: input.timestamp,
    snapshot: {
      messageId: 'message-1',
      timestamp: input.timestamp,
      trackedFileBackups: input.trackedFileBackups,
    },
  };
}

function projectSummary(projectPath: string): ProjectSummary {
  return {
    id: 'project-1',
    name: 'project-a',
    path: projectPath,
    exists: true,
    active: true,
    branch: 'main',
    lastUpdated: 'just now',
    diagnostics: [],
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
      lastSessionId: null,
    },
  };
}

function jsonl(value: unknown): string {
  return JSON.stringify(value);
}
