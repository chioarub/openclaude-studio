import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { createOpenClaudePaths } from './paths.js';
import {
  readActiveProvider,
  readOpenClaudeConfig,
  readProjectSummaries,
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
