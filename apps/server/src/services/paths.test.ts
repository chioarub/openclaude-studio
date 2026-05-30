import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import {
  createOpenClaudePaths,
  encodeProjectPath,
  isProjectTranscriptCwd,
  isProjectTranscriptDirectoryName,
} from './paths.js';

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
  });

  test('honors CLAUDE_CONFIG_DIR for the OpenClaude home', () => {
    const paths = createOpenClaudePaths({
      home: '/tmp/example-home',
      env: { CLAUDE_CONFIG_DIR: '/tmp/custom-openclaude' },
    });

    expect(paths.openClaudeHome).toBe('/tmp/custom-openclaude');
    expect(paths.openClaudeConfig).toBe('/tmp/example-home/.openclaude.json');
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
      isProjectTranscriptDirectoryName(projectPath, encodeProjectPath(join('/tmp', 'openclaude-studio'))),
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
});
