import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  X,
  Bot,
  User,
  Code2,
  Clock,
  FileText,
  Copy,
  Check,
  MessageSquare,
  Expand,
  Minimize2,
  History,
  ListChecks,
  ChevronDown,
} from 'lucide-react';

import type { ConversationTimelineEvent, SessionDetailsResponse } from '@openclaude-studio/shared';

import type { createApiClient } from '../api.js';
import { cn } from '../lib/cn.js';
import { CopyablePath } from './CopyablePath.js';

// Types

type ApiClient = ReturnType<typeof createApiClient>;
type TimelineEvent = ConversationTimelineEvent;
type FileHistoryEntry = SessionDetailsResponse['session']['fileHistory'][number];
type FileHistoryGroup = {
  filePath: string;
  latest: FileHistoryEntry;
  entries: FileHistoryEntry[];
  storedBackups: number;
  missingBackups: number;
  newFiles: number;
};
type PartialSessionDetails = Partial<SessionDetailsResponse['session']> & {
  tokens?: Partial<SessionDetailsResponse['session']['tokens']>;
};
type TimelineTool = NonNullable<ConversationTimelineEvent['tool']>;

export type InlineSegment =
  | { type: 'text'; text: string }
  | { type: 'code'; text: string }
  | { type: 'strong'; text: string }
  | { type: 'link'; text: string; href: string };

export type ConversationBlock =
  | { type: 'heading'; depth: number; text: string }
  | { type: 'paragraph'; segments: InlineSegment[] }
  | { type: 'code'; language: string; code: string }
  | { type: 'list'; ordered: boolean; items: InlineSegment[][] };

export function SessionDetailsModal({
  sessionId,
  projectId,
  isOpen,
  onClose,
  api,
}: {
  sessionId: string | null;
  projectId: string | null;
  isOpen: boolean;
  onClose: () => void;
  api: ApiClient;
}) {
  const [details, setDetails] = useState<SessionDetailsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [copied, setCopied] = useState(false);
  const mountedRef = useRef(true);
  const copyResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
      if (copyResetTimerRef.current) {
        clearTimeout(copyResetTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    let ignore = false;
    if (!sessionId || !isOpen || !projectId) {
      setDetails(null);
      setError(null);
      return () => {
        ignore = true;
      };
    }
    setDetails(null);
    setError(null);
    setShowAll(false);
    api
      .sessionDetails(projectId, sessionId)
      .then((data: SessionDetailsResponse) => {
        if (!ignore) setDetails(normalizeSessionDetailsResponse(data));
      })
      .catch((err: unknown) => {
        if (!ignore) setError(err instanceof Error ? err.message : 'Unable to load session details.');
      });
    return () => {
      ignore = true;
    };
  }, [sessionId, projectId, isOpen, api]);

  const timeline = useMemo(
    () => (details?.timeline ?? []).filter(isRenderableTimelineEvent),
    [details],
  );
  const visibleTimeline = showAll ? timeline : timeline.slice(0, 12);

  const handleCopyTimeline = () => {
    if (!details) return;
    const transcript = timeline
      .map((event) => `[${event.kind.toUpperCase()}] ${event.title}\n${event.content}`)
      .join('\n\n');
    if (!navigator.clipboard) return;
    void navigator.clipboard.writeText(transcript)
      .then(() => {
        if (!mountedRef.current) return;
        if (copyResetTimerRef.current) {
          clearTimeout(copyResetTimerRef.current);
        }
        setCopied(true);
        copyResetTimerRef.current = setTimeout(() => {
          if (mountedRef.current) {
            setCopied(false);
          }
          copyResetTimerRef.current = null;
        }, 2000);
      })
      .catch(() => {});
  };

  const session = details?.session;
  const fileHistoryGroups = useMemo(
    () => groupFileHistoryEntries(session?.fileHistory ?? []),
    [session?.fileHistory],
  );

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={details ? 'Session Details' : 'Loading...'}
      className="max-w-5xl h-[88vh]"
      bodyClassName="p-0 overflow-hidden flex-1 min-h-0"
    >
      {details && session ? (
        <div className="h-full min-h-0 flex flex-col p-6">
          {/* Session header */}
          <div className="flex flex-col md:flex-row items-start justify-between gap-6 pb-6 border-b border-hairline-soft shrink-0">
            <div className="flex-1">
              <h2 className="text-[22px] font-medium leading-[1.3] text-ink mb-2">{session.title}</h2>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-muted">
                <span className="flex items-center gap-1.5 bg-surface-soft px-2 py-0.5 rounded border border-hairline-soft/50">
                  <Clock className="w-3.5 h-3.5 text-muted-soft" /> {formatSessionDate(session.firstTimestamp)}
                </span>
                <span className="hidden sm:inline text-hairline">&bull;</span>
                <span className="flex items-center gap-1.5 text-primary bg-primary/5 px-2 py-0.5 rounded border border-primary/10 font-medium">
                  <Bot className="w-3.5 h-3.5" /> {session.modelSet.join(', ') || 'unknown model'}
                </span>
              </div>
            </div>
            <div className="flex flex-row md:flex-col items-center md:items-end gap-3 shrink-0">
              <Badge variant={session.status === 'completed' ? 'success' : 'error'}>
                {session.status === 'completed' ? 'Successful' : 'Failed'}
              </Badge>
              <div className="flex items-center gap-2 font-mono text-[13px] bg-code-panel text-code-panel-text px-3 py-1.5 rounded-lg border border-code-panel-border shadow-inner">
                <span className="opacity-60">COST</span>
                <span className="font-medium text-success">${session.costUsd.toFixed(3)}</span>
              </div>
            </div>
          </div>

          {/* Body: 8/4 grid */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 flex-1 min-h-0 overflow-hidden pt-8">
            {/* Left: conversation */}
            <div className="lg:col-span-8 flex min-h-0 flex-col">
              <div className="flex items-center justify-between border-b border-hairline-soft pb-3 mb-4 shrink-0">
                <div className="flex items-center gap-3">
                  <h3 className="text-xs font-medium tracking-[0.15em] text-muted-soft uppercase flex items-center gap-2">
                    <MessageSquare className="w-4 h-4" /> Conversation
                  </h3>
                  <span className="text-xs px-2 py-0.5 rounded-full bg-surface-soft border border-hairline-soft text-muted">
                    {timeline.length} events
                  </span>
                </div>
                <Button
                  variant="secondary"
                  className="!h-8 !text-xs !px-3 font-medium gap-1.5"
                  onClick={handleCopyTimeline}
                >
                  {copied ? <Check className="w-3 h-3 text-success" /> : <Copy className="w-3 h-3" />}
                  {copied ? 'Copied' : 'Copy Timeline'}
                </Button>
              </div>

              <div className="flex-1 min-h-0 overflow-y-auto pr-3 custom-scrollbar">
                <div className="space-y-6 relative ml-4 pb-2">
                  {/* Vertical line connector */}
                  <div className="absolute left-0 top-2 bottom-2 w-0.5 bg-hairline-soft -translate-x-[1.35rem]" />

                  {visibleTimeline.length === 0 ? (
                    <div className="ml-[-1rem] rounded-lg border border-dashed border-hairline-soft bg-surface-soft/30 px-4 py-8 text-center text-sm text-muted">
                      No conversation events were recorded for this session.
                    </div>
                  ) : (
                    visibleTimeline.map((event) => (
                      <ConversationEvent key={event.id} event={event} />
                    ))
                  )}

                  {!showAll && timeline.length > 12 && (
                    <div className="pt-2">
                      <button
                        className="w-full h-12 rounded-xl border border-dashed border-hairline-soft hover:bg-surface-soft text-muted text-sm font-medium transition-all group inline-flex items-center justify-center"
                        onClick={() => setShowAll(true)}
                      >
                        <Expand className="w-4 h-4 mr-2" />
                        Reveal {timeline.length - 12} more events in this session
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Right: sidebar */}
            <div
              data-testid="session-details-sidebar"
              className="lg:col-span-4 flex min-h-0 flex-col gap-4 overflow-y-auto overflow-x-hidden pr-1 custom-scrollbar"
            >
              <section className="shrink-0 rounded-lg border border-hairline-soft bg-surface-soft/35 p-4">
                <div className="mb-3 flex items-center gap-2 text-xs font-medium uppercase tracking-[0.15em] text-muted-soft">
                  <FileText className="w-4 h-4" />
                  Usage
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <MetricBlock label="Input" value={session.tokens.input.toLocaleString()} />
                  <MetricBlock label="Output" value={session.tokens.output.toLocaleString()} />
                  <MetricBlock label="Cache Read" value={session.tokens.cacheRead.toLocaleString()} />
                  <MetricBlock label="Cache Write" value={session.tokens.cacheWrite.toLocaleString()} />
                </div>
              </section>

              <div className="space-y-4 pb-1">
                <CollapsibleSection icon={<Code2 className="w-4 h-4" />} title="Files Changed" count={session.changedFiles.length} defaultOpen>
                  {session.changedFiles.length === 0 ? (
                    <div className="text-[12px] text-muted-soft text-center py-5 border border-dashed border-hairline-soft rounded-lg bg-surface-soft/30">
                      No files were altered.
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {session.changedFiles.map((file) => (
                        <div
                          key={file}
                          className="flex justify-between items-center bg-surface-soft border border-hairline-soft/50 rounded-lg px-3 py-2 text-[12px] font-mono group hover:border-primary/20 hover:bg-canvas transition-all"
                        >
                          <CopyablePath
                            value={file}
                            display={pathDisplayName(file)}
                            copyLabel="Copy changed file path"
                            truncate
                            className="mr-2 text-ink"
                            textClassName="truncate"
                            buttonClassName="h-5 w-5"
                          />
                        </div>
                      ))}
                    </div>
                  )}
                </CollapsibleSection>

                <CollapsibleSection icon={<Code2 className="w-4 h-4" />} title="Tools Used" count={session.toolsUsed.length} defaultOpen={false}>
                  <div>
                    {session.toolsUsed.length === 0 ? (
                      <div className="text-[12px] text-muted-soft text-center py-5 border border-dashed border-hairline-soft rounded-lg bg-surface-soft/30">
                        No tool calls recorded.
                      </div>
                    ) : (
                      <div className="flex flex-wrap gap-2">
                        {session.toolsUsed.map((tool) => (
                          <span key={tool.name} className="text-xs font-medium px-2 py-1 rounded-md bg-surface-soft border border-hairline-soft text-ink font-mono">
                            {tool.name} x{tool.count}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </CollapsibleSection>

                <CollapsibleSection icon={<ListChecks className="w-4 h-4" />} title="Tasks" count={session.linkedTasks.length} defaultOpen={false}>
                  {session.linkedTasks.length === 0 ? (
                    <div className="text-[12px] text-muted-soft text-center py-5 border border-dashed border-hairline-soft rounded-lg bg-surface-soft/30">
                      No session tasks were recorded.
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {session.linkedTasks.map((task) => (
                        <div key={task.id} className="rounded-lg border border-hairline-soft/50 bg-surface-soft/50 px-3 py-2">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="truncate text-[13px] font-medium text-ink">{task.title}</div>
                              {task.description && (
                                <div className="mt-1 max-h-[2.9em] overflow-hidden text-[12px] leading-relaxed text-muted">
                                  {task.description}
                                </div>
                              )}
                            </div>
                            <TaskStatusBadge status={task.status} />
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </CollapsibleSection>

                <CollapsibleSection icon={<History className="w-4 h-4" />} title="File History" count={fileHistoryGroups.length} defaultOpen={false}>
                  {fileHistoryGroups.length === 0 ? (
                    <div className="text-[12px] text-muted-soft text-center py-5 border border-dashed border-hairline-soft rounded-lg bg-surface-soft/30">
                      {session.fileHistoryAvailable ? 'Backup files exist, but no transcript snapshot mapped them to paths.' : 'No file-history snapshots were recorded.'}
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {fileHistoryGroups.map((group) => (
                        <div key={group.filePath} className="rounded-lg border border-hairline-soft/50 bg-canvas px-3 py-2">
                          <CopyablePath
                            value={group.filePath}
                            display={pathDisplayName(group.filePath)}
                            copyLabel="Copy file-history path"
                            truncate
                            className="font-mono text-[12px] text-ink"
                            textClassName="truncate"
                            buttonClassName="h-5 w-5"
                          />
                          <div className="mt-2 flex flex-wrap items-center gap-2 text-[12px] text-muted-soft">
                            <span className="font-mono">Latest v{group.latest.version}</span>
                            <span>{formatVersionCount(group.entries.length)}</span>
                            {group.latest.backupTime && <span>{formatBackupTime(group.latest.backupTime)}</span>}
                            <FileHistoryStateBadge group={group} />
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </CollapsibleSection>

                <CollapsibleSection
                  icon={<FileText className="w-4 h-4" />}
                  title="Plans"
                  count={session.linkedPlans.length}
                  defaultOpen={false}
                >
                  <div className="space-y-3 pr-1">
                    {session.linkedPlans.length > 0 && (
                      <div className="space-y-2 text-[12px] text-muted">
                        {session.linkedPlans.map((plan, index, plans) => (
                          <div key={plan.slug} className="rounded-lg border border-hairline-soft/50 bg-canvas px-3 py-2">
                            <div className="truncate text-[13px] font-medium text-ink">{plan.title}</div>
                            <div className="mt-1 flex flex-wrap items-center gap-2 text-[12px] text-muted-soft">
                              <span>
                                {plans.length === 1 ? 'Plan' : `Plan ${index + 1}`}{!plan.exists ? ' missing' : ''}
                              </span>
                              <span className="font-mono">{plan.slug}</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}

                    {session.linkedPlans.length === 0 && (
                      <div className="text-[12px] text-muted-soft text-center py-5 border border-dashed border-hairline-soft rounded-lg bg-surface-soft/30">
                        No linked plans were recorded.
                      </div>
                    )}
                  </div>
                </CollapsibleSection>
              </div>
            </div>
          </div>
        </div>
      ) : error ? (
        <div className="h-full min-h-64 flex flex-col items-center justify-center text-error gap-4 p-6">
          <p className="text-sm font-medium">{error}</p>
        </div>
      ) : (
        <div className="h-full min-h-64 flex flex-col items-center justify-center text-muted gap-4 p-6">
          <div className="w-8 h-8 border border-primary border-t-transparent rounded-full animate-spin" />
          <p className="text-sm font-medium animate-pulse">Loading session details...</p>
        </div>
      )}
    </Modal>
  );
}

function normalizeSessionDetailsResponse(data: SessionDetailsResponse): SessionDetailsResponse {
  const session = data.session as PartialSessionDetails | undefined;
  if (!session) {
    throw new Error('Session details response was missing session data.');
  }

  return {
    ...data,
    timeline: arrayOrEmpty<unknown>(data.timeline).map(normalizeTimelineEvent),
    session: {
      ...data.session,
      id: typeof session.id === 'string' ? session.id : '',
      title: typeof session.title === 'string' && session.title.trim() ? session.title : 'Untitled session',
      status: session.status === 'failed' ? 'failed' : 'completed',
      firstTimestamp: validTimestampOrFallback(session.firstTimestamp),
      lastTimestamp: validTimestampOrFallback(session.lastTimestamp),
      modelSet: arrayOrEmpty<string>(session.modelSet),
      changedFiles: arrayOrEmpty<string>(session.changedFiles),
      tokens: {
        input: finiteNumber(session.tokens?.input),
        output: finiteNumber(session.tokens?.output),
        cacheRead: finiteNumber(session.tokens?.cacheRead),
        cacheWrite: finiteNumber(session.tokens?.cacheWrite),
      },
      costUsd: finiteNumber(session.costUsd),
      linkedPlanCount: finiteNumber(session.linkedPlanCount),
      linkedTaskCount: finiteNumber(session.linkedTaskCount),
      messageCount: finiteNumber(session.messageCount),
      toolsUsed: arrayOrEmpty<SessionDetailsResponse['session']['toolsUsed'][number]>(session.toolsUsed),
      fileHistoryAvailable: Boolean(session.fileHistoryAvailable),
      fileHistory: arrayOrEmpty<SessionDetailsResponse['session']['fileHistory'][number]>(session.fileHistory),
      linkedTasks: arrayOrEmpty<SessionDetailsResponse['session']['linkedTasks'][number]>(session.linkedTasks),
      linkedPlans: arrayOrEmpty<SessionDetailsResponse['session']['linkedPlans'][number]>(session.linkedPlans),
    },
  };
}

function normalizeTimelineEvent(value: unknown, index: number): ConversationTimelineEvent {
  const event = isRecord(value) ? value : {};
  const kind = event.kind;
  const safeKind: ConversationTimelineEvent['kind'] =
    kind === 'user' || kind === 'assistant' || kind === 'tool' || kind === 'error' || kind === 'system'
      ? kind
      : 'system';

  const normalized: ConversationTimelineEvent = {
    id: typeof event.id === 'string' && event.id ? event.id : `timeline-${index}`,
    timestamp: validTimestampOrFallback(event.timestamp),
    kind: safeKind,
    title: typeof event.title === 'string' ? event.title : '',
    content: typeof event.content === 'string' ? event.content : '',
  };
  if (isRecord(event.tool)) {
    normalized.tool = normalizeTimelineTool(event.tool);
  }
  return normalized;
}

function normalizeTimelineTool(value: Record<string, unknown>): TimelineTool {
  const phase = value.phase === 'result' ? 'result' : 'call';
  const status =
    value.status === 'success' || value.status === 'error' || value.status === 'unknown'
      ? value.status
      : 'unknown';
  const outputType =
    value.outputType === 'command' ||
    value.outputType === 'stdout' ||
    value.outputType === 'stderr' ||
    value.outputType === 'file' ||
    value.outputType === 'text' ||
    value.outputType === 'image' ||
    value.outputType === 'none'
      ? value.outputType
      : 'none';

  return {
    phase,
    name: typeof value.name === 'string' ? value.name : null,
    status,
    command: typeof value.command === 'string' ? value.command : null,
    filePath: typeof value.filePath === 'string' ? value.filePath : null,
    outputType,
  };
}

function arrayOrEmpty<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function finiteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function validTimestampOrFallback(value: unknown): string {
  if (typeof value === 'string' && Number.isFinite(Date.parse(value))) {
    return value;
  }
  return new Date(0).toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// Modal

function Modal({
  isOpen,
  onClose,
  title,
  children,
  className,
  bodyClassName,
}: {
  isOpen: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = window.requestAnimationFrame(() => {
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusTarget = getFocusableElements(dialog)[0] ?? dialog;
      focusTarget.focus();
    });

    return () => {
      window.cancelAnimationFrame(frame);
      const restoreTarget = restoreFocusRef.current;
      restoreFocusRef.current = null;
      if (restoreTarget && document.contains(restoreTarget)) {
        restoreTarget.focus();
      }
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.key === 'Tab') {
        trapTabNavigation(e, dialogRef.current);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[1000] flex items-center justify-center overflow-y-auto overscroll-contain p-4 bg-surface-dark/55"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={dialogRef}
        tabIndex={-1}
        className={cn('bg-canvas border border-hairline rounded-lg shadow-sm w-full max-w-2xl max-h-[90vh] flex flex-col overflow-hidden', className)}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-hairline-soft bg-surface-soft shrink-0">
          <h2 id={titleId} className="text-[22px] font-medium leading-[1.3] text-ink">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close dialog"
            className="p-2 text-muted hover:text-error hover:bg-surface-card rounded-md transition-colors"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className={cn('p-6 overflow-hidden flex-1 min-h-0', bodyClassName)}>{children}</div>
      </div>
    </div>,
    document.body,
  );
}

function trapTabNavigation(event: KeyboardEvent, dialog: HTMLElement | null): void {
  if (!dialog) return;

  const focusable = getFocusableElements(dialog);
  if (focusable.length === 0) {
    event.preventDefault();
    dialog.focus();
    return;
  }

  const first = focusable[0]!;
  const last = focusable[focusable.length - 1]!;
  const activeElement = document.activeElement;

  if (event.shiftKey) {
    if (activeElement === first || !dialog.contains(activeElement)) {
      event.preventDefault();
      last.focus();
    }
    return;
  }

  if (activeElement === last || !dialog.contains(activeElement)) {
    event.preventDefault();
    first.focus();
  }
}

function getFocusableElements(root: HTMLElement): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((element) => element.tabIndex >= 0 && element.getAttribute('aria-hidden') !== 'true');
}

// Conversation event

function ConversationEvent({ event }: { event: TimelineEvent }) {
  const meta = eventMeta(event);

  return (
    <div className="relative group">
      <div className={cn('absolute -left-[1.35rem] top-5 w-2.5 h-2.5 rounded-full border-2 border-canvas -translate-x-1/2 z-10', meta.dotClass)} />

      <article className={cn('rounded-xl border transition-colors duration-200', meta.cardClass)}>
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-hairline-soft/70 px-5 py-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className={cn('inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md', meta.iconClass)}>
              {meta.icon}
            </span>
            <div className="min-w-0">
              <div className={cn('text-xs font-medium uppercase tracking-[0.15em]', meta.labelClass)}>{meta.label}</div>
              {event.kind === 'tool' && (
                <div className="mt-0.5 truncate font-mono text-xs text-muted-soft">{event.title}</div>
              )}
            </div>
          </div>
          <time className="font-mono text-xs text-muted-soft" dateTime={event.timestamp}>
            {formatEventTime(event.timestamp)}
          </time>
        </header>

        <div className="px-5 py-4">
          {event.kind === 'tool' || event.kind === 'system' || event.kind === 'error' ? (
            <ToolContent event={event} />
          ) : (
            <MarkdownContent content={event.content} role={event.kind} />
          )}
        </div>
      </article>
    </div>
  );
}

// Markdown content

function MarkdownContent({ content, role }: { content: string; role: 'user' | 'assistant' }) {
  const blocks = useMemo(() => parseConversationMarkdown(content), [content]);

  return (
    <div className={cn('space-y-3 break-words text-[14px] leading-[1.65]', role === 'user' ? 'text-ink' : 'text-body')}>
      {blocks.map((block, index) => {
        if (block.type === 'heading') {
          const sizeClass = block.depth === 1 ? 'text-[20px]' : block.depth === 2 ? 'text-[17px]' : 'text-[15px]';
          return (
            <div key={`${block.type}-${index}`} className={cn('font-medium leading-snug text-ink', sizeClass)}>
              {block.text}
            </div>
          );
        }

        if (block.type === 'code') {
          return (
            <div key={`${block.type}-${index}`} className="overflow-hidden rounded-lg border border-code-panel-border bg-code-panel">
              {block.language && (
                <div className="border-b border-code-panel-border bg-code-panel-elevated px-3 py-2 font-mono text-xs uppercase tracking-[0.14em] text-code-panel-muted">
                  {block.language}
                </div>
              )}
              <pre className="overflow-x-auto p-4 font-mono text-[13px] leading-[1.65] text-code-panel-text custom-scrollbar">
                <code>{block.code}</code>
              </pre>
            </div>
          );
        }

        if (block.type === 'list') {
          const List = block.ordered ? 'ol' : 'ul';
          return (
            <List
              key={`${block.type}-${block.ordered}-${index}`}
              className={cn('space-y-1 pl-5 marker:text-primary', block.ordered ? 'list-decimal' : 'list-disc')}
            >
              {block.items.map((item, itemIndex) => (
                <li key={itemIndex}>
                  <InlineContent segments={item} />
                </li>
              ))}
            </List>
          );
        }

        return (
          <p key={`${block.type}-${index}`} className="whitespace-pre-wrap">
            <InlineContent segments={block.segments} />
          </p>
        );
      })}
    </div>
  );
}

function InlineContent({ segments }: { segments: InlineSegment[] }) {
  return (
    <>
      {segments.map((segment, index) => {
        if (segment.type === 'code') {
          return (
            <code key={`${segment.type}-${index}`} className="rounded bg-surface-dark/5 px-1.5 py-0.5 font-mono text-[0.92em] text-ink">
              {segment.text}
            </code>
          );
        }
        if (segment.type === 'strong') {
          return <strong key={`${segment.type}-${index}`} className="font-medium text-ink">{segment.text}</strong>;
        }
        if (segment.type === 'link') {
          return (
            <a
              key={`${segment.type}-${index}`}
              href={segment.href}
              target={segment.href.startsWith('http') ? '_blank' : undefined}
              rel={segment.href.startsWith('http') ? 'noreferrer' : undefined}
              className="text-primary underline decoration-primary/30 underline-offset-2 transition-colors hover:text-primary-active"
            >
              {segment.text}
            </a>
          );
        }
        return <span key={`${segment.type}-${index}`}>{segment.text}</span>;
      })}
    </>
  );
}

// Tool content

function ToolContent({ event }: { event: TimelineEvent }) {
  if (event.kind === 'tool') {
    const description = describeToolEvent(event);

    return (
      <div className="space-y-3 text-[13px] leading-[1.55]">
        {description.statusLabel && (
          <span
            className={cn(
              'inline-flex items-center rounded-md px-2 py-1 text-xs font-medium uppercase tracking-[0.12em]',
              description.statusTone === 'success'
                ? 'bg-success/10 text-success'
                : description.statusTone === 'error'
                  ? 'bg-error/10 text-error'
                  : 'bg-surface-soft text-muted',
            )}
          >
            {description.statusLabel}
          </span>
        )}

        {description.path && (
          <div className="space-y-1">
            <div className="text-xs font-medium uppercase tracking-[0.14em] text-muted-soft">Path</div>
            <CopyablePath
              value={description.path}
              copyLabel="Copy tool path"
              breakAll
              className="font-mono text-[12px] text-ink"
              textClassName="break-all"
              buttonClassName="h-5 w-5"
            />
          </div>
        )}

        {description.primaryValue && description.primaryLabel && (
          <ToolCodeBlock label={description.primaryLabel} content={description.primaryValue} />
        )}

        {description.outputValue && description.outputLabel && (
          <ToolCodeBlock label={description.outputLabel} content={description.outputValue} tone={description.statusTone} />
        )}
      </div>
    );
  }

  return (
    <pre
      className={cn(
        'max-h-64 overflow-auto rounded-lg border p-3 font-mono text-xs leading-[1.6] custom-scrollbar whitespace-pre-wrap',
        event.kind === 'error' ? 'border-error/20 bg-error/5 text-error' : 'border-code-panel-border bg-code-panel text-code-panel-muted',
      )}
    >
      <code>{event.content}</code>
    </pre>
  );
}

function ToolCodeBlock({ label, content, tone = 'neutral' }: { label: string; content: string; tone?: 'neutral' | 'success' | 'error' }) {
  const [expanded, setExpanded] = useState(false);
  const canExpand = isExpandableToolContent(content);
  const displayContent = toolContentBlockDisplayContent(content, expanded);

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-3">
        <div className="text-xs font-medium uppercase tracking-[0.14em] text-muted-soft">{label}</div>
        {canExpand && (
          <button
            type="button"
            className="inline-flex items-center gap-1.5 h-8 px-2.5 text-xs bg-transparent text-ink hover:bg-surface-soft rounded-md transition-colors"
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? <Minimize2 className="h-3.5 w-3.5" /> : <Expand className="h-3.5 w-3.5" />}
            {expanded ? 'Collapse' : 'Expand'}
          </button>
        )}
      </div>
      <pre
        className={cn(
          'rounded-lg border p-3 font-mono text-xs leading-[1.6] custom-scrollbar whitespace-pre-wrap break-words',
          toolContentBlockOverflowClass(content, expanded),
          tone === 'error' ? 'border-error/20 bg-error/5 text-error' : 'border-code-panel-border bg-code-panel text-code-panel-muted',
        )}
      >
        <code>{displayContent}</code>
      </pre>
    </div>
  );
}

// Primitives

function MetricBlock({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-hairline-soft/50 bg-canvas px-3 py-2.5">
      <div className="mb-1 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-soft">{label}</div>
      <div className="truncate font-mono text-[15px] font-medium text-ink" title={value}>{value}</div>
    </div>
  );
}

function Badge({ children, variant, className: badgeClass }: { children: ReactNode; variant: 'success' | 'error' | 'primary' | 'default'; className?: string }) {
  const variants = {
    default: 'bg-surface-card text-ink text-[13px] font-medium px-3 py-1 rounded-pill',
    primary: 'bg-primary text-on-primary text-[12px] font-medium uppercase tracking-[1.5px] px-3 py-1 rounded-pill',
    error: 'bg-error text-on-primary text-[12px] font-medium uppercase tracking-[1.5px] px-3 py-1 rounded-pill',
    success: 'bg-success text-on-primary text-[12px] font-medium uppercase tracking-[1.5px] px-3 py-1 rounded-pill',
  };
  return (
    <span className={cn('inline-flex items-center', variants[variant], badgeClass)}>{children}</span>
  );
}

function Button({
  variant = 'primary',
  className,
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' }) {
  const base = 'inline-flex items-center justify-center rounded-md px-5 h-10 text-[14px] font-medium leading-none transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/15 disabled:opacity-50 disabled:pointer-events-none';
  const variants = {
    primary: 'bg-primary text-on-primary hover:bg-primary-active',
    secondary: 'bg-canvas text-ink border border-hairline hover:bg-surface-soft',
    ghost: 'bg-transparent text-ink hover:bg-surface-soft',
  };
  return (
    <button className={cn(base, variants[variant], className)} {...props}>
      {children}
    </button>
  );
}

function TaskStatusBadge({ status }: { status: string }) {
  const normalized = status.replace(/_/g, ' ');
  const variant = status === 'completed' ? 'success' : status === 'in_progress' ? 'primary' : 'default';

  return (
    <Badge variant={variant} className="shrink-0 text-xs px-2 py-0.5 uppercase tracking-[1px]">
      {normalized}
    </Badge>
  );
}

function FileHistoryStateBadge({ group }: { group: FileHistoryGroup }) {
  let label = 'Backup stored';
  let className = 'bg-success/10 text-success';
  if (group.newFiles > 0 && group.storedBackups === 0 && group.missingBackups === 0) {
    label = 'New file';
    className = 'bg-surface-soft text-muted';
  } else if (group.missingBackups > 0 && group.storedBackups === 0) {
    label = 'Backup missing';
    className = 'bg-error/10 text-error';
  } else if (group.missingBackups > 0) {
    label = 'Partial backups';
    className = 'bg-warning/10 text-warning';
  }

  return (
    <span className={cn('rounded px-1.5 py-0.5 text-[11px] font-medium', className)}>
      {label}
    </span>
  );
}

// Collapsible sidebar section

function CollapsibleSection({
  icon,
  title,
  count,
  defaultOpen = true,
  children,
}: {
  icon: ReactNode;
  title: string;
  count?: number;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full flex items-center gap-2 text-xs font-medium tracking-[0.15em] text-muted-soft uppercase border-b border-hairline-soft pb-3 hover:text-ink transition-colors"
      >
        {icon}
        <span className="flex-1 text-left">{title}</span>
        {count !== undefined && (
          <span className="text-[11px] px-2 py-0.5 rounded-full bg-surface-soft border border-hairline-soft/70 text-muted font-semibold tabular-nums leading-none">
            {count}
          </span>
        )}
        <ChevronDown className={cn('w-3.5 h-3.5 transition-transform duration-200', !open && '-rotate-90')} />
      </button>
      {open && <div className="pt-3">{children}</div>}
    </div>
  );
}

// Event metadata

function eventMeta(event: TimelineEvent) {
  if (event.kind === 'user') {
    return {
      label: 'User',
      icon: <User className="h-3.5 w-3.5" />,
      dotClass: 'bg-primary shadow-sm shadow-primary/20',
      cardClass: 'bg-surface-soft border-hairline-soft/70 group-hover:border-primary/20',
      iconClass: 'bg-primary/10 text-primary',
      labelClass: 'text-primary',
    };
  }

  if (event.kind === 'assistant') {
    return {
      label: 'Assistant',
      icon: <Bot className="h-3.5 w-3.5" />,
      dotClass: 'bg-success shadow-sm shadow-success/20',
      cardClass: 'bg-canvas border-primary/10 group-hover:border-primary/25',
      iconClass: 'bg-success/10 text-success',
      labelClass: 'text-success',
    };
  }

  if (event.kind === 'error') {
    return {
      label: 'Error',
      icon: <Code2 className="h-3.5 w-3.5" />,
      dotClass: 'bg-error shadow-sm shadow-error/20',
      cardClass: 'bg-error/[0.03] border-error/20 group-hover:border-error/30 ml-4',
      iconClass: 'bg-error/10 text-error',
      labelClass: 'text-error',
    };
  }

  return {
    label: event.kind === 'tool' ? describeToolEvent(event).label : 'System',
    icon: <Code2 className="h-3.5 w-3.5" />,
    dotClass: 'bg-muted-soft',
    cardClass: 'bg-canvas border-dashed border-hairline-soft ml-4',
    iconClass: 'bg-surface-soft text-muted',
    labelClass: 'text-muted',
  };
}

// Tool event description

type ToolEventDescription = {
  label: 'Tool' | 'Tool Call' | 'Tool Result';
  statusLabel: string | null;
  statusTone: 'neutral' | 'success' | 'error';
  primaryLabel: string | null;
  primaryValue: string | null;
  outputLabel: string | null;
  outputValue: string | null;
  path: string | null;
};

function describeToolEvent(event: TimelineEvent): ToolEventDescription {
  const tool = event.tool;
  const content = event.content.trim();
  const label = tool?.phase === 'call' ? 'Tool Call' : tool?.phase === 'result' ? 'Tool Result' : 'Tool';
  const statusTone: 'neutral' | 'success' | 'error' = tool?.status === 'error' ? 'error' : tool?.status === 'success' ? 'success' : 'neutral';
  const statusLabel =
    tool?.phase === 'result'
      ? tool.status === 'error'
        ? 'Failed'
        : tool.status === 'success'
          ? 'Completed'
          : 'Unknown'
      : null;

  const primaryLabel =
    tool?.phase === 'call' && tool.command ? 'Command' : tool?.phase === 'call' && tool.filePath ? 'Path' : null;
  const primaryValue = tool?.phase === 'call' ? tool.command ?? tool.filePath ?? null : null;
  const path = tool?.filePath && primaryValue !== tool.filePath ? tool.filePath : null;
  const contentIsPrimary = Boolean(primaryValue && content === primaryValue.trim());
  const contentIsPath = Boolean(path && content === path.trim());
  const outputValue = content && !contentIsPrimary && !contentIsPath ? event.content : null;
  const outputLabel = outputValue
    ? tool?.outputType === 'stderr'
      ? 'Error output'
      : tool?.outputType === 'stdout'
        ? 'Output'
        : 'Details'
    : null;

  return { label, statusLabel, statusTone, primaryLabel, primaryValue, outputLabel, outputValue, path };
}

// Markdown parser

function parseConversationMarkdown(source: string): ConversationBlock[] {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const blocks: ConversationBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? '';
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = line.match(/^```([A-Za-z0-9_-]*)\s*$/);
    if (fence) {
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index] ?? '')) {
        codeLines.push(lines[index] ?? '');
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({ type: 'code', language: fence[1] ?? '', code: codeLines.join('\n') });
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      blocks.push({ type: 'heading', depth: heading[1]!.length, text: heading[2]!.trim() });
      index += 1;
      continue;
    }

    const unordered = line.match(/^\s*[-*]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (unordered || ordered) {
      const listItems: InlineSegment[][] = [];
      const isOrdered = Boolean(ordered);
      while (index < lines.length) {
        const item = isOrdered
          ? (lines[index] ?? '').match(/^\s*\d+[.)]\s+(.+)$/)
          : (lines[index] ?? '').match(/^\s*[-*]\s+(.+)$/);
        if (!item) break;
        listItems.push(parseInlineMarkdown(item[1]!.trim()));
        index += 1;
      }
      blocks.push({ type: 'list', ordered: isOrdered, items: listItems });
      continue;
    }

    const paragraphLines: string[] = [];
    while (index < lines.length) {
      const nextLine = lines[index] ?? '';
      if (!nextLine.trim()) break;
      if (/^```/.test(nextLine) || /^(#{1,4})\s+/.test(nextLine) || /^\s*(?:[-*]|\d+[.)])\s+/.test(nextLine)) break;
      paragraphLines.push(nextLine);
      index += 1;
    }
    blocks.push({ type: 'paragraph', segments: parseInlineMarkdown(paragraphLines.join('\n').trim()) });
  }

  return blocks.length > 0 ? blocks : [{ type: 'paragraph', segments: [{ type: 'text', text: '' }] }];
}

function parseInlineMarkdown(source: string): InlineSegment[] {
  const segments: InlineSegment[] = [];
  const pattern = /(\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\))/g;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(source))) {
    if (match.index > cursor) {
      segments.push({ type: 'text', text: source.slice(cursor, match.index) });
    }
    if (match[2]) {
      segments.push({ type: 'strong', text: match[2] });
    } else if (match[3]) {
      segments.push({ type: 'code', text: match[3] });
    } else if (match[4] && match[5]) {
      segments.push({ type: 'link', text: match[4], href: safeHref(match[5]) });
    }
    cursor = pattern.lastIndex;
  }

  if (cursor < source.length) {
    segments.push({ type: 'text', text: source.slice(cursor) });
  }

  return segments.length > 0 ? segments : [{ type: 'text', text: '' }];
}

function safeHref(href: string): string {
  const trimmed = href.trim();
  if (trimmed.startsWith('/')) return trimmed;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'mailto:' ? trimmed : '#';
  } catch {
    return '#';
  }
}

// Tool content collapse helpers

const TOOL_CONTENT_COLLAPSE_CHAR_LIMIT = 900;
const TOOL_CONTENT_COLLAPSE_LINE_LIMIT = 12;
const TOOL_CONTENT_PREVIEW_CHAR_LIMIT = 760;
const TOOL_CONTENT_PREVIEW_LINE_LIMIT = 11;

function isRenderableTimelineEvent(event: TimelineEvent): boolean {
  const content = event.content.trim();
  if (event.kind === 'tool') {
    return Boolean(content || event.tool?.command || event.tool?.filePath || event.tool?.name);
  }
  if (event.kind === 'error') return Boolean(content || event.title.trim());
  return Boolean(content);
}

function isExpandableToolContent(content: string): boolean {
  const normalized = content.replace(/\r\n/g, '\n');
  return normalized.length > TOOL_CONTENT_COLLAPSE_CHAR_LIMIT || normalized.split('\n').length > TOOL_CONTENT_COLLAPSE_LINE_LIMIT;
}

function toolContentBlockOverflowClass(content: string, expanded: boolean): string {
  if (isExpandableToolContent(content) && !expanded) return 'max-h-64 overflow-hidden';
  return 'max-h-none overflow-x-auto overflow-y-visible';
}

function toolContentBlockDisplayContent(content: string, expanded: boolean): string {
  if (!isExpandableToolContent(content) || expanded) return content;
  const normalized = content.replace(/\r\n/g, '\n');
  const linePreview = normalized.split('\n').slice(0, TOOL_CONTENT_PREVIEW_LINE_LIMIT).join('\n');
  const charPreview = linePreview.length > TOOL_CONTENT_PREVIEW_CHAR_LIMIT ? linePreview.slice(0, TOOL_CONTENT_PREVIEW_CHAR_LIMIT) : linePreview;
  return `${charPreview.trimEnd().replace(/\.*$/, '')}...`;
}

// Utilities

function groupFileHistoryEntries(entries: FileHistoryEntry[]): FileHistoryGroup[] {
  const dedupedByBackupIdentity = new Map<string, FileHistoryEntry>();
  for (const entry of entries) {
    const key = fileHistoryIdentityKey(entry);
    const existing = dedupedByBackupIdentity.get(key);
    if (!existing || isEarlierBackupRecord(entry, existing)) {
      dedupedByBackupIdentity.set(key, entry);
    }
  }

  const byPath = new Map<string, FileHistoryEntry[]>();
  for (const entry of dedupedByBackupIdentity.values()) {
    byPath.set(entry.filePath, [...(byPath.get(entry.filePath) ?? []), entry]);
  }

  return [...byPath.entries()]
    .map(([filePath, fileEntries]) => {
      const sortedEntries = fileEntries.slice().sort(compareFileHistoryEntriesForDisplay);
      return {
        filePath,
        latest: sortedEntries[0]!,
        entries: sortedEntries,
        storedBackups: sortedEntries.filter((entry) => entry.backupFileName !== null && entry.backupExists).length,
        missingBackups: sortedEntries.filter((entry) => entry.backupFileName !== null && !entry.backupExists).length,
        newFiles: sortedEntries.filter((entry) => entry.backupFileName === null).length,
      };
    })
    .sort((left, right) => compareFileHistoryEntriesForDisplay(left.latest, right.latest));
}

function fileHistoryIdentityKey(entry: FileHistoryEntry): string {
  return [entry.filePath, entry.backupFileName ?? 'new-file', entry.version].join('\0');
}

function isEarlierBackupRecord(candidate: FileHistoryEntry, existing: FileHistoryEntry): boolean {
  if (!candidate.backupTime) return false;
  if (!existing.backupTime) return true;
  return candidate.backupTime < existing.backupTime;
}

function compareFileHistoryEntriesForDisplay(left: FileHistoryEntry, right: FileHistoryEntry): number {
  if (left.version !== right.version) {
    return right.version - left.version;
  }

  const rightTime = parseTimestamp(right.backupTime);
  const leftTime = parseTimestamp(left.backupTime);
  if (rightTime !== leftTime) {
    return rightTime - leftTime;
  }

  return left.filePath.localeCompare(right.filePath);
}

function formatVersionCount(count: number): string {
  return count === 1 ? '1 version' : `${count} versions`;
}

function pathDisplayName(filePath: string): string {
  const parts = filePath.split('/');
  if (parts.length <= 2) return filePath;
  return '.../' + parts.slice(-2).join('/');
}

function formatSessionDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return iso;
  }
}

function formatEventTime(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return timestamp;
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatBackupTime(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return timestamp;
  return date.toLocaleString([], { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function parseTimestamp(value: string | null): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}
