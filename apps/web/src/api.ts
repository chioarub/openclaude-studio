import type {
  HealthResponse,
  LogsSearchResponse,
  LogsWindowResponse,
  OverviewResponse,
  ProjectsResponse,
  SessionSummary,
} from '@openclaude-studio/shared';

export type ConnectionSettings = {
  baseUrl: string;
};

export type SessionsResponse = {
  sessions: SessionSummary[];
};

export class ApiRequestError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

export function createApiClient(settings: ConnectionSettings) {
  const baseUrl = normalizeBaseUrl(settings.baseUrl);

  async function request<T>(path: string): Promise<T> {
    const response = await fetch(`${baseUrl}${path}`, {
      headers: { accept: 'application/json' },
    });
    const payload = (await response.json().catch(() => null)) as unknown;

    if (!response.ok) {
      const message =
        payload && typeof payload === 'object' && 'error' in payload
          ? String(payload.error)
          : `Request failed with ${response.status}`;
      throw new ApiRequestError(message, response.status);
    }

    return payload as T;
  }

  return {
    health: () => request<HealthResponse>('/api/health'),
    projects: () => request<ProjectsResponse>('/api/projects'),
    overview: (projectId: string) =>
      request<OverviewResponse>(`/api/projects/${encodeURIComponent(projectId)}/overview`),
    sessions: (projectId: string) =>
      request<SessionsResponse>(`/api/projects/${encodeURIComponent(projectId)}/sessions`),
    logWindow: (input: { fileName?: string; projectId?: string; start?: number; count?: number } = {}) =>
      request<LogsWindowResponse>(`/api/logs/window${queryString(input)}`),
    logSearch: (
      input: { fileName?: string; projectId?: string; query?: string; level?: string; start?: number; count?: number } = {},
    ) => request<LogsSearchResponse>(`/api/logs/search${queryString(input)}`),
  };
}

export function normalizeBaseUrl(value: string): string {
  return (value.trim() || 'http://127.0.0.1:43110').replace(/\/+$/, '');
}

function queryString(input: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === '') continue;
    params.set(key, String(value));
  }
  const serialized = params.toString();
  return serialized ? `?${serialized}` : '';
}
