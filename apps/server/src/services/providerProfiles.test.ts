import { writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { createOpenClaudePaths } from './paths.js';
import {
  getProviderProfileTemplates,
  inferProviderTemplateId,
  readProviderProfiles,
} from './providerProfiles.js';

describe('Provider profile management data', () => {
  test('returns curated safe templates without embedded secrets or runtime commands', () => {
    const templates = getProviderProfileTemplates();

    expect(templates.map((template) => template.id)).toEqual([
      'anthropic',
      'openai',
      'gemini',
      'zai-coding-plan',
      'codex-oauth',
      'ollama',
      'mistral',
      'custom-openai',
    ]);
    expect(templates.find((template) => template.id === 'openai')).toMatchObject({
      category: 'hosted',
      provider: 'openai',
      requiresSecret: true,
      credential: { envVar: 'OPENAI_API_KEY' },
    });
    expect(templates.find((template) => template.id === 'codex-oauth')).toMatchObject({
      category: 'subscription',
      provider: 'openai',
      requiresSecret: false,
    });
    expect(templates.find((template) => template.id === 'ollama')).toMatchObject({
      category: 'local',
      requiresSecret: false,
    });
    expect(templates.some((template) => 'command' in template)).toBe(false);
    expect(JSON.stringify(templates)).not.toContain('apiKey');
    expect(JSON.stringify(templates)).not.toContain('authHeaderValue');
  });

  test('infers template families without treating custom OpenAI URLs as Ollama', () => {
    expect(
      inferProviderTemplateId({
        provider: 'openai',
        baseUrl: 'http://localhost:11434/v1',
      }),
    ).toBe('custom-openai');
    expect(
      inferProviderTemplateId({
        provider: 'ollama',
        baseUrl: 'http://localhost:11434/v1',
      }),
    ).toBe('ollama');
    expect(
      inferProviderTemplateId({
        provider: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
      }),
    ).toBe('anthropic');
  });

  test('reads profiles with validation diagnostics while redacting sensitive values', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ocs-providers-'));
    const paths = createOpenClaudePaths({ home, env: {} });
    await writeFile(
      paths.openClaudeConfig,
      JSON.stringify({
        activeProviderProfileId: 'missing-active',
        providerProfiles: [
          {
            id: 'openai-profile',
            name: 'OpenAI Team',
            provider: 'openai',
            baseUrl: 'https://user:password@example.com/v1?api_key=hidden',
            model: 'gpt-example',
            apiFormat: 'responses',
            apiKey: 'sk-live-private',
            authHeader: 'Authorization',
            authScheme: 'bearer',
            authHeaderValue: 'Bearer private-header',
            customHeaders: {
              Authorization: 'Bearer custom-private',
              'X-Workspace': 'studio',
            },
          },
          {
            id: 'local-model',
            name: 'Local Model',
            provider: 'ollama',
            baseUrl: 'http://127.0.0.1:11434/v1',
            model: 'llama3.1:8b',
          },
          {
            id: 'broken-profile',
            name: '',
            provider: 'openai',
            baseUrl: 'not a url',
            model: '',
          },
          {
            id: 'broken-profile',
            name: 'Duplicate ID',
            provider: 'openai',
            baseUrl: 'https://api.example.com/v1',
            model: 'gpt-example',
          },
        ],
      }),
      'utf8',
    );

    const result = await readProviderProfiles(paths);

    expect(result.path).toBe(paths.openClaudeConfig);
    expect(result.exists).toBe(true);
    expect(result.sensitiveFieldsRedacted).toBe(true);
    expect(result.activeProviderProfileId).toBe('missing-active');
    expect(result.summary).toMatchObject({
      total: 4,
      active: 1,
      valid: 2,
      warnings: expect.any(Number),
      errors: 2,
    });
    expect(result.diagnostics.some((diagnostic) => diagnostic.message.includes('not found'))).toBe(true);
    expect(result.profiles[0]).toMatchObject({
      id: 'openai-profile',
      active: true,
      baseUrl: 'https://example.com/v1?api_key=%3Credacted%3E',
      apiFormat: 'responses',
      apiKeySet: true,
      authHeader: 'Authorization',
      authHeaderValueSet: true,
      templateId: 'custom-openai',
      validation: { status: 'valid' },
    });
    expect(result.profiles[0]?.customHeaders).toEqual([
      { name: 'Authorization', sensitive: true, valueSet: true },
      { name: 'X-Workspace', sensitive: false, valueSet: true },
    ]);
    expect(result.profiles[2]?.validation).toMatchObject({
      status: 'error',
      issues: expect.arrayContaining([
        expect.objectContaining({ field: 'name', severity: 'error' }),
        expect.objectContaining({ field: 'model', severity: 'error' }),
        expect.objectContaining({ field: 'baseUrl', severity: 'error' }),
      ]),
    });
    expect(result.profiles[3]?.validation.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: 'id', severity: 'error' })]),
    );
    expect(JSON.stringify(result)).not.toContain('sk-live-private');
    expect(JSON.stringify(result)).not.toContain('private-header');
    expect(JSON.stringify(result)).not.toContain('custom-private');
    expect(JSON.stringify(result)).not.toContain('password');
  });

  test('selects only the first matching active profile when duplicate ids exist', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ocs-providers-'));
    const paths = createOpenClaudePaths({ home, env: {} });
    await writeFile(
      paths.openClaudeConfig,
      JSON.stringify({
        activeProviderProfileId: 'duplicate',
        providerProfiles: [
          {
            id: 'duplicate',
            name: 'First Duplicate',
            provider: 'openai',
            baseUrl: 'https://api.openai.com/v1',
            model: 'gpt-example',
            apiKey: 'sk-first-private',
          },
          {
            id: 'duplicate',
            name: 'Second Duplicate',
            provider: 'openai',
            baseUrl: 'https://api.openai.com/v1',
            model: 'gpt-example',
            apiKey: 'sk-second-private',
          },
        ],
      }),
      'utf8',
    );

    const result = await readProviderProfiles(paths);

    expect(result.summary).toMatchObject({ total: 2, active: 1, errors: 2 });
    expect(result.profiles.map((profile) => profile.active)).toEqual([true, false]);
    expect(result.profiles[0]?.validation.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: 'id', severity: 'error' })]),
    );
    expect(result.profiles[1]?.validation.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: 'id', severity: 'error' })]),
    );
    expect(JSON.stringify(result)).not.toContain('sk-first-private');
    expect(JSON.stringify(result)).not.toContain('sk-second-private');
  });

  test('treats whitespace-only credential values as absent', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ocs-providers-'));
    const paths = createOpenClaudePaths({ home, env: {} });
    await writeFile(
      paths.openClaudeConfig,
      JSON.stringify({
        activeProviderProfileId: 'openai-profile',
        providerProfiles: [
          {
            id: 'openai-profile',
            name: 'OpenAI Team',
            provider: 'openai',
            baseUrl: 'https://api.openai.com/v1',
            model: 'gpt-example',
            apiKey: '   ',
            authHeaderValue: '\t',
          },
        ],
      }),
      'utf8',
    );

    const result = await readProviderProfiles(paths);

    expect(result.profiles[0]).toMatchObject({
      apiKeySet: false,
      authHeaderValueSet: false,
      validation: {
        status: 'warning',
        issues: expect.arrayContaining([
          expect.objectContaining({
            field: 'credential',
            severity: 'warn',
          }),
        ]),
      },
    });
  });

  test('trims configured active ids and profile ids before matching them', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ocs-providers-'));
    const paths = createOpenClaudePaths({ home, env: {} });
    await writeFile(
      paths.openClaudeConfig,
      JSON.stringify({
        activeProviderProfileId: ' openai-profile ',
        providerProfiles: [
          {
            id: ' openai-profile ',
            name: 'OpenAI Team',
            provider: 'openai',
            baseUrl: 'https://api.openai.com/v1',
            model: 'gpt-example',
            apiKey: 'sk-private',
          },
        ],
      }),
      'utf8',
    );

    const result = await readProviderProfiles(paths);

    expect(result.activeProviderProfileId).toBe('openai-profile');
    expect(result.profiles[0]).toMatchObject({
      id: 'openai-profile',
      active: true,
      validation: { status: 'valid' },
    });
  });
});
