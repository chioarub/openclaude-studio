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
  test('serves a safe local API landing page without an API token', async () => {
    const server = await testServer();

    const response = await server.inject({ method: 'GET', url: '/?source=browser' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/plain');
    expect(response.body).toContain('OpenClaude Studio local API is running.');
    expect(response.body).toContain('https://openclaude-studio.pages.dev/');
    expect(response.body).toContain('/api/health');
    expect(response.body).toContain('This API is read-only.');
  });

  test('serves health without an API token', async () => {
    const server = await testServer();

    const response = await server.inject({ method: 'GET', url: '/api/health?poll=1' });

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

  test('allows the official hosted browser origin by default', async () => {
    const server = await testServer();

    const response = await server.inject({
      method: 'GET',
      url: '/api/health',
      headers: { origin: 'https://openclaude-studio.pages.dev' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBe('https://openclaude-studio.pages.dev');
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

  test('allows private network preflights for the official hosted browser origin by default', async () => {
    const server = await testServer();

    const response = await server.inject({
      method: 'OPTIONS',
      url: '/api/projects',
      headers: {
        'access-control-request-method': 'GET',
        'access-control-request-private-network': 'true',
        origin: 'https://openclaude-studio.pages.dev',
      },
    });

    expect(response.statusCode).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe('https://openclaude-studio.pages.dev');
    expect(response.headers['access-control-allow-private-network']).toBe('true');
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

  test('returns transcript-discovered projects from the projects response', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ocs-http-'));
    const projectPath = join(home, 'transcript-project');
    const paths = createOpenClaudePaths({ home, env: {} });
    const transcriptDir = join(paths.projectsDir, encodeProjectPath(projectPath));
    await mkdir(join(projectPath, '.git'), { recursive: true });
    await writeFile(join(projectPath, '.git', 'HEAD'), 'ref: refs/heads/transcript-main\n', 'utf8');
    await mkdir(transcriptDir, { recursive: true });
    await writeFile(paths.openClaudeConfig, JSON.stringify({ projects: {} }), 'utf8');
    await writeFile(
      join(transcriptDir, 'route-transcript-session.jsonl'),
      JSON.stringify({
        type: 'assistant',
        sessionId: 'route-transcript-session',
        timestamp: '2026-05-28T08:00:00.000Z',
        cwd: projectPath,
        message: {
          role: 'assistant',
          usage: { input_tokens: 21, output_tokens: 34 },
          content: 'Transcript-backed route project',
        },
      }),
      'utf8',
    );
    const server = await testServer(home);

    const response = await server.inject({ method: 'GET', url: '/api/projects', headers: tokenHeaders() });

    expect(response.statusCode).toBe(200);
    expect(response.json().projects).toEqual([
      expect.objectContaining({
        name: 'transcript-project',
        path: projectPath,
        branch: 'transcript-main',
        usage: expect.objectContaining({
          inputTokens: 21,
          outputTokens: 34,
          lastSessionId: 'route-transcript-session',
        }),
      }),
    ]);
  });

  test('serves latest log windows through the tail query parameter', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ocs-http-'));
    const paths = createOpenClaudePaths({ home, env: {} });
    await mkdir(paths.debugDir, { recursive: true });
    await writeFile(
      join(paths.debugDir, 'session-tail.txt'),
      [
        '2026-05-28T08:00:00.000Z INFO line-1',
        '2026-05-28T08:01:00.000Z INFO line-2',
        '2026-05-28T08:02:00.000Z WARN line-3',
        '2026-05-28T08:03:00.000Z INFO line-4',
        '2026-05-28T08:04:00.000Z ERROR line-5',
      ].join('\n'),
      'utf8',
    );
    const server = await testServer(home);

    const response = await server.inject({
      method: 'GET',
      url: '/api/logs/window?tail=true&count=2',
      headers: tokenHeaders(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      start: 3,
      totalLines: 5,
      entries: [
        { lineNumber: 4, message: 'line-4' },
        { lineNumber: 5, message: 'line-5' },
      ],
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
      usageSeries: [
        {
          date: '2026-05-28',
          name: '05-28',
          inputTokens: 10,
          outputTokens: 20,
          totalTokens: 30,
          costUsd: 0.25,
          sessionCount: 1,
          sessionIds: ['session-1'],
        },
      ],
    });
    expect(sessions.json().sessions[0]).toMatchObject({ id: 'session-1', title: 'Build the API' });
    expect(logs.json().entries[0]).toMatchObject({
      level: 'warn',
      message: 'OPENAI_API_KEY=<redacted> slow',
    });
    expect(logs.json().files.map((file: { name: string }) => file.name)).toEqual(['session-1.txt']);
  });

  test('returns read-only provider profile management data', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ocs-http-'));
    const paths = createOpenClaudePaths({ home, env: {} });
    await writeFile(
      paths.openClaudeConfig,
      JSON.stringify({
        activeProviderProfileId: 'provider-1',
        providerProfiles: [
          {
            id: 'provider-1',
            name: 'OpenAI',
            provider: 'openai',
            model: 'gpt-example',
            baseUrl: 'https://user:pass@example.com/v1?api_key=hidden',
            apiKey: 'sk-route-private',
            customHeaders: { Authorization: 'Bearer private-header' },
          },
        ],
      }),
      'utf8',
    );
    const server = await testServer(home);
    const headers = tokenHeaders();

    const unauthorized = await server.inject({ method: 'GET', url: '/api/provider/profiles' });
    const response = await server.inject({ method: 'GET', url: '/api/provider/profiles', headers });
    const mutation = await server.inject({ method: 'POST', url: '/api/provider/profiles', headers });

    expect(unauthorized.statusCode).toBe(401);
    expect(response.statusCode).toBe(200);
    const payload = response.json() as {
      templates: unknown[];
      profiles: Array<Record<string, unknown> & { customHeaders?: Array<Record<string, unknown>> }>;
    };
    expect(payload).toMatchObject({
      path: paths.openClaudeConfig,
      sensitiveFieldsRedacted: true,
      summary: { total: 1, active: 1, errors: 0 },
      profiles: [
        {
          id: 'provider-1',
          active: true,
          apiKeySet: true,
          baseUrl: 'https://example.com/v1?api_key=%3Credacted%3E',
        },
      ],
    });
    expect(payload.templates.length).toBeGreaterThan(0);
    expect(payload.profiles[0]).not.toHaveProperty('apiKey');
    expect(payload.profiles[0]).not.toHaveProperty('authHeaderValue');
    expect(payload.profiles[0]?.customHeaders).toEqual([
      { name: 'Authorization', sensitive: true, valueSet: true },
    ]);
    expect(payload.profiles[0]?.customHeaders?.[0]).not.toHaveProperty('value');
    expect(mutation.statusCode).toBe(404);
  });

  test('returns session details for an existing session', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ocs-http-'));
    const projectPath = join(home, 'project-a');
    const paths = createOpenClaudePaths({ home, env: {} });
    await mkdir(projectPath, { recursive: true });
    await mkdir(join(projectPath, '.git'), { recursive: true });
    await writeFile(join(projectPath, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
    await writeFile(
      paths.openClaudeConfig,
      JSON.stringify({
        providerProfiles: [],
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
    const projectDir = join(paths.projectsDir, encodeProjectPath(projectPath));
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(projectDir, 'session-1.jsonl'),
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
            usage: { input_tokens: 100, output_tokens: 200 },
            content: [{ type: 'text', text: 'Done' }],
          },
        }),
      ].join('\n'),
      'utf8',
    );
    const server = await testServer(home);
    const headers = tokenHeaders();

    const projects = await server.inject({ method: 'GET', url: '/api/projects', headers });
    const projectId = projects.json().projects[0].id;
    const detail = await server.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/sessions/session-1`,
      headers,
    });

    expect(detail.statusCode).toBe(200);
    const body = detail.json();
    expect(body.session).toMatchObject({ id: 'session-1', title: 'Build the API' });
    expect(body.timeline).toBeInstanceOf(Array);
    expect(body.timeline).toHaveLength(2);
  });

  test('returns a session change review through the read-only session changes route', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ocs-http-'));
    const projectPath = join(home, 'project-a');
    const paths = createOpenClaudePaths({ home, env: {} });
    await mkdir(join(projectPath, 'src'), { recursive: true });
    await writeFile(join(projectPath, 'src', 'api.ts'), 'export const value = 1;\n', 'utf8');
    await writeFile(
      paths.openClaudeConfig,
      JSON.stringify({
        providerProfiles: [],
        projects: {
          [projectPath]: {
            lastGracefulShutdown: '2026-05-28T08:00:00.000Z',
            lastSessionId: 'session-review',
          },
        },
      }),
      'utf8',
    );
    const projectDir = join(paths.projectsDir, encodeProjectPath(projectPath));
    await mkdir(projectDir, { recursive: true });
    await mkdir(join(paths.fileHistoryDir, 'session-review'), { recursive: true });
    await writeFile(join(paths.fileHistoryDir, 'session-review', 'api@v1'), 'export const value = 0;\n', 'utf8');
    await writeFile(
      join(projectDir, 'session-review.jsonl'),
      [
        JSON.stringify({
          type: 'assistant',
          sessionId: 'session-review',
          timestamp: '2026-05-28T08:01:00.000Z',
          cwd: projectPath,
          message: {
            role: 'assistant',
            model: 'claude-sonnet',
            content: [
              {
                type: 'tool_use',
                id: 'edit-api',
                name: 'Edit',
                input: { file_path: 'src/api.ts' },
              },
            ],
          },
        }),
        JSON.stringify({
          type: 'file-history-snapshot',
          timestamp: '2026-05-28T08:01:01.000Z',
          snapshot: {
            timestamp: '2026-05-28T08:01:01.000Z',
            trackedFileBackups: {
              'src/api.ts': {
                backupFileName: 'api@v1',
                version: 1,
                backupTime: '2026-05-28T08:01:01.000Z',
              },
            },
          },
        }),
      ].join('\n'),
      'utf8',
    );
    const server = await testServer(home);
    const headers = tokenHeaders();

    const projects = await server.inject({ method: 'GET', url: '/api/projects', headers });
    const projectId = projects.json().projects[0].id;
    const response = await server.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/sessions/session-review/changes`,
      headers,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      sessionId: 'session-review',
      totals: { fileCount: 1, additions: 1, deletions: 1, backupCount: 1 },
      files: [
        {
          filePath: 'src/api.ts',
          status: 'modified',
          backupFileName: 'api@v1',
          diff: {
            hunks: [
              {
                lines: [
                  { kind: 'remove', text: 'export const value = 0;' },
                  { kind: 'add', text: 'export const value = 1;' },
                ],
              },
            ],
          },
        },
      ],
    });
  });

  test('serves project-scoped plans and tasks through read-only endpoints', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ocs-http-'));
    const projectPath = join(home, 'project-a');
    const otherProjectPath = join(home, 'project-b');
    const paths = createOpenClaudePaths({ home, env: {} });
    await mkdir(projectPath, { recursive: true });
    await mkdir(otherProjectPath, { recursive: true });
    await writeFile(
      paths.openClaudeConfig,
      JSON.stringify({
        providerProfiles: [],
        projects: {
          [projectPath]: { lastGracefulShutdown: '2026-05-28T08:00:00.000Z' },
          [otherProjectPath]: { lastGracefulShutdown: '2026-05-28T08:00:00.000Z' },
        },
      }),
      'utf8',
    );
    await mkdir(join(paths.projectsDir, encodeProjectPath(projectPath)), { recursive: true });
    await mkdir(join(paths.projectsDir, encodeProjectPath(otherProjectPath)), { recursive: true });
    await mkdir(join(paths.tasksDir, 'route-session'), { recursive: true });
    await mkdir(join(paths.tasksDir, 'other-route-session'), { recursive: true });
    await mkdir(paths.plansDir, { recursive: true });
    await writeFile(join(paths.plansDir, 'route-plan.md'), '# Route Plan\n\nOPENAI_API_KEY=sk-route-secret\n');
    await writeFile(join(paths.plansDir, 'other-route-plan.md'), '# Other Route Plan\n\nDo not expose.\n');
    await writeFile(
      join(paths.tasksDir, 'route-session', '1.json'),
      `${JSON.stringify({ subject: 'Route task', status: 'in_progress', apiKey: 'task-secret' })}\n`,
    );
    await writeFile(
      join(paths.tasksDir, 'other-route-session', '1.json'),
      `${JSON.stringify({ subject: 'Other route task', status: 'completed' })}\n`,
    );
    await writeFile(
      join(paths.projectsDir, encodeProjectPath(projectPath), 'route-session.jsonl'),
      `${JSON.stringify({
        type: 'user',
        sessionId: 'route-session',
        timestamp: '2026-05-28T08:00:00.000Z',
        cwd: projectPath,
        slug: 'route-plan',
        message: { role: 'user', content: 'Use route task' },
      })}\n`,
      'utf8',
    );
    await writeFile(
      join(paths.projectsDir, encodeProjectPath(otherProjectPath), 'other-route-session.jsonl'),
      `${JSON.stringify({
        type: 'user',
        sessionId: 'other-route-session',
        timestamp: '2026-05-28T08:00:00.000Z',
        cwd: otherProjectPath,
        slug: 'other-route-plan',
        message: { role: 'user', content: 'Use other route task' },
      })}\n`,
      'utf8',
    );
    const server = await testServer(home);
    const headers = tokenHeaders();

    const projects = await server.inject({ method: 'GET', url: '/api/projects', headers });
    const projectId = projects.json().projects.find((project: { path: string }) => project.path === projectPath).id;
    const plans = await server.inject({ method: 'GET', url: `/api/projects/${projectId}/plans`, headers });
    const planDetail = await server.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/plans/route-plan`,
      headers,
    });
    const otherPlanDetail = await server.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/plans/other-route-plan`,
      headers,
    });
    const tasks = await server.inject({ method: 'GET', url: `/api/projects/${projectId}/tasks`, headers });
    const taskDetail = await server.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/tasks/route-session/1`,
      headers,
    });
    const otherTaskDetail = await server.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/tasks/other-route-session/1`,
      headers,
    });

    expect(plans.statusCode).toBe(200);
    expect(plans.json().plans.map((plan: { id: string }) => plan.id)).toEqual(['route-plan']);
    expect(JSON.stringify(plans.json())).not.toContain('Other Route Plan');
    expect(planDetail.statusCode).toBe(200);
    expect(planDetail.json().plan.content).toContain('OPENAI_API_KEY=<redacted>');
    expect(planDetail.json().plan.content).not.toContain('sk-route-secret');
    expect(otherPlanDetail.statusCode).toBe(404);
    expect(otherPlanDetail.json()).toMatchObject({ code: 'PLAN_NOT_FOUND' });
    expect(tasks.statusCode).toBe(200);
    expect(tasks.json().tasks.map((task: { title: string }) => task.title)).toEqual(['Route task']);
    expect(JSON.stringify(tasks.json())).not.toContain('Other route task');
    expect(taskDetail.statusCode).toBe(200);
    expect(taskDetail.json().task.content).toContain('"apiKey": "<redacted>"');
    expect(taskDetail.json().task.content).not.toContain('task-secret');
    expect(otherTaskDetail.statusCode).toBe(404);
    expect(otherTaskDetail.json()).toMatchObject({ code: 'TASK_NOT_FOUND' });
  });

  test('returns 404 for nonexistent session', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ocs-http-'));
    const projectPath = join(home, 'project-a');
    const paths = createOpenClaudePaths({ home, env: {} });
    await mkdir(projectPath, { recursive: true });
    await mkdir(join(projectPath, '.git'), { recursive: true });
    await writeFile(join(projectPath, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
    await writeFile(
      paths.openClaudeConfig,
      JSON.stringify({
        providerProfiles: [],
        projects: {
          [projectPath]: { lastGracefulShutdown: '2026-05-28T08:00:00.000Z' },
        },
      }),
      'utf8',
    );
    await mkdir(join(paths.projectsDir, encodeProjectPath(projectPath)), { recursive: true });
    const server = await testServer(home);
    const headers = tokenHeaders();

    const projects = await server.inject({ method: 'GET', url: '/api/projects', headers });
    const projectId = projects.json().projects[0].id;
    const response = await server.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/sessions/nonexistent`,
      headers,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'NOT_FOUND' });
  });

  test('returns 404 for nonexistent session change review', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ocs-http-'));
    const projectPath = join(home, 'project-a');
    const paths = createOpenClaudePaths({ home, env: {} });
    await mkdir(projectPath, { recursive: true });
    await writeFile(
      paths.openClaudeConfig,
      JSON.stringify({
        providerProfiles: [],
        projects: {
          [projectPath]: { lastGracefulShutdown: '2026-05-28T08:00:00.000Z' },
        },
      }),
      'utf8',
    );
    await mkdir(join(paths.projectsDir, encodeProjectPath(projectPath)), { recursive: true });
    const server = await testServer(home);
    const headers = tokenHeaders();

    const projects = await server.inject({ method: 'GET', url: '/api/projects', headers });
    const projectId = projects.json().projects[0].id;
    const response = await server.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/sessions/nonexistent/changes`,
      headers,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'NOT_FOUND' });
  });

  test('surfaces a config-dir conflict warning through /api/projects diagnostics', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ocs-conflict-'));
    const preferred = await mkdtemp(join(tmpdir(), 'ocs-preferred-'));
    const server = await buildServer({
      env: {
        OPENCLAUDE_CONFIG_DIR: preferred,
        CLAUDE_CONFIG_DIR: '/tmp/different-legacy-value',
      },
      home,
      version: '0.0.1-test',
    });
    servers.push(server);

    const response = await server.inject({ method: 'GET', url: '/api/projects' });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { diagnostics?: Array<{ level: string; message: string }> };
    const conflict = body.diagnostics?.find(
      diagnostic =>
        diagnostic.level === 'warn' && diagnostic.message.includes('OPENCLAUDE_CONFIG_DIR'),
    );

    expect(conflict).toBeDefined();
    // Privacy: the conflict diagnostic itself must not leak any path value.
    // (Other diagnostics in the response may include paths — that is the
    // established pattern elsewhere in the API and out of scope for this PR.)
    expect(conflict?.message).not.toContain(preferred);
    expect(conflict?.message).not.toContain('/tmp/different-legacy-value');
    expect(conflict?.message).not.toContain(home);
  });

  test('still surfaces the config-dir conflict warning when the global config is missing', async () => {
    // Regression: the diagnostic must appear even when readRawOpenClaudeConfig
    // cannot find the config file — that is exactly when users misconfigure.
    const home = await mkdtemp(join(tmpdir(), 'ocs-conflict-missing-'));
    const preferred = await mkdtemp(join(tmpdir(), 'ocs-preferred-missing-'));
    const server = await buildServer({
      env: {
        OPENCLAUDE_CONFIG_DIR: preferred,
        CLAUDE_CONFIG_DIR: '/tmp/different-legacy-value',
      },
      home,
      version: '0.0.1-test',
    });
    servers.push(server);

    const response = await server.inject({ method: 'GET', url: '/api/projects' });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { diagnostics?: Array<{ level: string; message: string }> };
    expect(
      body.diagnostics?.some(
        diagnostic =>
          diagnostic.level === 'warn' && diagnostic.message.includes('OPENCLAUDE_CONFIG_DIR'),
      ),
    ).toBe(true);
  });

  test('returns an empty background sessions list when none exist', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ocs-http-bg-'));
    const server = await testServer(home);

    const response = await server.inject({
      method: 'GET',
      url: '/api/background-sessions',
      headers: tokenHeaders(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      sessions: [],
      statusCounts: {
        running: 0,
        unknown: 0,
        exited: 0,
        failed: 0,
        stale: 0,
        killed: 0,
      },
    });
  });

  test('returns background session metadata and bounded logs through read-only endpoints', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ocs-http-bg-'));
    const sessionsRoot = join(home, '.openclaude', 'bg-sessions');
    await mkdir(join(sessionsRoot, 'sessions'), { recursive: true });
    await mkdir(join(sessionsRoot, 'logs'), { recursive: true });
    await writeFile(
      join(sessionsRoot, 'sessions', 'abc12345.json'),
      JSON.stringify({
        id: 'abc12345',
        name: 'my-bg-task',
        pid: 4242,
        cwd: '/tmp/project',
        status: 'running',
        provider: 'anthropic',
        model: 'claude-sonnet-4',
        sessionId: 'sess-001',
        startedAt: '2026-06-01T10:00:00.000Z',
        updatedAt: '2026-06-01T10:05:00.000Z',
        command: ['openclaude', '--print', '--bg'],
      }),
      'utf8',
    );
    await writeFile(
      join(sessionsRoot, 'logs', 'abc12345.out.log'),
      ['starting', 'OPENAI_API_KEY=sk-leak calling'].join('\n'),
      'utf8',
    );
    const server = await testServer(home);

    const listResponse = await server.inject({
      method: 'GET',
      url: '/api/background-sessions',
      headers: tokenHeaders(),
    });

    expect(listResponse.statusCode).toBe(200);
    const listBody = listResponse.json() as { sessions: Array<{ id: string; recordedStatus: string }> };
    expect(listBody.sessions).toHaveLength(1);
    expect(listBody.sessions[0]).toMatchObject({ id: 'abc12345', recordedStatus: 'running' });

    const logsResponse = await server.inject({
      method: 'GET',
      url: '/api/background-sessions/abc12345/logs?stream=stdout&tail=true&count=1',
      headers: tokenHeaders(),
    });

    expect(logsResponse.statusCode).toBe(200);
    const logsBody = logsResponse.json() as { entries: Array<{ text: string }>; totalLines: number };
    expect(logsBody.totalLines).toBe(2);
    expect(logsBody.entries).toHaveLength(1);
    expect(logsBody.entries[0]?.text).toBe('OPENAI_API_KEY=<redacted> calling');
  });

  test('rejects unsafe background session ids in the logs endpoint', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ocs-http-bg-'));
    const server = await testServer(home);

    const response = await server.inject({
      method: 'GET',
      url: '/api/background-sessions/..secret/logs',
      headers: tokenHeaders(),
    });

    expect(response.statusCode).toBe(400);
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
