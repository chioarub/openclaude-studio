import type { Stats } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

import type {
  Diagnostic,
  PlanDetailsResponse,
  PlanSummary,
  PlansResponse,
  ProjectSummary,
} from '@openclaude-studio/shared';

import { ApiError, invalidRequest } from '../http/errors.js';
import { type OpenClaudePaths } from './paths.js';
import { redactTextSecrets } from './redaction.js';
import { readBoundedTextFile } from './safeFile.js';
import {
  findTranscriptFilesForProject,
  parseTranscriptFilesForProject,
  type ParsedTranscriptEntry,
} from './sessions.js';

const PLAN_MAX_BYTES = 512 * 1024;
const PLAN_PREVIEW_MAX_BYTES = 64 * 1024;

export async function listProjectPlans(
  paths: OpenClaudePaths,
  project: Pick<ProjectSummary, 'id' | 'name' | 'path' | 'exists'>,
): Promise<PlansResponse> {
  const diagnostics: Diagnostic[] = [];
  const exists = await directoryExists(paths.plansDir);

  if (!exists) {
    diagnostics.push({
      level: 'info',
      message: 'Plans directory does not exist yet.',
      path: paths.plansDir,
    });
  }

  const sessionRefs = await buildPlanSessionMap(paths, project.path);
  const plans: PlanSummary[] = [];

  if (exists) {
    const linkedFiles = await linkedPlanFiles(paths.plansDir, new Set(sessionRefs.keys()));
    diagnostics.push(...linkedFiles.diagnostics);

    for (const id of linkedFiles.ids) {
      const sessions = sessionRefs.get(id);
      if (!sessions) continue;
      const result = await summarizeReferencedPlan(paths.plansDir, id, sessions);
      diagnostics.push(...result.diagnostics);
      if (result.plan) {
        plans.push(result.plan);
      }
    }
  }

  plans.sort(comparePlans);

  return {
    project: { id: project.id, name: project.name, path: project.path, exists: project.exists },
    plansDir: paths.plansDir,
    exists,
    plans,
    diagnostics,
  };
}

export async function readProjectPlan(
  paths: OpenClaudePaths,
  project: Pick<ProjectSummary, 'id' | 'name' | 'path' | 'exists'>,
  planId: string,
): Promise<PlanDetailsResponse> {
  const planPath = safePlanPath(paths.plansDir, planId);
  if (!planPath) {
    throw invalidRequest('Invalid plan ID.');
  }

  const sessionRefs = await buildPlanSessionMap(paths, project.path);
  const sessions = sessionRefs.get(planId);
  if (!sessions) {
    throw planNotFound(planPath);
  }

  const exists = await directoryExists(paths.plansDir);
  if (!exists) {
    throw planNotFound(planPath);
  }

  if (await unsafeExistingPlanPath(planPath)) {
    throw planNotFound(planPath);
  }

  const file = await readBoundedTextFile(planPath, { maxBytes: PLAN_MAX_BYTES });
  if (!file.exists) {
    throw planNotFound(planPath);
  }

  let stat: Stats;
  try {
    stat = await lstat(planPath);
  } catch (error) {
    if (isNodeFileError(error, 'ENOENT')) {
      throw planNotFound(planPath);
    }
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw planNotFound(planPath);
  }
  const content = file.content;
  const checklist = summarizeChecklist(content);

  const plan: PlanSummary & { content: string } = {
    id: planId,
    title: markdownTitle(content) ?? planId,
    exists: true,
    modifiedAt: stat.mtime.toISOString(),
    sizeBytes: stat.size,
    wordCount: wordCount(content),
    lineCount: content.length === 0 ? 0 : content.split(/\r?\n/).length,
    preview: markdownPreview(content),
    checklist,
    sessionIds: sessions.map((s) => s.id),
    sessions,
    latestSessionAt: sessions[0]?.lastTimestamp ?? null,
    content: redactTextSecrets(content),
  };

  return { plan, diagnostics: file.diagnostics };
}

// --- Internal helpers ---

type SessionRef = {
  id: string;
  title: string;
  lastTimestamp: string;
};

type PlanRead = {
  plan: PlanSummary | null;
  diagnostics: Diagnostic[];
};

async function summarizeReferencedPlan(
  plansDir: string,
  id: string,
  sessions: SessionRef[],
): Promise<PlanRead> {
  const path = safePlanPath(plansDir, id);
  if (!path) return { plan: null, diagnostics: [] };

  if (await unsafeExistingPlanPath(path)) {
    return {
      plan: null,
      diagnostics: [
        {
          level: 'warn',
          message: 'Referenced plan path exists but is not a regular readable file.',
          path,
        },
      ],
    };
  }

  try {
    const summary = await summarizePlanFile(path, id, sessions);
    if (summary) return summary;

    return { plan: null, diagnostics: [] };
  } catch (error) {
    if (isNodeFileError(error, 'ENOENT')) {
      return { plan: null, diagnostics: [] };
    }
    return {
      plan: null,
      diagnostics: [{ level: 'warn', message: 'Referenced plan could not be read.', path }],
    };
  }
}

async function summarizePlanFile(
  path: string,
  id: string,
  sessions: SessionRef[],
): Promise<PlanRead | null> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) return null;

  const file = await readBoundedTextFile(path, { maxBytes: PLAN_PREVIEW_MAX_BYTES });
  if (!file.exists) return null;

  const content = file.content;
  return {
    plan: {
      id,
      title: markdownTitle(content) ?? id,
      exists: true,
      modifiedAt: stat.mtime.toISOString(),
      sizeBytes: stat.size,
      wordCount: wordCount(content),
      lineCount: content.length === 0 ? 0 : content.split(/\r?\n/).length,
      preview: markdownPreview(content),
      checklist: summarizeChecklist(content),
      sessionIds: sessions.map((s) => s.id),
      sessions,
      latestSessionAt: sessions[0]?.lastTimestamp ?? null,
    },
    diagnostics: file.diagnostics,
  };
}

async function unsafeExistingPlanPath(path: string): Promise<boolean> {
  try {
    const stat = await lstat(path);
    return !stat.isFile() || stat.isSymbolicLink();
  } catch (error) {
    if (isNodeFileError(error, 'ENOENT')) return false;
    throw error;
  }
}

async function linkedPlanFiles(
  plansDir: string,
  referencedIds: Set<string>,
): Promise<{ ids: string[]; diagnostics: Diagnostic[] }> {
  if (referencedIds.size === 0) return { ids: [], diagnostics: [] };

  let entries;
  try {
    entries = await readdir(plansDir, { withFileTypes: true });
  } catch {
    return { ids: [], diagnostics: [] };
  }

  const ids: string[] = [];
  const diagnostics: Diagnostic[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.') || !entry.name.endsWith('.md')) continue;

    const id = entry.name.slice(0, -'.md'.length);
    if (!referencedIds.has(id) || !isSafePlanSlug(id)) continue;

    if (entry.isFile() && !entry.isSymbolicLink()) {
      ids.push(id);
      continue;
    }

    diagnostics.push(diagnostic(
      'warn',
      'Referenced plan path exists but is not a regular readable file.',
      safePlanPath(plansDir, id) ?? undefined,
    ));
  }

  return { ids: ids.sort((left, right) => left.localeCompare(right)), diagnostics };
}

async function buildPlanSessionMap(
  paths: OpenClaudePaths,
  projectPath: string,
): Promise<Map<string, SessionRef[]>> {
  const map = new Map<string, SessionRef[]>();

  let files: string[];
  try {
    files = await findTranscriptFilesForProject(paths.projectsDir, projectPath);
  } catch {
    return map;
  }

  let entries: ParsedTranscriptEntry[];
  try {
    entries = await parseTranscriptFilesForProject(files, projectPath);
  } catch {
    return map;
  }

  const entriesBySession = new Map<string, ParsedTranscriptEntry[]>();
  for (const entry of entries) {
    const rows = entriesBySession.get(entry.sessionId) ?? [];
    rows.push(entry);
    entriesBySession.set(entry.sessionId, rows);
  }

  for (const [sessionId, entries] of entriesBySession) {
    const sortedEntries = entries.slice().sort((left, right) => left.timestamp.localeCompare(right.timestamp));
    const slugs = new Set<string>();

    for (const entry of sortedEntries) {
      if (entry.slug && isSafePlanSlug(entry.slug)) {
        slugs.add(entry.slug);
      }
    }

    const lastTs = sortedEntries.at(-1)?.timestamp ?? new Date(0).toISOString();
    const title = sessionTitle(sortedEntries, sessionId);

    for (const slug of slugs) {
      const refs = map.get(slug) ?? [];
      const existing = refs.find((ref) => ref.id === sessionId);
      if (existing) {
        existing.lastTimestamp = lastTs;
      } else {
        refs.push({ id: sessionId, title, lastTimestamp: lastTs });
      }
      map.set(slug, refs);
    }
  }

  for (const [, refs] of map) {
    refs.sort((a, b) => b.lastTimestamp.localeCompare(a.lastTimestamp));
  }

  return map;
}

function sessionTitle(entries: ParsedTranscriptEntry[], sessionId: string): string {
  const explicitTitle = entries.map((entry) => entry.title).find((title): title is string => Boolean(title));
  const userTitle = entries
    .filter((entry) => entry.role === 'user')
    .map((entry) => redactTextSecrets(entry.text?.replace(/\s+/g, ' ').trim() ?? ''))
    .find((title) => title.length > 0);

  return truncateText(explicitTitle ?? userTitle ?? `Session ${sessionId.slice(0, 8)}`, 80);
}

function summarizeChecklist(content: string): { total: number; completed: number; pending: number } {
  let total = 0;
  let completed = 0;
  for (const line of content.split(/\r?\n/)) {
    const match = /^\s*[-*]\s+\[([ xX])\]\s+/.exec(line);
    if (!match) continue;
    total += 1;
    if ((match[1] ?? '').toLowerCase() === 'x') completed += 1;
  }
  return { total, completed, pending: total - completed };
}

function markdownTitle(content: string): string | null {
  for (const line of content.split(/\r?\n/)) {
    const match = /^#\s+(.+?)\s*$/.exec(line);
    if (match?.[1]) return truncateText(redactTextSecrets(match[1]), 140);
  }
  return null;
}

function markdownPreview(content: string): string {
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || /^#{1,6}\s+/.test(trimmed) || /^\s*[-*]\s+\[[ xX]\]\s+/.test(trimmed)) continue;
    return truncateText(redactTextSecrets(trimmed), 260);
  }
  return truncateText(redactTextSecrets(content.trim().replace(/\s+/g, ' ')), 260);
}

function wordCount(content: string): number {
  const words = content.trim().match(/\S+/g);
  return words ? words.length : 0;
}

function truncateText(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + '\u2026';
}

function comparePlans(left: PlanSummary, right: PlanSummary): number {
  if (left.latestSessionAt && right.latestSessionAt && left.latestSessionAt !== right.latestSessionAt) {
    return right.latestSessionAt.localeCompare(left.latestSessionAt);
  }
  if (left.latestSessionAt && !right.latestSessionAt) return -1;
  if (!left.latestSessionAt && right.latestSessionAt) return 1;
  if (left.exists !== right.exists) return left.exists ? -1 : 1;
  return right.modifiedAt.localeCompare(left.modifiedAt) || left.title.localeCompare(right.title);
}

function planNotFound(path?: string): ApiError {
  return new ApiError(404, 'PLAN_NOT_FOUND', 'Plan not found', [
    diagnostic('error', 'Plan not found for the selected project.', path),
  ]);
}

function isNodeFileError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}

function diagnostic(level: Diagnostic['level'], message: string, path?: string): Diagnostic {
  return path ? { level, message, path } : { level, message };
}

function isSafePlanSlug(slug: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(slug) && !slug.includes('..');
}

function safePlanPath(plansDir: string, planId: string): string | null {
  if (!isSafePlanSlug(planId)) return null;
  const root = resolve(plansDir);
  const path = resolve(root, `${planId}.md`);
  if (path === root || !path.startsWith(`${root}${sep}`)) return null;
  return path;
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    const stat = await lstat(path);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}
