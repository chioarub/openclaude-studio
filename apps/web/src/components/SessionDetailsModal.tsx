import { type KeyboardEvent as ReactKeyboardEvent, type ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react';
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
  ChevronRight,
  FileDiff,
  Folder,
  AlertTriangle,
  RefreshCw,
  PanelLeftClose,
  PanelLeftOpen,
} from 'lucide-react';

import type {
  ConversationTimelineEvent,
  Diagnostic,
  SessionChangeFileReview,
  SessionChangeReviewResponse,
  SessionDetailsResponse,
  SessionReplayResponse,
  SessionReplayStep,
} from '@openclaude-studio/shared';

import { ApiRequestError, type createApiClient } from '../api.js';
import { cn } from '../lib/cn.js';
import { CopyablePath } from './CopyablePath.js';
import { LoadingOverlay } from './LoadingState.js';

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
type ChangeFileTreeNode =
  | {
      type: 'directory';
      name: string;
      path: string;
      children: ChangeFileTreeNode[];
      fileCount: number;
      additions: number;
      deletions: number;
    }
  | {
      type: 'file';
      name: string;
      path: string;
      file: SessionChangeFileReview;
    };
type PartialSessionDetails = Partial<SessionDetailsResponse['session']> & {
  tokens?: Partial<SessionDetailsResponse['session']['tokens']>;
};
type TimelineTool = NonNullable<ConversationTimelineEvent['tool']>;
type SessionDetailsTab = 'conversation' | 'changes' | 'replay';
type SessionDetailsTabIds = Record<SessionDetailsTab, { panelId: string; tabId: string }>;
type PartialSessionChangeReview = Partial<SessionChangeReviewResponse> & {
  totals?: Partial<SessionChangeReviewResponse['totals']>;
};

const unsupportedChangeReviewMessage = 'Review Changes requires a newer local server. Update or restart the local OpenClaude Studio server to use this tab.';

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
  const [activeTab, setActiveTab] = useState<SessionDetailsTab>('conversation');
  const [changeReview, setChangeReview] = useState<SessionChangeReviewResponse | null>(null);
  const [changeReviewError, setChangeReviewError] = useState<string | null>(null);
  const [changeReviewLoading, setChangeReviewLoading] = useState(false);
  const [changeReviewReloadKey, setChangeReviewReloadKey] = useState(0);
  const [replay, setReplay] = useState<SessionReplayResponse | null | undefined>(undefined);
  const [replayError, setReplayError] = useState<string | null>(null);
  const [replayLoading, setReplayLoading] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [copied, setCopied] = useState(false);
  const mountedRef = useRef(true);
  const copyResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tabBaseId = useId();
  const tabIds = useMemo<SessionDetailsTabIds>(() => ({
    conversation: {
      tabId: `${tabBaseId}-conversation-tab`,
      panelId: `${tabBaseId}-conversation-panel`,
    },
    changes: {
      tabId: `${tabBaseId}-changes-tab`,
      panelId: `${tabBaseId}-changes-panel`,
    },
    replay: {
      tabId: `${tabBaseId}-replay-tab`,
      panelId: `${tabBaseId}-replay-panel`,
    },
  }), [tabBaseId]);

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
      setActiveTab('conversation');
      setChangeReview(null);
      setChangeReviewError(null);
      setChangeReviewLoading(false);
      setReplay(undefined);
      setReplayError(null);
      setReplayLoading(false);
      return () => {
        ignore = true;
      };
    }
    setDetails(null);
    setError(null);
    setActiveTab('conversation');
    setChangeReview(null);
    setChangeReviewError(null);
    setChangeReviewLoading(false);
    setChangeReviewReloadKey(0);
    setReplay(undefined);
    setReplayError(null);
    setReplayLoading(false);
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

  useEffect(() => {
    let ignore = false;
    if (!sessionId || !projectId || !isOpen || activeTab !== 'changes') {
      return () => {
        ignore = true;
      };
    }

    setChangeReviewLoading(true);
    setChangeReviewError(null);
    api
      .sessionChanges(projectId, sessionId)
      .then((data: SessionChangeReviewResponse) => {
        if (!ignore) setChangeReview(normalizeSessionChangeReviewResponse(data, sessionId));
      })
      .catch((err: unknown) => {
        if (!ignore) {
          if (err instanceof ApiRequestError && (err.status === 404 || err.status === 405)) {
            setChangeReview(unsupportedChangeReviewResponse(sessionId));
            setChangeReviewError(null);
            return;
          }
          setChangeReview(null);
          setChangeReviewError(err instanceof Error ? err.message : 'Unable to load session change review.');
        }
      })
      .finally(() => {
        if (!ignore) setChangeReviewLoading(false);
      });

    return () => {
      ignore = true;
    };
  }, [activeTab, sessionId, projectId, isOpen, api, changeReviewReloadKey]);

  useEffect(() => {
    let ignore = false;
    if (!sessionId || !projectId || !isOpen || activeTab !== 'replay') {
      return () => {
        ignore = true;
      };
    }
    if (replay !== undefined) {
      return () => {
        ignore = true;
      };
    }
    setReplayLoading(true);
    setReplayError(null);
    api
      .sessionReplay(projectId, sessionId)
      .then((data: SessionReplayResponse | null) => {
        if (!ignore) setReplay(normalizeReplayResponse(data));
      })
      .catch((err: unknown) => {
        if (!ignore) {
          setReplay(undefined);
          setReplayError(err instanceof Error ? err.message : 'Unable to load session replay.');
        }
      })
      .finally(() => {
        if (!ignore) setReplayLoading(false);
      });

    return () => {
      ignore = true;
    };
  }, [activeTab, sessionId, projectId, isOpen, api, replay]);

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
  const reviewTabFileCount = changeReview && !isUnsupportedChangeReview(changeReview)
    ? changeReview.totals.fileCount
    : session?.changedFiles.length ?? 0;
  const handleRetryChangeReview = () => {
    setChangeReview(null);
    setChangeReviewError(null);
    setChangeReviewReloadKey((value) => value + 1);
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Session Details"
      className="max-w-[min(96vw,1320px)] h-[90vh]"
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

          <SessionDetailsTabList
            activeTab={activeTab}
            onChange={setActiveTab}
            changedFileCount={reviewTabFileCount}
            tabIds={tabIds}
          />

          {/* Body: 8/4 grid */}
          <div
            id={tabIds.conversation.panelId}
            role="tabpanel"
            aria-labelledby={tabIds.conversation.tabId}
            tabIndex={0}
            hidden={activeTab !== 'conversation'}
            className={cn(
              'grid-cols-1 lg:grid-cols-12 gap-8 flex-1 min-h-0 overflow-hidden pt-8 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/15',
              activeTab === 'conversation' ? 'grid' : 'hidden',
            )}
          >
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
                      No task files are linked to this session.
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
                        No saved plan file is linked to this session.
                      </div>
                    )}
                  </div>
                </CollapsibleSection>
              </div>
            </div>
          </div>
          <div
            id={tabIds.changes.panelId}
            role="tabpanel"
            aria-labelledby={tabIds.changes.tabId}
            tabIndex={0}
            hidden={activeTab !== 'changes'}
            className={cn(
              'flex-1 min-h-0 overflow-hidden focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/15',
              activeTab === 'changes' ? 'flex' : 'hidden',
            )}
          >
            <SessionChangeReviewPanel
              review={changeReview}
              loading={changeReviewLoading}
              error={changeReviewError}
              onRetry={handleRetryChangeReview}
            />
          </div>
          <div
            id={tabIds.replay.panelId}
            role="tabpanel"
            aria-labelledby={tabIds.replay.tabId}
            tabIndex={0}
            hidden={activeTab !== 'replay'}
            className={cn(
              'flex-1 min-h-0 overflow-hidden focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/15',
              activeTab === 'replay' ? 'flex' : 'hidden',
            )}
          >
            <SessionReplayPanel
              replay={replay}
              loading={replayLoading}
              error={replayError}
            />
          </div>
        </div>
      ) : error ? (
        <div className="h-full min-h-64 flex flex-col items-center justify-center text-error gap-4 p-6">
          <p className="text-sm font-medium">{error}</p>
        </div>
      ) : (
        <div className="loading-boundary h-full min-h-64">
          <div aria-hidden="true" className="section-loading-placeholder modal-loading-placeholder" />
          <LoadingOverlay label="Loading session details" />
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

function unsupportedChangeReviewResponse(sessionId: string): SessionChangeReviewResponse {
  return {
    sessionId,
    files: [],
    totals: {
      fileCount: 0,
      additions: 0,
      deletions: 0,
      backupCount: 0,
      riskFlagCount: 0,
    },
    diagnostics: [
      {
        level: 'info',
        message: unsupportedChangeReviewMessage,
      },
    ],
  };
}

function isUnsupportedChangeReview(review: SessionChangeReviewResponse): boolean {
  return review.diagnostics.some((diagnostic) => diagnostic.message === unsupportedChangeReviewMessage);
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

function normalizeSessionChangeReviewResponse(data: SessionChangeReviewResponse, fallbackSessionId: string): SessionChangeReviewResponse {
  const review = data as PartialSessionChangeReview;
  const files = arrayOrEmpty<unknown>(review.files).map(normalizeChangeFileReview);
  const totals = (isRecord(review.totals) ? review.totals : {}) as Partial<SessionChangeReviewResponse['totals']>;
  return {
    sessionId: typeof review.sessionId === 'string' && review.sessionId ? review.sessionId : fallbackSessionId,
    files,
    totals: {
      fileCount: finiteNumberOrFallback(totals.fileCount, files.length),
      additions: finiteNumberOrFallback(totals.additions, sum(files, (file) => file.additions)),
      deletions: finiteNumberOrFallback(totals.deletions, sum(files, (file) => file.deletions)),
      backupCount: finiteNumberOrFallback(totals.backupCount, files.filter((file) => file.backupExists).length),
      riskFlagCount: finiteNumberOrFallback(totals.riskFlagCount, sum(files, (file) => file.riskFlags.length)),
    },
    diagnostics: arrayOrEmpty<unknown>(review.diagnostics).map(normalizeDiagnostic),
  };
}

function normalizeChangeFileReview(value: unknown, index: number): SessionChangeFileReview {
  const file = isRecord(value) ? value : {};
  const status = normalizeChangeStatus(file.status);
  return {
    id: typeof file.id === 'string' && file.id ? file.id : `change-${index}`,
    filePath: typeof file.filePath === 'string' && file.filePath ? file.filePath : 'unknown file',
    status,
    language: typeof file.language === 'string' ? file.language : null,
    backupFileName: typeof file.backupFileName === 'string' ? file.backupFileName : null,
    backupExists: Boolean(file.backupExists),
    backupVersion: finiteNumberOrNull(file.backupVersion),
    backupTime: typeof file.backupTime === 'string' ? file.backupTime : null,
    beforeTruncated: Boolean(file.beforeTruncated),
    afterTruncated: Boolean(file.afterTruncated),
    additions: finiteNumber(file.additions),
    deletions: finiteNumber(file.deletions),
    riskFlags: arrayOrEmpty<unknown>(file.riskFlags).map((flag) => {
      const item = isRecord(flag) ? flag : {};
      return {
        level: item.level === 'error' || item.level === 'warn' || item.level === 'info' ? item.level : 'info',
        label: typeof item.label === 'string' && item.label ? item.label : 'Review note',
        message: typeof item.message === 'string' ? item.message : '',
      };
    }),
    relatedEvents: arrayOrEmpty<unknown>(file.relatedEvents).map((event, eventIndex) => {
      const item = isRecord(event) ? event : {};
      return {
        id: typeof item.id === 'string' && item.id ? item.id : `event-${eventIndex}`,
        timestamp: validTimestampOrFallback(item.timestamp),
        title: typeof item.title === 'string' && item.title ? item.title : 'Tool event',
        toolName: typeof item.toolName === 'string' && item.toolName ? item.toolName : 'Tool',
        command: typeof item.command === 'string' ? item.command : null,
      };
    }),
    diff: normalizeChangeDiff(file.diff),
    diagnostics: arrayOrEmpty<unknown>(file.diagnostics).map(normalizeDiagnostic),
  };
}

function normalizeChangeStatus(value: unknown): SessionChangeFileReview['status'] {
  return value === 'modified' ||
    value === 'created' ||
    value === 'deleted' ||
    value === 'unchanged' ||
    value === 'missing-backup' ||
    value === 'missing-current' ||
    value === 'too-large' ||
    value === 'binary' ||
    value === 'unavailable'
    ? value
    : 'unavailable';
}

function normalizeChangeDiff(value: unknown): SessionChangeFileReview['diff'] {
  if (!isRecord(value)) {
    return null;
  }
  return {
    hunks: arrayOrEmpty<unknown>(value.hunks).map((hunk) => {
      const item = isRecord(hunk) ? hunk : {};
      return {
        oldStart: finiteNumber(item.oldStart),
        oldLines: finiteNumber(item.oldLines),
        newStart: finiteNumber(item.newStart),
        newLines: finiteNumber(item.newLines),
        lines: arrayOrEmpty<unknown>(item.lines).map((line) => {
          const diffLine = isRecord(line) ? line : {};
          const kind = diffLine.kind === 'add' || diffLine.kind === 'remove' || diffLine.kind === 'context'
            ? diffLine.kind
            : 'context';
          return {
            kind,
            oldLine: finiteNumberOrNull(diffLine.oldLine),
            newLine: finiteNumberOrNull(diffLine.newLine),
            text: typeof diffLine.text === 'string' ? diffLine.text : '',
          };
        }),
      };
    }),
  };
}

function normalizeDiagnostic(value: unknown): Diagnostic {
  const item = isRecord(value) ? value : {};
  const diagnostic: Diagnostic = {
    level: item.level === 'error' || item.level === 'warn' || item.level === 'info' ? item.level : 'info',
    message: typeof item.message === 'string' ? item.message : '',
  };
  if (typeof item.path === 'string') {
    diagnostic.path = item.path;
  }
  return diagnostic;
}

function arrayOrEmpty<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function finiteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function finiteNumberOrFallback(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function finiteNumberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function sum<T>(items: T[], selector: (item: T) => number): number {
  return items.reduce((total, item) => total + selector(item), 0);
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

function SessionDetailsTabList({
  activeTab,
  onChange,
  changedFileCount,
  tabIds,
}: {
  activeTab: SessionDetailsTab;
  onChange: (tab: SessionDetailsTab) => void;
  changedFileCount: number;
  tabIds: SessionDetailsTabIds;
}) {
  const tabs: Array<{ id: SessionDetailsTab; label: string; count?: number; icon: ReactNode }> = [
    { id: 'conversation', label: 'Conversation', icon: <MessageSquare className="h-3.5 w-3.5" /> },
    { id: 'changes', label: 'Review Changes', count: changedFileCount, icon: <FileDiff className="h-3.5 w-3.5" /> },
    { id: 'replay', label: 'Replay', icon: <History className="h-3.5 w-3.5" /> },
  ];
  const focusTab = (tabId: string) => {
    const focus = () => document.getElementById(tabId)?.focus();
    if (typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(focus);
    } else {
      window.setTimeout(focus, 0);
    }
  };
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    const lastIndex = tabs.length - 1;
    let nextIndex: number | null = null;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      nextIndex = index === lastIndex ? 0 : index + 1;
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      nextIndex = index === 0 ? lastIndex : index - 1;
    } else if (event.key === 'Home') {
      nextIndex = 0;
    } else if (event.key === 'End') {
      nextIndex = lastIndex;
    }
    if (nextIndex === null) {
      return;
    }
    event.preventDefault();
    const nextTab = tabs[nextIndex]!;
    onChange(nextTab.id);
    focusTab(tabIds[nextTab.id].tabId);
  };

  return (
    <div className="shrink-0 border-b border-hairline-soft pt-4">
      <div role="tablist" aria-label="Session details sections" className="flex flex-wrap gap-2">
        {tabs.map((tab, index) => {
          const selected = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              id={tabIds[tab.id].tabId}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={tabIds[tab.id].panelId}
              tabIndex={selected ? 0 : -1}
              className={cn(
                'inline-flex h-9 items-center gap-2 rounded-md border px-3 text-xs font-medium uppercase tracking-[0.12em] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/15',
                selected
                  ? 'border-primary/30 bg-primary/10 text-primary'
                  : 'border-hairline-soft bg-canvas text-muted hover:bg-surface-soft hover:text-ink',
              )}
              onClick={() => onChange(tab.id)}
              onKeyDown={(event) => handleKeyDown(event, index)}
            >
              {tab.icon}
              {tab.label}
              {tab.count !== undefined && (
                <span className="rounded bg-surface-soft px-1.5 py-0.5 font-mono text-[11px] text-muted">
                  {tab.count}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function SessionChangeReviewPanel({
  review,
  loading,
  error,
  onRetry,
}: {
  review: SessionChangeReviewResponse | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  const [selectedFileId, setSelectedFileId] = useState<string | null>(null);
  const files = useMemo(
    () => (review?.files ?? []).slice().sort(compareChangeFilesForDisplay),
    [review],
  );

  useEffect(() => {
    if (!review) {
      setSelectedFileId(null);
      return;
    }
    setSelectedFileId((current) => (current && files.some((file) => file.id === current) ? current : files[0]?.id ?? null));
  }, [files, review]);

  if (loading && !review) {
    return (
      <div className="loading-boundary flex-1 min-h-0">
        <div aria-hidden="true" className="section-loading-placeholder modal-loading-placeholder" />
        <LoadingOverlay label="Loading change review" />
      </div>
    );
  }

  if (error && !review) {
    return (
      <div className="flex flex-1 min-h-0 items-center justify-center pt-8">
        <div className="max-w-md rounded-lg border border-error/20 bg-error/[0.04] p-5 text-sm text-error">
          <div className="mb-3 flex items-center gap-2 font-medium">
            <AlertTriangle className="h-4 w-4" />
            Unable to load change review
          </div>
          <p>{error}</p>
          <Button variant="secondary" className="mt-4 h-9 px-3 text-xs" onClick={onRetry}>
            <RefreshCw className="mr-2 h-3.5 w-3.5" />
            Retry
          </Button>
        </div>
      </div>
    );
  }

  if (!review) {
    return null;
  }

  if (isUnsupportedChangeReview(review)) {
    return (
      <div aria-busy={loading} className="loading-boundary flex flex-1 min-h-0 items-center justify-center pt-8">
        <div className="max-w-lg rounded-lg border border-primary/15 bg-primary/[0.04] p-5 text-sm text-ink">
          <div className="mb-3 flex items-center gap-2 font-medium">
            <AlertTriangle className="h-4 w-4 text-primary" />
            Review Changes requires a newer local server
          </div>
          <p className="leading-6 text-muted">{unsupportedChangeReviewMessage}</p>
          <Button variant="secondary" className="mt-4 h-9 px-3 text-xs" onClick={onRetry}>
            <RefreshCw className="mr-2 h-3.5 w-3.5" />
            Retry
          </Button>
        </div>
        {loading ? <LoadingOverlay label="Loading change review" /> : null}
      </div>
    );
  }

  const diffableFiles = files.filter(hasReviewableDiff);
  const unavailableFiles = files.filter((file) => !hasReviewableDiff(file));
  const handleSelectFile = (file: SessionChangeFileReview) => {
    setSelectedFileId(file.id);
    document.getElementById(changeFileDomId(file))?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  };

  return (
    <div aria-busy={loading} className="loading-boundary flex flex-1 min-h-0 flex-col gap-4 pt-6 pr-2">
      <ChangeReviewSummaryBar
        review={review}
        diffableCount={diffableFiles.length}
        unavailableCount={unavailableFiles.length}
      />

      <DiagnosticsList diagnostics={review.diagnostics} />

      {files.length === 0 ? (
        <div className="rounded-lg border border-dashed border-hairline-soft bg-surface-soft/30 px-4 py-10 text-center text-sm text-muted">
          No reviewable file changes were derived from this session.
        </div>
      ) : (
        <ChangeReviewWorkspace
          files={files}
          selectedFileId={selectedFileId}
          onSelectFile={handleSelectFile}
        />
      )}
      {loading ? <LoadingOverlay label="Loading change review" /> : null}
    </div>
  );
}

function ChangeReviewSummaryBar({
  review,
  diffableCount,
  unavailableCount,
}: {
  review: SessionChangeReviewResponse;
  diffableCount: number;
  unavailableCount: number;
}) {
  return (
    <div className="rounded-lg border border-hairline-soft bg-canvas px-4 py-3">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-medium text-ink">
            <FileDiff className="h-4 w-4 text-primary" />
            <span>Session review</span>
          </div>
          <div className="mt-1 flex items-center gap-2 text-xs text-muted">
            <span>{diffableCount} {pluralize(diffableCount, 'file')} with diffs</span>
            <UnavailableChangeInfo count={unavailableCount} />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-x-5 gap-y-2 sm:flex sm:flex-wrap sm:justify-end">
          <ReviewMetric label="Files" value={`${review.totals.fileCount} changed ${pluralize(review.totals.fileCount, 'file')}`} />
          <ReviewMetric label="Additions" value={`+${review.totals.additions}`} tone="success" />
          <ReviewMetric label="Deletions" value={`-${review.totals.deletions}`} tone="error" />
          <ReviewMetric
            label="Risk Flags"
            value={`${review.totals.riskFlagCount} risk ${pluralize(review.totals.riskFlagCount, 'flag')}`}
            tone={review.totals.riskFlagCount > 0 ? 'warning' : 'neutral'}
          />
        </div>
      </div>
    </div>
  );
}

function ChangeReviewWorkspace({
  files,
  selectedFileId,
  onSelectFile,
}: {
  files: SessionChangeFileReview[];
  selectedFileId: string | null;
  onSelectFile: (file: SessionChangeFileReview) => void;
}) {
  const fileTreeId = useId();
  const [isFileTreeVisible, setIsFileTreeVisible] = useState(true);
  const toggleLabel = isFileTreeVisible ? 'Hide file tree' : 'Show file tree';

  return (
    <div
      className={cn(
        'grid min-h-0 flex-1 overflow-hidden gap-4',
        isFileTreeVisible ? 'lg:grid-cols-[18rem_minmax(0,1fr)] xl:grid-cols-[19.5rem_minmax(0,1fr)]' : 'grid-cols-1',
      )}
    >
      {isFileTreeVisible && (
        <ChangeFileNavigation
          id={fileTreeId}
          files={files}
          selectedFileId={selectedFileId}
          onSelectFile={onSelectFile}
        />
      )}

      <section
        aria-label="File diffs"
        className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-hairline-soft bg-canvas"
      >
        <div className="flex flex-col gap-2 border-b border-hairline-soft bg-surface-soft/35 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-sm font-medium text-ink">Diffs</div>
          <Button
            type="button"
            variant="secondary"
            className="h-7 w-fit px-2.5 text-xs"
            aria-expanded={isFileTreeVisible}
            aria-controls={isFileTreeVisible ? fileTreeId : undefined}
            title={toggleLabel}
            onClick={() => setIsFileTreeVisible((visible) => !visible)}
          >
            {isFileTreeVisible ? <PanelLeftClose className="mr-1.5 h-3.5 w-3.5" /> : <PanelLeftOpen className="mr-1.5 h-3.5 w-3.5" />}
            {toggleLabel}
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-3 pb-8 custom-scrollbar">
          <div className="space-y-3">
            {files.map((file) => (
              <ChangeFileCard key={file.id} file={file} selected={file.id === selectedFileId} />
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}

function ChangeFileNavigation({
  id,
  files,
  selectedFileId,
  onSelectFile,
}: {
  id: string;
  files: SessionChangeFileReview[];
  selectedFileId: string | null;
  onSelectFile: (file: SessionChangeFileReview) => void;
}) {
  const tree = useMemo(() => buildChangeFileTree(files), [files]);
  const [collapsedPaths, setCollapsedPaths] = useState<Set<string>>(() => new Set());
  const toggleDirectory = (path: string) => {
    setCollapsedPaths((current) => {
      const next = new Set(current);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  return (
    <nav id={id} aria-label="Changed files" className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-hairline-soft bg-canvas">
      <div className="flex flex-col gap-1 border-b border-hairline-soft bg-surface-soft/40 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <h3 className="text-sm font-medium text-ink">Changed files</h3>
        <div className="font-mono text-xs text-muted">
          <span className="text-success">+{sumChangeLines(files, 'additions')}</span>
          <span className="mx-2 text-muted-soft">/</span>
          <span className="text-error">-{sumChangeLines(files, 'deletions')}</span>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto py-2 pb-8 custom-scrollbar">
        {tree.map((node) => (
          <ChangeFileTreeItem
            key={node.path}
            node={node}
            level={0}
            collapsedPaths={collapsedPaths}
            selectedFileId={selectedFileId}
            onToggleDirectory={toggleDirectory}
            onSelectFile={onSelectFile}
          />
        ))}
      </div>
    </nav>
  );
}

function ChangeFileTreeItem({
  node,
  level,
  collapsedPaths,
  selectedFileId,
  onToggleDirectory,
  onSelectFile,
}: {
  node: ChangeFileTreeNode;
  level: number;
  collapsedPaths: Set<string>;
  selectedFileId: string | null;
  onToggleDirectory: (path: string) => void;
  onSelectFile: (file: SessionChangeFileReview) => void;
}) {
  if (node.type === 'directory') {
    const collapsed = collapsedPaths.has(node.path);
    return (
      <div>
        <button
          type="button"
          aria-expanded={!collapsed}
          aria-label={`${node.path || node.name} folder`}
          onClick={() => onToggleDirectory(node.path)}
          className="flex w-full min-w-0 items-center gap-1.5 px-2.5 py-1.5 text-left font-mono text-[11px] text-muted-soft transition-colors hover:bg-surface-soft/45 focus:outline-none focus-visible:bg-surface-soft focus-visible:ring-2 focus-visible:ring-primary/15"
          style={{ paddingLeft: `${10 + level * 14}px` }}
        >
          {collapsed ? <ChevronRight className="h-3 w-3 shrink-0" /> : <ChevronDown className="h-3 w-3 shrink-0" />}
          <Folder className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate" title={node.path || node.name}>{node.name}</span>
          <span className="shrink-0 text-[10px] text-muted-soft">{node.fileCount}</span>
        </button>
        {!collapsed && (
          <div>
            {node.children.map((child) => (
              <ChangeFileTreeItem
                key={child.path}
                node={child}
                level={level + 1}
                collapsedPaths={collapsedPaths}
                selectedFileId={selectedFileId}
                onToggleDirectory={onToggleDirectory}
                onSelectFile={onSelectFile}
              />
            ))}
          </div>
        )}
      </div>
    );
  }

  const file = node.file;
  return (
    <button
      type="button"
      aria-label={file.filePath}
      aria-current={file.id === selectedFileId ? 'true' : undefined}
      onClick={() => onSelectFile(file)}
      className={cn(
        'flex w-full min-w-0 items-center gap-2 px-2.5 py-1.5 text-left transition-colors focus:outline-none focus-visible:bg-surface-soft focus-visible:ring-2 focus-visible:ring-primary/15',
        file.id === selectedFileId ? 'bg-primary/[0.07]' : 'hover:bg-surface-soft/45',
      )}
      style={{ paddingLeft: `${24 + level * 14}px` }}
    >
      <ChangeStatusDot status={file.status} />
      <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink" title={file.filePath}>{node.name}</span>
      <ChangeTreeLineStats file={file} />
    </button>
  );
}

function UnavailableChangeInfo({ count }: { count: number }) {
  if (count === 0) {
    return null;
  }

  const label = `${count} ${pluralize(count, 'file')} cannot be diffed`;
  const description = [
    label,
    'Studio found these file changes in the session transcript, but it does not have safe before/after text for them.',
    'Common causes: current file removed, missing file-history backup, oversized content, or non-text content.',
  ].join(' ');

  return (
    <span
      aria-label={label}
      title={description}
      className="inline-flex w-fit items-center gap-1 rounded border border-warning/25 bg-warning/[0.08] px-1.5 py-0.5 text-warning"
    >
      <AlertTriangle className="h-3.5 w-3.5" />
      <span>{count} unavailable</span>
    </span>
  );
}

function ReviewMetric({ label, value, tone = 'neutral' }: { label: string; value: string; tone?: 'neutral' | 'success' | 'error' | 'warning' }) {
  const toneClass = {
    neutral: 'text-ink',
    success: 'text-success',
    error: 'text-error',
    warning: 'text-warning',
  }[tone];

  return (
    <div className="min-w-[5.5rem]">
      <div className="mb-1 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-soft">{label}</div>
      <div className={cn('truncate font-mono text-[13px] font-medium', toneClass)}>{value}</div>
    </div>
  );
}

function ChangeFileCard({ file, selected = false }: { file: SessionChangeFileReview; selected?: boolean }) {
  const diffText = changeFileUnifiedDiffText(file);
  const hasDiff = Boolean(diffText);

  return (
    <article
      id={changeFileDomId(file)}
      aria-label={hasDiff ? `Diff for ${file.filePath}` : `Change details for ${file.filePath}`}
      className={cn(
        'scroll-mt-3 overflow-hidden rounded-md border bg-canvas',
        selected ? 'border-primary/35 shadow-sm shadow-primary/10' : 'border-hairline-soft',
      )}
    >
      <header className="border-b border-hairline-soft bg-surface-soft/35 px-3 py-2.5">
        <div className="flex min-w-0 flex-col gap-2 lg:flex-row lg:items-start lg:justify-between">
          <div className="flex min-w-0 flex-1 items-start gap-2">
            <FileDiff className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-soft" />
            <CopyablePath
              value={file.filePath}
              copyLabel={`Copy path for ${file.filePath}`}
              truncate
              className="min-w-0 flex-1 font-mono text-[13px] text-ink"
              textClassName="truncate font-medium"
              buttonClassName="h-6 w-6"
            />
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2 lg:justify-end">
            <ChangeLineStats file={file} />
            {hasDiff && (
              <Button
                variant="secondary"
                className="h-7 px-2.5 text-xs"
                aria-label={`Copy diff for ${file.filePath}`}
                onClick={() => {
                  if (navigator.clipboard) {
                    void navigator.clipboard.writeText(diffText);
                  }
                }}
              >
                <Copy className="mr-1.5 h-3.5 w-3.5" />
                Copy Diff
              </Button>
            )}
          </div>
        </div>
        <ChangeFileMetadata file={file} />
      </header>

      {hasDiff ? <DiffPanel file={file} /> : <UnavailableDiffPanel file={file} />}

      <FileDiagnostics file={file} />
    </article>
  );
}

function ChangeFileMetadata({ file }: { file: SessionChangeFileReview }) {
  const currentState = currentContentStateLabel(file);

  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-muted">
      <StatusBadge status={file.status} />
      {file.language && (
        <span className="rounded bg-canvas px-2 py-0.5 font-mono text-[11px] uppercase tracking-[0.12em] text-muted-soft">
          {file.language}
        </span>
      )}
      <span>{backupContentStateLabel(file)}</span>
      {currentState && <span>{currentState}</span>}
      {file.backupVersion !== null && <span className="font-mono">v{file.backupVersion}</span>}
      {file.backupTime && <span>{formatBackupTime(file.backupTime)}</span>}
      <FileActivitySummary events={file.relatedEvents} />
      <InlineRiskFlags flags={file.riskFlags} />
      {(file.beforeTruncated || file.afterTruncated) && <span>Content truncated</span>}
    </div>
  );
}

function ChangeLineStats({ file }: { file: SessionChangeFileReview }) {
  if (!hasReviewableDiff(file)) {
    return <span className="whitespace-nowrap rounded bg-surface-soft px-2 py-0.5 font-mono text-xs text-muted">No diff</span>;
  }

  return (
    <span className="inline-flex items-center gap-2 whitespace-nowrap rounded bg-canvas px-2 py-0.5 font-mono text-xs">
      <span className="text-success">+{file.additions}</span>
      <span className="text-error">-{file.deletions}</span>
    </span>
  );
}

function ChangeTreeLineStats({ file }: { file: SessionChangeFileReview }) {
  if (!hasReviewableDiff(file)) {
    return <span className="shrink-0 font-mono text-[11px] text-muted-soft">No diff</span>;
  }

  return (
    <span className="shrink-0 whitespace-nowrap font-mono text-[11px]">
      <span className="text-success">+{file.additions}</span>
      <span className="mx-1 text-muted-soft">/</span>
      <span className="text-error">-{file.deletions}</span>
    </span>
  );
}

function ChangeStatusDot({ status }: { status: SessionChangeFileReview['status'] }) {
  const meta = changeStatusMeta(status);
  return (
    <span
      className={cn(
        'h-2 w-2 shrink-0 rounded-full border',
        status === 'modified' || status === 'created'
          ? 'border-success/60 bg-success'
          : status === 'deleted' || status === 'unavailable'
            ? 'border-error/60 bg-error'
            : status === 'unchanged'
              ? 'border-hairline-soft bg-muted-soft'
              : 'border-warning/70 bg-warning',
      )}
      title={`${meta.label}: ${meta.description}`}
    />
  );
}

function InlineRiskFlags({ flags }: { flags: SessionChangeFileReview['riskFlags'] }) {
  if (flags.length === 0) {
    return null;
  }

  return (
    <>
      {flags.map((flag) => (
        <span
          key={`${flag.level}-${flag.label}-${flag.message}`}
          title={flag.message}
          className={cn(
            'inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] font-medium',
            flag.level === 'error'
              ? 'border-error/20 bg-error/[0.06] text-error'
              : flag.level === 'warn'
                ? 'border-warning/25 bg-warning/[0.08] text-ink'
                : 'border-primary/15 bg-primary/[0.06] text-primary',
          )}
        >
          <AlertTriangle className="h-3 w-3" />
          {flag.label}
        </span>
      ))}
    </>
  );
}

function FileActivitySummary({ events }: { events: SessionChangeFileReview['relatedEvents'] }) {
  const event = events.at(-1);
  if (!event) {
    return null;
  }

  const extraCount = events.length - 1;
  return (
    <span title={event.command ?? event.title}>
      {event.title} {formatEventTime(event.timestamp)}
      {extraCount > 0 ? ` +${extraCount}` : ''}
    </span>
  );
}

function DiffPanel({ file }: { file: SessionChangeFileReview }) {
  return (
    <div className="bg-code-panel">
      <DiffHunks file={file} />
    </div>
  );
}

function UnavailableDiffPanel({ file }: { file: SessionChangeFileReview }) {
  const reason = diffUnavailableReason(file);

  return (
    <div className="px-4 py-4">
      <div className="rounded-md border border-hairline-soft bg-surface-soft/35 px-4 py-4">
        <div className="flex gap-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
          <div className="min-w-0">
            <div className="text-sm font-medium text-ink">Cannot show diff</div>
            <div className="mt-1 text-sm font-medium text-muted">{reason.title}</div>
            <p className="mt-1 text-sm leading-6 text-muted">{reason.description}</p>
          </div>
        </div>
      </div>
    </div>
  );
}

function FileDiagnostics({ file }: { file: SessionChangeFileReview }) {
  if (file.diagnostics.length === 0) {
    return null;
  }

  return (
    <div className="border-t border-hairline-soft bg-surface-soft/20 px-3 py-2.5">
      <DiagnosticsList diagnostics={file.diagnostics} currentPath={file.filePath} />
    </div>
  );
}

function DiffHunks({ file }: { file: SessionChangeFileReview }) {
  const hunks = file.diff?.hunks ?? [];
  const { hasOldLineNumbers, hasNewLineNumbers, gridColumnsClass } = useMemo(() => {
    const hasOldLines = hunks.some((hunk) => hunk.lines.some((line) => line.oldLine !== null));
    const hasNewLines = hunks.some((hunk) => hunk.lines.some((line) => line.newLine !== null));
    return {
      hasOldLineNumbers: hasOldLines,
      hasNewLineNumbers: hasNewLines,
      gridColumnsClass: diffLineGridColumnsClass(hasOldLines, hasNewLines),
    };
  }, [hunks]);

  return (
    <div className="overflow-x-auto custom-scrollbar">
      <div className="w-max min-w-full font-mono text-[12px] leading-[1.55] text-code-panel-text">
        {hunks.map((hunk, hunkIndex) => (
          <div key={`${file.id}-hunk-${hunkIndex}`}>
            <div className={cn('grid gap-1 border-b border-code-panel-border/70 bg-code-panel-elevated px-2 py-1 text-code-panel-muted', gridColumnsClass)}>
              {hasOldLineNumbers && <span />}
              {hasNewLineNumbers && <span />}
              <span />
              <span>{`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`}</span>
            </div>
            {hunk.lines.map((line, lineIndex) => (
              <div
                key={`${file.id}-${hunkIndex}-${lineIndex}`}
                className={cn(
                  'grid gap-1 border-l-2 px-2 py-0.5',
                  gridColumnsClass,
                  line.kind === 'add'
                    ? 'border-success/70 bg-success/[0.10]'
                    : line.kind === 'remove'
                      ? 'border-error/70 bg-error/[0.08]'
                      : 'border-transparent text-code-panel-muted',
                  )}
                >
                {hasOldLineNumbers && <span className="select-none text-right text-code-panel-muted">{line.oldLine ?? ''}</span>}
                {hasNewLineNumbers && <span className="select-none text-right text-code-panel-muted">{line.newLine ?? ''}</span>}
                <span
                  className={cn(
                    'select-none font-semibold',
                    line.kind === 'add' ? 'text-success' : line.kind === 'remove' ? 'text-error' : 'text-code-panel-muted',
                  )}
                >
                  {line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' '}
                </span>
                <span className="whitespace-pre pr-4 text-code-panel-text">{line.text || ' '}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function diffLineGridColumnsClass(hasOldLineNumbers: boolean, hasNewLineNumbers: boolean): string {
  if (hasOldLineNumbers && hasNewLineNumbers) {
    return 'grid-cols-[3.25rem_3.25rem_1.5rem_minmax(0,1fr)]';
  }

  if (hasOldLineNumbers || hasNewLineNumbers) {
    return 'grid-cols-[3.25rem_1.5rem_minmax(0,1fr)]';
  }

  return 'grid-cols-[1.5rem_minmax(0,1fr)]';
}

function StatusBadge({ status, compact = false }: { status: SessionChangeFileReview['status']; compact?: boolean }) {
  const meta = changeStatusMeta(status);
  return (
    <span
      className={cn(
        'inline-flex w-fit items-center whitespace-nowrap rounded-md border px-2 py-0.5 text-[11px] font-medium uppercase tracking-[0.12em]',
        compact && 'min-w-[7.5rem] justify-center',
        meta.className,
      )}
      title={meta.description}
    >
      {meta.label}
    </span>
  );
}

function DiagnosticsList({ diagnostics, currentPath }: { diagnostics: Diagnostic[]; currentPath?: string }) {
  if (diagnostics.length === 0) {
    return null;
  }

  return (
    <div className="space-y-2">
      {diagnostics.map((diagnostic, index) => (
        <div
          key={`${diagnostic.level}-${diagnostic.message}-${index}`}
          className={cn(
            'rounded-lg border px-3 py-2 text-xs',
            diagnostic.level === 'error'
              ? 'border-error/20 bg-error/[0.05] text-error'
              : diagnostic.level === 'warn'
                ? 'border-warning/25 bg-warning/[0.08] text-ink'
                : 'border-primary/15 bg-primary/[0.05] text-primary',
          )}
        >
          <div className="font-medium">{diagnostic.message || 'Diagnostic recorded.'}</div>
          {diagnostic.path && diagnostic.path !== currentPath && <div className="mt-1 font-mono text-muted-soft">{diagnostic.path}</div>}
        </div>
      ))}
    </div>
  );
}

function compareChangeFilesForDisplay(left: SessionChangeFileReview, right: SessionChangeFileReview): number {
  const reviewable = Number(hasReviewableDiff(right)) - Number(hasReviewableDiff(left));
  if (reviewable !== 0) return reviewable;
  const risk = highestRiskRank(right.riskFlags) - highestRiskRank(left.riskFlags);
  if (risk !== 0) return risk;
  const changedLines = right.additions + right.deletions - (left.additions + left.deletions);
  if (changedLines !== 0) return changedLines;
  return left.filePath.localeCompare(right.filePath);
}

function buildChangeFileTree(files: SessionChangeFileReview[]): ChangeFileTreeNode[] {
  type MutableDirectory = Extract<ChangeFileTreeNode, { type: 'directory' }> & {
    directories: Map<string, MutableDirectory>;
  };
  const root: MutableDirectory = {
    type: 'directory',
    name: '',
    path: '',
    children: [],
    directories: new Map(),
    fileCount: 0,
    additions: 0,
    deletions: 0,
  };

  for (const file of files) {
    const parts = splitFilePathParts(file.filePath);
    const fileName = parts.at(-1) ?? file.filePath;
    const directories = parts.slice(0, -1);
    const lineage = [root];
    let parent = root;

    for (const name of directories) {
      const path = parent.path ? `${parent.path}/${name}` : name;
      let directory = parent.directories.get(name);
      if (!directory) {
        directory = {
          type: 'directory',
          name,
          path,
          children: [],
          directories: new Map(),
          fileCount: 0,
          additions: 0,
          deletions: 0,
        };
        parent.directories.set(name, directory);
        parent.children.push(directory);
      }
      parent = directory;
      lineage.push(parent);
    }

    for (const directory of lineage) {
      directory.fileCount += 1;
      directory.additions += file.additions;
      directory.deletions += file.deletions;
    }

    parent.children.push({
      type: 'file',
      name: fileName,
      path: file.filePath,
      file,
    });
  }

  return root.children.map(finalizeChangeFileTreeNode);
}

function finalizeChangeFileTreeNode(node: ChangeFileTreeNode): ChangeFileTreeNode {
  if (node.type === 'file') {
    return node;
  }

  const { type, name, path, children, fileCount, additions, deletions } = node;
  return {
    type,
    name,
    path,
    children: children.map(finalizeChangeFileTreeNode),
    fileCount,
    additions,
    deletions,
  };
}

function hasReviewableDiff(file: SessionChangeFileReview): boolean {
  return Boolean(file.diff?.hunks.length);
}

function isTemporaryWorktreePath(filePath: string): boolean {
  return filePath.split('/').includes('worktrees') && filePath.includes('.claude/');
}

function sumChangeLines(files: SessionChangeFileReview[], field: 'additions' | 'deletions'): number {
  return files.reduce((total, file) => total + file[field], 0);
}

function splitFilePath(filePath: string): { directory: string; fileName: string } {
  const normalized = filePath.replace(/\\/g, '/');
  const lastSeparatorIndex = normalized.lastIndexOf('/');
  if (lastSeparatorIndex === -1) {
    return { directory: '', fileName: normalized || 'file' };
  }
  return {
    directory: normalized.slice(0, lastSeparatorIndex),
    fileName: normalized.slice(lastSeparatorIndex + 1) || 'file',
  };
}

function splitFilePathParts(filePath: string): string[] {
  const normalized = filePath.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  return parts.length > 0 ? parts : ['file'];
}

function changeFileDomId(file: SessionChangeFileReview): string {
  return `session-change-${file.id.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
}

function backupContentStateLabel(file: SessionChangeFileReview): string {
  if (file.status === 'created') return 'New file baseline';
  if (file.backupExists) return 'Backup available';
  return 'No readable backup';
}

function currentContentStateLabel(file: SessionChangeFileReview): string | null {
  if (file.status === 'deleted') return 'Current file removed';
  if (file.status === 'missing-current' || file.status === 'unavailable') return 'Current file unavailable';
  if (file.afterTruncated) return 'Current file truncated';
  return null;
}

function diffUnavailableReason(file: SessionChangeFileReview): { title: string; description: string } {
  if (file.status === 'unavailable' && isTemporaryWorktreePath(file.filePath)) {
    return {
      title: 'Temporary worktree unavailable',
      description:
        'The transcript records a file edit inside a temporary OpenClaude worktree, but Studio cannot safely read a current file or a file-history backup. The worktree was likely removed after the session.',
    };
  }

  if (file.status === 'missing-backup') {
    return {
      title: 'No readable backup',
      description:
        'Studio found the changed path and current file, but no safe file-history backup was available for the before side of the diff.',
    };
  }

  if (file.status === 'missing-current') {
    return {
      title: 'Current file unavailable',
      description:
        'Studio found a backup, but the current file could not be read safely. This can happen when the file was removed, moved, or blocked by path safety checks.',
    };
  }

  if (file.status === 'too-large') {
    return {
      title: 'Content too large',
      description:
        'One side of the change exceeded Studio\'s bounded read or diff limits, so the diff was skipped to keep local data handling predictable.',
    };
  }

  if (file.status === 'binary') {
    return {
      title: 'Binary or unsupported content',
      description:
        'The before or after content does not look like plain text, so Studio did not render line-based diff rows.',
    };
  }

  if (file.status === 'unchanged') {
    return {
      title: 'No textual changes',
      description:
        'After redaction and normalization, Studio did not find visible line changes for this file.',
    };
  }

  return {
    title: 'No safe before/after text',
    description:
      'Studio identified this file from the session transcript, but it does not have enough safe source data to render a reviewable diff.',
  };
}

function changeStatusMeta(status: SessionChangeFileReview['status']): {
  label: string;
  description: string;
  className: string;
} {
  switch (status) {
    case 'modified':
      return {
        label: 'Modified',
        description: 'Current content differs from the selected backup.',
        className: 'border-primary/20 bg-primary/10 text-primary',
      };
    case 'created':
      return {
        label: 'Added',
        description: 'The session appears to have created this file.',
        className: 'border-success/25 bg-success/10 text-success',
      };
    case 'deleted':
      return {
        label: 'Deleted',
        description: 'A backup exists and the current file is gone.',
        className: 'border-error/25 bg-error/10 text-error',
      };
    case 'unchanged':
      return {
        label: 'Unchanged',
        description: 'No visible text changes after redaction.',
        className: 'border-hairline-soft bg-surface-soft text-muted',
      };
    case 'missing-backup':
      return {
        label: 'No backup',
        description: 'The before side of the diff is unavailable.',
        className: 'border-warning/25 bg-warning/10 text-warning',
      };
    case 'missing-current':
      return {
        label: 'Missing current',
        description: 'The after side of the diff is unavailable.',
        className: 'border-warning/25 bg-warning/10 text-warning',
      };
    case 'too-large':
      return {
        label: 'Too large',
        description: 'Diff rendering was skipped because the content exceeded bounded read or diff limits.',
        className: 'border-warning/25 bg-warning/10 text-warning',
      };
    case 'binary':
      return {
        label: 'Binary',
        description: 'Line-based diff rendering is not available for this content.',
        className: 'border-warning/25 bg-warning/10 text-warning',
      };
    case 'unavailable':
      return {
        label: 'Unavailable',
        description: 'Studio only has transcript evidence for this change.',
        className: 'border-error/20 bg-error/[0.06] text-error',
      };
  }
}

function highestRiskRank(flags: SessionChangeFileReview['riskFlags']): number {
  return flags.reduce((rank, flag) => Math.max(rank, flag.level === 'error' ? 3 : flag.level === 'warn' ? 2 : 1), 0);
}

function changeFileUnifiedDiffText(file: SessionChangeFileReview): string {
  if (!file.diff || file.diff.hunks.length === 0) {
    return '';
  }

  const lines = [`--- ${file.filePath}`, `+++ ${file.filePath}`];
  for (const hunk of file.diff.hunks) {
    lines.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
    for (const line of hunk.lines) {
      const prefix = line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' ';
      lines.push(`${prefix}${line.text}`);
    }
  }
  return lines.join('\n');
}

function pluralize(count: number, singular: string): string {
  return count === 1 ? singular : `${singular}s`;
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

type ReplayStepFilter = 'all' | 'tool' | 'user' | 'retry' | 'error';

function SessionReplayPanel({
  replay,
  loading,
  error,
}: {
  replay: SessionReplayResponse | null | undefined;
  loading: boolean;
  error: string | null;
}) {
  const [stepFilter, setStepFilter] = useState<ReplayStepFilter>('all');
  const [toolFilter, setToolFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [copiedStep, setCopiedStep] = useState<number | null>(null);
  const copiedStepResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (copiedStepResetTimerRef.current) {
        clearTimeout(copiedStepResetTimerRef.current);
      }
    };
  }, []);

  if (loading) {
    return (
      <div className="loading-boundary h-full min-h-64 w-full">
        <div aria-hidden="true" className="section-loading-placeholder modal-loading-placeholder" />
        <LoadingOverlay label="Loading session replay" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="h-full min-h-64 flex flex-col items-center justify-center text-error gap-4 p-6">
        <p className="text-sm font-medium">{error}</p>
      </div>
    );
  }

  if (replay === undefined) {
    return null;
  }

  if (replay === null) {
    return (
      <div className="h-full min-h-64 flex flex-col items-center justify-center text-muted gap-4 p-6">
        <History className="w-8 h-8 opacity-40" />
        <p className="text-sm">Replay is not available on this local server version.</p>
      </div>
    );
  }

  const diagnosticNote = replay.diagnostics?.[0]?.message;

  if (replay.status === 'unavailable') {
    return (
      <div className="h-full min-h-64 flex flex-col items-center justify-center text-muted gap-4 p-6">
        <History className="w-8 h-8 opacity-40" />
        <p className="text-sm">No replay data available for this session.</p>
        <p className="text-xs text-muted-soft">
          Replay sidecars are produced by newer OpenClaude versions.
        </p>
      </div>
    );
  }

  if (replay.status === 'unsupported_version') {
    return (
      <div className="h-full min-h-64 flex flex-col items-center justify-center text-muted gap-4 p-6">
        <History className="w-8 h-8 opacity-40" />
        <p className="text-sm">
          Replay schema version {replay.version ?? 'unknown'} is not supported by this server.
        </p>
        <p className="text-xs text-muted-soft">Update the local server to read this replay format.</p>
      </div>
    );
  }

  if (replay.status === 'malformed') {
    return (
      <div className="h-full min-h-64 flex flex-col items-center justify-center text-warning gap-4 p-6">
        <AlertTriangle className="w-8 h-8 opacity-40" />
        <p className="text-sm">Replay data is malformed and cannot be displayed.</p>
        {diagnosticNote && <p className="text-xs text-muted-soft">{diagnosticNote}</p>}
      </div>
    );
  }

  if (replay.status === 'conflict') {
    return (
      <div className="h-full min-h-64 flex flex-col items-center justify-center text-warning gap-4 p-6">
        <AlertTriangle className="w-8 h-8 opacity-40" />
        <p className="text-sm">Multiple conflicting replay files were found.</p>
        {diagnosticNote && <p className="text-xs text-muted-soft">{diagnosticNote}</p>}
      </div>
    );
  }

  const { summary, steps } = replay;

  const availableTools = [...new Set(
    steps
      .filter((s): s is Extract<SessionReplayStep, { type: 'tool' }> => s.type === 'tool')
      .map((s) => s.toolName),
  )].sort();

  const filteredSteps = steps.filter((step) => {
    if (stepFilter !== 'all' && step.type !== stepFilter) return false;
    if (toolFilter !== 'all' && (step.type !== 'tool' || step.toolName !== toolFilter)) return false;
    if (statusFilter !== 'all' && (step.type !== 'tool' || step.resultStatus !== statusFilter)) return false;
    return true;
  });

  const handleCopyStep = async (step: SessionReplayStep) => {
    const text = formatStepSummary(step);
    try {
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(text);
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
      }
      if (copiedStepResetTimerRef.current) {
        clearTimeout(copiedStepResetTimerRef.current);
      }
      setCopiedStep(step.stepNumber);
      copiedStepResetTimerRef.current = setTimeout(() => {
        setCopiedStep(null);
        copiedStepResetTimerRef.current = null;
      }, 2000);
    } catch {
      // Clipboard not available
    }
  };

  return (
    <div className="flex flex-col gap-4 w-full overflow-y-auto p-1">
      <div className="flex items-center justify-between shrink-0">
        <h3 className="text-xs font-medium tracking-[0.15em] text-muted-soft uppercase flex items-center gap-2">
          <History className="w-4 h-4" /> Replay Timeline
        </h3>
        <span className="text-[11px] text-muted-soft">
          Replay is a redacted execution summary.
        </span>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 shrink-0">
        <ReplayMetric label="Steps" value={String(summary.totalSteps)} />
        <ReplayMetric label="Duration" value={formatDuration(summary.durationMs)} />
        <ReplayMetric
          label="User Requests"
          value={String(summary.userRequests)}
        />
        <ReplayMetric
          label="Retries"
          value={summary.retryAttempts !== null ? String(summary.retryAttempts) : '—'}
        />
        <ReplayMetric
          label="Repeated"
          value={summary.repeatedAttempts !== null ? String(summary.repeatedAttempts) : '—'}
        />
        <ReplayMetric
          label="Files Modified"
          value={String(summary.filesModified.length)}
        />
      </div>

      {summary.toolBreakdown.length > 0 && (
        <div className="flex flex-wrap gap-2 shrink-0">
          {summary.toolBreakdown.map((entry) => (
            <span
              key={entry.tool}
              className="text-xs px-2 py-1 rounded-full bg-surface-soft border border-hairline-soft text-muted"
            >
              {entry.tool}: {entry.count}
            </span>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3 shrink-0 border-b border-hairline-soft pb-3">
        <select
          className="text-xs bg-surface-soft border border-hairline-soft rounded-md px-2 py-1 text-foreground"
          value={stepFilter}
          onChange={(e) => setStepFilter(e.target.value as ReplayStepFilter)}
          aria-label="Filter by step type"
        >
          <option value="all">All types</option>
          <option value="tool">Tool</option>
          <option value="user">User</option>
          <option value="retry">Retry</option>
          <option value="error">Error</option>
        </select>
        {availableTools.length > 0 && (
          <select
            className="text-xs bg-surface-soft border border-hairline-soft rounded-md px-2 py-1 text-foreground"
            value={toolFilter}
            onChange={(e) => setToolFilter(e.target.value)}
            aria-label="Filter by tool name"
          >
            <option value="all">All tools</option>
            {availableTools.map((tool) => (
              <option key={tool} value={tool}>{tool}</option>
            ))}
          </select>
        )}
        <select
          className="text-xs bg-surface-soft border border-hairline-soft rounded-md px-2 py-1 text-foreground"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          aria-label="Filter by result status"
        >
          <option value="all">All statuses</option>
          <option value="success">Success</option>
          <option value="error">Error</option>
          <option value="cancelled">Cancelled</option>
          <option value="permission_denied">Permission denied</option>
        </select>
      </div>

      {replay.stepsTruncated && (
        <p className="text-xs text-warning shrink-0">
          Timeline truncated — showing the first {steps.length} steps.
        </p>
      )}

      {filteredSteps.length === 0 ? (
        <div className="flex items-center justify-center text-muted text-sm py-8">
          No steps match the current filters.
        </div>
      ) : (
        <ol className="flex flex-col gap-2">
          {filteredSteps.map((step) => (
            <li key={`${step.type}-${step.stepNumber}`}>
              <ReplayStepCard
                step={step}
                copied={copiedStep === step.stepNumber}
                onCopy={() => handleCopyStep(step)}
              />
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function ReplayMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1 p-3 rounded-lg border border-hairline-soft bg-surface-soft">
      <span className="text-[10px] uppercase tracking-wider text-muted-soft">{label}</span>
      <span className="text-sm font-medium text-foreground">{value}</span>
    </div>
  );
}

function ReplayStepCard({
  step,
  copied,
  onCopy,
}: {
  step: SessionReplayStep;
  copied: boolean;
  onCopy: () => void;
}) {
  const timestampMs = step.timestamp ? Date.parse(step.timestamp) : Number.NaN;
  const timestamp = Number.isNaN(timestampMs) ? null : new Date(timestampMs);

  return (
    <div className="flex flex-col gap-2 p-3 rounded-lg border border-hairline-soft bg-surface">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-mono text-muted">#{step.stepNumber}</span>
          <StepTypeBadge type={step.type} />
          {step.type === 'tool' && (
            <>
              <span className="text-xs font-medium text-foreground">{step.toolName}</span>
              <ResultStatusBadge status={step.resultStatus} />
              {step.isRepeatedAttempt && (
                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-warning/10 text-warning border border-warning/20">
                  Repeat #{step.repeatedAttemptNumber ?? '?'}
                </span>
              )}
            </>
          )}
          {step.type === 'retry' && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-warning/10 text-warning border border-warning/20">
              {step.retryType}
              {step.attempt !== null && step.maxRetries !== null
                ? ` ${step.attempt}/${step.maxRetries}`
                : step.attempt !== null
                  ? ` ${step.attempt}`
                  : ''}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {timestamp && (
            <span className="text-[11px] text-muted-soft">
              {timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
            </span>
          )}
          {step.type === 'tool' && step.durationMs > 0 && (
            <span className="text-[11px] text-muted-soft">{formatDuration(step.durationMs)}</span>
          )}
          <button
            type="button"
            onClick={onCopy}
            className="text-muted hover:text-foreground transition-colors p-1"
            aria-label="Copy step summary"
            title={copied ? 'Copied' : 'Copy step summary'}
          >
            {copied ? <Check className="w-3.5 h-3.5 text-success" /> : <Copy className="w-3.5 h-3.5" />}
          </button>
        </div>
      </div>
      <StepContent step={step} />
    </div>
  );
}

function StepTypeBadge({ type }: { type: SessionReplayStep['type'] }) {
  const config: Record<SessionReplayStep['type'], { label: string; className: string }> = {
    tool: { label: 'Tool', className: 'bg-primary/10 text-primary border-primary/20' },
    user: { label: 'User', className: 'bg-info/10 text-info border-info/20' },
    retry: { label: 'Retry', className: 'bg-warning/10 text-warning border-warning/20' },
    error: { label: 'Error', className: 'bg-error/10 text-error border-error/20' },
  };
  const entry = config[type];
  const label = entry?.label ?? type;
  const className = entry?.className ?? 'bg-muted/10 text-muted border-muted/20';
  return (
    <span className={cn('text-[10px] px-1.5 py-0.5 rounded-full border font-medium', className)}>
      {label}
    </span>
  );
}

function ResultStatusBadge({ status }: { status: string }) {
  const config: Record<string, string> = {
    success: 'bg-success/10 text-success border-success/20',
    error: 'bg-error/10 text-error border-error/20',
    cancelled: 'bg-muted/10 text-muted border-muted/20',
    permission_denied: 'bg-warning/10 text-warning border-warning/20',
    unknown: 'bg-muted/10 text-muted border-muted/20',
  };
  const className = config[status] ?? config.unknown;
  return (
    <span className={cn('text-[10px] px-1.5 py-0.5 rounded-full border', className)}>
      {status.replace('_', ' ')}
    </span>
  );
}

function StepContent({ step }: { step: SessionReplayStep }) {
  if (step.type === 'tool') {
    return (
      <div className="flex flex-col gap-1.5 text-xs">
        {step.inputSummary && (
          <p className="text-foreground">
            {step.inputSummary}
            {step.inputSummaryTruncated && <span className="text-muted-soft"> (truncated)</span>}
          </p>
        )}
        {step.resultPreview && (
          <p className="text-muted-soft font-mono text-[11px] bg-code-panel text-code-panel-text px-2 py-1 rounded border border-code-panel-border">
            {step.resultPreview}
            {step.resultPreviewTruncated && <span className="opacity-60"> (truncated)</span>}
          </p>
        )}
        {step.filesModified.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {step.filesModified.map((file, index) => (
              <span
                key={`${file}-${index}`}
                className="text-[10px] px-1.5 py-0.5 rounded bg-surface-soft border border-hairline-soft text-muted font-mono"
              >
                {file}
              </span>
            ))}
            {step.filesModifiedTruncated && (
              <span className="text-[10px] text-muted-soft">(more)</span>
            )}
          </div>
        )}
      </div>
    );
  }
  if (step.type === 'user') {
    return (
      <p className="text-xs text-foreground">
        {step.content}
        {step.contentTruncated && <span className="text-muted-soft"> (truncated)</span>}
      </p>
    );
  }
  if (step.type === 'retry') {
    return (
      <div className="flex flex-col gap-1.5 text-xs">
        <p className="text-foreground">
          {step.reason}
          {step.reasonTruncated && <span className="text-muted-soft"> (truncated)</span>}
        </p>
        {step.retryDelayMs !== null && (
          <p className="text-muted-soft">Delay: {formatDuration(step.retryDelayMs)}</p>
        )}
        {step.commands.length > 0 && (
          <div className="flex flex-col gap-1">
            {step.commands.map((cmd, index) => (
              <span
                key={`${cmd}-${index}`}
                className="font-mono text-[11px] bg-code-panel text-code-panel-text px-2 py-1 rounded border border-code-panel-border"
              >
                {cmd}
              </span>
            ))}
            {step.commandsTruncated && (
              <span className="text-[10px] text-muted-soft">(more commands)</span>
            )}
          </div>
        )}
      </div>
    );
  }
  // error
  return (
    <p className="text-xs text-error">
      {step.error}
      {step.errorTruncated && <span className="text-muted-soft"> (truncated)</span>}
    </p>
  );
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

function normalizeReplayResponse(data: unknown): SessionReplayResponse | null {
  if (data === null) return null;
  if (!isRecord(data)) {
    return malformedReplayResponse('unknown', 'Replay response is not an object.');
  }
  if (
    data.status !== 'available' &&
    data.status !== 'unavailable' &&
    data.status !== 'unsupported_version' &&
    data.status !== 'malformed' &&
    data.status !== 'conflict'
  ) {
    return malformedReplayResponse(replaySessionId(data), 'Replay response status is not recognized.');
  }
  if (data.status !== 'available') return data as SessionReplayResponse;
  const availableReplay = data as Partial<Extract<SessionReplayResponse, { status: 'available' }>>;
  if (typeof availableReplay.version !== 'number') {
    return malformedReplayResponse(replaySessionId(data), 'Replay version is missing from the server response.');
  }
  const summary = availableReplay.summary ?? undefined;
  if (!summary) {
    return malformedReplayResponse(
      replaySessionId(data),
      'Replay summary is missing from the server response.',
      typeof availableReplay.version === 'number' ? availableReplay.version : null,
    );
  }
  return {
    status: 'available',
    supported: true,
    available: true,
    sessionId: replaySessionId(data),
    version: availableReplay.version,
    createdAt: typeof availableReplay.createdAt === 'string' ? availableReplay.createdAt : null,
    summary: {
      totalSteps: typeof summary.totalSteps === 'number' ? summary.totalSteps : 0,
      toolBreakdown: Array.isArray(summary.toolBreakdown)
        ? summary.toolBreakdown.filter(
            (e): e is { tool: string; count: number } =>
              e != null && typeof e.tool === 'string' && typeof e.count === 'number',
          )
        : [],
      filesModified: Array.isArray(summary.filesModified)
        ? summary.filesModified.filter((file): file is string => typeof file === 'string')
        : [],
      filesModifiedTruncated: summary.filesModifiedTruncated ?? false,
      durationMs: typeof summary.durationMs === 'number' ? summary.durationMs : 0,
      startTimestamp: summary.startTimestamp ?? null,
      endTimestamp: summary.endTimestamp ?? null,
      userRequests: typeof summary.userRequests === 'number' ? summary.userRequests : 0,
      retryAttempts: summary.retryAttempts ?? null,
      repeatedAttempts: summary.repeatedAttempts ?? null,
    },
    steps: Array.isArray(data.steps)
      ? data.steps
          .map(normalizeReplayStep)
          .filter((step): step is SessionReplayStep => step !== null)
      : [],
    stepsTruncated: availableReplay.stepsTruncated === true,
    diagnostics: Array.isArray(availableReplay.diagnostics) ? availableReplay.diagnostics : [],
  };
}

function replaySessionId(data: Record<string, unknown>): string {
  return typeof data.sessionId === 'string' ? data.sessionId : 'unknown';
}

function malformedReplayResponse(
  sessionId: string,
  message: string,
  version: number | null = null,
): SessionReplayResponse {
  return {
    status: 'malformed',
    supported: true,
    available: true,
    sessionId,
    version,
    diagnostics: [{ level: 'warn', message }],
  };
}

type ReplayToolStep = Extract<SessionReplayStep, { type: 'tool' }>;
type ReplayRetryStep = Extract<SessionReplayStep, { type: 'retry' }>;

const REPLAY_RESULT_STATUSES = new Set<ReplayToolStep['resultStatus']>([
  'success',
  'error',
  'cancelled',
  'permission_denied',
  'unknown',
]);

const REPLAY_RETRY_TYPES = new Set<ReplayRetryStep['retryType']>([
  'api',
  'permission',
  'unknown',
]);

function normalizeReplayStep(value: unknown): SessionReplayStep | null {
  if (!isRecord(value)) return null;
  const stepNumber = finiteNumberOrNull(value.stepNumber);
  if (stepNumber === null) return null;
  const timestamp = typeof value.timestamp === 'string' ? value.timestamp : null;

  if (value.type === 'tool') {
    const toolName = typeof value.toolName === 'string' && value.toolName.trim()
      ? value.toolName
      : null;
    if (!toolName) return null;
    return {
      type: 'tool',
      stepNumber,
      toolName,
      toolUseId: typeof value.toolUseId === 'string' ? value.toolUseId : null,
      inputSummary: typeof value.inputSummary === 'string' ? value.inputSummary : '',
      inputSummaryTruncated: value.inputSummaryTruncated === true,
      resultStatus: normalizeReplayResultStatus(value.resultStatus),
      resultPreview: typeof value.resultPreview === 'string' ? value.resultPreview : null,
      resultPreviewTruncated: value.resultPreviewTruncated === true,
      durationMs: Math.max(0, finiteNumber(value.durationMs)),
      timestamp,
      filesModified: stringArray(value.filesModified),
      filesModifiedTruncated: value.filesModifiedTruncated === true,
      repeatedAttemptNumber: finiteNumberOrNull(value.repeatedAttemptNumber),
      isRepeatedAttempt: value.isRepeatedAttempt === true,
    };
  }

  if (value.type === 'user') {
    if (typeof value.content !== 'string') return null;
    return {
      type: 'user',
      stepNumber,
      content: value.content,
      contentTruncated: value.contentTruncated === true,
      timestamp,
    };
  }

  if (value.type === 'retry') {
    return {
      type: 'retry',
      stepNumber,
      retryType: normalizeReplayRetryType(value.retryType),
      attempt: finiteNumberOrNull(value.attempt),
      maxRetries: finiteNumberOrNull(value.maxRetries),
      retryDelayMs: finiteNumberOrNull(value.retryDelayMs),
      reason: typeof value.reason === 'string' ? value.reason : '',
      reasonTruncated: value.reasonTruncated === true,
      commands: stringArray(value.commands),
      commandsTruncated: value.commandsTruncated === true,
      timestamp,
    };
  }

  if (value.type === 'error') {
    return {
      type: 'error',
      stepNumber,
      error: typeof value.error === 'string' ? value.error : '',
      errorTruncated: value.errorTruncated === true,
      timestamp,
    };
  }

  return null;
}

function normalizeReplayResultStatus(value: unknown): ReplayToolStep['resultStatus'] {
  return typeof value === 'string' && REPLAY_RESULT_STATUSES.has(value as ReplayToolStep['resultStatus'])
    ? value as ReplayToolStep['resultStatus']
    : 'unknown';
}

function normalizeReplayRetryType(value: unknown): ReplayRetryStep['retryType'] {
  return typeof value === 'string' && REPLAY_RETRY_TYPES.has(value as ReplayRetryStep['retryType'])
    ? value as ReplayRetryStep['retryType']
    : 'unknown';
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function formatStepSummary(step: SessionReplayStep): string {
  const parts: string[] = [`[${step.type}] step #${step.stepNumber}`];
  if (step.type === 'tool') {
    parts.push(`tool: ${step.toolName}`);
    if (step.inputSummary) parts.push(`input: ${step.inputSummary}`);
    parts.push(`result: ${step.resultStatus}`);
    if (step.resultPreview) parts.push(`preview: ${step.resultPreview}`);
    if (step.durationMs > 0) parts.push(`duration: ${formatDuration(step.durationMs)}`);
  } else if (step.type === 'user') {
    parts.push(`content: ${step.content}`);
  } else if (step.type === 'retry') {
    parts.push(`type: ${step.retryType}`);
    parts.push(`reason: ${step.reason}`);
    if (step.retryDelayMs !== null) parts.push(`delay: ${formatDuration(step.retryDelayMs)}`);
  } else if (step.type === 'error') {
    parts.push(`error: ${step.error}`);
  }
  if (step.timestamp) parts.push(`at: ${step.timestamp}`);
  return parts.join('\n');
}
