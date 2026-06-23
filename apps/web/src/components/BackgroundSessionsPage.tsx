import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

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
  RefreshCcw,
  TerminalSquare,
} from 'lucide-react';

import type { ApiClient } from '../api.js';
import { ApiRequestError } from '../api.js';
import { cn } from '../lib/cn.js';
import { LoadingOverlay } from './LoadingState.js';

type BackgroundSessionsPageProps = {
  api: ApiClient;
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

const STATUS_BADGE_STYLES: Record<BackgroundSessionStatus, string> = {
  running: 'border-primary/25 bg-primary/10 text-primary',
  unknown: 'border-hairline-soft bg-surface-soft/80 text-muted',
  exited: 'border-hairline-soft bg-surface-soft/80 text-muted',
  failed: 'border-danger/35 bg-danger/10 text-danger',
  stale: 'border-warning/35 bg-warning/10 text-warning',
  killed: 'border-danger/35 bg-danger/10 text-danger',
};

const DEFAULT_LOG_COUNT = 100;
const REFRESH_INTERVAL_MS = 15_000;

export function BackgroundSessionsPage({ api }: BackgroundSessionsPageProps) {
  const navigate = useNavigate();

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
  }, [fetchSessions]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        void fetchSessions();
      }
    }, REFRESH_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [fetchSessions]);

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

  const handleOpenSession = useCallback(
    (projectId: string, sessionId: string) => {
      void navigate(`/sessions?project=${encodeURIComponent(projectId)}&session=${encodeURIComponent(sessionId)}`);
    },
    [navigate],
  );

  const headerLabel = `${sessions.length} session${sessions.length === 1 ? '' : 's'}`;

  return (
    <section aria-busy={loading} className="panel relative min-h-[60vh]">
      {loading && response ? <LoadingOverlay label="Refreshing background sessions" /> : null}

      <header className="page-header">
        <div className="page-header-title">
          <div className="icon-frame">
            <TerminalSquare className="h-6 w-6" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <h1 className="font-display text-[34px] leading-none text-ink md:text-[40px]">Background Sessions</h1>
            <div className="mt-2 flex min-w-0 items-center gap-2">
              <span className="status-dot" />
              <span className="truncate text-xs font-medium uppercase leading-none tracking-widest text-muted-soft">
                {headerLabel}
              </span>
            </div>
          </div>
        </div>
        <div className="page-header-aside">
          <button
            aria-label="Refresh background sessions"
            type="button"
            className="btn-ghost"
            onClick={() => void fetchSessions()}
          >
            <RefreshCcw className="h-4 w-4" aria-hidden="true" />
            <span className="hidden md:inline">Refresh</span>
          </button>
        </div>
      </header>

      {error ? (
        <div className="px-6 py-8">
          <ErrorBanner message={error} degraded={degraded} />
        </div>
      ) : (
        <>
          <StatusCounters counts={statusCounts} total={sessions.length} />

          <div className="flex flex-wrap items-center gap-3 px-6 py-4">
            <label className="relative flex-1 min-w-[200px]">
              <span className="sr-only">Search background sessions</span>
              <input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search by name, id, provider, model, or project"
                className="input w-full pl-9"
              />
              <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-soft" />
            </label>
            <label className="flex items-center gap-2">
              <span className="text-xs font-medium uppercase tracking-widest text-muted-soft">Status</span>
              <select
                value={statusFilter}
                onChange={(event) => setStatusFilter(event.target.value as StatusOption)}
                className="input"
              >
                <option value="all">All</option>
                {STATUS_ORDER.map((status) => (
                  <option key={status} value={status}>
                    {capitalize(status)}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {!loading && filtered.length === 0 ? (
            <div className="px-6 pb-12">
              {sessions.length === 0 ? (
                <EmptyState
                  title="No background sessions found"
                  body="Detached background sessions started with openclaude --bg will appear here."
                />
              ) : (
                <EmptyState
                  title="No sessions match your filters"
                  body="Try clearing the search or selecting a different status."
                />
              )}
            </div>
          ) : (
            <SessionsTable
              sessions={filtered}
              selectedId={selectedId}
              onSelect={setSelectedId}
            />
          )}

          {diagnostics.length > 0 ? (
            <div className="px-6 py-4">
              <DiagnosticsList diagnostics={diagnostics} />
            </div>
          ) : null}

          {selected ? (
            <SessionDetail
              api={api}
              session={selected}
              onClose={() => setSelectedId(null)}
              onOpenSession={handleOpenSession}
            />
          ) : null}
        </>
      )}

      <div className="px-6 py-3 text-[11px] text-muted-soft">
        Privacy: background logs may contain prompts and model output. Secrets are redacted server-side, but treat every line as potentially sensitive.
      </div>
    </section>
  );
}

function StatusCounters({
  counts,
  total,
}: {
  counts: Record<BackgroundSessionStatus, number>;
  total: number;
}) {
  return (
    <div className="grid grid-cols-2 gap-2 px-6 py-4 sm:grid-cols-3 lg:grid-cols-7">
      <Counter label="Total" value={total} className="border-hairline-soft bg-surface-soft/80 text-ink" />
      {STATUS_ORDER.map((status) => (
        <Counter
          key={status}
          label={capitalize(status)}
          value={counts[status] ?? 0}
          className={cn('border', STATUS_BADGE_STYLES[status])}
        />
      ))}
    </div>
  );
}

function Counter({ label, value, className }: { label: string; value: number; className?: string }) {
  return (
    <div className={cn('flex flex-col rounded-lg px-3 py-2', className)}>
      <span className="text-[10px] font-semibold uppercase tracking-widest opacity-80">{label}</span>
      <span className="font-display text-xl leading-none">{value}</span>
    </div>
  );
}

function SessionsTable({
  sessions,
  selectedId,
  onSelect,
}: {
  sessions: BackgroundSessionSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-hairline-soft text-left text-[11px] uppercase tracking-widest text-muted-soft">
            <th className="px-6 py-2 font-medium">Name</th>
            <th className="px-3 py-2 font-medium">Status</th>
            <th className="px-3 py-2 font-medium">Provider</th>
            <th className="px-3 py-2 font-medium">Project</th>
            <th className="px-3 py-2 font-medium">Started</th>
            <th className="px-3 py-2 font-medium">Updated</th>
          </tr>
        </thead>
        <tbody>
          {sessions.map((session) => {
            const isSelected = session.id === selectedId;
            return (
              <tr
                key={session.id}
                onClick={() => onSelect(session.id)}
                className={cn(
                  'cursor-pointer border-b border-hairline-soft/60 transition-colors',
                  isSelected ? 'bg-primary/5' : 'hover:bg-surface-soft/40',
                )}
              >
                <td className="px-6 py-3">
                  <div className="flex flex-col">
                    <span className="font-medium text-ink">{session.name ?? <span className="text-muted">unnamed</span>}</span>
                    <span className="font-mono text-[11px] text-muted-soft">{session.shortId}</span>
                  </div>
                </td>
                <td className="px-3 py-3">
                  <StatusBadge status={session.recordedStatus} terminal={session.terminal} />
                </td>
                <td className="px-3 py-3">
                  <div className="flex flex-col">
                    <span className="text-ink">{session.provider ?? <span className="text-muted">—</span>}</span>
                    {session.model ? (
                      <span className="text-[11px] text-muted-soft">{session.model}</span>
                    ) : null}
                  </div>
                </td>
                <td className="px-3 py-3">
                  {session.project ? (
                    <span className="text-ink">{session.project.projectName}</span>
                  ) : (
                    <span className="text-muted">—</span>
                  )}
                </td>
                <td className="px-3 py-3 text-muted">{formatTimestamp(session.startedAt)}</td>
                <td className="px-3 py-3 text-muted">{formatTimestamp(session.updatedAt)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function StatusBadge({ status, terminal }: { status: BackgroundSessionStatus; terminal: boolean }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium',
        STATUS_BADGE_STYLES[status],
      )}
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', terminal ? 'bg-current opacity-50' : 'bg-current animate-pulse')} />
      {capitalize(status)}
    </span>
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
    <div className="fixed inset-0 z-40 flex justify-end bg-black/30" onClick={onClose}>
      <div
        className="flex h-full w-full max-w-2xl flex-col bg-panel shadow-xl"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-label={`Background session ${session.name ?? session.id} details`}
      >
        <header className="flex items-start justify-between border-b border-hairline-soft px-6 py-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <StatusBadge status={session.recordedStatus} terminal={session.terminal} />
              <span className="font-mono text-[11px] text-muted-soft">{session.shortId}</span>
            </div>
            <h2 className="mt-2 truncate font-display text-2xl text-ink">
              {session.name ?? 'Unnamed session'}
            </h2>
          </div>
          <button type="button" className="btn-ghost" aria-label="Close detail" onClick={onClose}>
            ✕
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-6 py-4">
          <DetailGrid session={session} onOpenSession={onOpenSession} />

          <div className="mt-6">
            <div className="flex items-center gap-1 border-b border-hairline-soft">
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
                <EmptyState
                  title={`No ${stream} log available`}
                  body="This session does not have a captured log for the selected stream."
                />
              ) : logs && logs.entries.length === 0 ? (
                <EmptyState title="Log is empty" body="No lines were captured yet." />
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
          <dt className="text-[11px] font-medium uppercase tracking-widest text-muted-soft">Session</dt>
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
      <dt className="text-[11px] font-medium uppercase tracking-widest text-muted-soft">{label}</dt>
      <dd className={cn('text-ink', mono && 'font-mono text-[12px] break-all')}>{value}</dd>
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
      <div className="max-h-[400px] overflow-y-auto rounded-lg border border-hairline-soft bg-surface-soft/40">
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

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-hairline-soft px-6 py-12 text-center">
      <TerminalSquare className="h-8 w-8 text-muted-soft" aria-hidden="true" />
      <p className="mt-3 font-medium text-ink">{title}</p>
      <p className="mt-1 text-sm text-muted-soft">{body}</p>
    </div>
  );
}

function DiagnosticsList({ diagnostics }: { diagnostics: Diagnostic[] }) {
  return (
    <details className="rounded-lg border border-hairline-soft bg-surface-soft/40">
      <summary className="cursor-pointer px-4 py-2 text-xs font-medium uppercase tracking-widest text-muted-soft">
        {diagnostics.length} diagnostic{diagnostics.length === 1 ? '' : 's'}
      </summary>
      <ul className="border-t border-hairline-soft px-4 py-2 text-xs">
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

function SearchIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
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
    start: typeof record.start === 'number' ? Math.floor(record.start) : 0,
    count: typeof record.count === 'number' ? Math.floor(record.count) : 0,
    totalLines: typeof record.totalLines === 'number' ? Math.floor(record.totalLines) : 0,
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
    flagCount: typeof value.flagCount === 'number' ? Math.floor(value.flagCount) : 0,
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
    const lineNumber = typeof record.lineNumber === 'number' ? Math.floor(record.lineNumber) : 0;
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
    const raw = record[status];
    counts[status] = typeof raw === 'number' && Number.isFinite(raw) ? Math.floor(raw) : 0;
  }
  // Recompute from the normalized session list if the server-provided counts are missing or zero.
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
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
