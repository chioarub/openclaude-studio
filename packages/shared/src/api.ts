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

export type ProviderTemplateId =
  | 'anthropic'
  | 'openai'
  | 'gemini'
  | 'zai-coding-plan'
  | 'codex-oauth'
  | 'ollama'
  | 'mistral'
  | 'custom-openai';

export type ProviderProfileField =
  | 'id'
  | 'name'
  | 'provider'
  | 'baseUrl'
  | 'model'
  | 'credential'
  | 'apiFormat'
  | 'authHeader'
  | 'authScheme'
  | 'customHeaders'
  | 'activeProviderProfileId';

export type ProviderProfileTemplate = {
  id: ProviderTemplateId;
  label: string;
  category: 'hosted' | 'local' | 'subscription' | 'custom';
  description: string;
  provider: string;
  baseUrl: string;
  model: string;
  modelPlaceholder: string;
  requiresSecret: boolean;
  requiredFields: ProviderProfileField[];
  advancedFields: ProviderProfileField[];
  apiFormat: 'responses' | 'chat_completions' | null;
  authHeader: string | null;
  authScheme: 'bearer' | 'raw' | null;
  customHeaders: Array<{ name: string; value: string }>;
  credential: {
    label: string;
    envVar: string;
    placeholder: string;
  } | null;
};

export type ProviderCustomHeaderSummary = {
  name: string;
  valueSet: boolean;
  sensitive: boolean;
};

export type ProviderProfileValidationIssue = {
  severity: 'info' | 'warn' | 'error';
  field?: ProviderProfileField;
  message: string;
};

export type ProviderProfileValidation = {
  status: 'valid' | 'warning' | 'error';
  issues: ProviderProfileValidationIssue[];
};

export type SafeProviderProfile = ProviderSummary & {
  apiFormat: 'responses' | 'chat_completions' | string | null;
  authHeader: string | null;
  authScheme: 'bearer' | 'raw' | string | null;
  customHeaders: ProviderCustomHeaderSummary[];
  templateId: ProviderTemplateId;
  templateLabel: string;
  validation: ProviderProfileValidation;
};

export type ProviderProfilesResponse = {
  path: string;
  exists: boolean;
  activeProviderProfileId: string | null;
  sensitiveFieldsRedacted: true;
  profiles: SafeProviderProfile[];
  templates: ProviderProfileTemplate[];
  summary: {
    total: number;
    active: number;
    valid: number;
    warnings: number;
    errors: number;
    templates: number;
  };
  diagnostics: Diagnostic[];
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

export type BackgroundSessionStatus =
  | 'running'
  | 'unknown'
  | 'exited'
  | 'failed'
  | 'stale'
  | 'killed';

export type BackgroundSessionProcessPresence = 'unknown';

export type BackgroundSessionProjectLink = {
  projectId: string;
  projectName: string;
};

export type BackgroundSessionSummary = {
  id: string;
  shortId: string;
  name: string | null;
  pid: number | null;
  cwd: string | null;
  recordedStatus: BackgroundSessionStatus;
  terminal: boolean;
  processPresence: BackgroundSessionProcessPresence;
  provider: string | null;
  model: string | null;
  sessionId: string | null;
  startedAt: string | null;
  updatedAt: string | null;
  durationMs: number | null;
  commandSummary: BackgroundSessionCommandSummary;
  project: BackgroundSessionProjectLink | null;
  sessionLink: BackgroundSessionSessionLink | null;
  stdoutLogAvailable: boolean;
  stderrLogAvailable: boolean;
};

export type BackgroundSessionCommandSummary = {
  binary: string | null;
  flagCount: number;
  truncated: boolean;
};

export type BackgroundSessionSessionLink = {
  projectId: string;
  sessionId: string;
};

export type BackgroundSessionsResponse = {
  sessions: BackgroundSessionSummary[];
  statusCounts: Record<BackgroundSessionStatus, number>;
  diagnostics: Diagnostic[];
};

export type BackgroundSessionLogStream = 'stdout' | 'stderr';

export type BackgroundSessionLogEntry = {
  id: string;
  lineNumber: number;
  text: string;
};

export type BackgroundSessionLogsResponse = {
  sessionId: string;
  stream: BackgroundSessionLogStream;
  entries: BackgroundSessionLogEntry[];
  start: number;
  count: number;
  totalLines: number;
  truncated: boolean;
  diagnostics: Diagnostic[];
};

export type ApiErrorResponse = {
  error: string;
  code: string;
  diagnostics: Diagnostic[];
};
