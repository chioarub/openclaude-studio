import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { createOpenClaudePaths, encodeProjectPath } from './paths.js';

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
});
