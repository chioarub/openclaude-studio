import { useEffect, useState, type ReactNode } from 'react';
import {
  Activity,
  AlertTriangle,
  CircleDollarSign,
  Database,
  FileText,
  FolderGit2,
  KeyRound,
  RefreshCw,
  Search,
  Server,
  ShieldCheck,
} from 'lucide-react';
import type {
  LogEntry,
  LogsSearchResponse,
  LogsWindowResponse,
  OverviewResponse,
  ProjectSummary,
  SessionSummary,
} from '@openclaude-studio/shared';

import { createApiClient, normalizeBaseUrl, type ConnectionSettings } from './api';

const connectionStorageKey = 'openclaude-studio.connection';
const defaultConnection: ConnectionSettings = {
  baseUrl: 'http://127.0.0.1:43110',
  token: '',
};

type LoadState = 'idle' | 'loading' | 'ready' | 'error';

type Snapshot = {
  projects: ProjectSummary[];
  overview: OverviewResponse | null;
  sessions: SessionSummary[];
  logs: LogsWindowResponse | LogsSearchResponse | null;
};

export default function App() {
  const [connection, setConnection] = useState(loadConnection);
  const [draftBaseUrl, setDraftBaseUrl] = useState(connection.baseUrl);
  const [draftToken, setDraftToken] = useState(connection.token);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedLogFile, setSelectedLogFile] = useState<string | undefined>();
  const [logQuery, setLogQuery] = useState('');
  const [status, setStatus] = useState<LoadState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot>({
    projects: [],
    overview: null,
    sessions: [],
    logs: null,
  });

  const selectedProject = snapshot.projects.find((project) => project.id === selectedProjectId) ?? null;

  async function loadWorkspace(input: {
    projectId?: string | null;
    fileName?: string;
    query?: string;
    nextConnection?: ConnectionSettings;
  } = {}) {
    const activeConnection = input.nextConnection ?? connection;
    if (!activeConnection.token.trim()) {
      setStatus('idle');
      setError('API token required.');
      return;
    }

    const activeApi = createApiClient(activeConnection);
    setStatus('loading');
    setError(null);

    try {
      const projectsResponse = await activeApi.projects();
      const projectId = resolveProjectId(projectsResponse.projects, input.projectId ?? selectedProjectId);
      const fileName = input.fileName ?? selectedLogFile;
      const query = input.query ?? logQuery;
      const [overview, sessionsResponse, logs] = projectId
        ? await Promise.all([
            activeApi.overview(projectId),
            activeApi.sessions(projectId),
            query.trim()
              ? activeApi.logSearch(logSearchInput(fileName, query.trim()))
              : activeApi.logWindow(logWindowInput(fileName)),
          ])
        : [null, { sessions: [] }, await activeApi.logWindow(logWindowInput(fileName))];

      setConnection(activeConnection);
      saveConnection(activeConnection);
      setSelectedProjectId(projectId);
      setSelectedLogFile(logs.selectedFile?.name);
      setSnapshot({
        projects: projectsResponse.projects,
        overview,
        sessions: sessionsResponse.sessions,
        logs,
      });
      setStatus('ready');
    } catch (caught) {
      setStatus('error');
      setError(caught instanceof Error ? caught.message : 'Unable to load workspace.');
    }
  }

  useEffect(() => {
    if (connection.token) {
      void loadWorkspace({ nextConnection: connection });
    }
    // Run once with persisted connection; explicit refreshes handle later updates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const totalTokens = snapshot.overview?.cards.totalTokens ?? 0;

  return (
    <main className="min-h-screen bg-canvas text-ink">
      <header className="border-b border-line bg-panel px-5 py-4">
        <div className="mx-auto flex max-w-7xl flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-muted">
              <Server className="h-4 w-4" aria-hidden="true" />
              Local companion
            </div>
            <h1 className="mt-1 text-2xl font-semibold tracking-normal">OpenClaude Studio</h1>
          </div>

          <form
            className="grid gap-2 md:grid-cols-[minmax(220px,320px)_minmax(220px,320px)_auto]"
            onSubmit={(event) => {
              event.preventDefault();
              const nextConnection = {
                baseUrl: normalizeBaseUrl(draftBaseUrl),
                token: draftToken.trim(),
              };
              void loadWorkspace({ nextConnection });
            }}
          >
            <label className="field-label">
              Server URL
              <input
                className="field-input"
                value={draftBaseUrl}
                onChange={(event) => setDraftBaseUrl(event.target.value)}
                spellCheck={false}
              />
            </label>
            <label className="field-label">
              API token
              <input
                className="field-input"
                value={draftToken}
                onChange={(event) => setDraftToken(event.target.value)}
                spellCheck={false}
                type="password"
              />
            </label>
            <button className="primary-button" disabled={status === 'loading'} type="submit">
              <RefreshCw className={status === 'loading' ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
              Refresh
            </button>
          </form>
        </div>
      </header>

      <div className="mx-auto grid max-w-7xl gap-5 px-5 py-5 lg:grid-cols-[320px_minmax(0,1fr)]">
        <aside className="panel min-h-[240px]">
          <div className="section-heading">
            <FolderGit2 className="h-4 w-4" aria-hidden="true" />
            Projects
          </div>
          <div className="mt-3 space-y-2">
            {snapshot.projects.length === 0 ? (
              <EmptyState label={connection.token ? 'No projects found' : 'Connect to local server'} />
            ) : (
              snapshot.projects.map((project) => (
                <button
                  className={project.id === selectedProjectId ? 'project-row project-row-active' : 'project-row'}
                  key={project.id}
                  onClick={() => void loadWorkspace({ projectId: project.id })}
                  type="button"
                >
                  <span className="truncate font-medium">{project.name}</span>
                  <span className="truncate text-xs text-muted">{project.branch}</span>
                </button>
              ))
            )}
          </div>
        </aside>

        <section className="space-y-5">
          {error ? <StatusBanner error={error} status={status} /> : null}

          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <Metric icon={<Activity />} label="Sessions" value={snapshot.overview?.cards.sessionCount ?? 0} />
            <Metric icon={<Database />} label="Tokens" value={formatNumber(totalTokens)} />
            <Metric icon={<CircleDollarSign />} label="Cost" value={formatUsd(snapshot.overview?.cards.totalCostUsd ?? 0)} />
            <Metric icon={<AlertTriangle />} label="Log issues" value={logIssueCount(snapshot.overview)} />
          </div>

          <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
            <div className="space-y-5">
              <ProjectOverview project={selectedProject} overview={snapshot.overview} />
              <SessionsTable sessions={snapshot.sessions} />
            </div>
            <div className="space-y-5">
              <ProviderPanel overview={snapshot.overview} />
              <LogsPanel
                logs={snapshot.logs}
                query={logQuery}
                selectedFile={selectedLogFile}
                onFileChange={(fileName) => {
                  setSelectedLogFile(fileName);
                  void loadWorkspace(fileName ? { fileName } : {});
                }}
                onQueryChange={setLogQuery}
                onSearch={() => void loadWorkspace({ query: logQuery })}
              />
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}

function ProjectOverview({
  project,
  overview,
}: {
  project: ProjectSummary | null;
  overview: OverviewResponse | null;
}) {
  return (
    <section className="panel">
      <div className="section-heading">
        <ShieldCheck className="h-4 w-4" aria-hidden="true" />
        Overview
      </div>
      {project && overview ? (
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <Info label="Path" value={project.path} />
          <Info label="Branch" value={project.branch} />
          <Info label="Changed files" value={String(overview.cards.changedFileCount)} />
          <Info label="Failed sessions" value={String(overview.cards.failedSessionCount)} />
        </div>
      ) : (
        <EmptyState label="No project selected" />
      )}
    </section>
  );
}

function ProviderPanel({ overview }: { overview: OverviewResponse | null }) {
  const provider = overview?.provider;
  return (
    <section className="panel">
      <div className="section-heading">
        <KeyRound className="h-4 w-4" aria-hidden="true" />
        Provider
      </div>
      {provider ? (
        <div className="mt-4 space-y-3 text-sm">
          <Info label="Name" value={provider.name} />
          <Info label="Model" value={provider.model} />
          <Info label="Base URL" value={provider.baseUrl ?? 'default'} />
          <div className="flex flex-wrap gap-2">
            <Badge tone={provider.apiKeySet ? 'success' : 'muted'} label={provider.apiKeySet ? 'API key set' : 'No API key'} />
            <Badge
              tone={provider.authHeaderValueSet ? 'success' : 'muted'}
              label={provider.authHeaderValueSet ? 'Auth header set' : 'No auth header'}
            />
          </div>
        </div>
      ) : (
        <EmptyState label="No active provider" />
      )}
    </section>
  );
}

function SessionsTable({ sessions }: { sessions: SessionSummary[] }) {
  return (
    <section className="panel">
      <div className="section-heading">
        <FileText className="h-4 w-4" aria-hidden="true" />
        Recent sessions
      </div>
      <div className="mt-3 overflow-x-auto">
        {sessions.length === 0 ? (
          <EmptyState label="No sessions found" />
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Title</th>
                <th>Status</th>
                <th>Models</th>
                <th>Tokens</th>
                <th>Cost</th>
              </tr>
            </thead>
            <tbody>
              {sessions.slice(0, 8).map((session) => (
                <tr key={session.id}>
                  <td className="max-w-[320px] truncate">{session.title}</td>
                  <td>
                    <Badge tone={session.status === 'failed' ? 'danger' : 'success'} label={session.status} />
                  </td>
                  <td>{session.modelSet.join(', ') || 'unknown'}</td>
                  <td>{formatNumber(session.tokens.input + session.tokens.output + session.tokens.cacheRead + session.tokens.cacheWrite)}</td>
                  <td>{formatUsd(session.costUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}

function LogsPanel({
  logs,
  selectedFile,
  query,
  onFileChange,
  onQueryChange,
  onSearch,
}: {
  logs: LogsWindowResponse | LogsSearchResponse | null;
  selectedFile: string | undefined;
  query: string;
  onFileChange: (fileName: string | undefined) => void;
  onQueryChange: (value: string) => void;
  onSearch: () => void;
}) {
  return (
    <section className="panel">
      <div className="section-heading">
        <FileText className="h-4 w-4" aria-hidden="true" />
        Logs
      </div>
      <div className="mt-3 grid gap-2">
        <select
          className="field-input"
          onChange={(event) => onFileChange(event.target.value || undefined)}
          value={selectedFile ?? ''}
        >
          {logs?.files.length ? null : <option value="">No logs</option>}
          {logs?.files.map((file) => (
            <option key={file.name} value={file.name}>
              {file.name}
            </option>
          ))}
        </select>
        <div className="flex gap-2">
          <input
            aria-label="Search logs"
            className="field-input min-w-0 flex-1"
            onChange={(event) => onQueryChange(event.target.value)}
            value={query}
          />
          <button className="icon-button" onClick={onSearch} title="Search logs" type="button">
            <Search className="h-4 w-4" />
          </button>
        </div>
      </div>
      <div className="log-view mt-3">
        {logs?.entries.length ? (
          logs.entries.slice(0, 80).map((entry) => <LogLine entry={entry} key={entry.id} />)
        ) : (
          <EmptyState label="No log entries" />
        )}
      </div>
    </section>
  );
}

function LogLine({ entry }: { entry: LogEntry }) {
  return (
    <div className={`log-line log-${entry.level}`}>
      <span className="tabular-nums text-muted">{entry.lineNumber}</span>
      <span>{entry.timestamp?.slice(11, 19) ?? '--:--:--'}</span>
      <span className="uppercase">{entry.level}</span>
      <span className="min-w-0 truncate">{entry.message}</span>
    </div>
  );
}

function Metric({ icon, label, value }: { icon: ReactNode; label: string; value: string | number }) {
  return (
    <div className="metric">
      <div className="metric-icon">{icon}</div>
      <div>
        <div className="text-xs font-medium text-muted">{label}</div>
        <div className="mt-1 text-xl font-semibold">{value}</div>
      </div>
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-xs font-medium text-muted">{label}</div>
      <div className="mt-1 truncate text-sm font-medium" title={value}>
        {value}
      </div>
    </div>
  );
}

function Badge({ label, tone }: { label: string; tone: 'danger' | 'muted' | 'success' }) {
  return <span className={`badge badge-${tone}`}>{label}</span>;
}

function EmptyState({ label }: { label: string }) {
  return <div className="empty-state">{label}</div>;
}

function StatusBanner({ error, status }: { error: string; status: LoadState }) {
  return (
    <div className="status-banner">
      <AlertTriangle className="h-4 w-4" />
      <span>{status === 'loading' ? 'Loading' : error}</span>
    </div>
  );
}

function resolveProjectId(projects: ProjectSummary[], requested: string | null | undefined): string | null {
  if (requested && projects.some((project) => project.id === requested)) {
    return requested;
  }
  return projects.find((project) => project.active)?.id ?? projects[0]?.id ?? null;
}

function logWindowInput(fileName: string | undefined) {
  return fileName ? { fileName, count: 250 } : { count: 250 };
}

function logSearchInput(fileName: string | undefined, query: string) {
  return fileName ? { fileName, query, count: 250 } : { query, count: 250 };
}

function loadConnection(): ConnectionSettings {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(connectionStorageKey) ?? '') as Partial<ConnectionSettings>;
    return {
      baseUrl: normalizeBaseUrl(parsed.baseUrl ?? defaultConnection.baseUrl),
      token: parsed.token ?? defaultConnection.token,
    };
  } catch {
    return defaultConnection;
  }
}

function saveConnection(connection: ConnectionSettings) {
  window.localStorage.setItem(connectionStorageKey, JSON.stringify(connection));
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat().format(value);
}

function formatUsd(value: number): string {
  return new Intl.NumberFormat(undefined, { currency: 'USD', style: 'currency' }).format(value);
}

function logIssueCount(overview: OverviewResponse | null): number {
  if (!overview) return 0;
  return overview.cards.logWarningCount + overview.cards.logErrorCount;
}
