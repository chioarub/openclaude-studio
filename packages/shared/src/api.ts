export type Diagnostic = {
  level: 'info' | 'warn' | 'error';
  message: string;
  path?: string;
};

export type HealthResponse = {
  status: 'ok';
  version: string;
  serverTime: string;
  uptime: number;
};

export type ProjectSummary = {
  id: string;
  name: string;
  path: string;
  exists: boolean;
  active: boolean;
  branch: string;
  lastUpdated: string;
  diagnostics: Diagnostic[];
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    costUsd: number;
    lastSessionId: string | null;
  };
};

export type ProviderSummary = {
  id: string;
  name: string;
  provider: string;
  model: string;
  baseUrl: string | null;
  active: boolean;
  apiKeySet: boolean;
  authHeaderValueSet: boolean;
};

export type SessionSummary = {
  id: string;
  title: string;
  status: 'completed' | 'failed';
  firstTimestamp: string;
  lastTimestamp: string;
  modelSet: string[];
  changedFiles: string[];
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  costUsd: number;
  linkedPlanCount: number;
  linkedTaskCount: number;
};

export type LogFileSummary = {
  name: string;
  sizeBytes: number;
  modifiedAt: string;
  sessionId: string | null;
};

export type LogEntry = {
  id: string;
  lineNumber: number;
  timestamp: string | null;
  level: 'info' | 'warn' | 'error' | 'debug';
  message: string;
};

export type LogsFilesResponse = {
  files: LogFileSummary[];
  diagnostics: Diagnostic[];
};

export type LogsWindowResponse = {
  files: LogFileSummary[];
  selectedFile: LogFileSummary | null;
  entries: LogEntry[];
  start: number;
  count: number;
  totalLines: number;
  diagnostics: Diagnostic[];
};

export type LogsSearchResponse = LogsWindowResponse & {
  query: string;
  totalMatches: number;
};

export type OverviewResponse = {
  project: ProjectSummary;
  provider: ProviderSummary | null;
  cards: {
    sessionCount: number;
    failedSessionCount: number;
    changedFileCount: number;
    totalTokens: number;
    totalCostUsd: number;
    logWarningCount: number;
    logErrorCount: number;
  };
  recentSessions: SessionSummary[];
  diagnostics: Diagnostic[];
};

export type ApiErrorResponse = {
  error: string;
  code: string;
  diagnostics: Diagnostic[];
};
