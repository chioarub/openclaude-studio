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
      redactTextSecrets('GET https://api.example.test/v1?api_key=secret-value&access_token=secret&model=x token=plain'),
    ).toBe(
      'GET https://api.example.test/v1?api_key=<redacted>&access_token=<redacted>&model=x token=<redacted>',
    );
  });

  test('redacts URL credentials and query secrets', () => {
    expect(redactUrl('https://user:pass@example.com/v1?api_key=secret&model=x')).toBe(
      'https://example.com/v1?api_key=%3Credacted%3E&model=x',
    );
  });
});
