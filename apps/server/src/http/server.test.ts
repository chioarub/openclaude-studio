import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { createOpenClaudePaths, encodeProjectPath } from '../services/paths.js';
import { buildServer } from './server.js';

const servers: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(servers.map((server) => server.close()));
  servers.length = 0;
});

describe('HTTP server', () => {
  test('serves health without an API token', async () => {
    const server = await testServer();

    const response = await server.inject({ method: 'GET', url: '/api/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'ok', version: '0.0.1-test' });
  });

  test('requires the API token for data endpoints', async () => {
    const server = await testServer();

    const response = await server.inject({ method: 'GET', url: '/api/projects' });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 'UNAUTHORIZED' });
  });

  test('serves data endpoints without a token when auth is not configured', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ocs-http-'));
    const server = await buildServer({ env: {}, home, version: '0.0.1-test' });
    servers.push(server);

    const response = await server.inject({ method: 'GET', url: '/api/projects' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ projects: [] });
  });

  test('allows loopback browser origins on any local dev port', async () => {
    const server = await testServer();

    const ipv4Response = await server.inject({
      method: 'GET',
      url: '/api/health',
      headers: { origin: 'http://127.0.0.1:5174' },
    });
    const ipv6Response = await server.inject({
      method: 'GET',
      url: '/api/health',
      headers: { origin: 'http://[::1]:5174' },
    });

    expect(ipv4Response.statusCode).toBe(200);
    expect(ipv4Response.headers['access-control-allow-origin']).toBe('http://127.0.0.1:5174');
    expect(ipv6Response.statusCode).toBe(200);
    expect(ipv6Response.headers['access-control-allow-origin']).toBe('http://[::1]:5174');
  });

  test('does not allow public browser origins unless explicitly configured', async () => {
    const server = await testServer();

    const response = await server.inject({
      method: 'GET',
      url: '/api/health',
      headers: { origin: 'https://example.com' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  test('allows configured hosted browser origins from server environment', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ocs-http-'));
    const server = await buildServer({
      authToken: 'test-token',
      env: { OPENCLAUDE_STUDIO_ALLOWED_ORIGINS: 'https://studio.example.com' },
      home,
      version: '0.0.1-test',
    });
    servers.push(server);

    const response = await server.inject({
      method: 'GET',
      url: '/api/health',
      headers: { origin: 'https://studio.example.com' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBe('https://studio.example.com');
  });

  test('allows private network preflights for configured hosted browser origins', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ocs-http-'));
    const server = await buildServer({
      authToken: 'test-token',
      allowedOrigins: ['https://studio.example.com'],
      env: {},
      home,
      version: '0.0.1-test',
    });
    servers.push(server);

    const response = await server.inject({
      method: 'OPTIONS',
      url: '/api/projects',
      headers: {
        'access-control-request-method': 'GET',
        'access-control-request-private-network': 'true',
        origin: 'https://studio.example.com',
      },
    });

    expect(response.statusCode).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe('https://studio.example.com');
    expect(response.headers['access-control-allow-private-network']).toBe('true');
  });

  test('does not allow private network preflights for unconfigured public origins', async () => {
    const server = await testServer();

    const response = await server.inject({
      method: 'OPTIONS',
      url: '/api/projects',
      headers: {
        'access-control-request-method': 'GET',
        'access-control-request-private-network': 'true',
        origin: 'https://example.com',
      },
    });

    expect(response.statusCode).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    expect(response.headers['access-control-allow-private-network']).toBeUndefined();
  });

  test('returns project discovery diagnostics with the projects response', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ocs-http-'));
    const paths = createOpenClaudePaths({ home, env: {} });
    await writeFile(paths.openClaudeConfig, '{not-json', 'utf8');
    const server = await testServer(home);

    const response = await server.inject({ method: 'GET', url: '/api/projects', headers: tokenHeaders() });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      projects: [],
      diagnostics: [{ level: 'error', message: expect.stringContaining('Unable to parse global config') }],
    });
  });

  test('returns projects, overview, sessions, and logs through read-only endpoints', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ocs-http-'));
    const projectPath = join(home, 'project-a');
    const paths = createOpenClaudePaths({ home, env: {} });
    await mkdir(projectPath, { recursive: true });
    await mkdir(join(projectPath, '.git'), { recursive: true });
    await writeFile(join(projectPath, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
    await writeFile(
      paths.openClaudeConfig,
      JSON.stringify({
        activeProviderProfileId: 'provider-1',
        providerProfiles: [
          {
            id: 'provider-1',
            name: 'Anthropic',
            provider: 'anthropic',
            model: 'claude-sonnet',
            baseUrl: 'https://user:pass@example.com/v1?api_key=secret',
            apiKey: 'secret',
          },
        ],
        projects: {
          [projectPath]: {
            lastGracefulShutdown: '2026-05-28T08:00:00.000Z',
            lastSessionId: 'session-1',
            lastCost: 0.25,
          },
        },
      }),
      'utf8',
    );
    await mkdir(join(paths.projectsDir, encodeProjectPath(projectPath)), { recursive: true });
    await writeFile(
      join(paths.projectsDir, encodeProjectPath(projectPath), 'session-1.jsonl'),
      [
        JSON.stringify({
          type: 'user',
          sessionId: 'session-1',
          timestamp: '2026-05-28T08:00:00.000Z',
          cwd: projectPath,
          message: { role: 'user', content: 'Build the API' },
        }),
        JSON.stringify({
          type: 'assistant',
          sessionId: 'session-1',
          timestamp: '2026-05-28T08:01:00.000Z',
          cwd: projectPath,
          message: {
            role: 'assistant',
            model: 'claude-sonnet',
            usage: { input_tokens: 10, output_tokens: 20 },
            content: [{ type: 'text', text: 'Done' }],
          },
        }),
      ].join('\n'),
      'utf8',
    );
    await mkdir(paths.debugDir, { recursive: true });
    await writeFile(
      join(paths.debugDir, 'session-1.txt'),
      '2026-05-28T08:00:00.000Z WARN OPENAI_API_KEY=secret-value slow\n',
      'utf8',
    );
    await writeFile(
      join(paths.debugDir, 'session-other.txt'),
      '2026-05-28T08:00:00.000Z ERROR other project log\n',
      'utf8',
    );
    const server = await testServer(home);
    const headers = tokenHeaders();

    const projects = await server.inject({ method: 'GET', url: '/api/projects', headers });
    const projectId = projects.json().projects[0].id;
    const overview = await server.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/overview`,
      headers,
    });
    const sessions = await server.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/sessions`,
      headers,
    });
    const logs = await server.inject({
      method: 'GET',
      url: `/api/logs/window?projectId=${projectId}`,
      headers,
    });

    expect(projects.statusCode).toBe(200);
    expect(projects.json().projects[0]).toMatchObject({ name: 'project-a', branch: 'main' });
    expect(overview.json()).toMatchObject({
      provider: { id: 'provider-1', baseUrl: 'https://example.com/v1?api_key=%3Credacted%3E' },
      cards: { sessionCount: 1, totalTokens: 30, totalCostUsd: 0.25, logWarningCount: 1 },
    });
    expect(sessions.json().sessions[0]).toMatchObject({ id: 'session-1', title: 'Build the API' });
    expect(logs.json().entries[0]).toMatchObject({
      level: 'warn',
      message: 'OPENAI_API_KEY=<redacted> slow',
    });
    expect(logs.json().files.map((file: { name: string }) => file.name)).toEqual(['session-1.txt']);
  });
});

async function testServer(home = '/tmp/ocs-empty-home'): Promise<FastifyInstance> {
  const server = await buildServer({
    authToken: 'test-token',
    env: {},
    home,
    version: '0.0.1-test',
  });
  servers.push(server);
  return server;
}

function tokenHeaders() {
  return { 'x-openclaude-studio-token': 'test-token' };
}
