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
  legacyDirectoryFallback: boolean;
};

const PREFERRED_CONFIG_DIR_ENV = 'OPENCLAUDE_CONFIG_DIR';
const LEGACY_CONFIG_DIR_ENV = 'CLAUDE_CONFIG_DIR';

/**
 * Resolves which value (preferred or legacy) to use for the OpenClaude config
 * root, mirroring upstream OpenClaude precedence.
 *
 * Rules:
 * - `OPENCLAUDE_CONFIG_DIR` is preferred over the legacy `CLAUDE_CONFIG_DIR`.
 * - Empty or whitespace-only values are treated as unset. Upstream's
 *   `resolveConfigDirEnv` operates on raw values and does not trim; Studio
 *   intentionally trims because a stray trailing newline in an env file is a
 *   common cause of "wrong root" bugs and upstream's untrimmed value would
 *   simply resolve to a nonexistent directory. This is a deliberate,
 *   user-friendlier divergence from upstream.
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
 * Compares two override paths for conflict detection. On Windows, filesystem
 * paths are case-insensitive, so a case-only difference (e.g. `C:\Foo` vs
 * `c:\foo`) points to the same directory and must not be reported as a
 * conflict. Upstream's string compare is case-sensitive, which produces
 * spurious warnings on Windows; Studio intentionally matches the filesystem
 * semantics of the host platform instead.
 *
 * Exported for direct unit testing of the platform branch.
 */
export function overridesConflict(
  preferred: string,
  legacy: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (preferred === legacy) {
    return false;
  }
  if (platform === 'win32') {
    return preferred.toLowerCase() !== legacy.toLowerCase();
  }
  return true;
}

/**
 * Resolves the OpenClaude data home and the global config file path, mirroring
 * upstream OpenClaude's `getClaudeConfigHomeDir()` + `getGlobalClaudeFile()`
 * read-location semantics.
 *
 * Two distinct paths are resolved:
 *
 * 1. Data home (`openClaudeHome`) — where projects/, sessions/, logs/, etc.
 *    live. Mirrors `getClaudeConfigHomeDir`, minus the migration writes Studio
 *    is not allowed to perform:
 *    - With an override env var set, that value wins (preferred over legacy),
 *      NFC-normalized.
 *    - Without one, the default is `"<home>/.openclaude"`. When that directory
 *      is missing and `"<home>/.claude"` exists, upstream falls back to the
 *      legacy directory after a failed migration. Studio cannot migrate, but
 *      reads from the same legacy directory so users with an incomplete
 *      migration still see their data instead of an empty dashboard.
 *
 * 2. Config root — where the global config file lives. Mirrors
 *    `getGlobalClaudeFile`'s `configDirEnv || homedir()`:
 *    - With an override, the config root IS the override (file at
 *      `"<override>/.openclaude.json"`).
 *    - Without one, the config root is `"<home>"` (file at
 *      `"<home>/.openclaude.json"`). Note: the config file lives directly in
 *      home, NOT inside the `.openclaude` data directory.
 *
 * Global config file precedence inside the config root:
 * - If `"<configRoot>/.config.json"` exists, it wins (upstream's oldest
 *   format fallback, any path).
 * - Otherwise prefer `"<configRoot>/.openclaude.json"`.
 * - Under an explicit config dir (override set), if the modern file is missing
 *   and `"<configRoot>/.claude.json"` exists, fall back to the legacy
 *   filename. The default home path does not get this fallback because
 *   upstream migrates those installs to the modern filename.
 *
 * No filesystem writes. `existsSync` is a stat-style check used only to pick
 * between filenames and to detect the legacy-directory fallback; it never
 * follows symlinks and never authorizes a read.
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
  legacyDirectoryFallback: boolean;
} {
  const home = options.home;
  const env = options.env;
  const exists = options.existsSync ?? ((path: string) => existsSync(path));

  const preferred = env[PREFERRED_CONFIG_DIR_ENV]?.trim() || undefined;
  const legacy = env[LEGACY_CONFIG_DIR_ENV]?.trim() || undefined;
  const hasOverride = Boolean(preferred ?? legacy);
  const conflict = Boolean(
    preferred && legacy && overridesConflict(preferred, legacy),
  );

  const selected = preferred ?? legacy;
  const source: ConfigDirSource = preferred
    ? 'openclaude'
    : legacy
      ? 'legacy'
      : 'default';

  // Resolve the OpenClaude data home (projects/, sessions/, etc.) and the
  // config root (where the global config file lives). These are the same path
  // when an override is set, but differ in the default case:
  //   - data home defaults to <home>/.openclaude
  //   - config root defaults to <home> (so the file is <home>/.openclaude.json)
  // This mirrors upstream: getClaudeConfigHomeDir() returns the data home,
  // getGlobalClaudeFile() uses `configDirEnv || homedir()` as the config root.
  let legacyDirectoryFallback = false;
  let openClaudeHome: string;
  let configRoot: string;
  if (selected) {
    const normalized = selected.normalize('NFC');
    openClaudeHome = normalized;
    configRoot = normalized;
  } else {
    const modernDir = join(home, '.openclaude').normalize('NFC');
    const legacyDir = join(home, '.claude').normalize('NFC');
    if (!exists(modernDir) && exists(legacyDir)) {
      // Migration failed and only ~/.claude exists: upstream reads data from
      // ~/.claude. The config file still lives at <home>/.openclaude.json (or
      // its legacy fallbacks) because getGlobalClaudeFile uses homedir().
      openClaudeHome = legacyDir;
      legacyDirectoryFallback = true;
      configRoot = home.normalize('NFC');
    } else {
      openClaudeHome = modernDir;
      configRoot = home.normalize('NFC');
    }
  }

  // Resolve the global config file inside the config root. Precedence:
  //   .config.json  (oldest format, checked first, any path)
  //   .openclaude.json  (modern default)
  //   .claude.json  (legacy filename, override path only)
  const configJson = join(configRoot, '.config.json');
  const openClaudeJson = join(configRoot, '.openclaude.json');
  const claudeJson = join(configRoot, '.claude.json');

  let openClaudeConfig: string;
  let legacyFilenameFallback = false;

  if (exists(configJson)) {
    openClaudeConfig = configJson;
    legacyFilenameFallback = true;
  } else if (hasOverride && !exists(openClaudeJson) && exists(claudeJson)) {
    openClaudeConfig = claudeJson;
    legacyFilenameFallback = true;
  } else {
    openClaudeConfig = openClaudeJson;
  }

  return {
    openClaudeHome,
    openClaudeConfig,
    source,
    conflict,
    legacyFilenameFallback,
    legacyDirectoryFallback,
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
      legacyDirectoryFallback: resolution.legacyDirectoryFallback,
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
