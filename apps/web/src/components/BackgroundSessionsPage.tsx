import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type {
  BackgroundSessionLogEntry,
  BackgroundSessionLogStream,
  BackgroundSessionLogsResponse,
  BackgroundSessionStatus,
  BackgroundSessionSummary,
  BackgroundSessionsResponse,
  Diagnostic,
} from '@openclaude-studio/shared';
import {
  AlertTriangle,
  Check,
  Copy,
  Search,
  TerminalSquare,
  X,
} from 'lucide-react';

import type { ApiClient } from '../api.js';
import { ApiRequestError } from '../api.js';
import {
  Badge,
  EmptyState,
  PageHeader,
  PageStack,
  QuickStat,
  SectionHeading,
} from './shared.js';
import { LoadingOverlay } from './LoadingState.js';
import { cn } from '../lib/cn.js';

type BackgroundSessionsPageProps = {
  api: ApiClient;
  onOpenSession: (projectId: string, sessionId: string) => void;
};

type StatusOption = 'all' | BackgroundSessionStatus;

const STATUS_ORDER: BackgroundSessionStatus[] = [
  'running',
  'unknown',
  'exited',
  'failed',
  'stale',
  'killed',
];

const DEFAULT_LOG_COUNT = 100;

function statusTone(status: BackgroundSessionStatus): 'danger' | 'muted' | 'success' | 'warning' {
  switch (status) {
    case 'running':
      return 'success';
    case 'failed':
    case 'killed':
      return 'danger';
    case 'stale':
      return 'warning';
    default:
      return 'muted';
  }
}

export function BackgroundSessionsPage({ api, onOpenSession }: BackgroundSessionsPageProps) {
  const [response, setResponse] = useState<BackgroundSessionsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [degraded, setDegraded] = useState(false);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusOption>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  const fetchSessions = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);

    try {
      const result = await api.backgroundSessions();
      if (requestId !== requestIdRef.current) return;
      setResponse(normalizeBackgroundSessionsResponse(result));
      setDegraded(false);
    } catch (caught) {
      if (requestId !== requestIdRef.current) return;
      if (caught instanceof ApiRequestError && caught.status === 404) {
        setDegraded(true);
        setError('Background session monitoring requires a newer local server.');
      } else {
        setError(caught instanceof Error ? caught.message : 'Failed to load background sessions.');
      }
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void fetchSessions();
    // Load once on mount. The global top-bar refresh button reloads the whole
    // workspace (including this page). No silent polling — consistent with
    // every other content page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  const sessions = response?.sessions ?? [];
  const statusCounts = response?.statusCounts ?? emptyStatusCounts();
  const diagnostics = response?.diagnostics ?? [];

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return sessions.filter((session) => {
      if (statusFilter !== 'all' && session.recordedStatus !== statusFilter) {
        return false;
      }
      if (!query) return true;
      return matchesSearch(session, query);
    });
  }, [sessions, search, statusFilter]);

  const selected = useMemo(
    () => sessions.find((session) => session.id === selectedId) ?? null,
    [sessions, selectedId],
  );

  const runningCount = statusCounts.running ?? 0;
  const failedCount = (statusCounts.failed ?? 0) + (statusCounts.killed ?? 0);

  return (
    <PageStack>
      <PageHeader
        icon={TerminalSquare}
        status={`${sessions.length} session${sessions.length === 1 ? '' : 's'}`}
        title="Background Sessions"
        aside={
          <div className="page-header-stats">
            <QuickStat label="Running" value={runningCount} />
            <QuickStat label="Failed" value={failedCount} />
          </div>
        }
      />

      {error ? (
        <section className="panel">
          <ErrorBanner message={error} degraded={degraded} />
        </section>
      ) : (
        <section aria-busy={loading} className="panel loading-boundary">
          <SectionHeading icon={TerminalSquare} label="Sessions" />

          <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center">
            <label className="relative flex-1">
              <span className="sr-only">Search background sessions</span>
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-soft" aria-hidden="true" />
              <input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search name, id, provider, model, project"
                className="field-input w-full"
                style={{ paddingLeft: '2.25rem' }}
              />
            </label>
          </div>

          <div className="mt-3 flex flex-wrap gap-1.5">
            <FilterPill
              active={statusFilter === 'all'}
              label="All"
              onClick={() => setStatusFilter('all')}
            />
            {STATUS_ORDER.map((status) => (
              <FilterPill
                key={status}
                active={statusFilter === status}
                label={capitalize(status)}
                onClick={() => setStatusFilter(status)}
              />
            ))}
          </div>

          <div className="mt-4 overflow-x-auto">
            {!loading && filtered.length === 0 ? (
              <EmptyState
                label={
                  sessions.length === 0
                    ? 'No background sessions found'
                    : 'No sessions match your filters'
                }
              />
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Status</th>
                    <th>Provider</th>
                    <th>Project</th>
                    <th>Started</th>
                    <th>Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((session) => (
                    <tr
                      key={session.id}
                      tabIndex={0}
                      aria-label={`Open details for ${displayLabel(session)}`}
                      onClick={() => setSelectedId(session.id)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          setSelectedId(session.id);
                        }
                      }}
                      className="cursor-pointer hover:bg-surface-soft/50 transition-colors"
                    >
                      <td className="max-w-[280px]">
                        <div className="flex flex-col">
                          <span className="truncate font-medium text-ink">{displayLabel(session)}</span>
                          <span className="font-mono text-[11px] text-muted-soft">{session.shortId}</span>
                        </div>
                      </td>
                      <td>
                        <Badge label={capitalize(session.recordedStatus)} tone={statusTone(session.recordedStatus)} />
                      </td>
                      <td className="max-w-[200px] truncate">{session.provider ?? '—'}</td>
                      <td className="max-w-[200px] truncate">{session.project?.projectName ?? '—'}</td>
                      <td className="whitespace-nowrap text-muted">{formatTimestamp(session.startedAt)}</td>
                      <td className="whitespace-nowrap text-muted">{formatTimestamp(session.updatedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {diagnostics.length > 0 ? (
            <div className="mt-4">
              <DiagnosticsList diagnostics={diagnostics} />
            </div>
          ) : null}

          {loading ? <LoadingOverlay label={response ? 'Refreshing background sessions' : 'Loading background sessions'} /> : null}
        </section>
      )}

      <p className="text-[11px] text-muted-soft">
        Privacy: background logs may contain prompts and model output. Secrets are redacted server-side, but treat every line as potentially sensitive.
      </p>

      {selected ? (
        <SessionDetail
          api={api}
          session={selected}
          onClose={() => setSelectedId(null)}
          onOpenSession={onOpenSession}
        />
      ) : null}
    </PageStack>
  );
}

function FilterPill({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'rounded-md border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-widest transition-colors',
        active
          ? 'border-primary bg-primary/10 text-primary'
          : 'border-hairline bg-canvas text-muted-soft hover:bg-surface-soft hover:text-ink',
      )}
    >
      {label}
    </button>
  );
}

function SessionDetail({
  api,
  session,
  onClose,
  onOpenSession,
}: {
  api: ApiClient;
  session: BackgroundSessionSummary;
  onClose: () => void;
  onOpenSession: (projectId: string, sessionId: string) => void;
}) {
  const [stream, setStream] = useState<BackgroundSessionLogStream>('stdout');
  const [logs, setLogs] = useState<BackgroundSessionLogsResponse | null>(null);
  const [logLoading, setLogLoading] = useState(false);
  const [logError, setLogError] = useState<string | null>(null);
  const [copiedLine, setCopiedLine] = useState<number | null>(null);
  const logsRequestIdRef = useRef(0);

  const fetchLogs = useCallback(async () => {
    const requestId = ++logsRequestIdRef.current;
    setLogLoading(true);
    setLogError(null);
    try {
      const result = await api.backgroundSessionLogs(session.id, {
        stream,
        count: DEFAULT_LOG_COUNT,
        tail: true,
      });
      if (requestId !== logsRequestIdRef.current) return;
      setLogs(normalizeBackgroundSessionLogsResponse(result));
    } catch (caught) {
      if (requestId !== logsRequestIdRef.current) return;
      setLogError(caught instanceof Error ? caught.message : 'Failed to load logs.');
    } finally {
      if (requestId === logsRequestIdRef.current) setLogLoading(false);
    }
  }, [api, session.id, stream]);

  useEffect(() => {
    void fetchLogs();
  }, [fetchLogs]);

  useEffect(() => {
    if (!session.id) return;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [session.id, onClose]);

  const handleCopy = useCallback((entry: BackgroundSessionLogEntry, index: number) => {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(entry.text).then(() => {
        setCopiedLine(index);
        window.setTimeout(() => setCopiedLine(null), 1500);
      }).catch(() => undefined);
    }
  }, []);

  const logAvailable = stream === 'stdout' ? session.stdoutLogAvailable : session.stderrLogAvailable;

  return (
    <div
      className="fixed inset-0 z-[1000] flex items-center justify-center overflow-y-auto overscroll-contain bg-surface-dark/55 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        aria-modal="true"
        className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-lg border border-hairline bg-canvas shadow-sm"
        role="dialog"
        aria-label={`Background session ${session.name ?? session.id} details`}
      >
        <div className="flex shrink-0 items-start justify-between gap-4 border-b border-hairline-soft bg-surface-soft px-5 py-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Badge label={capitalize(session.recordedStatus)} tone={statusTone(session.recordedStatus)} />
              <span className="font-mono text-[11px] text-muted-soft">{session.shortId}</span>
            </div>
            <h2 className="mt-1 truncate text-[22px] font-medium leading-tight text-ink">
              {displayLabel(session)}
            </h2>
          </div>
          <button
            aria-label="Close dialog"
            className="rounded-md p-2 text-muted transition-colors hover:bg-surface-card hover:text-error"
            onClick={onClose}
            type="button"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="custom-scrollbar min-h-0 flex-1 overflow-y-auto p-5">
          <DetailGrid session={session} onOpenSession={onOpenSession} />

          <div className="mt-6">
            <SectionHeading icon={TerminalSquare} label={stream === 'stderr' ? 'Stderr output' : 'Stdout output'} />
            <div className="mt-3 flex items-center gap-1 border-b border-hairline">
              {(['stdout', 'stderr'] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => setStream(option)}
                  className={cn(
                    'px-3 py-2 text-xs font-medium uppercase tracking-widest transition-colors',
                    stream === option
                      ? 'border-b-2 border-primary text-primary'
                      : 'text-muted-soft hover:text-ink',
                  )}
                >
                  {option}
                </button>
              ))}
            </div>

            <div className="relative mt-3">
              {logLoading ? <LoadingOverlay label="Loading logs" /> : null}
              {logError ? (
                <ErrorBanner message={logError} degraded={false} />
              ) : !logAvailable ? (
                <EmptyState label={`No ${stream} log available`} />
              ) : logs && logs.entries.length === 0 ? (
                <div className="rounded-lg border border-dashed border-hairline px-6 py-10 text-center">
                  <p className="font-medium text-ink">No {stream} output captured yet</p>
                  <p className="mt-1 text-sm text-muted-soft">
                    The log file exists but is empty. Output appears here once the background session writes to {stream}.
                  </p>
                </div>
              ) : (
                <LogWindow
                  entries={logs?.entries ?? []}
                  truncated={logs?.truncated ?? false}
                  totalLines={logs?.totalLines ?? 0}
                  copiedLine={copiedLine}
                  onCopy={handleCopy}
                />
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function DetailGrid({
  session,
  onOpenSession,
}: {
  session: BackgroundSessionSummary;
  onOpenSession: (projectId: string, sessionId: string) => void;
}) {
  return (
    <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <DetailItem label="ID" value={session.id} mono />
      <DetailItem label="PID" value={session.pid != null ? String(session.pid) : '—'} mono />
      <DetailItem label="Provider" value={session.provider ?? '—'} />
      <DetailItem label="Model" value={session.model ?? '—'} />
      <DetailItem label="Started" value={formatTimestamp(session.startedAt)} />
      <DetailItem label="Updated" value={formatTimestamp(session.updatedAt)} />
      <DetailItem label="Duration" value={formatDuration(session.durationMs)} />
      <DetailItem
        label="Process"
        value={session.processPresence === 'unknown' ? 'Recorded status only' : capitalize(session.processPresence)}
      />
      <DetailItem
        label="Command"
        value={session.commandSummary.binary ?? '—'}
        hint={
          session.commandSummary.truncated
            ? `${session.commandSummary.flagCount}+ flags (truncated)`
            : `${session.commandSummary.flagCount} flag${session.commandSummary.flagCount === 1 ? '' : 's'}`
        }
      />
      <DetailItem label="Working directory" value={session.cwd ?? '—'} mono />
      {session.project ? (
        <DetailItem label="Project" value={session.project.projectName} />
      ) : null}
      {session.sessionLink ? (
        <div className="flex flex-col gap-1">
          <dt className="text-xs font-medium text-muted">Session</dt>
          <dd>
            <button
              type="button"
              className="text-primary hover:underline"
              onClick={() => onOpenSession(session.sessionLink!.projectId, session.sessionLink!.sessionId)}
            >
              Open session transcript
            </button>
          </dd>
        </div>
      ) : null}
    </dl>
  );
}

function DetailItem({ label, value, hint, mono }: { label: string; value: string; hint?: string; mono?: boolean }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-xs font-medium text-muted">{label}</dt>
      <dd className={cn('text-sm font-medium text-ink', mono && 'font-mono break-all')}>{value}</dd>
      {hint ? <dd className="text-[11px] text-muted-soft">{hint}</dd> : null}
    </div>
  );
}

function LogWindow({
  entries,
  truncated,
  totalLines,
  copiedLine,
  onCopy,
}: {
  entries: BackgroundSessionLogEntry[];
  truncated: boolean;
  totalLines: number;
  copiedLine: number | null;
  onCopy: (entry: BackgroundSessionLogEntry, index: number) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      {truncated ? (
        <p className="text-[11px] text-warning">
          Log was truncated. Showing the most recent {entries.length} of {totalLines} lines.
        </p>
      ) : null}
      <div className="max-h-[400px] overflow-y-auto rounded-lg border border-hairline bg-surface-soft/40">
        {entries.map((entry, index) => (
          <div
            key={entry.id}
            className="group flex items-start gap-2 border-b border-hairline-soft/40 px-3 py-1.5 last:border-0"
          >
            <span className="select-none font-mono text-[10px] leading-5 text-muted-soft">
              {entry.lineNumber}
            </span>
            <code className="min-w-0 flex-1 whitespace-pre-wrap break-all font-mono text-[12px] text-ink">
              {entry.text}
            </code>
            <button
              type="button"
              aria-label="Copy log line"
              onClick={() => onCopy(entry, index)}
              className={cn(
                'shrink-0 rounded p-1 opacity-0 transition-opacity group-hover:opacity-100',
                copiedLine === index ? 'text-success' : 'text-muted-soft hover:text-primary',
              )}
            >
              {copiedLine === index ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function ErrorBanner({ message, degraded }: { message: string; degraded: boolean }) {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-warning/35 bg-warning/10 px-4 py-3 text-warning">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0">
        <p className="text-sm font-medium">{message}</p>
        {degraded ? (
          <p className="mt-1 text-xs opacity-80">
            Update the local openclaude-studio server to enable background session monitoring.
          </p>
        ) : null}
      </div>
    </div>
  );
}

function DiagnosticsList({ diagnostics }: { diagnostics: Diagnostic[] }) {
  return (
    <details className="rounded-lg border border-hairline bg-surface-soft/40">
      <summary className="cursor-pointer px-4 py-2 text-xs font-medium uppercase tracking-widest text-muted-soft">
        {diagnostics.length} diagnostic{diagnostics.length === 1 ? '' : 's'}
      </summary>
      <ul className="border-t border-hairline px-4 py-2 text-xs">
        {diagnostics.map((diagnostic, index) => (
          <li key={index} className={cn('py-1', diagnostic.level === 'warn' ? 'text-warning' : 'text-muted')}>
            <span className="font-mono uppercase">{diagnostic.level}</span>
            <span className="ml-2">{diagnostic.message}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

function matchesSearch(session: BackgroundSessionSummary, query: string): boolean {
  const haystack = [
    session.id,
    session.name,
    session.provider,
    session.model,
    session.project?.projectName,
    session.cwd,
  ]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join(' ')
    .toLowerCase();
  return haystack.includes(query);
}

function emptyStatusCounts(): Record<BackgroundSessionStatus, number> {
  return { running: 0, unknown: 0, exited: 0, failed: 0, stale: 0, killed: 0 };
}

function normalizeBackgroundSessionsResponse(value: unknown): BackgroundSessionsResponse {
  const record = isRecord(value) ? value : {};
  const sessions = normalizeSessionSummaries(record.sessions);
  return {
    sessions,
    statusCounts: normalizeStatusCounts(record.statusCounts, sessions),
    diagnostics: normalizeDiagnostics(record.diagnostics),
  };
}

function normalizeBackgroundSessionLogsResponse(value: unknown): BackgroundSessionLogsResponse {
  const record = isRecord(value) ? value : {};
  const sessionId = typeof record.sessionId === 'string' ? record.sessionId : '';
  const stream: BackgroundSessionLogStream = record.stream === 'stderr' ? 'stderr' : 'stdout';
  return {
    sessionId,
    stream,
    entries: normalizeLogEntries(record.entries),
    start: toNonNegativeInt(record.start),
    count: toNonNegativeInt(record.count),
    totalLines: toNonNegativeInt(record.totalLines),
    truncated: Boolean(record.truncated),
    diagnostics: normalizeDiagnostics(record.diagnostics),
  };
}

function normalizeSessionSummaries(value: unknown): BackgroundSessionSummary[] {
  if (!Array.isArray(value)) return [];
  return value.map(normalizeSessionSummary).filter((item): item is BackgroundSessionSummary => item !== null);
}

function normalizeSessionSummary(value: unknown): BackgroundSessionSummary | null {
  if (!isRecord(value)) return null;
  const recordedStatus = readStatusValue(value.recordedStatus);
  if (!recordedStatus) return null;

  const id = typeof value.id === 'string' ? value.id : '';
  if (!id) return null;

  return {
    id,
    shortId: typeof value.shortId === 'string' && value.shortId.length > 0 ? value.shortId : id.slice(0, 8),
    name: readNullableString(value.name),
    pid: typeof value.pid === 'number' && Number.isFinite(value.pid) && value.pid > 0 ? Math.floor(value.pid) : null,
    cwd: readNullableString(value.cwd),
    recordedStatus,
    terminal: Boolean(value.terminal),
    processPresence: value.processPresence === 'unknown' ? 'unknown' : 'unknown',
    provider: readNullableString(value.provider),
    model: readNullableString(value.model),
    sessionId: readNullableString(value.sessionId),
    startedAt: readNullableString(value.startedAt),
    updatedAt: readNullableString(value.updatedAt),
    durationMs: typeof value.durationMs === 'number' && Number.isFinite(value.durationMs) ? value.durationMs : null,
    commandSummary: normalizeCommandSummary(value.commandSummary),
    project: normalizeProjectLink(value.project),
    sessionLink: normalizeSessionLink(value.sessionLink),
    stdoutLogAvailable: Boolean(value.stdoutLogAvailable),
    stderrLogAvailable: Boolean(value.stderrLogAvailable),
  };
}

function normalizeCommandSummary(value: unknown): BackgroundSessionSummary['commandSummary'] {
  if (!isRecord(value)) return { binary: null, flagCount: 0, truncated: false };
  return {
    binary: readNullableString(value.binary),
    flagCount: toNonNegativeInt(value.flagCount),
    truncated: Boolean(value.truncated),
  };
}

function normalizeProjectLink(value: unknown): BackgroundSessionSummary['project'] | null {
  if (!isRecord(value)) return null;
  const projectId = typeof value.projectId === 'string' ? value.projectId : '';
  const projectName = typeof value.projectName === 'string' ? value.projectName : '';
  if (!projectId || !projectName) return null;
  return { projectId, projectName };
}

function normalizeSessionLink(value: unknown): BackgroundSessionSummary['sessionLink'] | null {
  if (!isRecord(value)) return null;
  const projectId = typeof value.projectId === 'string' ? value.projectId : '';
  const sessionId = typeof value.sessionId === 'string' ? value.sessionId : '';
  if (!projectId || !sessionId) return null;
  return { projectId, sessionId };
}

function normalizeLogEntries(value: unknown): BackgroundSessionLogEntry[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    const record = isRecord(entry) ? entry : {};
    const id = typeof record.id === 'string' ? record.id : '';
    const lineNumber = toNonNegativeInt(record.lineNumber);
    const text = typeof record.text === 'string' ? record.text : '';
    return { id, lineNumber, text };
  });
}

function normalizeStatusCounts(
  value: unknown,
  sessions: BackgroundSessionSummary[],
): Record<BackgroundSessionStatus, number> {
  const counts = emptyStatusCounts();
  const record = isRecord(value) ? value : {};
  for (const status of STATUS_ORDER) {
    counts[status] = toNonNegativeInt(record[status]);
  }
  if (Object.values(counts).every((count) => count === 0) && sessions.length > 0) {
    for (const session of sessions) {
      counts[session.recordedStatus] += 1;
    }
  }
  return counts;
}

function normalizeDiagnostics(value: unknown): Diagnostic[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const record = isRecord(item) ? item : {};
    const level = record.level === 'warn' || record.level === 'error' ? record.level : 'info';
    const message = typeof record.message === 'string' ? record.message : '';
    return { level, message };
  });
}

function readStatusValue(value: unknown): BackgroundSessionStatus | null {
  if (typeof value !== 'string') return null;
  return (STATUS_ORDER as readonly string[]).includes(value) ? (value as BackgroundSessionStatus) : null;
}

function readNullableString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function toNonNegativeInt(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * Returns the most meaningful label for a background session. The upstream
 * `name` field is optional (only set when the user passes --name), so most
 * sessions have no name. Fall back to the working-directory basename (the
 * project folder), then the command binary, then the short id.
 */
function displayLabel(session: BackgroundSessionSummary): string {
  if (session.name) return session.name;
  if (session.cwd) {
    const parts = session.cwd.replace(/[\\/]+$/, '').split(/[\\/]/);
    const tail = parts[parts.length - 1];
    if (tail) return tail;
  }
  if (session.commandSummary.binary) return session.commandSummary.binary;
  return session.shortId;
}

function formatTimestamp(value: string | null): string {
  if (!value) return '—';
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return value;
  return new Date(parsed).toLocaleString();
}

function formatDuration(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}
