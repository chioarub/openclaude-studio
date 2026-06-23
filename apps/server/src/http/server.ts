import cors from '@fastify/cors';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';

import type {
  ApiErrorResponse,
  Diagnostic,
  HealthResponse,
  LogEntry,
  OverviewResponse,
  OverviewUsagePoint,
  ProjectsResponse,
  ProjectSummary,
  SessionSummary,
} from '@openclaude-studio/shared';

import {
  readActiveProvider,
  readProjectSummaries,
  readProjectSummariesWithDiagnostics,
} from '../services/openclaudeData.js';
import { listBackgroundSessions, readBackgroundSessionLogs, type BackgroundLogWindowRequest } from '../services/backgroundSessions.js';
import { readProviderProfiles } from '../services/providerProfiles.js';
import { listLogFiles, readLogWindow, searchLogs, type LogFileScope, type LogSearchRequest } from '../services/logs.js';
import { listProjectPlans, readProjectPlan } from '../services/plans.js';
import { createOpenClaudePaths, type PathOptions } from '../services/paths.js';
import { readSessionChangeReview } from '../services/sessionChangeReview.js';
import { readSessionSummaries } from '../services/sessions.js';
import { readSessionDetails } from '../services/sessionDetails.js';
import { listProjectTasks, readProjectTask } from '../services/tasks.js';
import { ApiError } from './errors.js';

export type ServerOptions = PathOptions & {
  authToken?: string;
  allowedOrigins?: string[];
  version?: string;
};

export const defaultAllowedOrigins = ['https://openclaude-studio.pages.dev'] as const;

type ProjectParams = {
  projectId: string;
};

export async function buildServer(options: ServerOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const pathOptions: PathOptions = {};
  if (options.home !== undefined) pathOptions.home = options.home;
  if (options.env !== undefined) pathOptions.env = options.env;
  const paths = createOpenClaudePaths(pathOptions);
  const env = options.env ?? process.env;
  const authToken = options.authToken;
  const version = options.version ?? env.npm_package_version ?? '0.0.1';
  const configuredAllowedOrigins = new Set([
    ...defaultAllowedOrigins,
    ...(options.allowedOrigins ?? []),
    ...(env.OPENCLAUDE_STUDIO_ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
  ]);
  const isAllowedOrigin = (origin: string | undefined) => isAllowedBrowserOrigin(origin, configuredAllowedOrigins);

  await app.register(cors, {
    origin: (origin, callback) => {
      callback(null, isAllowedOrigin(origin));
    },
    methods: ['GET', 'OPTIONS'],
    allowedHeaders: ['content-type', 'x-openclaude-studio-token'],
    maxAge: 600,
    preflightContinue: true,
  });

  app.addHook('onRequest', async (request, reply) => {
    if (request.method === 'OPTIONS') {
      if (
        request.headers['access-control-request-private-network'] === 'true' &&
        isAllowedOrigin(request.headers.origin)
      ) {
        reply.header('Access-Control-Allow-Private-Network', 'true');
      }
      return reply.code(204).header('Content-Length', '0').send();
    }

    if (!authToken || isRootRequestUrl(request.url) || isHealthRequestUrl(request.url)) {
      return;
    }

    if (request.headers['x-openclaude-studio-token'] !== authToken) {
      return reply.code(401).send({
        error: 'Unauthorized',
        code: 'UNAUTHORIZED',
        diagnostics: [{ level: 'error', message: 'Missing or invalid API token.' }],
      } satisfies ApiErrorResponse);
    }
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ApiError) {
      return reply.code(error.statusCode).send({
        error: error.message,
        code: error.code,
        diagnostics: error.diagnostics,
      } satisfies ApiErrorResponse);
    }

    return reply.code(500).send({
      error: 'Internal server error',
      code: 'INTERNAL_ERROR',
      diagnostics: [{ level: 'error', message: 'An unexpected server error occurred.' }],
    } satisfies ApiErrorResponse);
  });

  app.get('/api/health', async (): Promise<HealthResponse> => ({
    status: 'ok',
    version,
    serverTime: new Date().toISOString(),
    uptime: process.uptime(),
  }));

  app.get('/', async (_request, reply) => {
    return reply.type('text/plain; charset=utf-8').send([
      'OpenClaude Studio local API is running.',
      '',
      'Open the dashboard:',
      'https://openclaude-studio.pages.dev/',
      '',
      'Health:',
      '/api/health',
      '',
      'This API is read-only. Keep it bound to 127.0.0.1 unless you know what you are doing.',
      '',
    ].join('\n'));
  });

  app.get('/api/projects', async (): Promise<ProjectsResponse> => {
    return readProjectSummariesWithDiagnostics(paths);
  });

  app.get('/api/provider/active', async () => readActiveProvider(paths));

  app.get('/api/provider/profiles', async () => readProviderProfiles(paths));

  app.get<{ Params: ProjectParams }>('/api/projects/:projectId/sessions', async (request) => {
    const project = await resolveProject(paths, request.params.projectId);
    return { sessions: await readSessionSummaries(paths, project) };
  });

  app.get<{ Params: { projectId: string; sessionId: string } }>(
    '/api/projects/:projectId/sessions/:sessionId',
    async (request, reply) => {
      const project = await resolveProject(paths, request.params.projectId);
      const result = await readSessionDetails(paths, project, request.params.sessionId);
      if (!result) {
        return reply.code(404).send({ error: 'Session not found', code: 'NOT_FOUND', diagnostics: [] } satisfies ApiErrorResponse);
      }
      return result;
    },
  );

  app.get<{ Params: { projectId: string; sessionId: string } }>(
    '/api/projects/:projectId/sessions/:sessionId/changes',
    async (request, reply) => {
      const project = await resolveProject(paths, request.params.projectId);
      const result = await readSessionChangeReview(paths, project, request.params.sessionId);
      if (!result) {
        return reply.code(404).send({ error: 'Session not found', code: 'NOT_FOUND', diagnostics: [] } satisfies ApiErrorResponse);
      }
      return result;
    },
  );

  app.get<{ Params: ProjectParams }>('/api/projects/:projectId/plans', async (request) => {
    const project = await resolveProject(paths, request.params.projectId);
    return listProjectPlans(paths, project);
  });

  app.get<{ Params: { projectId: string; planId: string } }>(
    '/api/projects/:projectId/plans/:planId',
    async (request) => {
      const project = await resolveProject(paths, request.params.projectId);
      return readProjectPlan(paths, project, request.params.planId);
    },
  );

  app.get<{ Params: ProjectParams }>('/api/projects/:projectId/tasks', async (request) => {
    const project = await resolveProject(paths, request.params.projectId);
    return listProjectTasks(paths, project);
  });

  app.get<{ Params: { projectId: string; sessionId: string; taskId: string } }>(
    '/api/projects/:projectId/tasks/:sessionId/:taskId',
    async (request) => {
      const project = await resolveProject(paths, request.params.projectId);
      return readProjectTask(paths, project, request.params.sessionId, request.params.taskId);
    },
  );

  app.get<{ Params: ProjectParams }>('/api/projects/:projectId/overview', async (request) => {
    const project = await resolveProject(paths, request.params.projectId);
    const [provider, sessions] = await Promise.all([
      readActiveProvider(paths),
      readSessionSummaries(paths, project),
    ]);
    const logs = await readLogWindow(paths, undefined, { count: 250 }, logScopeFromSessions(sessions));

    return buildOverviewResponse(project, provider, sessions, logs);
  });

  app.get('/api/logs/files', async () => listLogFiles(paths));

  app.get('/api/logs/window', async (request) => {
    const scope = await logScopeFromRequest(paths, request);
    return readLogWindow(paths, queryString(request, 'fileName'), logWindowRequest(request), scope);
  });

  app.get('/api/logs/search', async (request) => {
    const scope = await logScopeFromRequest(paths, request);
    return searchLogs(paths, queryString(request, 'fileName'), logSearchRequest(request), scope);
  });

  app.get('/api/background-sessions', async () => listBackgroundSessions(paths));

  app.get<{ Params: { sessionId: string } }>(
    '/api/background-sessions/:sessionId/logs',
    async (request) => {
      const params: BackgroundLogWindowRequest = {
        stream: queryString(request, 'stream') === 'stderr' ? 'stderr' : 'stdout',
      };
      const start = queryNumber(request, 'start');
      const count = queryNumber(request, 'count');
      const tail = queryString(request, 'tail') === 'true';
      if (start !== undefined) params.start = start;
      if (count !== undefined) params.count = count;
      if (tail) params.tail = true;
      return readBackgroundSessionLogs(paths, request.params.sessionId, params);
    },
  );

  return app;
}

async function resolveProject(
  paths: ReturnType<typeof createOpenClaudePaths>,
  projectId: string,
): Promise<ProjectSummary> {
  const projects = await readProjectSummaries(paths);
  const project = projects.find((item) => item.id === projectId);
  if (!project) {
    throw new ApiError(404, 'PROJECT_NOT_FOUND', 'Project not found.', [
      { level: 'error', message: 'Project not found.' },
    ]);
  }
  return project;
}

function buildOverviewResponse(
  project: ProjectSummary,
  providerResult: Awaited<ReturnType<typeof readActiveProvider>>,
  sessions: Awaited<ReturnType<typeof readSessionSummaries>>,
  logs: Awaited<ReturnType<typeof readLogWindow>>,
): OverviewResponse {
  const changedFiles = new Set(sessions.flatMap((session) => session.changedFiles));
  const usageSeries = buildUsageSeries(sessions);
  const diagnostics: Diagnostic[] = [
    ...project.diagnostics,
    ...providerResult.diagnostics,
    ...logs.diagnostics,
  ];

  return {
    project,
    provider: providerResult.provider,
    cards: {
      sessionCount: sessions.length,
      failedSessionCount: sessions.filter((session) => session.status === 'failed').length,
      changedFileCount: changedFiles.size,
      totalTokens: sessions.reduce(
        (total, session) =>
          total +
          session.tokens.input +
          session.tokens.output +
          session.tokens.cacheRead +
          session.tokens.cacheWrite,
        0,
      ),
      totalCostUsd: sessions.reduce((total, session) => total + session.costUsd, 0),
      logWarningCount: logs.entries.filter((entry) => entry.level === 'warn').length,
      logErrorCount: logs.entries.filter((entry) => entry.level === 'error').length,
    },
    recentSessions: sessions.slice(0, 5),
    usageSeries,
    diagnostics,
  };
}

function buildUsageSeries(sessions: SessionSummary[]): OverviewUsagePoint[] {
  const byDay = new Map<string, OverviewUsagePoint>();

  for (const session of sessions) {
    const day = session.lastTimestamp.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      continue;
    }

    const existing = byDay.get(day) ?? {
      date: day,
      name: day.slice(5),
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      sessionCount: 0,
      sessionIds: [],
    };

    existing.inputTokens += session.tokens.input;
    existing.outputTokens += session.tokens.output;
    existing.cacheReadTokens += session.tokens.cacheRead;
    existing.cacheWriteTokens += session.tokens.cacheWrite;
    existing.totalTokens += sessionTokenTotal(session);
    existing.costUsd += session.costUsd;
    existing.sessionCount += 1;
    existing.sessionIds.push(session.id);
    byDay.set(day, existing);
  }

  return [...byDay.values()].sort((left, right) => left.date.localeCompare(right.date));
}

function sessionTokenTotal(session: SessionSummary): number {
  return session.tokens.input + session.tokens.output + session.tokens.cacheRead + session.tokens.cacheWrite;
}

async function logScopeFromRequest(
  paths: ReturnType<typeof createOpenClaudePaths>,
  request: FastifyRequest,
): Promise<LogFileScope> {
  const projectId = queryString(request, 'projectId');
  if (!projectId) {
    return {};
  }

  const project = await resolveProject(paths, projectId);
  const sessions = await readSessionSummaries(paths, project);
  return logScopeFromSessions(sessions);
}

function logScopeFromSessions(sessions: Awaited<ReturnType<typeof readSessionSummaries>>): LogFileScope {
  return { sessionIds: new Set(sessions.map((session) => session.id)) };
}

function queryString(request: FastifyRequest, key: string): string | undefined {
  const value = queryValue(request, key);
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function queryNumber(request: FastifyRequest, key: string): number | undefined {
  const value = queryValue(request, key);
  if (typeof value !== 'string') {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function queryLevel(request: FastifyRequest): LogSearchRequest['level'] {
  const value = queryString(request, 'level');
  if (value === 'info' || value === 'warn' || value === 'error' || value === 'debug' || value === 'all') {
    return value;
  }
  return undefined;
}

function logWindowRequest(request: FastifyRequest) {
  const result: { count?: number; start?: number; tail?: boolean } = {};
  const start = queryNumber(request, 'start');
  const count = queryNumber(request, 'count');
  const tail = queryString(request, 'tail');
  if (start !== undefined) result.start = start;
  if (count !== undefined) result.count = count;
  if (tail === 'true') result.tail = true;
  return result;
}

function logSearchRequest(request: FastifyRequest): LogSearchRequest {
  const result: LogSearchRequest = logWindowRequest(request);
  const query = queryString(request, 'query');
  const level = queryLevel(request);
  if (query !== undefined) result.query = query;
  if (level !== undefined) result.level = level;
  return result;
}

function queryValue(request: FastifyRequest, key: string): unknown {
  const query = request.query;
  if (!query || typeof query !== 'object' || Array.isArray(query)) {
    return undefined;
  }
  return (query as Record<string, unknown>)[key];
}

function isLoopbackBrowserOrigin(origin: string): boolean {
  try {
    const parsed = new URL(origin);
    const hostname = parsed.hostname.toLowerCase();
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1')
    );
  } catch {
    return false;
  }
}

function isAllowedBrowserOrigin(origin: string | undefined, configuredAllowedOrigins: ReadonlySet<string>): boolean {
  return !origin || configuredAllowedOrigins.has(origin) || isLoopbackBrowserOrigin(origin);
}

function isRootRequestUrl(requestUrl: string): boolean {
  return requestPathname(requestUrl) === '/';
}

function isHealthRequestUrl(requestUrl: string): boolean {
  return requestPathname(requestUrl) === '/api/health';
}

function requestPathname(requestUrl: string): string | null {
  try {
    return new URL(requestUrl, 'http://127.0.0.1').pathname;
  } catch {
    return null;
  }
}
