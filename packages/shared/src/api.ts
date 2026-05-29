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

export type ProjectsResponse = {
  projects: ProjectSummary[];
  diagnostics: Diagnostic[];
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

export type ConversationTimelineEvent = {
  id: string;
  timestamp: string;
  kind: 'user' | 'assistant' | 'tool' | 'error' | 'system';
  title: string;
  content: string;
  tool?: {
    phase: 'call' | 'result';
    name: string | null;
    status: 'success' | 'error' | 'unknown';
    command: string | null;
    filePath: string | null;
    outputType: 'command' | 'stdout' | 'stderr' | 'file' | 'text' | 'image' | 'none';
  };
};

export type SessionFileHistoryEntry = {
  filePath: string;
  backupFileName: string | null;
  version: number;
  backupTime: string | null;
  backupExists: boolean;
};

export type LinkedTaskSummary = {
  id: string;
  title: string;
  status: string;
  description: string;
  activeForm: string | null;
};

export type LinkedPlanSummary = {
  slug: string;
  title: string;
  exists: boolean;
};

export type SessionDetails = SessionSummary & {
  messageCount: number;
  toolsUsed: { name: string; count: number }[];
  fileHistoryAvailable: boolean;
  fileHistory: SessionFileHistoryEntry[];
  linkedTasks: LinkedTaskSummary[];
  linkedPlans: LinkedPlanSummary[];
};

export type SessionDetailsResponse = {
  session: SessionDetails;
  timeline: ConversationTimelineEvent[];
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

export type OverviewUsagePoint = {
  date: string;
  name: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costUsd: number;
  sessionCount: number;
  sessionIds: string[];
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
  usageSeries: OverviewUsagePoint[];
  diagnostics: Diagnostic[];
};

export type ApiErrorResponse = {
  error: string;
  code: string;
  diagnostics: Diagnostic[];
};
