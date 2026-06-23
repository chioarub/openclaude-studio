import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

// Track every call into the fs module so the write-safety test can prove the
// resolver touches only stat-style APIs. vi.hoisted runs before the mock
// factory below, which is itself hoisted above all imports.
const { fsCalls, resetFsCalls } = vi.hoisted(() => {
  const fsCalls: Array<{ method: string; args: unknown[] }> = [];
  return {
    fsCalls,
    resetFsCalls: () => {
      fsCalls.length = 0;
    },
  };
});

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  const wrapped: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(actual)) {
    if (typeof value === 'function') {
      const fnName = name;
      wrapped[fnName] = (...args: unknown[]) => {
        fsCalls.push({ method: fnName, args });
        return (value as (...a: unknown[]) => unknown).apply(actual, args);
      };
    } else {
      wrapped[name] = value;
    }
  }
  return wrapped;
});

import {
  createOpenClaudePaths,
  encodeProjectPath,
  isProjectTranscriptCwd,
  isProjectTranscriptDirectoryName,
  overridesConflict,
  resolveConfigDirEnv,
  resolveOpenClaudeConfigDir,
} from './paths.js';

describe('resolveConfigDirEnv', () => {
  test('returns undefined when neither variable is set', () => {
    expect(resolveConfigDirEnv({})).toBeUndefined();
  });

  test('prefers OPENCLAUDE_CONFIG_DIR over CLAUDE_CONFIG_DIR', () => {
    expect(
      resolveConfigDirEnv({
        openClaudeConfigDir: '/openclaude',
        legacyConfigDir: '/legacy',
      }),
    ).toBe('/openclaude');
  });

  test('falls back to the legacy variable when preferred is absent', () => {
    expect(resolveConfigDirEnv({ legacyConfigDir: '/legacy' })).toBe('/legacy');
  });

  test('treats empty strings as unset', () => {
    expect(resolveConfigDirEnv({ openClaudeConfigDir: '', legacyConfigDir: '' })).toBeUndefined();
  });

  test('treats whitespace-only strings as unset', () => {
    expect(
      resolveConfigDirEnv({ openClaudeConfigDir: '   ', legacyConfigDir: '\t' }),
    ).toBeUndefined();
  });

  test('trims surrounding whitespace from the selected value', () => {
    expect(
      resolveConfigDirEnv({ openClaudeConfigDir: '  /openclaude  ' }),
    ).toBe('/openclaude');
  });
});

describe('overridesConflict', () => {
  test('returns false when both values are identical', () => {
    expect(overridesConflict('/same', '/same', 'linux')).toBe(false);
    expect(overridesConflict('/same', '/same', 'win32')).toBe(false);
  });

  test('returns true when values differ on POSIX', () => {
    expect(overridesConflict('/a', '/b', 'linux')).toBe(true);
    expect(overridesConflict('/a', '/b', 'darwin')).toBe(true);
  });

  test('treats case-only differences as the same path on Windows', () => {
    // C:\Foo and c:\foo point to the same directory on Windows.
    expect(overridesConflict('C:\\Foo', 'c:\\foo', 'win32')).toBe(false);
  });

  test('still reports real conflicts on Windows when paths differ beyond case', () => {
    expect(overridesConflict('C:\\Foo', 'C:\\Bar', 'win32')).toBe(true);
  });

  test('does not apply Windows case-folding on POSIX', () => {
    // On POSIX, /Foo and /foo are different directories.
    expect(overridesConflict('/Foo', '/foo', 'linux')).toBe(true);
  });
});

describe('resolveOpenClaudeConfigDir', () => {
  function resolve(
    env: Record<string, string | undefined>,
    options: {
      home?: string;
      existsSync?: (path: string) => boolean;
    } = {},
  ) {
    return resolveOpenClaudeConfigDir({
      home: options.home ?? '/tmp/example-home',
      env,
      ...(options.existsSync ? { existsSync: options.existsSync } : {}),
    });
  }

  test('uses the default home when neither variable is set and no legacy artifacts exist', () => {
    // Inject existsSync so the test does not depend on the developer's real home.
    const result = resolve({}, { existsSync: () => false });

    expect(result.openClaudeHome).toBe(join('/tmp/example-home', '.openclaude'));
    expect(result.openClaudeConfig).toBe(join('/tmp/example-home', '.openclaude.json'));
    expect(result.source).toBe('default');
    expect(result.conflict).toBe(false);
    expect(result.legacyFilenameFallback).toBe(false);
    expect(result.legacyDirectoryFallback).toBe(false);
  });

  test('honors OPENCLAUDE_CONFIG_DIR and places the config file inside the override', () => {
    const result = resolve({ OPENCLAUDE_CONFIG_DIR: '/tmp/openclaude' }, { existsSync: () => false });

    expect(result.openClaudeHome).toBe('/tmp/openclaude');
    expect(result.openClaudeConfig).toBe(join('/tmp/openclaude', '.openclaude.json'));
    expect(result.source).toBe('openclaude');
    expect(result.conflict).toBe(false);
    expect(result.legacyFilenameFallback).toBe(false);
  });

  test('honors CLAUDE_CONFIG_DIR as a legacy alias', () => {
    const result = resolve({ CLAUDE_CONFIG_DIR: '/tmp/legacy' }, { existsSync: () => false });

    expect(result.openClaudeHome).toBe('/tmp/legacy');
    expect(result.openClaudeConfig).toBe(join('/tmp/legacy', '.openclaude.json'));
    expect(result.source).toBe('legacy');
    expect(result.conflict).toBe(false);
  });

  test('selects OPENCLAUDE_CONFIG_DIR and reports a conflict when both differ', () => {
    const result = resolve({
      OPENCLAUDE_CONFIG_DIR: '/tmp/openclaude',
      CLAUDE_CONFIG_DIR: '/tmp/legacy',
    });

    expect(result.openClaudeHome).toBe('/tmp/openclaude');
    expect(result.openClaudeConfig).toBe(join('/tmp/openclaude', '.openclaude.json'));
    expect(result.source).toBe('openclaude');
    expect(result.conflict).toBe(true);
  });

  test('does not report a conflict when both variables are equal', () => {
    const result = resolve({
      OPENCLAUDE_CONFIG_DIR: '/tmp/shared',
      CLAUDE_CONFIG_DIR: '/tmp/shared',
    });

    expect(result.openClaudeHome).toBe('/tmp/shared');
    expect(result.source).toBe('openclaude');
    expect(result.conflict).toBe(false);
  });

  test('does not report a conflict when values are Unicode-equivalent (NFD vs NFC)', () => {
    // 'café' as composed (NFC) vs decomposed (NFD). Same path, different bytes.
    const nfc = '/tmp/café'.normalize('NFC');
    const nfd = '/tmp/café'.normalize('NFD');
    const result = resolve({
      OPENCLAUDE_CONFIG_DIR: nfc,
      CLAUDE_CONFIG_DIR: nfd,
    }, { existsSync: () => false });

    expect(result.conflict).toBe(false);
    expect(result.openClaudeHome).toBe(nfc);
  });

  test('treats empty-string values as unset', () => {
    const result = resolve({ OPENCLAUDE_CONFIG_DIR: '', CLAUDE_CONFIG_DIR: '' }, { existsSync: () => false });

    expect(result.source).toBe('default');
    expect(result.openClaudeHome).toBe(join('/tmp/example-home', '.openclaude'));
    expect(result.openClaudeConfig).toBe(join('/tmp/example-home', '.openclaude.json'));
  });

  test('falls back to legacy .claude.json inside an explicit root when .openclaude.json is missing', () => {
    const seen = new Set<string>();
    const existsSync = (path: string) => {
      seen.add(path);
      // Only the legacy file is present.
      return path === join('/tmp/custom', '.claude.json');
    };

    const result = resolve({ OPENCLAUDE_CONFIG_DIR: '/tmp/custom' }, { existsSync });

    expect(result.openClaudeConfig).toBe(join('/tmp/custom', '.claude.json'));
    expect(result.legacyFilenameFallback).toBe(true);
    expect(result.source).toBe('openclaude');
    expect(seen).toContain(join('/tmp/custom', '.openclaude.json'));
    expect(seen).toContain(join('/tmp/custom', '.claude.json'));
  });

  test('prefers the oldest-format .config.json inside an explicit root when newer files are absent', () => {
    const existsSync = (path: string) => path === join('/tmp/custom', '.config.json');

    const result = resolve({ OPENCLAUDE_CONFIG_DIR: '/tmp/custom' }, { existsSync });

    expect(result.openClaudeConfig).toBe(join('/tmp/custom', '.config.json'));
    expect(result.legacyFilenameFallback).toBe(true);
  });

  test('prefers .openclaude.json when both legacy and new files exist under an override', () => {
    const existsSync = (path: string) =>
      path === join('/tmp/custom', '.openclaude.json') ||
      path === join('/tmp/custom', '.claude.json');

    const result = resolve({ OPENCLAUDE_CONFIG_DIR: '/tmp/custom' }, { existsSync });

    expect(result.openClaudeConfig).toBe(join('/tmp/custom', '.openclaude.json'));
    expect(result.legacyFilenameFallback).toBe(false);
  });

  test('defaults to .openclaude.json inside an explicit root when no file exists yet', () => {
    const result = resolve({ OPENCLAUDE_CONFIG_DIR: '/tmp/brand-new' }, { existsSync: () => false });

    expect(result.openClaudeConfig).toBe(join('/tmp/brand-new', '.openclaude.json'));
    expect(result.legacyFilenameFallback).toBe(false);
  });

  test('falls back to .config.json in the default home when .openclaude.json is missing', () => {
    // Regression: the .config.json fallback must run in the default-home path,
    // not only under an explicit override. Mirrors upstream getGlobalClaudeFile().
    // The config file lives in <home>, not in <home>/.openclaude.
    const existsSync = (path: string) => path === join('/tmp/example-home', '.config.json');

    const result = resolve({}, { existsSync });

    expect(result.openClaudeHome).toBe(join('/tmp/example-home', '.openclaude'));
    expect(result.openClaudeConfig).toBe(join('/tmp/example-home', '.config.json'));
    expect(result.legacyFilenameFallback).toBe(true);
    expect(result.source).toBe('default');
  });

  test('falls back to the legacy .claude directory in the default home when .openclaude is missing', () => {
    // Regression: when migration failed and only ~/.claude exists, upstream
    // reads data from ~/.claude but the global config file still lives at
    // <home>/.openclaude.json (getGlobalClaudeFile uses homedir()).
    const existsSync = (path: string) =>
      path === join('/tmp/example-home', '.claude') ||
      path === join('/tmp/example-home', '.openclaude.json');

    const result = resolve({}, { existsSync });

    expect(result.openClaudeHome).toBe(join('/tmp/example-home', '.claude'));
    expect(result.legacyDirectoryFallback).toBe(true);
    expect(result.openClaudeConfig).toBe(join('/tmp/example-home', '.openclaude.json'));
    expect(result.source).toBe('default');
  });

  test('does not fall back to .claude directory when .openclaude exists', () => {
    const existsSync = (path: string) =>
      path === join('/tmp/example-home', '.openclaude') ||
      path === join('/tmp/example-home', '.openclaude.json');

    const result = resolve({}, { existsSync });

    expect(result.openClaudeHome).toBe(join('/tmp/example-home', '.openclaude'));
    expect(result.legacyDirectoryFallback).toBe(false);
  });

  test('does not apply the .claude.json filename fallback in the default home', () => {
    // Upstream only applies the legacy filename fallback under an explicit
    // config dir. In the default home, presence of .claude.json alone must
    // not select it — the modern filename is used regardless.
    const existsSync = (path: string) => path === join('/tmp/example-home', '.claude.json');

    const result = resolve({}, { existsSync });

    expect(result.openClaudeConfig).toBe(join('/tmp/example-home', '.openclaude.json'));
    expect(result.legacyFilenameFallback).toBe(false);
  });

  test('normalizes the override path to NFC Unicode', () => {
    // 'é' as a decomposed (NFD) sequence: 'e' + combining acute accent.
    const nfd = 'cafe\u0301';
    const result = resolve({ OPENCLAUDE_CONFIG_DIR: `/tmp/${nfd}` }, { existsSync: () => false });

    expect(result.openClaudeHome).toBe(`/tmp/${nfd.normalize('NFC')}`);
  });

  test('resolution is idempotent — same inputs produce identical outputs', () => {
    const temp = mkdtempSync(join(tmpdir(), 'studio-paths-'));
    const result = resolve({ OPENCLAUDE_CONFIG_DIR: temp });
    const again = resolve({ OPENCLAUDE_CONFIG_DIR: temp });

    expect(again).toEqual(result);
  });
});

describe('resolveOpenClaudeConfigDir write safety', () => {
  afterEach(() => {
    resetFsCalls();
  });

  test('never invokes any filesystem write API during resolution', () => {
    // The fs module is wrapped (top of file) to record every call. Resolution
    // must touch only existsSync (stat-style). If any write-capable method
    // fires, the test fails. This catches accidental writes even if a future
    // refactor moves them into a helper.
    const writeMethods = new Set([
      'writeFile',
      'writeFileSync',
      'mkdir',
      'mkdirSync',
      'copyFile',
      'copyFileSync',
      'rename',
      'renameSync',
      'unlink',
      'unlinkSync',
      'rmdir',
      'rmdirSync',
      'appendFile',
      'appendFileSync',
      'createWriteStream',
    ]);

    const temp = mkdtempSync(join(tmpdir(), 'studio-paths-'));
    mkdirSync(join(temp, '.openclaude'), { recursive: true });
    // Config file lives in <home>, not in <home>/.openclaude.
    writeFileSync(join(temp, '.openclaude.json'), '{}');

    resetFsCalls();

    // Default-home path with modern artifacts present — exercises every branch.
    const result = resolveOpenClaudeConfigDir({
      home: temp,
      env: {},
    });

    expect(result.openClaudeConfig).toBe(join(temp, '.openclaude.json'));

    const writeCallsDuringResolution = fsCalls.filter(call => writeMethods.has(call.method));
    expect(writeCallsDuringResolution).toEqual([]);

    // And the only read-style call should be existsSync.
    const methodsCalled = new Set(fsCalls.map(call => call.method));
    expect(methodsCalled).toEqual(new Set(['existsSync']));
  });
});

describe('OpenClaude paths', () => {
  test('resolves default paths from the provided home directory', () => {
    // Inject existsSync so the test does not depend on the developer's home.
    const paths = createOpenClaudePaths({
      home: '/tmp/example-home',
      env: {},
      existsSync: () => false,
    });

    expect(paths.openClaudeConfig).toBe('/tmp/example-home/.openclaude.json');
    expect(paths.openClaudeHome).toBe('/tmp/example-home/.openclaude');
    expect(paths.projectsDir).toBe('/tmp/example-home/.openclaude/projects');
    expect(paths.debugDir).toBe('/tmp/example-home/.openclaude/debug');
    expect(paths.tasksDir).toBe('/tmp/example-home/.openclaude/tasks');
    expect(paths.plansDir).toBe('/tmp/example-home/.openclaude/plans');
    expect(paths.fileHistoryDir).toBe('/tmp/example-home/.openclaude/file-history');
    expect(paths.configDirResolution).toEqual({
      source: 'default',
      conflict: false,
      legacyFilenameFallback: false,
      legacyDirectoryFallback: false,
    });
  });

  test('honors OPENCLAUDE_CONFIG_DIR and routes every derived path through the override', () => {
    const temp = mkdtempSync(join(tmpdir(), 'studio-paths-'));
    const paths = createOpenClaudePaths({
      home: '/tmp/example-home',
      env: { OPENCLAUDE_CONFIG_DIR: temp },
    });

    expect(paths.openClaudeHome).toBe(temp);
    expect(paths.openClaudeConfig).toBe(join(temp, '.openclaude.json'));
    expect(paths.projectsDir).toBe(join(temp, 'projects'));
    expect(paths.tasksDir).toBe(join(temp, 'tasks'));
    expect(paths.plansDir).toBe(join(temp, 'plans'));
    expect(paths.fileHistoryDir).toBe(join(temp, 'file-history'));
    expect(paths.configDirResolution.source).toBe('openclaude');
  });

  test('reads the global config from the override when a legacy .claude.json is the only file present', () => {
    const temp = mkdtempSync(join(tmpdir(), 'studio-paths-'));
    writeFileSync(join(temp, '.claude.json'), '{}');

    const paths = createOpenClaudePaths({
      home: '/tmp/example-home',
      env: { OPENCLAUDE_CONFIG_DIR: temp },
    });

    expect(paths.openClaudeConfig).toBe(join(temp, '.claude.json'));
    expect(paths.configDirResolution.legacyFilenameFallback).toBe(true);
  });

  test('keeps CLAUDE_CONFIG_DIR working as a legacy alias', () => {
    const paths = createOpenClaudePaths({
      home: '/tmp/example-home',
      env: { CLAUDE_CONFIG_DIR: '/tmp/custom-openclaude' },
      existsSync: () => false,
    });

    expect(paths.openClaudeHome).toBe('/tmp/custom-openclaude');
    expect(paths.openClaudeConfig).toBe('/tmp/custom-openclaude/.openclaude.json');
    expect(paths.configDirResolution.source).toBe('legacy');
  });

  test('reports a conflict when both env vars are set differently', () => {
    const paths = createOpenClaudePaths({
      home: '/tmp/example-home',
      env: {
        OPENCLAUDE_CONFIG_DIR: '/tmp/openclaude',
        CLAUDE_CONFIG_DIR: '/tmp/legacy',
      },
    });

    expect(paths.openClaudeHome).toBe('/tmp/openclaude');
    expect(paths.configDirResolution.source).toBe('openclaude');
    expect(paths.configDirResolution.conflict).toBe(true);
  });

  test('encodes project paths the same way OpenClaude stores session folders', () => {
    expect(encodeProjectPath(join('/tmp', 'project name'))).toBe('-tmp-project-name');
  });

  test('matches selected project transcript and worktree transcript directory names only', () => {
    const projectPath = join('/tmp', 'openclaude');

    expect(isProjectTranscriptDirectoryName(projectPath, encodeProjectPath(projectPath))).toBe(true);
    expect(
      isProjectTranscriptDirectoryName(
        projectPath,
        encodeProjectPath(join(projectPath, '.claude', 'worktrees', 'feature-a')),
      ),
    ).toBe(true);
    expect(
      isProjectTranscriptDirectoryName(
        projectPath,
        encodeProjectPath(join('/tmp', 'openclaude-studio')),
      ),
    ).toBe(false);
  });

  test('matches selected project cwd and child cwd paths without matching siblings', () => {
    const projectPath = join('/tmp', 'project-a');

    expect(isProjectTranscriptCwd(projectPath, projectPath)).toBe(true);
    expect(isProjectTranscriptCwd(projectPath, join(projectPath, '.claude', 'worktrees', 'feature-a'))).toBe(true);
    expect(isProjectTranscriptCwd(projectPath, join(projectPath, 'nested-package'))).toBe(true);
    expect(isProjectTranscriptCwd(projectPath, join('/tmp', 'project-b'))).toBe(false);
    expect(isProjectTranscriptCwd(join('/tmp', 'openclaude'), join('/tmp', 'openclaude-studio'))).toBe(false);
  });

  test('matches children when the selected project path is the filesystem root', () => {
    expect(isProjectTranscriptCwd('/', join('/tmp', 'project-a'))).toBe(true);
  });
});
