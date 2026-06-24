import type {
  BackgroundSessionLogStream,
  BackgroundSessionLogsResponse,
  BackgroundSessionsResponse,
  HealthResponse,
  LogsSearchResponse,
  LogsWindowResponse,
  OverviewResponse,
  PlanDetailsResponse,
  PlansResponse,
  ProviderProfilesResponse,
  ProjectsResponse,
  SessionChangeReviewResponse,
  SessionDetailsResponse,
  SessionReplayResponse,
  SessionSummary,
  TaskDetailsResponse,
  TasksResponse,
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

export type ApiClient = ReturnType<typeof createApiClient>;

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
    providerProfiles: () => request<ProviderProfilesResponse>('/api/provider/profiles'),
    overview: (projectId: string) =>
      request<OverviewResponse>(`/api/projects/${encodeURIComponent(projectId)}/overview`),
    sessions: (projectId: string) =>
      request<SessionsResponse>(`/api/projects/${encodeURIComponent(projectId)}/sessions`),
    sessionDetails: (projectId: string, sessionId: string) =>
      request<SessionDetailsResponse>(`/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}`),
    sessionChanges: (projectId: string, sessionId: string) =>
      request<SessionChangeReviewResponse>(`/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/changes`),
    sessionReplay: async (projectId: string, sessionId: string): Promise<SessionReplayResponse | null> => {
      try {
        return await request<SessionReplayResponse>(`/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/replay`);
      } catch (error) {
        if (error instanceof ApiRequestError && error.status === 404) {
          return null;
        }
        throw error;
      }
    },
    logWindow: (input: { fileName?: string; projectId?: string; start?: number; count?: number; tail?: boolean } = {}) =>
      request<LogsWindowResponse>(`/api/logs/window${queryString(input)}`),
    logSearch: (
      input: {
        fileName?: string;
        projectId?: string;
        query?: string;
        level?: string;
        start?: number;
        count?: number;
        tail?: boolean;
      } = {},
    ) => request<LogsSearchResponse>(`/api/logs/search${queryString(input)}`),
    backgroundSessions: () => request<BackgroundSessionsResponse>('/api/background-sessions'),
    backgroundSessionLogs: (
      sessionId: string,
      input: {
        stream?: BackgroundSessionLogStream;
        start?: number;
        count?: number;
        tail?: boolean;
      } = {},
    ) =>
      request<BackgroundSessionLogsResponse>(
        `/api/background-sessions/${encodeURIComponent(sessionId)}/logs${queryString(input)}`,
      ),
    plans: (projectId: string) =>
      request<PlansResponse>(`/api/projects/${encodeURIComponent(projectId)}/plans`),
    planDetails: (projectId: string, planId: string) =>
      request<PlanDetailsResponse>(`/api/projects/${encodeURIComponent(projectId)}/plans/${encodeURIComponent(planId)}`),
    tasks: (projectId: string) =>
      request<TasksResponse>(`/api/projects/${encodeURIComponent(projectId)}/tasks`),
    taskDetails: (projectId: string, sessionId: string, taskId: string) =>
      request<TaskDetailsResponse>(`/api/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(sessionId)}/${encodeURIComponent(taskId)}`),
  };
}

export function normalizeBaseUrl(value: string): string {
  return (value.trim() || 'http://127.0.0.1:43110').replace(/\/+$/, '');
}

function queryString(input: Record<string, string | number | boolean | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === '') continue;
    params.set(key, String(value));
  }
  const serialized = params.toString();
  return serialized ? `?${serialized}` : '';
}
