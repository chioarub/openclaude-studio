import cors from '@fastify/cors';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';

import type {
  ApiErrorResponse,
  Diagnostic,
  HealthResponse,
  LogEntry,
  OverviewResponse,
  ProjectSummary,
} from '@openclaude-studio/shared';

import { readActiveProvider, readProjectSummaries } from '../services/openclaudeData.js';
import { listLogFiles, readLogWindow, searchLogs, type LogSearchRequest } from '../services/logs.js';
import { createOpenClaudePaths, type PathOptions } from '../services/paths.js';
import { readSessionSummaries } from '../services/sessions.js';
import { ApiError } from './errors.js';

export type ServerOptions = PathOptions & {
  authToken?: string;
  version?: string;
};

type ProjectParams = {
  projectId: string;
};

export async function buildServer(options: ServerOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const pathOptions: PathOptions = {};
  if (options.home !== undefined) pathOptions.home = options.home;
  if (options.env !== undefined) pathOptions.env = options.env;
  const paths = createOpenClaudePaths(pathOptions);
  const authToken = options.authToken;
  const version = options.version ?? process.env.npm_package_version ?? '0.0.1';

  await app.register(cors, {
    origin: true,
    methods: ['GET', 'OPTIONS'],
    allowedHeaders: ['content-type', 'x-openclaude-studio-token'],
  });

  app.addHook('onRequest', async (request, reply) => {
    if (!authToken || request.url.startsWith('/api/health')) {
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

  app.get('/api/projects', async () => ({
    projects: await readProjectSummaries(paths),
  }));

  app.get('/api/provider/active', async () => readActiveProvider(paths));

  app.get<{ Params: ProjectParams }>('/api/projects/:projectId/sessions', async (request) => {
    const project = await resolveProject(paths, request.params.projectId);
    return { sessions: await readSessionSummaries(paths, project) };
  });

  app.get<{ Params: ProjectParams }>('/api/projects/:projectId/overview', async (request) => {
    const project = await resolveProject(paths, request.params.projectId);
    const [provider, sessions, logs] = await Promise.all([
      readActiveProvider(paths),
      readSessionSummaries(paths, project),
      readLogWindow(paths, undefined, { count: 250 }),
    ]);

    return buildOverviewResponse(project, provider, sessions, logs);
  });

  app.get('/api/logs/files', async () => listLogFiles(paths));

  app.get('/api/logs/window', async (request) =>
    readLogWindow(paths, queryString(request, 'fileName'), logWindowRequest(request)),
  );

  app.get('/api/logs/search', async (request) =>
    searchLogs(paths, queryString(request, 'fileName'), logSearchRequest(request)),
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
    diagnostics,
  };
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
  const result: { start?: number; count?: number } = {};
  const start = queryNumber(request, 'start');
  const count = queryNumber(request, 'count');
  if (start !== undefined) result.start = start;
  if (count !== undefined) result.count = count;
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
