import { createHash } from 'node:crypto';
import { lstat, readFile, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

import type { Diagnostic, ProjectSummary, ProviderSummary } from '@openclaude-studio/shared';

import { redactSecrets, redactUrl } from './redaction.js';
import { readBoundedTextFile } from './safeFile.js';
import type { OpenClaudePaths } from './paths.js';

type UnknownRecord = Record<string, unknown>;

type OpenClaudeProjectConfig = {
  exampleFilesGeneratedAt?: unknown;
  lastCost?: unknown;
  lastGracefulShutdown?: unknown;
  lastSessionId?: unknown;
  lastTotalCacheCreationInputTokens?: unknown;
  lastTotalCacheReadInputTokens?: unknown;
  lastTotalInputTokens?: unknown;
  lastTotalOutputTokens?: unknown;
};

type OpenClaudeConfig = {
  activeProviderProfileId?: unknown;
  projects?: unknown;
  providerProfiles?: unknown;
};

export type OpenClaudeConfigResponse = {
  path: string;
  exists: boolean;
  config: UnknownRecord;
  diagnostics: Diagnostic[];
  sensitiveFieldsRedacted: true;
};

export type ProjectSummariesResponse = {
  projects: ProjectSummary[];
  diagnostics: Diagnostic[];
};

type RawConfigRead = {
  path: string;
  exists: boolean;
  config: OpenClaudeConfig;
  diagnostics: Diagnostic[];
};

const maxConfigBytes = 5 * 1024 * 1024;

export async function readOpenClaudeConfig(
  paths: OpenClaudePaths,
): Promise<OpenClaudeConfigResponse> {
  const result = await readRawOpenClaudeConfig(paths);

  return {
    ...result,
    config: redactSecrets(result.config as UnknownRecord),
    sensitiveFieldsRedacted: true,
  };
}

export async function readProjectSummaries(
  paths: OpenClaudePaths,
  now = new Date(),
): Promise<ProjectSummary[]> {
  return (await readProjectSummariesWithDiagnostics(paths, now)).projects;
}

export async function readProjectSummariesWithDiagnostics(
  paths: OpenClaudePaths,
  now = new Date(),
): Promise<ProjectSummariesResponse> {
  const { config, diagnostics } = await readRawOpenClaudeConfig(paths);
  return {
    projects: await projectSummariesFromConfig(config, now),
    diagnostics,
  };
}

async function projectSummariesFromConfig(
  config: OpenClaudeConfig,
  now: Date,
): Promise<ProjectSummary[]> {
  const entries = getProjectEntries(config);
  const latestTimestamp = Math.max(
    0,
    ...entries.map(([, projectConfig]) => timestampFromProjectConfig(projectConfig) ?? 0),
  );
  const projects = await Promise.all(
    entries.map(async ([projectPath, projectConfig]) => {
      const resolvedPath = resolve(projectPath);
      const exists = await isExistingDirectory(resolvedPath);
      const lastUsedTimestamp =
        timestampFromProjectConfig(projectConfig) ?? (exists ? await pathTimestamp(resolvedPath) : null);
      const diagnostics: Diagnostic[] = exists
        ? []
        : [{ level: 'error', message: 'Project path does not exist.', path: resolvedPath }];

      return {
        project: {
          id: makeProjectId(resolvedPath),
          name: basename(resolvedPath) || resolvedPath,
          path: resolvedPath,
          exists,
          active: lastUsedTimestamp !== null && lastUsedTimestamp === latestTimestamp,
          branch: exists ? await readProjectBranch(resolvedPath) : 'missing',
          lastUpdated: formatRelative(lastUsedTimestamp, now),
          diagnostics,
          usage: readProjectUsage(projectConfig),
        } satisfies ProjectSummary,
        lastUsedTimestamp,
      };
    }),
  );

  return projects.sort((left, right) => {
    if (left.project.active !== right.project.active) return left.project.active ? -1 : 1;
    return (right.lastUsedTimestamp ?? 0) - (left.lastUsedTimestamp ?? 0);
  }).map(({ project }) => project);
}

export async function readProviderSummaries(paths: OpenClaudePaths): Promise<ProviderSummary[]> {
  const { config } = await readRawOpenClaudeConfig(paths);
  return toProviderSummaries(config);
}

export async function readActiveProvider(paths: OpenClaudePaths): Promise<{
  provider: ProviderSummary | null;
  diagnostics: Diagnostic[];
}> {
  const { config, diagnostics: configDiagnostics } = await readRawOpenClaudeConfig(paths);
  const profiles = getProviderProfiles(config);
  const providers = toProviderSummaries(config);
  const configuredActiveId = stringFromUnknown(config.activeProviderProfileId);
  const selectedActiveId = selectActiveProviderId(config, profiles);
  const diagnostics: Diagnostic[] = [...configDiagnostics];

  if (profiles.length === 0) {
    diagnostics.push({ level: 'warn', message: 'No provider profiles are configured.' });
  } else if (!configuredActiveId) {
    diagnostics.push({
      level: 'warn',
      message: 'No active provider profile is configured; using the first provider profile.',
    });
  } else if (configuredActiveId !== selectedActiveId) {
    diagnostics.push({
      level: 'warn',
      message: 'Configured active provider profile was not found; using the first provider profile.',
    });
  }

  return {
    provider: providers.find((provider) => provider.active) ?? null,
    diagnostics,
  };
}

function toProviderSummaries(config: OpenClaudeConfig): ProviderSummary[] {
  const profiles = getProviderProfiles(config);
  const selectedActiveId = selectActiveProviderId(config, profiles);

  return profiles.map((profile, index) => {
    const id = stringFromUnknown(profile.id) ?? makeFallbackProviderId(profile, index);
    const name = stringFromUnknown(profile.name) ?? 'Unnamed provider';

    return {
      id,
      name,
      provider: stringFromUnknown(profile.provider) ?? 'unknown',
      model: stringFromUnknown(profile.model) ?? 'default',
      baseUrl: redactUrl(stringFromUnknown(profile.baseUrl)),
      active: id === selectedActiveId,
      apiKeySet: hasNonEmptyString(profile.apiKey),
      authHeaderValueSet: hasNonEmptyString(profile.authHeaderValue),
    } satisfies ProviderSummary;
  });
}

async function readRawOpenClaudeConfig(paths: OpenClaudePaths): Promise<RawConfigRead> {
  const result = await readBoundedTextFile(paths.openClaudeConfig, { maxBytes: maxConfigBytes });
  const diagnostics = [...result.diagnostics];

  if (!result.exists) {
    return { path: result.path, exists: false, config: {}, diagnostics };
  }

  if (result.truncated) {
    diagnostics.push({
      level: 'error',
      message: `Global config exceeds the ${maxConfigBytes} byte read limit.`,
      path: result.path,
    });
    return { path: result.path, exists: true, config: {}, diagnostics };
  }

  try {
    const parsed = JSON.parse(result.content) as unknown;
    if (!isRecord(parsed)) {
      diagnostics.push({
        level: 'error',
        message: 'Global config must be a JSON object.',
        path: result.path,
      });
      return { path: result.path, exists: true, config: {}, diagnostics };
    }

    return { path: result.path, exists: true, config: parsed as OpenClaudeConfig, diagnostics };
  } catch (error) {
    diagnostics.push({
      level: 'error',
      message: `Unable to parse global config: ${errorMessage(error)}`,
      path: result.path,
    });
    return { path: result.path, exists: true, config: {}, diagnostics };
  }
}

function getProjectEntries(config: OpenClaudeConfig): Array<[string, OpenClaudeProjectConfig]> {
  if (!isRecord(config.projects)) {
    return [];
  }

  return Object.entries(config.projects)
    .filter((entry): entry is [string, OpenClaudeProjectConfig] => {
      const [projectPath, projectConfig] = entry;
      return projectPath.length > 0 && isRecord(projectConfig);
    })
    .sort(([left], [right]) => left.localeCompare(right));
}

function getProviderProfiles(config: OpenClaudeConfig): UnknownRecord[] {
  return Array.isArray(config.providerProfiles) ? config.providerProfiles.filter(isRecord) : [];
}

function selectActiveProviderId(config: OpenClaudeConfig, profiles: UnknownRecord[]): string | null {
  if (profiles.length === 0) {
    return null;
  }

  const activeId = stringFromUnknown(config.activeProviderProfileId);
  if (
    activeId &&
    profiles.some(
      (profile, index) =>
        (stringFromUnknown(profile.id) ?? makeFallbackProviderId(profile, index)) === activeId,
    )
  ) {
    return activeId;
  }

  return stringFromUnknown(profiles[0]?.id) ?? makeFallbackProviderId(profiles[0] ?? {}, 0);
}

function readProjectUsage(config: OpenClaudeProjectConfig): ProjectSummary['usage'] {
  return {
    inputTokens: intFromUnknown(config.lastTotalInputTokens),
    outputTokens: intFromUnknown(config.lastTotalOutputTokens),
    cacheReadTokens: intFromUnknown(config.lastTotalCacheReadInputTokens),
    cacheWriteTokens: intFromUnknown(config.lastTotalCacheCreationInputTokens),
    costUsd: numberFromUnknown(config.lastCost),
    lastSessionId: stringFromUnknown(config.lastSessionId),
  };
}

async function readProjectBranch(projectPath: string): Promise<string> {
  const gitRoot = await findGitRoot(projectPath);
  if (!gitRoot) {
    return 'no git';
  }

  try {
    const head = await readGitHead(gitRoot);
    const match = head.match(/^ref: refs\/heads\/(.+)$/);
    return match?.[1] ?? head.slice(0, 7);
  } catch {
    return 'unknown';
  }
}

async function findGitRoot(startPath: string): Promise<string | null> {
  let current = (await stat(startPath)).isDirectory() ? startPath : dirname(startPath);

  while (true) {
    try {
      await lstat(join(current, '.git'));
      return current;
    } catch (error) {
      if (!isNodeFileError(error, 'ENOENT')) {
        throw error;
      }
    }

    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

async function readGitHead(gitRoot: string): Promise<string> {
  const gitPath = join(gitRoot, '.git');
  const stats = await lstat(gitPath);

  if (stats.isDirectory()) {
    return (await readFile(join(gitPath, 'HEAD'), 'utf8')).trim();
  }

  if (stats.isFile()) {
    const gitFile = (await readFile(gitPath, 'utf8')).trim();
    const match = gitFile.match(/^gitdir:\s*(.+)$/);
    if (!match?.[1]) {
      throw new Error('Unsupported .git file format');
    }
    return (await readFile(join(resolve(gitRoot, match[1].trim()), 'HEAD'), 'utf8')).trim();
  }

  throw new Error('Unsupported .git path');
}

async function isExistingDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if (isNodeFileError(error, 'ENOENT')) {
      return false;
    }
    throw error;
  }
}

async function pathTimestamp(path: string): Promise<number | null> {
  try {
    const stats = await stat(path);
    return Number.isFinite(stats.mtimeMs) ? stats.mtimeMs : null;
  } catch (error) {
    if (isNodeFileError(error, 'ENOENT')) {
      return null;
    }
    throw error;
  }
}

function timestampFromProjectConfig(config: OpenClaudeProjectConfig): number | null {
  return (
    timestampFromUnknown(config.lastGracefulShutdown) ??
    timestampFromUnknown(config.exampleFilesGeneratedAt)
  );
}

function timestampFromUnknown(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function formatRelative(timestamp: number | null, now: Date): string {
  if (!timestamp || !Number.isFinite(timestamp)) {
    return 'never';
  }

  const delta = Math.max(0, now.getTime() - timestamp);
  const minutes = Math.floor(delta / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;

  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;

  return new Date(timestamp).toISOString().slice(0, 10);
}

export function makeProjectId(projectPath: string): string {
  return `project_${createHash('sha256').update(resolve(projectPath)).digest('hex').slice(0, 12)}`;
}

function makeFallbackProviderId(profile: UnknownRecord, index: number): string {
  const stableInput = [
    stringFromUnknown(profile.name) ?? 'provider',
    stringFromUnknown(profile.provider) ?? 'unknown',
    stringFromUnknown(profile.model) ?? 'default',
    String(index),
  ].join(':');
  return `provider_${createHash('sha256').update(stableInput).digest('hex').slice(0, 12)}`;
}

function intFromUnknown(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function numberFromUnknown(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function stringFromUnknown(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function hasNonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0;
}

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNodeFileError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
