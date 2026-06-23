import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';

export type PathOptions = {
  home?: string;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  existsSync?: (path: string) => boolean;
};

export type OpenClaudePaths = ReturnType<typeof createOpenClaudePaths>;

/**
 * Which environment variable (or default) provided the OpenClaude config root.
 * Mirrors upstream OpenClaude precedence.
 */
export type ConfigDirSource = 'openclaude' | 'legacy' | 'default';

/**
 * Non-sensitive metadata describing how the OpenClaude config root was chosen.
 * Suitable for diagnostics; contains no path values.
 */
export type ConfigDirResolution = {
  source: ConfigDirSource;
  conflict: boolean;
  legacyFilenameFallback: boolean;
};

const PREFERRED_CONFIG_DIR_ENV = 'OPENCLAUDE_CONFIG_DIR';
const LEGACY_CONFIG_DIR_ENV = 'CLAUDE_CONFIG_DIR';

/**
 * Resolves which value (preferred or legacy) to use for the OpenClaude config
 * root, mirroring upstream OpenClaude precedence.
 *
 * Rules:
 * - `OPENCLAUDE_CONFIG_DIR` is preferred over the legacy `CLAUDE_CONFIG_DIR`.
 * - Empty or whitespace-only values are treated as unset.
 * - When both are set and differ, the preferred variable wins.
 *
 * Exported for tests. Returns `undefined` when neither variable is set.
 */
export function resolveConfigDirEnv(env: {
  openClaudeConfigDir?: string;
  legacyConfigDir?: string;
}): string | undefined {
  const open = env.openClaudeConfigDir?.trim() || undefined;
  const legacy = env.legacyConfigDir?.trim() || undefined;
  return open || legacy || undefined;
}

/**
 * Resolves the OpenClaude home directory and the global config file path.
 *
 * The global config file lives inside the resolved home directory when an
 * override is set, matching upstream OpenClaude's `getGlobalClaudeFile()`:
 *
 * - With an explicit config dir, prefer `"<dir>/.openclaude.json"`. If that
 *   file is missing and `"<dir>/.claude.json"` exists, fall back to the legacy
 *   filename (upstream keeps this fallback for opt-out-of-migration users).
 * - Additionally, if `"<dir>/.config.json"` exists inside an explicit config
 *   dir, it wins over both the new and legacy filenames — matching upstream's
 *   oldest-format fallback.
 * - With no override, the global config file is `"<home>/.openclaude.json"`.
 *
 * No filesystem writes. `existsSync` is used only to pick between filenames
 * when an override is set; it is never used to authorize reads.
 */
export function resolveOpenClaudeConfigDir(options: {
  home: string;
  env: NodeJS.ProcessEnv | Record<string, string | undefined>;
  existsSync?: (path: string) => boolean;
}): {
  openClaudeHome: string;
  openClaudeConfig: string;
  source: ConfigDirSource;
  conflict: boolean;
  legacyFilenameFallback: boolean;
} {
  const home = options.home;
  const env = options.env;
  const exists = options.existsSync ?? ((path: string) => existsSync(path));

  const preferred = env[PREFERRED_CONFIG_DIR_ENV]?.trim() || undefined;
  const legacy = env[LEGACY_CONFIG_DIR_ENV]?.trim() || undefined;
  const conflict = Boolean(preferred && legacy && preferred !== legacy);

  const selected = preferred ?? legacy;
  const source: ConfigDirSource = preferred
    ? 'openclaude'
    : legacy
      ? 'legacy'
      : 'default';

  const openClaudeHome = (
    selected
      ? selected.normalize('NFC')
      : join(home, '.openclaude')
  ).normalize('NFC');

  let openClaudeConfig: string;
  let legacyFilenameFallback = false;

  if (selected) {
    const normalized = selected.normalize('NFC');
    const openClaudeJson = join(normalized, '.openclaude.json');
    const claudeJson = join(normalized, '.claude.json');
    const configJson = join(normalized, '.config.json');

    // Oldest upstream fallback wins when the newer files are absent.
    if (!exists(openClaudeJson) && exists(configJson)) {
      openClaudeConfig = configJson;
      legacyFilenameFallback = true;
    } else if (!exists(openClaudeJson) && exists(claudeJson)) {
      openClaudeConfig = claudeJson;
      legacyFilenameFallback = true;
    } else {
      openClaudeConfig = openClaudeJson;
    }
  } else {
    openClaudeConfig = join(home, '.openclaude.json');
  }

  return {
    openClaudeHome,
    openClaudeConfig,
    source,
    conflict,
    legacyFilenameFallback,
  };
}

export function createOpenClaudePaths(options: PathOptions = {}) {
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;

  const resolution = resolveOpenClaudeConfigDir({
    home,
    env,
    ...(options.existsSync ? { existsSync: options.existsSync } : {}),
  });

  const openClaudeHome = resolution.openClaudeHome;

  return {
    home,
    openClaudeHome,
    openClaudeConfig: resolution.openClaudeConfig,
    configDirResolution: {
      source: resolution.source,
      conflict: resolution.conflict,
      legacyFilenameFallback: resolution.legacyFilenameFallback,
    } satisfies ConfigDirResolution,
    projectsDir: join(openClaudeHome, 'projects'),
    debugDir: join(openClaudeHome, 'debug'),
    sessionsDir: join(openClaudeHome, 'sessions'),
    statsCache: join(openClaudeHome, 'stats-cache.json'),
    tasksDir: join(openClaudeHome, 'tasks'),
    plansDir: join(openClaudeHome, 'plans'),
    fileHistoryDir: join(openClaudeHome, 'file-history'),
    projectSettings(projectPath: string) {
      const base = join(resolve(projectPath), '.openclaude');
      return {
        projectSettings: join(base, 'settings.json'),
        localSettings: join(base, 'settings.local.json'),
      };
    },
  };
}

export function encodeProjectPath(projectPath: string): string {
  return resolve(projectPath).replace(/[^a-zA-Z0-9]/g, '-');
}

export function isProjectTranscriptDirectoryName(projectPath: string, directoryName: string): boolean {
  const encodedProjectPath = encodeProjectPath(projectPath);
  return (
    directoryName === encodedProjectPath ||
    directoryName.startsWith(`${encodedProjectPath}--claude-worktrees-`)
  );
}

export function isProjectTranscriptCwd(projectPath: string, cwd: string): boolean {
  const resolvedProjectPath = resolve(projectPath);
  const resolvedCwd = resolve(cwd);
  return isSameOrChildPath(resolvedCwd, resolvedProjectPath);
}

function isSameOrChildPath(candidate: string, parent: string): boolean {
  const parentPrefix = parent.endsWith(sep) ? parent : `${parent}${sep}`;
  return candidate === parent || candidate.startsWith(parentPrefix);
}
