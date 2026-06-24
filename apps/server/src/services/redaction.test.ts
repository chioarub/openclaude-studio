import { describe, expect, test } from 'vitest';

import { redactSecrets, redactTextSecrets, redactUrl } from './redaction.js';

describe('redaction', () => {
  test('redacts nested secret fields', () => {
    expect(
      redactSecrets({
        apiKey: 'example-api-key',
        nested: { authorization: 'Bearer token-value', safe: 'visible' },
      }),
    ).toEqual({
      apiKey: '<redacted>',
      nested: { authorization: '<redacted>', safe: 'visible' },
    });
  });

  test('redacts likely secrets in text', () => {
    expect(redactTextSecrets('OPENAI_API_KEY="example-api-key" token=plain bearer abcdefghijk')).toBe(
      'OPENAI_API_KEY="<redacted>" token=<redacted> bearer <redacted>',
    );
  });

  test('redacts query parameter secrets in text logs', () => {
    expect(
      redactTextSecrets('GET https://api.example.test/v1?api_key=secret-value&access_key=access-secret&connection_string=db-secret&custom_headers=Authorization:Bearer-secret&access_token=secret&model=x token=plain'),
    ).toBe(
      'GET https://api.example.test/v1?api_key=<redacted>&access_key=<redacted>&connection_string=<redacted>&custom_headers=<redacted>&access_token=<redacted>&model=x token=<redacted>',
    );
  });

  test('redacts URL credentials and query secrets', () => {
    expect(redactUrl('https://user:pass@example.com/v1?api_key=secret&custom_headers=secret&model=x')).toBe(
      'https://example.com/v1?api_key=%3Credacted%3E&custom_headers=%3Credacted%3E&model=x',
    );
  });

  test('redacts provider credential environment assignments without leaking pool entries', () => {
    const content = [
      'OPENAI_API_KEYS=sk-pool-a,sk-pool-b',
      'ATLAS_CLOUD_API_KEY=atlas-private',
      'NEARAI_API_KEY=near-private',
      'FIREWORKS_API_KEY=fireworks-private',
      'OPENCODE_API_KEY=opencode-private',
      'NVIDIA_API_KEY=nvidia-private',
      'ANTHROPIC_FOUNDRY_API_KEY=foundry-private',
      'XAI_API_KEY=xai-private',
      'GITHUB_TOKEN=github-private',
      'GH_TOKEN=gh-private',
      'CODEX_API_KEY=codex-private',
      'AWS_ACCESS_KEY=aws-access-private',
      'AWS_ACCESS_KEY_ID=aws-access-id-private',
      'AWS_SECRET_ACCESS_KEY=aws-secret-access-private',
      'GIT_PRIVATE_KEY=private-key-private',
      'SERVICE_ACCESS_TOKEN=service-access-private',
      'DATABASE_CONNECTION_STRING=database-connection-private',
      'DATABASE_URL=postgres://user:password@host/db',
      'OPENAI_AUTH_HEADER_VALUE=Bearer custom-private',
      'HOTKEY=ctrl-k',
      'Authorization: Bearer header-private',
    ].join('\n');

    const redacted = redactTextSecrets(content);

    expect(redacted).toContain('OPENAI_API_KEYS=<redacted>');
    expect(redacted).toContain('ATLAS_CLOUD_API_KEY=<redacted>');
    expect(redacted).toContain('NEARAI_API_KEY=<redacted>');
    expect(redacted).toContain('FIREWORKS_API_KEY=<redacted>');
    expect(redacted).toContain('OPENCODE_API_KEY=<redacted>');
    expect(redacted).toContain('NVIDIA_API_KEY=<redacted>');
    expect(redacted).toContain('ANTHROPIC_FOUNDRY_API_KEY=<redacted>');
    expect(redacted).toContain('XAI_API_KEY=<redacted>');
    expect(redacted).toContain('GITHUB_TOKEN=<redacted>');
    expect(redacted).toContain('GH_TOKEN=<redacted>');
    expect(redacted).toContain('CODEX_API_KEY=<redacted>');
    expect(redacted).toContain('AWS_ACCESS_KEY=<redacted>');
    expect(redacted).toContain('AWS_ACCESS_KEY_ID=<redacted>');
    expect(redacted).toContain('AWS_SECRET_ACCESS_KEY=<redacted>');
    expect(redacted).toContain('GIT_PRIVATE_KEY=<redacted>');
    expect(redacted).toContain('SERVICE_ACCESS_TOKEN=<redacted>');
    expect(redacted).toContain('DATABASE_CONNECTION_STRING=<redacted>');
    expect(redacted).toContain('DATABASE_URL=postgres://<redacted>@host/db');
    expect(redacted).toContain('OPENAI_AUTH_HEADER_VALUE=<redacted>');
    expect(redacted).toContain('HOTKEY=ctrl-k');
    expect(redacted).toContain('Authorization: Bearer <redacted>');
    expect(redacted).not.toContain('sk-pool-a');
    expect(redacted).not.toContain('github-private');
    expect(redacted).not.toContain('foundry-private');
    expect(redacted).not.toContain('aws-access-private');
    expect(redacted).not.toContain('aws-access-id-private');
    expect(redacted).not.toContain('aws-secret-access-private');
    expect(redacted).not.toContain('private-key-private');
    expect(redacted).not.toContain('service-access-private');
    expect(redacted).not.toContain('database-connection-private');
    expect(redacted).not.toContain('user:password');
    expect(redacted).not.toContain('custom-private');
    expect(redacted).not.toContain('header-private');
  });

  test('redacts URL userinfo, query tokens, and fragments in URLs and text', () => {
    expect(redactUrl('https://user:pass@example.com/v1?access_token=secret&model=x#token=fragment-secret')).toBe(
      'https://example.com/v1?access_token=%3Credacted%3E&model=x#%3Credacted%3E',
    );
    expect(redactUrl('postgres://user:pass@host/db')).toBe('postgres://host/db');
    expect(redactUrl('https://example.com/docs#section')).toBe('https://example.com/docs#section');
    expect(redactUrl('https://example.com/docs#this-is-a-very-long-section-name')).toBe(
      'https://example.com/docs#this-is-a-very-long-section-name',
    );
    expect(redactUrl('https://example.com/callback#abcdefghijklmnopqrstuvwxyz123456')).toBe(
      'https://example.com/callback#%3Credacted%3E',
    );
    expect(redactUrl('https://example.com/callback#code=abc123')).toBe(
      'https://example.com/callback#%3Credacted%3E',
    );
    expect(
      redactTextSecrets('GET https://user:pass@example.com/v1?api_key=query-secret#access_token=fragment-secret'),
    ).toBe('GET https://<redacted>@example.com/v1?api_key=<redacted>#<redacted>');
    expect(redactTextSecrets('GET https://example.com/callback#code=abc123')).toBe(
      'GET https://example.com/callback#<redacted>',
    );
    expect(redactTextSecrets('GET https://example.com/docs#section')).toBe('GET https://example.com/docs#section');
    expect(redactTextSecrets('GET https://example.com/docs#this-is-a-very-long-section-name')).toBe(
      'GET https://example.com/docs#this-is-a-very-long-section-name',
    );
  });
});
