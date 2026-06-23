import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import {
  createOpenClaudePaths,
  encodeProjectPath,
  isProjectTranscriptCwd,
  isProjectTranscriptDirectoryName,
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

  test('uses the default home when neither variable is set', () => {
    const result = resolve({});

    expect(result.openClaudeHome).toBe(join('/tmp/example-home', '.openclaude'));
    expect(result.openClaudeConfig).toBe(join('/tmp/example-home', '.openclaude.json'));
    expect(result.source).toBe('default');
    expect(result.conflict).toBe(false);
    expect(result.legacyFilenameFallback).toBe(false);
  });

  test('honors OPENCLAUDE_CONFIG_DIR and places the config file inside the override', () => {
    const result = resolve({ OPENCLAUDE_CONFIG_DIR: '/tmp/openclaude' });

    expect(result.openClaudeHome).toBe('/tmp/openclaude');
    expect(result.openClaudeConfig).toBe(join('/tmp/openclaude', '.openclaude.json'));
    expect(result.source).toBe('openclaude');
    expect(result.conflict).toBe(false);
    expect(result.legacyFilenameFallback).toBe(false);
  });

  test('honors CLAUDE_CONFIG_DIR as a legacy alias', () => {
    const result = resolve({ CLAUDE_CONFIG_DIR: '/tmp/legacy' });

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

  test('treats empty-string values as unset', () => {
    const result = resolve({ OPENCLAUDE_CONFIG_DIR: '', CLAUDE_CONFIG_DIR: '' });

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
    // Both candidate paths were inspected, but nothing else.
    expect(seen).toContain(join('/tmp/custom', '.openclaude.json'));
    expect(seen).toContain(join('/tmp/custom', '.claude.json'));
  });

  test('prefers the oldest-format .config.json when newer files are absent', () => {
    const existsSync = (path: string) => path === join('/tmp/custom', '.config.json');

    const result = resolve({ OPENCLAUDE_CONFIG_DIR: '/tmp/custom' }, { existsSync });

    expect(result.openClaudeConfig).toBe(join('/tmp/custom', '.config.json'));
    expect(result.legacyFilenameFallback).toBe(true);
  });

  test('prefers .openclaude.json when both legacy and new files exist', () => {
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

  test('does not consult the filesystem when no override is set', () => {
    const seen: string[] = [];
    const existsSync = (path: string) => {
      seen.push(path);
      return false;
    };

    const result = resolve({}, { existsSync });

    expect(result.openClaudeConfig).toBe(join('/tmp/example-home', '.openclaude.json'));
    expect(result.legacyFilenameFallback).toBe(false);
    expect(seen).toEqual([]);
  });

  test('normalizes the override path to NFC Unicode', () => {
    // 'é' as a decomposed (NFD) sequence: 'e' + combining acute accent.
    const nfd = 'cafe\u0301';
    const result = resolve({ OPENCLAUDE_CONFIG_DIR: `/tmp/${nfd}` });

    expect(result.openClaudeHome).toBe(`/tmp/${nfd.normalize('NFC')}`);
  });

  test('never writes to the filesystem', () => {
    // Using a real temp dir ensures any accidental write would be observable.
    const temp = mkdtempSync(join(tmpdir(), 'studio-paths-'));
    const result = resolve({ OPENCLAUDE_CONFIG_DIR: temp });

    expect(result.openClaudeHome).toBe(temp);
    expect(result.openClaudeConfig).toBe(join(temp, '.openclaude.json'));
    // Resolution is pure — same inputs, same output.
    const again = resolve({ OPENCLAUDE_CONFIG_DIR: temp });
    expect(again).toEqual(result);
  });
});

describe('OpenClaude paths', () => {
  test('resolves default paths from the provided home directory', () => {
    const paths = createOpenClaudePaths({ home: '/tmp/example-home', env: {} });

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
