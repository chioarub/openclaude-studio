import { chmod, mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { createOpenClaudePaths, encodeProjectPath } from './paths.js';
import {
  readActiveProvider,
  readOpenClaudeConfig,
  readProjectSummaries,
  readProjectSummariesWithDiagnostics,
  readProviderSummaries,
} from './openclaudeData.js';

describe('OpenClaude data discovery', () => {
  test('reads project summaries from the global OpenClaude config', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ocs-data-'));
    const project = join(home, 'project-a');
    const missingProject = join(home, 'missing-project');
    await mkdir(join(project, '.git'), { recursive: true });
    await writeFile(join(project, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');

    const paths = createOpenClaudePaths({ home, env: {} });
    await writeFile(
      paths.openClaudeConfig,
      JSON.stringify({
        projects: {
          [missingProject]: { lastGracefulShutdown: '2026-05-27T08:00:00Z' },
          [project]: {
            lastGracefulShutdown: '2026-05-28T08:00:00Z',
            lastTotalInputTokens: 10,
            lastTotalOutputTokens: 20,
            lastTotalCacheReadInputTokens: 30,
            lastTotalCacheCreationInputTokens: 40,
            lastCost: 0.12,
            lastSessionId: 'session-1',
          },
        },
      }),
      'utf8',
    );

    const projects = await readProjectSummaries(paths, new Date('2026-05-28T08:10:00Z'));

    expect(projects[0]).toMatchObject({
      name: 'project-a',
      path: project,
      exists: true,
      active: true,
      branch: 'main',
      lastUpdated: '10 min ago',
      usage: {
        inputTokens: 10,
        outputTokens: 20,
        cacheReadTokens: 30,
        cacheWriteTokens: 40,
        costUsd: 0.12,
        lastSessionId: 'session-1',
      },
    });
    expect(projects[1]).toMatchObject({
      path: missingProject,
      exists: false,
      active: false,
    });
    expect(projects[1]?.diagnostics[0]?.level).toBe('error');
  });

  test('discovers project summaries from transcript metadata when global config omits them', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ocs-data-'));
    const project = join(home, 'transcript-only-project');
    const paths = createOpenClaudePaths({ home, env: {} });
    const projectDir = join(paths.projectsDir, encodeProjectPath(project));
    await mkdir(join(project, '.git'), { recursive: true });
    await writeFile(join(project, '.git', 'HEAD'), 'ref: refs/heads/feature/transcripts\n', 'utf8');
    await mkdir(projectDir, { recursive: true });
    await writeFile(paths.openClaudeConfig, JSON.stringify({ projects: {} }), 'utf8');
    await writeFile(
      join(projectDir, 'session-transcript-only.jsonl'),
      [
        jsonl({
          type: 'user',
          sessionId: 'session-transcript-only',
          timestamp: '2026-05-28T08:00:00.000Z',
          cwd: project,
          message: { role: 'user', content: 'Inspect this project' },
        }),
        jsonl({
          type: 'assistant',
          sessionId: 'session-transcript-only',
          timestamp: '2026-05-28T08:01:00.000Z',
          cwd: project,
          message: {
            role: 'assistant',
            usage: {
              input_tokens: 11,
              output_tokens: 13,
              cache_read_input_tokens: 17,
              cache_creation_input_tokens: 19,
            },
            content: 'Done',
          },
        }),
      ].join('\n'),
      'utf8',
    );

    const projects = await readProjectSummaries(paths, new Date('2026-05-29T08:01:00Z'));

    expect(projects).toEqual([
      expect.objectContaining({
        name: 'transcript-only-project',
        path: project,
        exists: true,
        active: true,
        branch: 'feature/transcripts',
        lastUpdated: '1 day ago',
        usage: {
          inputTokens: 11,
          outputTokens: 13,
          cacheReadTokens: 17,
          cacheWriteTokens: 19,
          costUsd: 0,
          lastSessionId: 'session-transcript-only',
        },
      }),
    ]);
  });

  test('discovers transcript projects when cwd metadata appears after a large row', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ocs-data-'));
    const project = join(home, 'large-transcript-project');
    const paths = createOpenClaudePaths({ home, env: {} });
    const projectDir = join(paths.projectsDir, encodeProjectPath(project));
    await mkdir(project, { recursive: true });
    await mkdir(projectDir, { recursive: true });
    await writeFile(paths.openClaudeConfig, JSON.stringify({ projects: {} }), 'utf8');
    await writeFile(
      join(projectDir, 'session-large-prefix.jsonl'),
      [
        jsonl({
          type: 'system',
          sessionId: 'session-large-prefix',
          timestamp: '2026-05-28T07:59:00.000Z',
          message: { role: 'system', content: 'x'.repeat(600 * 1024) },
        }),
        jsonl({
          type: 'user',
          sessionId: 'session-large-prefix',
          timestamp: '2026-05-28T08:00:00.000Z',
          cwd: project,
          message: { role: 'user', content: 'Discover this project after a large metadata row' },
        }),
      ].join('\n'),
      'utf8',
    );

    const projects = await readProjectSummaries(paths, new Date('2026-05-28T08:10:00Z'));

    expect(projects).toEqual([
      expect.objectContaining({
        name: 'large-transcript-project',
        path: project,
        lastUpdated: '10 min ago',
      }),
    ]);
  });

  test('surfaces diagnostics when transcript discovery reads a truncated file', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ocs-data-'));
    const project = join(home, 'truncated-transcript-project');
    const paths = createOpenClaudePaths({ home, env: {} });
    const projectDir = join(paths.projectsDir, encodeProjectPath(project));
    const transcriptPath = join(projectDir, 'session-truncated.jsonl');
    await mkdir(project, { recursive: true });
    await mkdir(projectDir, { recursive: true });
    await writeFile(paths.openClaudeConfig, JSON.stringify({ projects: {} }), 'utf8');
    await writeFile(
      transcriptPath,
      [
        jsonl({
          type: 'user',
          sessionId: 'session-truncated',
          timestamp: '2026-05-28T08:00:00.000Z',
          cwd: project,
          message: { role: 'user', content: 'Discover this project before the file truncates' },
        }),
        jsonl({
          type: 'assistant',
          sessionId: 'session-truncated',
          timestamp: '2026-05-28T08:01:00.000Z',
          cwd: project,
          message: { role: 'assistant', content: 'x'.repeat(11 * 1024 * 1024) },
        }),
      ].join('\n'),
      'utf8',
    );

    const result = await readProjectSummariesWithDiagnostics(paths, new Date('2026-05-28T08:10:00Z'));

    expect(result.projects).toEqual([
      expect.objectContaining({
        name: 'truncated-transcript-project',
        path: project,
      }),
    ]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        level: 'warn',
        message: 'File was truncated to 10485760 bytes.',
        path: transcriptPath,
      }),
    ]);
  });

  test('keeps global config project metadata when transcript metadata also exists', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ocs-data-'));
    const project = join(home, 'project-a');
    const paths = createOpenClaudePaths({ home, env: {} });
    const projectDir = join(paths.projectsDir, encodeProjectPath(project));
    await mkdir(join(project, '.git'), { recursive: true });
    await writeFile(join(project, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      paths.openClaudeConfig,
      JSON.stringify({
        projects: {
          [project]: {
            lastGracefulShutdown: '2026-05-28T08:00:00Z',
            lastTotalInputTokens: 1,
            lastTotalOutputTokens: 2,
            lastTotalCacheReadInputTokens: 3,
            lastTotalCacheCreationInputTokens: 4,
            lastCost: 0.5,
            lastSessionId: 'config-session',
          },
        },
      }),
      'utf8',
    );
    await writeFile(
      join(projectDir, 'session-transcript.jsonl'),
      jsonl({
        type: 'assistant',
        sessionId: 'transcript-session',
        timestamp: '2026-05-29T08:00:00.000Z',
        cwd: project,
        message: {
          role: 'assistant',
          usage: { input_tokens: 100, output_tokens: 200 },
          content: 'Transcript metadata should not replace config metadata.',
        },
      }),
      'utf8',
    );

    const projects = await readProjectSummaries(paths, new Date('2026-05-28T08:10:00Z'));

    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({
      path: project,
      lastUpdated: '10 min ago',
      usage: {
        inputTokens: 1,
        outputTokens: 2,
        cacheReadTokens: 3,
        cacheWriteTokens: 4,
        costUsd: 0.5,
        lastSessionId: 'config-session',
      },
    });
  });

  test('folds OpenClaude worktree transcript roots into the parent project', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ocs-data-'));
    const project = join(home, 'project-a');
    const worktree = join(project, '.claude', 'worktrees', 'feature-a');
    const paths = createOpenClaudePaths({ home, env: {} });
    const worktreeTranscriptDir = join(paths.projectsDir, encodeProjectPath(worktree));
    await mkdir(join(project, '.git'), { recursive: true });
    await writeFile(join(project, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
    await mkdir(worktreeTranscriptDir, { recursive: true });
    await writeFile(paths.openClaudeConfig, JSON.stringify({ projects: {} }), 'utf8');
    await writeFile(
      join(worktreeTranscriptDir, 'session-worktree.jsonl'),
      jsonl({
        type: 'assistant',
        sessionId: 'session-worktree',
        timestamp: '2026-05-28T08:00:00.000Z',
        cwd: worktree,
        message: {
          role: 'assistant',
          usage: { input_tokens: 5, output_tokens: 8 },
          content: 'Worktree session',
        },
      }),
      'utf8',
    );

    const projects = await readProjectSummaries(paths, new Date('2026-05-28T08:10:00Z'));

    expect(projects).toEqual([
      expect.objectContaining({
        name: 'project-a',
        path: project,
        branch: 'main',
        usage: expect.objectContaining({
          inputTokens: 5,
          outputTokens: 8,
          lastSessionId: 'session-worktree',
        }),
      }),
    ]);
  });

  test('ignores spoofed worktree-prefix roots whose cwd is the parent project', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ocs-data-'));
    const project = join(home, 'project-a');
    const paths = createOpenClaudePaths({ home, env: {} });
    const spoofedWorktreeDir = join(paths.projectsDir, `${encodeProjectPath(project)}--claude-worktrees-spoof`);
    await mkdir(spoofedWorktreeDir, { recursive: true });
    await writeFile(paths.openClaudeConfig, JSON.stringify({ projects: {} }), 'utf8');
    await writeFile(
      join(spoofedWorktreeDir, 'session-spoof.jsonl'),
      jsonl({
        type: 'user',
        sessionId: 'session-spoof',
        timestamp: '2026-05-28T08:00:00.000Z',
        cwd: project,
        message: { role: 'user', content: 'This root name should not be trusted by prefix alone' },
      }),
      'utf8',
    );

    await expect(readProjectSummaries(paths)).resolves.toEqual([]);
  });

  test('discovers colliding encoded project paths from transcript cwd metadata', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ocs-data-'));
    const project = join(home, 'project-a');
    const collidingProject = join(home, 'project', 'a');
    const paths = createOpenClaudePaths({ home, env: {} });
    const projectDir = join(paths.projectsDir, encodeProjectPath(project));
    expect(encodeProjectPath(project)).toBe(encodeProjectPath(collidingProject));
    await mkdir(project, { recursive: true });
    await mkdir(collidingProject, { recursive: true });
    await mkdir(projectDir, { recursive: true });
    await writeFile(paths.openClaudeConfig, JSON.stringify({ projects: {} }), 'utf8');
    await writeFile(
      join(projectDir, 'session-collision.jsonl'),
      [
        jsonl({
          type: 'user',
          sessionId: 'session-project-a',
          timestamp: '2026-05-28T08:00:00.000Z',
          cwd: project,
          message: { role: 'user', content: 'First project' },
        }),
        jsonl({
          type: 'user',
          sessionId: 'session-project-nested-a',
          timestamp: '2026-05-28T09:00:00.000Z',
          cwd: collidingProject,
          message: { role: 'user', content: 'Colliding project' },
        }),
      ].join('\n'),
      'utf8',
    );

    const projects = await readProjectSummaries(paths, new Date('2026-05-28T09:10:00Z'));

    expect(projects.map((item) => item.path).sort()).toEqual([collidingProject, project].sort());
  });

  test('ignores transcript rows whose cwd does not match the transcript root', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ocs-data-'));
    const transcriptRootProject = join(home, 'project-a');
    const mismatchedProject = join(home, 'project-b');
    const paths = createOpenClaudePaths({ home, env: {} });
    const projectDir = join(paths.projectsDir, encodeProjectPath(transcriptRootProject));
    await mkdir(projectDir, { recursive: true });
    await writeFile(paths.openClaudeConfig, JSON.stringify({ projects: {} }), 'utf8');
    await writeFile(
      join(projectDir, 'session-mismatch.jsonl'),
      jsonl({
        type: 'user',
        sessionId: 'session-mismatch',
        timestamp: '2026-05-28T08:00:00.000Z',
        cwd: mismatchedProject,
        message: { role: 'user', content: 'Wrong root' },
      }),
      'utf8',
    );

    await expect(readProjectSummaries(paths)).resolves.toEqual([]);
  });

  test('does not traverse symlinked transcript roots during project discovery', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ocs-data-'));
    const project = join(home, 'project-a');
    const outside = join(home, 'outside-transcripts');
    const paths = createOpenClaudePaths({ home, env: {} });
    await mkdir(outside, { recursive: true });
    await mkdir(paths.projectsDir, { recursive: true });
    await writeFile(paths.openClaudeConfig, JSON.stringify({ projects: {} }), 'utf8');
    await writeFile(
      join(outside, 'session-symlink.jsonl'),
      jsonl({
        type: 'user',
        sessionId: 'session-symlink',
        timestamp: '2026-05-28T08:00:00.000Z',
        cwd: project,
        message: { role: 'user', content: 'Do not discover through symlink' },
      }),
      'utf8',
    );
    await symlink(outside, join(paths.projectsDir, encodeProjectPath(project)));

    await expect(readProjectSummaries(paths)).resolves.toEqual([]);
  });

  test('reports unreadable transcript roots and continues discovering readable projects', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ocs-data-'));
    const project = join(home, 'readable-project');
    const unreadableProject = join(home, 'unreadable-project');
    const paths = createOpenClaudePaths({ home, env: {} });
    const projectDir = join(paths.projectsDir, encodeProjectPath(project));
    const unreadableRoot = join(paths.projectsDir, encodeProjectPath(unreadableProject));
    await mkdir(project, { recursive: true });
    await mkdir(projectDir, { recursive: true });
    await mkdir(unreadableRoot, { recursive: true });
    await writeFile(paths.openClaudeConfig, JSON.stringify({ projects: {} }), 'utf8');
    await writeFile(
      join(projectDir, 'session-readable.jsonl'),
      jsonl({
        type: 'user',
        sessionId: 'session-readable',
        timestamp: '2026-05-28T08:00:00.000Z',
        cwd: project,
        message: { role: 'user', content: 'Readable transcript root' },
      }),
      'utf8',
    );

    await chmod(unreadableRoot, 0);
    try {
      const result = await readProjectSummariesWithDiagnostics(paths, new Date('2026-05-28T08:10:00Z'));

      expect(result.projects).toEqual([
        expect.objectContaining({
          name: 'readable-project',
          path: project,
        }),
      ]);
      expect(result.diagnostics).toContainEqual({
        level: 'warn',
        message: 'Transcript root could not be scanned.',
        path: unreadableRoot,
      });
    } finally {
      await chmod(unreadableRoot, 0o700).catch(() => undefined);
    }
  });

  test('reports diagnostics for missing transcript-discovered project paths', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ocs-data-'));
    const missingProject = join(home, 'missing-project');
    const paths = createOpenClaudePaths({ home, env: {} });
    const projectDir = join(paths.projectsDir, encodeProjectPath(missingProject));
    await mkdir(projectDir, { recursive: true });
    await writeFile(paths.openClaudeConfig, JSON.stringify({ projects: {} }), 'utf8');
    await writeFile(
      join(projectDir, 'session-missing.jsonl'),
      jsonl({
        type: 'user',
        sessionId: 'session-missing',
        timestamp: '2026-05-28T08:00:00.000Z',
        cwd: missingProject,
        message: { role: 'user', content: 'Project no longer exists' },
      }),
      'utf8',
    );

    const projects = await readProjectSummaries(paths, new Date('2026-05-28T08:10:00Z'));

    expect(projects[0]).toMatchObject({
      path: missingProject,
      exists: false,
      branch: 'missing',
      diagnostics: [{ level: 'error', message: 'Project path does not exist.', path: missingProject }],
    });
  });

  test('reads provider summaries without exposing secrets', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ocs-data-'));
    const paths = createOpenClaudePaths({ home, env: {} });
    await writeFile(
      paths.openClaudeConfig,
      JSON.stringify({
        activeProviderProfileId: 'active-provider',
        providerProfiles: [
          {
            id: 'inactive-provider',
            name: 'Inactive',
            provider: 'openai',
            baseUrl: 'https://user:pass@example.com/v1?api_key=secret&model=x',
            model: 'gpt-4.1',
            apiKey: 'example-key',
          },
          {
            id: 'active-provider',
            name: 'Active',
            provider: 'anthropic',
            baseUrl: 'https://api.example.com/v1',
            model: 'claude-sonnet',
            authHeaderValue: 'Bearer token',
          },
        ],
      }),
      'utf8',
    );

    const providers = await readProviderSummaries(paths);
    const active = await readActiveProvider(paths);

    expect(providers[0]).toMatchObject({
      id: 'inactive-provider',
      baseUrl: 'https://example.com/v1?api_key=%3Credacted%3E&model=x',
      apiKeySet: true,
      authHeaderValueSet: false,
      active: false,
    });
    expect(active.provider).toMatchObject({
      id: 'active-provider',
      active: true,
      apiKeySet: false,
      authHeaderValueSet: true,
    });
  });

  test('returns diagnostics for malformed global config', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ocs-data-'));
    const paths = createOpenClaudePaths({ home, env: {} });
    await writeFile(paths.openClaudeConfig, '{not json', 'utf8');

    const result = await readOpenClaudeConfig(paths);

    expect(result.config).toEqual({});
    expect(result.exists).toBe(true);
    expect(result.diagnostics[0]?.level).toBe('error');
  });

  test('redacts sensitive fields from exposed global config reads', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ocs-data-'));
    const paths = createOpenClaudePaths({ home, env: {} });
    await writeFile(
      paths.openClaudeConfig,
      JSON.stringify({ providerProfiles: [{ id: 'provider-1', apiKey: 'secret-value' }] }),
      'utf8',
    );

    const result = await readOpenClaudeConfig(paths);

    expect(result.config).toEqual({
      providerProfiles: [{ id: 'provider-1', apiKey: '<redacted>' }],
    });
  });

  test('does not read a symlinked global config file', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ocs-data-'));
    const paths = createOpenClaudePaths({ home, env: {} });
    const target = join(home, 'target.json');
    await writeFile(target, JSON.stringify({ projects: {} }), 'utf8');
    await symlink(target, paths.openClaudeConfig);

    const result = await readOpenClaudeConfig(paths);

    expect(result.config).toEqual({});
    expect(result.diagnostics[0]?.level).toBe('warn');
  });
});

describe('config directory conflict diagnostics', () => {
  test('warns when OPENCLAUDE_CONFIG_DIR and CLAUDE_CONFIG_DIR differ', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ocs-data-'));
    const preferred = await mkdtemp(join(tmpdir(), 'ocs-preferred-'));
    const paths = createOpenClaudePaths({
      home,
      env: {
        OPENCLAUDE_CONFIG_DIR: preferred,
        CLAUDE_CONFIG_DIR: '/tmp/legacy-and-different',
      },
    });
    await writeFile(paths.openClaudeConfig, JSON.stringify({ projects: {} }), 'utf8');

    const result = await readProjectSummariesWithDiagnostics(paths, new Date('2026-06-23T00:00:00Z'));

    const conflict = result.diagnostics.find(
      diagnostic =>
        diagnostic.level === 'warn' &&
        diagnostic.message.includes('OPENCLAUDE_CONFIG_DIR'),
    );

    expect(conflict).toBeDefined();
    // Privacy: the message must never embed path values.
    expect(conflict?.message).not.toContain(preferred);
    expect(conflict?.message).not.toContain('/tmp/legacy-and-different');
    expect(conflict?.message).not.toContain(home);
  });

  test('does not warn when only one variable is set', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ocs-data-'));
    const preferred = await mkdtemp(join(tmpdir(), 'ocs-preferred-'));
    const paths = createOpenClaudePaths({
      home,
      env: { OPENCLAUDE_CONFIG_DIR: preferred },
    });
    await writeFile(paths.openClaudeConfig, JSON.stringify({ projects: {} }), 'utf8');

    const result = await readProjectSummariesWithDiagnostics(paths, new Date('2026-06-23T00:00:00Z'));

    expect(
      result.diagnostics.some(diagnostic => diagnostic.message.includes('CLAUDE_CONFIG_DIR')),
    ).toBe(false);
  });

  test('does not warn when both variables are set to the same value', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ocs-data-'));
    const shared = await mkdtemp(join(tmpdir(), 'ocs-shared-'));
    const paths = createOpenClaudePaths({
      home,
      env: {
        OPENCLAUDE_CONFIG_DIR: shared,
        CLAUDE_CONFIG_DIR: shared,
      },
    });
    await writeFile(paths.openClaudeConfig, JSON.stringify({ projects: {} }), 'utf8');

    const result = await readProjectSummariesWithDiagnostics(paths, new Date('2026-06-23T00:00:00Z'));

    expect(
      result.diagnostics.some(diagnostic => diagnostic.message.includes('OPENCLAUDE_CONFIG_DIR')),
    ).toBe(false);
  });
});

function jsonl(value: unknown): string {
  return JSON.stringify(value);
}
