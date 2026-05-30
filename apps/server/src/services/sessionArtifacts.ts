import { lstat, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { encodeProjectPath } from './paths.js';
import { readBoundedTextFile } from './safeFile.js';

const ARTIFACT_SCOPE_SCAN_MAX_DEPTH = 10;
const TRANSCRIPT_SCAN_MAX_BYTES = 10 * 1024 * 1024;

export async function isUnambiguousSessionArtifactScope(
  projectsDir: string,
  projectPath: string,
  sessionId: string,
): Promise<boolean> {
  if (!isSafeSessionScopedArtifactId(sessionId)) {
    return false;
  }

  const selectedProjectDir = resolve(join(projectsDir, encodeProjectPath(projectPath)));
  let entries;
  try {
    entries = await readdir(projectsDir, { withFileTypes: true });
  } catch (error) {
    if (isNodeFileError(error, 'ENOENT') || isNodeFileError(error, 'ENOTDIR')) {
      return true;
    }
    throw error;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const candidateDir = join(projectsDir, entry.name);
    const stats = await safeLstat(candidateDir);
    if (!stats || !stats.isDirectory() || stats.isSymbolicLink()) {
      continue;
    }
    if (resolve(candidateDir) === selectedProjectDir) {
      continue;
    }
    if (await directoryContainsSessionTranscript(candidateDir, sessionId, 0)) {
      return false;
    }
  }

  return true;
}

export async function findAmbiguousSessionArtifactIds(
  projectsDir: string,
  projectPath: string,
  sessionIds: Iterable<string>,
  options: { scanTranscriptContent?: boolean } = {},
): Promise<Set<string>> {
  const remaining = new Set([...sessionIds].filter(isSafeSessionScopedArtifactId));
  const ambiguous = new Set<string>();
  if (remaining.size === 0) {
    return ambiguous;
  }

  const selectedProjectDir = resolve(join(projectsDir, encodeProjectPath(projectPath)));
  let entries;
  try {
    entries = await readdir(projectsDir, { withFileTypes: true });
  } catch (error) {
    if (isNodeFileError(error, 'ENOENT') || isNodeFileError(error, 'ENOTDIR')) {
      return ambiguous;
    }
    throw error;
  }

  for (const entry of entries) {
    if (remaining.size === 0) {
      break;
    }
    if (!entry.isDirectory()) {
      continue;
    }

    const candidateDir = join(projectsDir, entry.name);
    const stats = await safeLstat(candidateDir);
    if (!stats || !stats.isDirectory() || stats.isSymbolicLink()) {
      continue;
    }
    if (resolve(candidateDir) === selectedProjectDir) {
      continue;
    }

    await collectSessionTranscripts(candidateDir, remaining, ambiguous, 0, options);
  }

  return ambiguous;
}

function isSafeSessionScopedArtifactId(value: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(value) && !value.includes('..');
}

async function directoryContainsSessionTranscript(root: string, sessionId: string, depth: number): Promise<boolean> {
  if (depth > ARTIFACT_SCOPE_SCAN_MAX_DEPTH) {
    return true;
  }

  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return false;
  }

  for (const entry of entries) {
    const entryPath = join(root, entry.name);
    const stats = await safeLstat(entryPath);
    if (!stats || stats.isSymbolicLink()) {
      continue;
    }

    if (stats.isDirectory()) {
      if (await directoryContainsSessionTranscript(entryPath, sessionId, depth + 1)) {
        return true;
      }
      continue;
    }

    if (!stats.isFile() || !entry.name.endsWith('.jsonl')) {
      continue;
    }
    if (entry.name === `${sessionId}.jsonl` || await transcriptFileContainsSessionId(entryPath, sessionId)) {
      return true;
    }
  }

  return false;
}

async function collectSessionTranscripts(
  root: string,
  remaining: Set<string>,
  ambiguous: Set<string>,
  depth: number,
  options: { scanTranscriptContent?: boolean },
): Promise<void> {
  if (remaining.size === 0) {
    return;
  }
  if (depth > ARTIFACT_SCOPE_SCAN_MAX_DEPTH) {
    for (const sessionId of remaining) {
      ambiguous.add(sessionId);
    }
    remaining.clear();
    return;
  }

  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (remaining.size === 0) {
      return;
    }

    const entryPath = join(root, entry.name);
    const stats = await safeLstat(entryPath);
    if (!stats || stats.isSymbolicLink()) {
      continue;
    }

    if (stats.isDirectory()) {
      await collectSessionTranscripts(entryPath, remaining, ambiguous, depth + 1, options);
      continue;
    }

    if (!stats.isFile() || !entry.name.endsWith('.jsonl')) {
      continue;
    }

    const fileSessionId = entry.name.slice(0, -'.jsonl'.length);
    if (remaining.has(fileSessionId)) {
      ambiguous.add(fileSessionId);
      remaining.delete(fileSessionId);
      continue;
    }

    if (options.scanTranscriptContent === false) {
      continue;
    }

    const containedIds = await transcriptFileSessionIdsInSet(entryPath, remaining);
    for (const sessionId of containedIds) {
      ambiguous.add(sessionId);
      remaining.delete(sessionId);
    }
  }
}

async function transcriptFileContainsSessionId(filePath: string, sessionId: string): Promise<boolean> {
  try {
    const file = await readBoundedTextFile(filePath, { maxBytes: TRANSCRIPT_SCAN_MAX_BYTES });
    if (!file.exists) {
      return false;
    }
    if (!file.content.includes(sessionId)) {
      return false;
    }

    for (const line of file.content.split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }
      try {
        const parsed = JSON.parse(line) as unknown;
        if (isRecord(parsed) && parsed.sessionId === sessionId) {
          return true;
        }
      } catch {
        continue;
      }
    }
  } catch {
    return false;
  }

  return false;
}

async function transcriptFileSessionIdsInSet(filePath: string, sessionIds: Set<string>): Promise<Set<string>> {
  const found = new Set<string>();
  if (sessionIds.size === 0) {
    return found;
  }

  try {
    const file = await readBoundedTextFile(filePath, { maxBytes: TRANSCRIPT_SCAN_MAX_BYTES });
    if (!file.exists) {
      return found;
    }
    const candidateIds = [...sessionIds].filter((sessionId) => file.content.includes(sessionId));
    if (candidateIds.length === 0) {
      return found;
    }
    const candidateSet = new Set(candidateIds);

    for (const line of file.content.split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }
      try {
        const parsed = JSON.parse(line) as unknown;
        if (isRecord(parsed) && typeof parsed.sessionId === 'string' && candidateSet.has(parsed.sessionId)) {
          found.add(parsed.sessionId);
          if (found.size === candidateSet.size) {
            return found;
          }
        }
      } catch {
        continue;
      }
    }
  } catch {
    return found;
  }

  return found;
}

async function safeLstat(path: string) {
  try {
    return await lstat(path);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNodeFileError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}
