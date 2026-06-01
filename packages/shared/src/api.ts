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

export type SessionChangeStatus =
  | 'modified'
  | 'created'
  | 'deleted'
  | 'unchanged'
  | 'missing-backup'
  | 'missing-current'
  | 'too-large'
  | 'binary'
  | 'unavailable';

export type SessionChangeRiskFlag = {
  level: 'info' | 'warn' | 'error';
  label: string;
  message: string;
};

export type SessionChangeRelatedEvent = {
  id: string;
  timestamp: string;
  title: string;
  toolName: string;
  command: string | null;
};

export type SessionChangeDiffLine = {
  kind: 'context' | 'add' | 'remove';
  oldLine: number | null;
  newLine: number | null;
  text: string;
};

export type SessionChangeDiffHunk = {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: SessionChangeDiffLine[];
};

export type SessionChangeFileReview = {
  id: string;
  filePath: string;
  status: SessionChangeStatus;
  language: string | null;
  backupFileName: string | null;
  backupExists: boolean;
  backupVersion: number | null;
  backupTime: string | null;
  beforeTruncated: boolean;
  afterTruncated: boolean;
  additions: number;
  deletions: number;
  riskFlags: SessionChangeRiskFlag[];
  relatedEvents: SessionChangeRelatedEvent[];
  diff: {
    hunks: SessionChangeDiffHunk[];
  } | null;
  diagnostics: Diagnostic[];
};

export type SessionChangeReviewResponse = {
  sessionId: string;
  files: SessionChangeFileReview[];
  totals: {
    fileCount: number;
    additions: number;
    deletions: number;
    backupCount: number;
    riskFlagCount: number;
  };
  diagnostics: Diagnostic[];
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

export type ArtifactSessionSummary = {
  id: string;
  title: string;
  lastTimestamp: string;
};

export type PlanSummary = {
  id: string;
  title: string;
  exists: boolean;
  modifiedAt: string;
  sizeBytes: number;
  wordCount: number;
  lineCount: number;
  preview: string;
  checklist: {
    total: number;
    completed: number;
    pending: number;
  };
  sessionIds: string[];
  sessions: ArtifactSessionSummary[];
  latestSessionAt: string | null;
};

export type PlansResponse = {
  project: { id: string; name: string; path: string; exists: boolean };
  plansDir: string;
  exists: boolean;
  plans: PlanSummary[];
  diagnostics: Diagnostic[];
};

export type PlanDetailsResponse = {
  plan: PlanSummary & {
    content: string;
  };
  diagnostics: Diagnostic[];
};

export type TaskSummary = {
  id: string;
  taskId: string;
  title: string;
  status: string;
  description: string;
  activeForm: string | null;
  sessionId: string;
  sessionTitle: string;
  modifiedAt: string;
  sizeBytes: number;
};

export type TasksResponse = {
  project: { id: string; name: string; path: string; exists: boolean };
  tasksDir: string;
  exists: boolean;
  tasks: TaskSummary[];
  diagnostics: Diagnostic[];
};

export type TaskDetailsResponse = {
  task: TaskSummary & {
    content: string;
  };
  diagnostics: Diagnostic[];
};

export type ApiErrorResponse = {
  error: string;
  code: string;
  diagnostics: Diagnostic[];
};
