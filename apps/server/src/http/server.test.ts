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
