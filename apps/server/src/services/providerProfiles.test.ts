import { chmod, mkdir, symlink, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { createOpenClaudePaths } from './paths.js';
import {
  getStudioProviderDescriptors,
  recognizeStudioProvider,
} from './providerRecognition.js';
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

    const result = await readProviderProfiles(paths, {});

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

    const result = await readProviderProfiles(paths, {});

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

    const result = await readProviderProfiles(paths, {});
    const fallback = await readProviderProfiles(paths, { OPENAI_API_KEY: 'sk-env-fallback' });

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
    expect(fallback.profiles[0]?.credential).toEqual({
      credentialMode: 'single',
      credentialCount: 1,
      credentialConfigured: true,
      credentialInvalid: false,
      credentialSources: ['Studio server env: OPENAI_API_KEY'],
    });
    expect(JSON.stringify(fallback)).not.toContain('sk-env-fallback');
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

    const result = await readProviderProfiles(paths, {});

    expect(result.activeProviderProfileId).toBe('openai-profile');
    expect(result.profiles[0]).toMatchObject({
      id: 'openai-profile',
      active: true,
      validation: { status: 'valid' },
    });
  });

  test('returns provider recognition and safe credential-pool metadata without secrets', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ocs-providers-'));
    const paths = createOpenClaudePaths({ home, env: {} });
    await writeFile(
      paths.openClaudeConfig,
      JSON.stringify({
        activeProviderProfileId: 'fireworks-profile',
        providerProfiles: [
          {
            id: 'fireworks-profile',
            name: 'Fireworks Team',
            provider: 'openai',
            baseUrl: 'https://api.fireworks.ai/inference/v1',
            model: 'accounts/fireworks/models/test-model',
            apiKey: 'fw-secret-a, fw-secret-b',
          },
          {
            id: 'near-profile',
            name: 'NEAR Team',
            provider: 'openai',
            baseUrl: 'https://foo.completions.near.ai/v1',
            model: 'anthropic/claude-sonnet-4-6',
            customHeaders: {
              Authorization: 'Bearer near-private',
              'X-Trace': 'enabled',
            },
          },
        ],
      }),
      'utf8',
    );

    const result = await readProviderProfiles(paths, {});

    expect(result.summary).toMatchObject({
      total: 2,
      recognized: 2,
      startupProfileConfigured: false,
    });
    expect(result.profiles[0]).toMatchObject({
      provider: 'openai',
      recognizedProvider: {
        id: 'fireworks',
        label: 'Fireworks AI',
        category: 'hosted',
        transport: 'openai-compatible',
        discoveryMode: 'static',
        credentialEnvVars: ['FIREWORKS_API_KEY', 'OPENAI_API_KEYS', 'OPENAI_API_KEY', 'OPENAI_AUTH_HEADER_VALUE'],
        safeTemplateAvailable: false,
        inspectionOnly: false,
      },
      credential: {
        credentialMode: 'pool',
        credentialCount: 2,
        credentialConfigured: true,
        credentialInvalid: false,
        credentialSources: ['saved profile apiKey'],
      },
    });
    expect(result.profiles[1]).toMatchObject({
      recognizedProvider: {
        id: 'nearai',
        label: 'NEAR AI',
        category: 'hosted',
      },
      credential: {
        credentialMode: 'none',
        credentialCount: 0,
        credentialConfigured: false,
        credentialInvalid: false,
      },
    });
    expect(result.profiles[1]?.customHeaders).toEqual([
      { name: 'Authorization', sensitive: true, valueSet: true },
      { name: 'X-Trace', sensitive: false, valueSet: true },
    ]);
    expect(JSON.stringify(result)).not.toContain('fw-secret-a');
    expect(JSON.stringify(result)).not.toContain('fw-secret-b');
    expect(JSON.stringify(result)).not.toContain('near-private');
  });

  test('respects OpenAI pool and singular credential precedence from the Studio server environment', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ocs-providers-'));
    const paths = createOpenClaudePaths({ home, env: {} });
    await writeFile(
      paths.openClaudeConfig,
      JSON.stringify({
        providerProfiles: [
          {
            id: 'openai-profile',
            name: 'OpenAI Team',
            provider: 'openai',
            baseUrl: 'https://api.openai.com/v1',
            model: 'gpt-example',
          },
        ],
      }),
      'utf8',
    );

    const pooled = await readProviderProfiles(paths, {
      OPENAI_API_KEYS: ' sk-env-a , , sk-env-b ',
      OPENAI_API_KEY: 'sk-env-c',
    });
    expect(pooled.profiles[0]?.credential).toEqual({
      credentialMode: 'pool',
      credentialCount: 2,
      credentialConfigured: true,
      credentialInvalid: false,
      credentialSources: ['Studio server env: OPENAI_API_KEYS'],
    });
    expect(pooled.profiles[0]?.validation).toEqual({
      status: 'valid',
      issues: [],
    });

    const delimiterOnlyPool = await readProviderProfiles(paths, {
      OPENAI_API_KEYS: ', ,',
      OPENAI_API_KEY: 'sk-env-c',
    });
    expect(delimiterOnlyPool.profiles[0]?.credential).toEqual({
      credentialMode: 'single',
      credentialCount: 1,
      credentialConfigured: true,
      credentialInvalid: false,
      credentialSources: ['Studio server env: OPENAI_API_KEY'],
    });

    const duplicatePool = await readProviderProfiles(paths, {
      OPENAI_API_KEYS: 'sk-env-a,sk-env-a',
    });
    expect(duplicatePool.profiles[0]?.credential).toEqual({
      credentialMode: 'pool',
      credentialCount: 2,
      credentialConfigured: true,
      credentialInvalid: false,
      credentialSources: ['Studio server env: OPENAI_API_KEYS'],
    });

    const placeholderPool = await readProviderProfiles(paths, {
      OPENAI_API_KEYS: 'sk-env-a,SUA_CHAVE',
      OPENAI_API_KEY: 'sk-env-c',
    });
    expect(placeholderPool.profiles[0]?.credential).toEqual({
      credentialMode: 'unknown',
      credentialCount: 2,
      credentialConfigured: false,
      credentialInvalid: true,
      credentialSources: ['Studio server env: OPENAI_API_KEYS'],
    });
    expect(JSON.stringify(pooled)).not.toContain('sk-env-a');
    expect(JSON.stringify(pooled)).not.toContain('sk-env-b');
    expect(JSON.stringify(delimiterOnlyPool)).not.toContain('sk-env-c');
    expect(JSON.stringify(duplicatePool)).not.toContain('sk-env-a');
    expect(JSON.stringify(placeholderPool)).not.toContain('sk-env-a');
    expect(JSON.stringify(placeholderPool)).not.toContain('SUA_CHAVE');
  });

  test('uses environment auth-header values for OpenAI-compatible credential diagnostics', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ocs-providers-'));
    const paths = createOpenClaudePaths({ home, env: {} });
    await writeFile(
      paths.openClaudeConfig,
      JSON.stringify({
        providerProfiles: [
          {
            id: 'openai-profile',
            name: 'OpenAI Team',
            provider: 'openai',
            baseUrl: 'https://api.openai.com/v1',
            model: 'gpt-example',
          },
          {
            id: 'custom-profile',
            name: 'Custom Team',
            provider: 'openai',
            baseUrl: 'https://api.example.com/v1',
            model: 'custom-model',
          },
        ],
      }),
      'utf8',
    );

    const result = await readProviderProfiles(paths, {
      OPENAI_AUTH_HEADER: 'X-Provider-Key',
      OPENAI_AUTH_HEADER_VALUE: 'Bearer env-header-private',
    });

    expect(result.profiles[0]?.credential).toEqual({
      credentialMode: 'single',
      credentialCount: 1,
      credentialConfigured: true,
      credentialInvalid: false,
      credentialSources: ['Studio server env: OPENAI_AUTH_HEADER_VALUE'],
    });
    expect(result.profiles[0]?.validation).toEqual({
      status: 'valid',
      issues: [],
    });
    expect(result.profiles[1]?.recognizedProvider.id).toBe('custom');
    expect(result.profiles[1]?.credential).toEqual({
      credentialMode: 'single',
      credentialCount: 1,
      credentialConfigured: true,
      credentialInvalid: false,
      credentialSources: ['Studio server env: OPENAI_AUTH_HEADER_VALUE'],
    });
    expect(result.profiles[1]?.validation).toEqual({
      status: 'valid',
      issues: [],
    });
    expect(JSON.stringify(result)).not.toContain('Bearer env-header-private');
  });

  test('does not apply inherited OpenAI credentials to no-auth local providers', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ocs-providers-'));
    const paths = createOpenClaudePaths({ home, env: {} });
    await writeFile(
      paths.openClaudeConfig,
      JSON.stringify({
        providerProfiles: [
          {
            id: 'ollama-profile',
            name: 'Ollama',
            provider: 'ollama',
            baseUrl: 'http://localhost:11434/v1',
            model: 'llama3.1:8b',
          },
          {
            id: 'lmstudio-profile',
            name: 'LM Studio',
            provider: 'lmstudio',
            baseUrl: 'http://localhost:1234/v1',
            model: 'local-model',
          },
          {
            id: 'atomic-profile',
            name: 'Atomic Chat',
            provider: 'atomic-chat',
            baseUrl: 'http://127.0.0.1:1337/v1',
            model: 'atomic-model',
          },
        ],
      }),
      'utf8',
    );

    const result = await readProviderProfiles(paths, {
      OPENAI_API_KEY: 'sk-env-local-single',
      OPENAI_API_KEYS: 'sk-env-local-a,sk-env-local-b',
      OPENAI_AUTH_HEADER: 'X-Provider-Key',
      OPENAI_AUTH_HEADER_VALUE: 'Bearer env-local-header',
    });

    expect(result.profiles.map((profile) => profile.recognizedProvider.id)).toEqual([
      'ollama',
      'lmstudio',
      'atomic-chat',
    ]);
    expect(result.profiles.map((profile) => profile.credential)).toEqual([
      {
        credentialMode: 'none',
        credentialCount: 0,
        credentialConfigured: false,
        credentialInvalid: false,
        credentialSources: [],
      },
      {
        credentialMode: 'none',
        credentialCount: 0,
        credentialConfigured: false,
        credentialInvalid: false,
        credentialSources: [],
      },
      {
        credentialMode: 'none',
        credentialCount: 0,
        credentialConfigured: false,
        credentialInvalid: false,
        credentialSources: [],
      },
    ]);
    expect(JSON.stringify(result)).not.toContain('sk-env-local');
    expect(JSON.stringify(result)).not.toContain('env-local-header');
  });

  test('reports invalid saved credentials without falling back to lower-precedence environment credentials', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ocs-providers-'));
    const paths = createOpenClaudePaths({ home, env: {} });
    await writeFile(
      paths.openClaudeConfig,
      JSON.stringify({
        providerProfiles: [
          {
            id: 'openai-profile',
            name: 'OpenAI Team',
            provider: 'openai',
            baseUrl: 'https://api.openai.com/v1',
            model: 'gpt-example',
            apiKey: 'SUA_CHAVE',
          },
        ],
      }),
      'utf8',
    );

    const result = await readProviderProfiles(paths, { OPENAI_API_KEY: 'sk-env-c' });

    expect(result.profiles[0]?.credential).toEqual({
      credentialMode: 'unknown',
      credentialCount: 1,
      credentialConfigured: false,
      credentialInvalid: true,
      credentialSources: ['saved profile apiKey'],
    });
    expect(result.profiles[0]?.validation).toEqual({
      status: 'warning',
      issues: [
        {
          field: 'credential',
          severity: 'warn',
          message: 'Configured credential appears to be invalid or a placeholder.',
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain('SUA_CHAVE');
    expect(JSON.stringify(result)).not.toContain('sk-env-c');
  });

  test('recognizes Codex API-key mode from the Studio server environment', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ocs-providers-'));
    const paths = createOpenClaudePaths({ home, env: {} });
    await writeFile(
      paths.openClaudeConfig,
      JSON.stringify({
        providerProfiles: [
          {
            id: 'codex-profile',
            name: 'Codex API Key',
            provider: 'codex',
            baseUrl: 'https://chatgpt.com/backend-api/codex',
            model: 'codexplan',
          },
        ],
      }),
      'utf8',
    );

    const result = await readProviderProfiles(paths, { CODEX_API_KEY: 'codex-env-private' });

    expect(result.profiles[0]).toMatchObject({
      recognizedProvider: { id: 'codex' },
      credential: {
        credentialMode: 'single',
        credentialCount: 1,
        credentialConfigured: true,
        credentialInvalid: false,
        credentialSources: ['Studio server env: CODEX_API_KEY'],
      },
    });
    expect(JSON.stringify(result)).not.toContain('codex-env-private');
  });

  test('keeps Codex auth-header credentials in OAuth recognition mode', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ocs-providers-'));
    const paths = createOpenClaudePaths({ home, env: {} });
    await writeFile(
      paths.openClaudeConfig,
      JSON.stringify({
        providerProfiles: [
          {
            id: 'codex-profile',
            name: 'Codex Header Credential',
            provider: 'codex',
            baseUrl: 'https://chatgpt.com/backend-api/codex',
            model: 'codexplan',
            authHeaderValue: 'Bearer private-header',
          },
        ],
      }),
      'utf8',
    );

    const result = await readProviderProfiles(paths, {});

    expect(result.profiles[0]).toMatchObject({
      recognizedProvider: { id: 'codex-oauth' },
      credential: {
        credentialMode: 'single',
        credentialCount: 1,
        credentialConfigured: true,
        credentialInvalid: false,
        credentialSources: ['saved profile authHeaderValue'],
      },
    });
    expect(JSON.stringify(result)).not.toContain('private-header');
  });

  test('exposes startup profile metadata from the config root without returning env values', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ocs-providers-'));
    const paths = createOpenClaudePaths({ home, env: {} });
    await mkdir(paths.openClaudeHome, { recursive: true });
    await writeFile(
      paths.openClaudeConfig,
      JSON.stringify({ providerProfiles: [] }),
      'utf8',
    );
    await writeFile(
      join(paths.openClaudeHome, '.openclaude-profile.json'),
      JSON.stringify({
        profile: 'openai',
        createdAt: '2026-06-24T12:00:00.000Z',
        env: {
          OPENAI_BASE_URL: 'https://api.openai.com/v1',
          OPENAI_MODEL: 'gpt-example',
          OPENAI_API_KEYS: 'startup-secret-a,startup-secret-b',
          OPENAI_AUTH_HEADER_VALUE: 'Bearer startup-private',
          ANTHROPIC_CUSTOM_HEADERS: 'Authorization: Bearer private',
          AWS_ACCESS_KEY_ID: 'startup-access-key-id',
          AWS_SECRET_ACCESS_KEY: 'startup-secret-access-key',
          DATABASE_CONNECTION_STRING: 'postgres://user:password@host/db',
          DATABASE_URL: 'postgres://user:password@host/db',
          DEEPSEEK_API_KEY: 'startup-deepseek-secret',
          GIT_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----',
          JWT_SECRET_KEY: 'startup-jwt-secret-key',
          SAFE_LABEL: 'internal provider label',
          SERVICE_ACCESS_TOKEN: 'startup-access-token',
          XAI_CREDENTIAL_SOURCE: 'oauth',
        },
        ignored: 'not returned',
      }),
      'utf8',
    );

    const result = await readProviderProfiles(paths);

    expect(result.startupProfile).toMatchObject({
      exists: true,
      profile: 'openai',
      createdAt: '2026-06-24T12:00:00.000Z',
      configuredNonSecretFields: ['OPENAI_BASE_URL', 'OPENAI_MODEL'],
      credentials: [
        { name: 'ANTHROPIC_CUSTOM_HEADERS', configured: true },
        { name: 'DEEPSEEK_API_KEY', configured: true },
        { name: 'OPENAI_API_KEYS', configured: true },
        { name: 'OPENAI_AUTH_HEADER_VALUE', configured: true },
        { name: 'XAI_CREDENTIAL_SOURCE', configured: true },
      ],
      credential: {
        credentialMode: 'pool',
        credentialCount: 2,
        credentialConfigured: true,
        credentialInvalid: false,
        credentialSources: ['startup profile env: OPENAI_API_KEYS'],
      },
      recognizedProvider: {
        id: 'openai',
        label: 'OpenAI',
      },
    });
    expect(JSON.stringify(result.startupProfile)).not.toContain('startup-secret-a');
    expect(JSON.stringify(result.startupProfile)).not.toContain('startup-secret-b');
    expect(JSON.stringify(result.startupProfile)).not.toContain('startup-private');
    expect(JSON.stringify(result.startupProfile)).not.toContain('Bearer private');
    expect(JSON.stringify(result.startupProfile)).not.toContain('AWS_ACCESS_KEY_ID');
    expect(JSON.stringify(result.startupProfile)).not.toContain('startup-access-key-id');
    expect(JSON.stringify(result.startupProfile)).not.toContain('AWS_SECRET_ACCESS_KEY');
    expect(JSON.stringify(result.startupProfile)).not.toContain('startup-secret-access-key');
    expect(JSON.stringify(result.startupProfile)).not.toContain('DATABASE_CONNECTION_STRING');
    expect(JSON.stringify(result.startupProfile)).not.toContain('postgres://user:password@host/db');
    expect(JSON.stringify(result.startupProfile)).not.toContain('DATABASE_URL');
    expect(JSON.stringify(result.startupProfile)).not.toContain('startup-deepseek-secret');
    expect(JSON.stringify(result.startupProfile)).not.toContain('GIT_PRIVATE_KEY');
    expect(JSON.stringify(result.startupProfile)).not.toContain('BEGIN PRIVATE KEY');
    expect(JSON.stringify(result.startupProfile)).not.toContain('JWT_SECRET_KEY');
    expect(JSON.stringify(result.startupProfile)).not.toContain('startup-jwt-secret-key');
    expect(JSON.stringify(result.startupProfile)).not.toContain('SAFE_LABEL');
    expect(JSON.stringify(result.startupProfile)).not.toContain('internal provider label');
    expect(JSON.stringify(result.startupProfile)).not.toContain('SERVICE_ACCESS_TOKEN');
    expect(JSON.stringify(result.startupProfile)).not.toContain('startup-access-token');
    expect(JSON.stringify(result.startupProfile)).not.toContain('ignored');
  });

  test('degrades unknown future startup profiles to custom recognition', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ocs-providers-'));
    const paths = createOpenClaudePaths({ home, env: {} });
    await mkdir(paths.openClaudeHome, { recursive: true });
    await writeFile(paths.openClaudeConfig, JSON.stringify({ providerProfiles: [] }), 'utf8');
    await writeFile(
      join(paths.openClaudeHome, '.openclaude-profile.json'),
      JSON.stringify({
        profile: 'future-provider',
        env: {
          OPENAI_BASE_URL: 'https://future.example/v1',
          OPENAI_MODEL: 'future-model',
        },
      }),
      'utf8',
    );

    const result = await readProviderProfiles(paths);

    expect(result.startupProfile).toMatchObject({
      exists: true,
      profile: 'future-provider',
      configuredNonSecretFields: ['OPENAI_BASE_URL', 'OPENAI_MODEL'],
      recognizedProvider: {
        id: 'custom',
        label: 'Custom OpenAI-compatible',
      },
      diagnostics: [],
    });
  });

  test('scopes startup credential state to the recognized provider', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ocs-providers-'));
    const paths = createOpenClaudePaths({ home, env: {} });
    await mkdir(paths.openClaudeHome, { recursive: true });
    await writeFile(paths.openClaudeConfig, JSON.stringify({ providerProfiles: [] }), 'utf8');
    await writeFile(
      join(paths.openClaudeHome, '.openclaude-profile.json'),
      JSON.stringify({
        profile: 'openai',
        env: {
          OPENAI_MODEL: 'gpt-example',
          CODEX_API_KEY: 'codex-secret',
        },
      }),
      'utf8',
    );

    const openai = await readProviderProfiles(paths);
    expect(openai.startupProfile).toMatchObject({
      profile: 'openai',
      recognizedProvider: { id: 'openai' },
      credential: {
        credentialMode: 'none',
        credentialCount: 0,
        credentialConfigured: false,
        credentialInvalid: false,
        credentialSources: [],
      },
    });
    expect(JSON.stringify(openai.startupProfile)).not.toContain('codex-secret');

    await writeFile(
      join(paths.openClaudeHome, '.openclaude-profile.json'),
      JSON.stringify({
        profile: 'codex',
        env: {
          CODEX_CREDENTIAL_SOURCE: 'oauth',
          CHATGPT_ACCOUNT_ID: 'account-id',
        },
      }),
      'utf8',
    );
    const codexOauth = await readProviderProfiles(paths);
    expect(codexOauth.startupProfile).toMatchObject({
      profile: 'codex',
      recognizedProvider: { id: 'codex-oauth' },
      credential: {
        credentialMode: 'none',
        credentialCount: 0,
        credentialConfigured: false,
        credentialInvalid: false,
        credentialSources: [],
      },
    });
    expect(JSON.stringify(codexOauth.startupProfile)).not.toContain('account-id');

    await writeFile(
      join(paths.openClaudeHome, '.openclaude-profile.json'),
      JSON.stringify({
        profile: 'codex',
        env: {
          CODEX_API_KEY: 'codex-secret',
        },
      }),
      'utf8',
    );
    const codexApiKey = await readProviderProfiles(paths);
    expect(codexApiKey.startupProfile).toMatchObject({
      profile: 'codex',
      recognizedProvider: { id: 'codex' },
      credential: {
        credentialMode: 'single',
        credentialCount: 1,
        credentialConfigured: true,
        credentialInvalid: false,
        credentialSources: ['startup profile env: CODEX_API_KEY'],
      },
    });
    expect(JSON.stringify(codexApiKey.startupProfile)).not.toContain('codex-secret');
  });

  test('reports missing, malformed, symlinked, and oversized startup profiles through diagnostics', async () => {
    const missingHome = await mkdtemp(join(tmpdir(), 'ocs-providers-missing-'));
    const missingPaths = createOpenClaudePaths({ home: missingHome, env: {} });
    await writeFile(missingPaths.openClaudeConfig, JSON.stringify({ providerProfiles: [] }), 'utf8');
    const missing = await readProviderProfiles(missingPaths);
    expect(missing.startupProfile).toMatchObject({
      exists: false,
      profile: null,
      diagnostics: [expect.objectContaining({ level: 'info', message: 'File does not exist.' })],
    });

    const malformedHome = await mkdtemp(join(tmpdir(), 'ocs-providers-malformed-'));
    const malformedPaths = createOpenClaudePaths({ home: malformedHome, env: {} });
    await mkdir(malformedPaths.openClaudeHome, { recursive: true });
    await writeFile(malformedPaths.openClaudeConfig, JSON.stringify({ providerProfiles: [] }), 'utf8');
    await writeFile(join(malformedPaths.openClaudeHome, '.openclaude-profile.json'), '{"profile":42}', 'utf8');
    const malformed = await readProviderProfiles(malformedPaths);
    expect(malformed.startupProfile).toMatchObject({
      exists: true,
      profile: null,
      diagnostics: [expect.objectContaining({ level: 'error', message: 'Startup profile must contain a non-empty profile string, env object, and optional createdAt string.' })],
    });

    const invalidJsonHome = await mkdtemp(join(tmpdir(), 'ocs-providers-invalid-json-'));
    const invalidJsonPaths = createOpenClaudePaths({ home: invalidJsonHome, env: {} });
    await mkdir(invalidJsonPaths.openClaudeHome, { recursive: true });
    await writeFile(invalidJsonPaths.openClaudeConfig, JSON.stringify({ providerProfiles: [] }), 'utf8');
    await writeFile(
      join(invalidJsonPaths.openClaudeHome, '.openclaude-profile.json'),
      '{"profile":"openai","env":{"OPENAI_API_KEY":"sk-startup-private",',
      'utf8',
    );
    const invalidJson = await readProviderProfiles(invalidJsonPaths);
    expect(invalidJson.startupProfile).toMatchObject({
      exists: true,
      profile: null,
      diagnostics: [expect.objectContaining({ level: 'error', message: 'Unable to parse startup profile as JSON.' })],
    });
    expect(JSON.stringify(invalidJson.startupProfile.diagnostics)).not.toContain('sk-startup-private');
    expect(JSON.stringify(invalidJson.startupProfile.diagnostics)).not.toContain('OPENAI_API_KEY');

    const symlinkHome = await mkdtemp(join(tmpdir(), 'ocs-providers-symlink-'));
    const symlinkPaths = createOpenClaudePaths({ home: symlinkHome, env: {} });
    await mkdir(symlinkPaths.openClaudeHome, { recursive: true });
    await writeFile(symlinkPaths.openClaudeConfig, JSON.stringify({ providerProfiles: [] }), 'utf8');
    const target = join(symlinkHome, 'private-profile.json');
    await writeFile(target, JSON.stringify({ profile: 'openai', env: {}, createdAt: '2026-06-24T12:00:00.000Z' }), 'utf8');
    await symlink(target, join(symlinkPaths.openClaudeHome, '.openclaude-profile.json'));
    const symlinked = await readProviderProfiles(symlinkPaths);
    expect(symlinked.startupProfile).toMatchObject({
      exists: false,
      profile: null,
      diagnostics: [expect.objectContaining({ level: 'warn', message: 'Symlinked files are not read.' })],
    });

    if (process.platform !== 'win32' && process.getuid?.() !== 0) {
      const unreadableHome = await mkdtemp(join(tmpdir(), 'ocs-providers-unreadable-'));
      const unreadablePaths = createOpenClaudePaths({ home: unreadableHome, env: {} });
      await mkdir(unreadablePaths.openClaudeHome, { recursive: true });
      await writeFile(unreadablePaths.openClaudeConfig, JSON.stringify({ providerProfiles: [] }), 'utf8');
      const unreadableProfilePath = join(unreadablePaths.openClaudeHome, '.openclaude-profile.json');
      await writeFile(unreadableProfilePath, JSON.stringify({ profile: 'openai', env: {}, createdAt: '2026-06-24T12:00:00.000Z' }), 'utf8');
      await chmod(unreadableProfilePath, 0);
      const unreadable = await readProviderProfiles(unreadablePaths);
      expect(unreadable.startupProfile).toMatchObject({
        exists: true,
        profile: null,
        diagnostics: [expect.objectContaining({ level: 'warn', message: 'Unable to read startup profile: Permission denied.' })],
      });
    }

    const oversizedHome = await mkdtemp(join(tmpdir(), 'ocs-providers-oversized-'));
    const oversizedPaths = createOpenClaudePaths({ home: oversizedHome, env: {} });
    await mkdir(oversizedPaths.openClaudeHome, { recursive: true });
    await writeFile(oversizedPaths.openClaudeConfig, JSON.stringify({ providerProfiles: [] }), 'utf8');
    await writeFile(
      join(oversizedPaths.openClaudeHome, '.openclaude-profile.json'),
      JSON.stringify({ profile: 'openai', env: { OPENAI_MODEL: 'x'.repeat(80 * 1024) }, createdAt: '2026-06-24T12:00:00.000Z' }),
      'utf8',
    );
    const oversized = await readProviderProfiles(oversizedPaths);
    expect(oversized.startupProfile).toMatchObject({
      exists: true,
      profile: null,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ level: 'error', message: 'Startup profile exceeds the 65536 byte read limit.' }),
      ]),
    });
  });
});

describe('Provider recognition registry', () => {
  test('covers current upstream first-class routes without turning every route into a template', () => {
    expect(getStudioProviderDescriptors().map((descriptor) => descriptor.id)).toEqual([
      'anthropic',
      'atlas-cloud',
      'bankr',
      'deepseek',
      'fireworks',
      'gemini',
      'minimax',
      'moonshot',
      'nearai',
      'openai',
      'venice',
      'xai',
      'xiaomi-mimo',
      'zai',
      'atomic-chat',
      'azure-openai',
      'bedrock',
      'foundry',
      'custom',
      'dashscope-cn',
      'dashscope-intl',
      'github-enterprise',
      'github',
      'gitlawb-opengateway',
      'groq',
      'hicap',
      'kimi-code',
      'lmstudio',
      'mistral',
      'nvidia-nim',
      'ollama',
      'opencode-go',
      'opencode',
      'openrouter',
      'together',
      'vertex',
      'xiaomi-mimo-token',
      'codex',
      'codex-oauth',
    ]);

    const templates = getProviderProfileTemplates().map((template) => template.id);
    expect(templates).toEqual([
      'anthropic',
      'openai',
      'gemini',
      'zai-coding-plan',
      'codex-oauth',
      'ollama',
      'mistral',
      'custom-openai',
    ]);
    expect(templates).not.toContain('fireworks');
    expect(templates).not.toContain('nearai');
    expect(templates).not.toContain('atlas-cloud');
  });

  test.each([
    ['anthropic', 'anthropic'],
    ['atlas-cloud', 'atlas-cloud'],
    ['bankr', 'bankr'],
    ['deepseek', 'deepseek'],
    ['fireworks', 'fireworks'],
    ['gemini', 'gemini'],
    ['minimax', 'minimax'],
    ['moonshot', 'moonshot'],
    ['nearai', 'nearai'],
    ['openai', 'openai'],
    ['venice', 'venice'],
    ['xai', 'xai'],
    ['xiaomi-mimo', 'xiaomi-mimo'],
    ['zai', 'zai'],
    ['atomic-chat', 'atomic-chat'],
    ['azure-openai', 'azure-openai'],
    ['bedrock', 'bedrock'],
    ['foundry', 'foundry'],
    ['custom', 'custom'],
    ['dashscope-cn', 'dashscope-cn'],
    ['dashscope-intl', 'dashscope-intl'],
    ['github-enterprise', 'github-enterprise'],
    ['github', 'github'],
    ['gitlawb-opengateway', 'gitlawb-opengateway'],
    ['groq', 'groq'],
    ['hicap', 'hicap'],
    ['kimi-code', 'kimi-code'],
    ['lmstudio', 'lmstudio'],
    ['mistral', 'mistral'],
    ['nvidia-nim', 'nvidia-nim'],
    ['ollama', 'ollama'],
    ['opencode-go', 'opencode-go'],
    ['opencode', 'opencode'],
    ['openrouter', 'openrouter'],
    ['together', 'together'],
    ['vertex', 'vertex'],
    ['xiaomi-mimo-token', 'xiaomi-mimo-token'],
    ['codex', 'codex-oauth'],
    ['codex-oauth', 'codex-oauth'],
  ])('recognizes provider identifier %s as %s', (provider, expectedId) => {
    expect(recognizeStudioProvider({ provider, baseUrl: null, apiKeySet: false }).id).toBe(expectedId);
  });

  test('recognizes Codex API-key and OAuth modes separately', () => {
    expect(recognizeStudioProvider({ provider: 'codex', baseUrl: null, apiKeySet: true }).id).toBe('codex');
    expect(recognizeStudioProvider({ provider: 'codex', baseUrl: null, apiKeySet: false }).id).toBe('codex-oauth');
  });

  test('recognizes GitHub Enterprise Copilot only by explicit provider id', () => {
    expect(
      recognizeStudioProvider({
        provider: 'github-enterprise',
        baseUrl: 'https://api.githubcopilot.com',
        apiKeySet: true,
      }).id,
    ).toBe('github-enterprise');
  });

  test.each([
    ['https://api.anthropic.com/v1', 'anthropic'],
    ['https://api.fireworks.ai/inference/v1', 'fireworks'],
    ['https://API.Fireworks.AI/inference/v1', 'fireworks'],
    ['https://generativelanguage.googleapis.com/v1beta/models', 'gemini'],
    ['https://cloud-api.near.ai/v1', 'nearai'],
    ['https://foo.completions.near.ai/v1', 'nearai'],
    ['https://api.atlascloud.ai/v1', 'atlas-cloud'],
    ['https://api.x.ai/v1', 'xai'],
    ['https://api.xiaomimimo.com/v1', 'xiaomi-mimo'],
    ['https://api.mimo-v2.com/v1', 'xiaomi-mimo'],
    ['https://token-plan-cn.xiaomimimo.com/v1', 'xiaomi-mimo-token'],
    ['https://opencode.ai/zen/go/v1', 'opencode-go'],
    ['https://opencode.ai/zen/v1', 'opencode'],
    ['https://opengateway.gitlawb.com/v1', 'gitlawb-opengateway'],
    ['https://api.githubcopilot.com', 'github'],
    ['https://integrate.api.nvidia.com/v1', 'nvidia-nim'],
    ['http://localhost:11434/v1', 'ollama'],
    ['http://127.0.0.1:1234/v1', 'lmstudio'],
    ['http://127.0.0.1:1337/v1', 'atomic-chat'],
    ['https://chatgpt.com/backend-api/codex', 'codex-oauth'],
  ])('recognizes controlled hostname %s as %s', (baseUrl, expectedId) => {
    expect(recognizeStudioProvider({ provider: 'openai', baseUrl, apiKeySet: false }).id).toBe(expectedId);
  });

  test.each([
    'https://api.fireworks.ai.evil.test/inference/v1',
    'https://cloud-api.near.ai.evil.test/v1',
    'https://evilcompletions.near.ai/v1',
    'https://api.x.ai.attacker.example/v1',
    'https://chatgpt.com.attacker.example/backend-api/codex',
    'https://api.remote.example:1234/v1',
  ])('does not recognize deceptive hostname %s', (baseUrl) => {
    expect(recognizeStudioProvider({ provider: 'openai', baseUrl, apiKeySet: false }).id).toBe('custom');
  });

  test('classifies unknown future provider ids as custom', () => {
    const recognized = recognizeStudioProvider({
      provider: 'future-provider',
      baseUrl: 'https://future.example/v1',
      apiKeySet: false,
    });

    expect(recognized).toMatchObject({
      id: 'custom',
      label: 'Custom OpenAI-compatible',
      category: 'custom',
    });
  });
});
