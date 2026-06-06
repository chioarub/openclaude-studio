import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import type {
  ArtifactSessionSummary,
  Diagnostic,
  PlanDetailsResponse,
  PlanSummary,
  TaskDetailsResponse,
  TaskSummary,
} from '@openclaude-studio/shared';
import {
  AlertTriangle,
  Check,
  CircleDot,
  ClipboardList,
  FileText,
  ListChecks,
  MessageSquareText,
  RefreshCcw,
} from 'lucide-react';

import type { ApiClient } from '../api.js';
import { cn } from '../lib/cn.js';
import { LoadingOverlay } from './LoadingState.js';

type Tab = 'plans' | 'tasks';
type OpenSessionHandler = ((sessionId: string) => void) | undefined;

type PlansTasksPageProps = {
  api: ApiClient;
  onDiagnosticsChange?: (diagnostics: Diagnostic[]) => void;
  onOpenSession?: (sessionId: string) => void;
  projectId: string;
};

const statusGroupOrder: Array<{ key: string; label: string }> = [
  { key: 'in_progress', label: 'Active' },
  { key: 'pending', label: 'Pending' },
  { key: 'todo', label: 'Todo' },
  { key: 'blocked', label: 'Blocked' },
  { key: 'completed', label: 'Completed' },
];

const statusBadgeStyles: Record<string, string> = {
  in_progress: 'border-primary/25 bg-primary/10 text-primary',
  pending: 'border-hairline-soft bg-surface-soft/80 text-muted',
  todo: 'border-hairline-soft bg-surface-soft/80 text-muted',
  blocked: 'border-warning/35 bg-warning/10 text-warning',
  completed: 'border-success/30 bg-success/10 text-success',
};

export function PlansTasksPage({ api, onDiagnosticsChange, onOpenSession, projectId }: PlansTasksPageProps) {
  const [tab, setTab] = useState<Tab>('plans');
  const [plans, setPlans] = useState<PlanSummary[]>([]);
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [diagnostics, setDiagnostics] = useState<Diagnostic[]>([]);
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [planDetail, setPlanDetail] = useState<PlanDetailsResponse | null>(null);
  const [taskDetail, setTaskDetail] = useState<TaskDetailsResponse | null>(null);
  const [planDetailError, setPlanDetailError] = useState<string | null>(null);
  const [taskDetailError, setTaskDetailError] = useState<string | null>(null);
  const [listVersion, setListVersion] = useState(0);
  const [loading, setLoading] = useState(true);
  const [planDetailLoading, setPlanDetailLoading] = useState(false);
  const [taskDetailLoading, setTaskDetailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listRequestIdRef = useRef(0);
  const planDetailRequestIdRef = useRef(0);
  const taskDetailRequestIdRef = useRef(0);

  const updateDiagnostics = useCallback((nextDiagnostics: Diagnostic[]) => {
    const next = dedupeDiagnostics(nextDiagnostics);
    setDiagnostics(next);
    onDiagnosticsChange?.(next);
  }, [onDiagnosticsChange]);

  const fetchLists = useCallback(async () => {
    const requestId = ++listRequestIdRef.current;
    setLoading(true);
    setError(null);

    try {
      const [plansRes, tasksRes] = await Promise.all([api.plans(projectId), api.tasks(projectId)]);
      if (requestId !== listRequestIdRef.current) return;

      const plansPayload: Record<string, unknown> = isRecord(plansRes) ? plansRes : {};
      const tasksPayload: Record<string, unknown> = isRecord(tasksRes) ? tasksRes : {};
      const nextPlans = normalizePlanSummaries(plansPayload.plans);
      const nextTasks = normalizeTaskSummaries(tasksPayload.tasks);
      setPlans(nextPlans);
      setTasks(nextTasks);
      updateDiagnostics([
        ...normalizeDiagnostics(plansPayload.diagnostics),
        ...normalizeDiagnostics(tasksPayload.diagnostics),
      ]);
      setSelectedPlanId((current) => resolveSelection(nextPlans, current));
      setSelectedTaskId((current) => resolveSelection(nextTasks, current));
      setListVersion((version) => version + 1);
    } catch (caught) {
      if (requestId !== listRequestIdRef.current) return;
      updateDiagnostics([]);
      setError(caught instanceof Error ? caught.message : 'Failed to load plans and tasks.');
    } finally {
      if (requestId === listRequestIdRef.current) setLoading(false);
    }
  }, [api, projectId, updateDiagnostics]);

  useEffect(() => {
    setSelectedPlanId(null);
    setSelectedTaskId(null);
    setPlanDetail(null);
    setTaskDetail(null);
    setPlanDetailError(null);
    setTaskDetailError(null);
    updateDiagnostics([]);
    void fetchLists();
  }, [fetchLists, updateDiagnostics]);

  useEffect(() => {
    const requestId = ++planDetailRequestIdRef.current;
    if (!selectedPlanId) {
      setPlanDetail(null);
      setPlanDetailError(null);
      setPlanDetailLoading(false);
      return;
    }

    setPlanDetailLoading(true);
    setPlanDetailError(null);
    api.planDetails(projectId, selectedPlanId)
      .then((response) => {
        if (requestId === planDetailRequestIdRef.current) setPlanDetail(normalizePlanDetailsResponse(response));
      })
      .catch((caught) => {
        if (requestId === planDetailRequestIdRef.current) {
          setPlanDetail(null);
          setPlanDetailError(errorMessage(caught, 'Unable to load plan details.'));
        }
      })
      .finally(() => {
        if (requestId === planDetailRequestIdRef.current) setPlanDetailLoading(false);
      });
  }, [api, listVersion, projectId, selectedPlanId]);

  useEffect(() => {
    const requestId = ++taskDetailRequestIdRef.current;
    if (!selectedTaskId) {
      setTaskDetail(null);
      setTaskDetailError(null);
      setTaskDetailLoading(false);
      return;
    }

    const selectedTask = tasks.find((task) => task.id === selectedTaskId);
    if (!selectedTask) {
      setTaskDetail(null);
      setTaskDetailError(null);
      setTaskDetailLoading(false);
      return;
    }

    setTaskDetailLoading(true);
    setTaskDetailError(null);
    api.taskDetails(projectId, selectedTask.sessionId, selectedTask.taskId)
      .then((response) => {
        if (requestId === taskDetailRequestIdRef.current) setTaskDetail(normalizeTaskDetailsResponse(response));
      })
      .catch((caught) => {
        if (requestId === taskDetailRequestIdRef.current) {
          setTaskDetail(null);
          setTaskDetailError(errorMessage(caught, 'Unable to load task details.'));
        }
      })
      .finally(() => {
        if (requestId === taskDetailRequestIdRef.current) setTaskDetailLoading(false);
      });
  }, [api, listVersion, projectId, selectedTaskId, tasks]);

  const tasksByStatus = useMemo(() => {
    const groups = new Map<string, TaskSummary[]>();
    for (const task of tasks) {
      const status = taskStatusKey(task.status);
      const list = groups.get(status) ?? [];
      list.push(task);
      groups.set(status, list);
    }
    return groups;
  }, [tasks]);

  const summary = useMemo(() => {
    const activeTasks = tasks.filter((task) => taskStatusKey(task.status) === 'in_progress').length;
    const blockedTasks = tasks.filter((task) => taskStatusKey(task.status) === 'blocked').length;
    const planFiles = plans.filter((plan) => plan.exists).length;
    const pendingPlanItems = plans.reduce((total, plan) => total + plan.checklist.pending, 0);
    return { activeTasks, blockedTasks, pendingPlanItems, planFiles };
  }, [plans, tasks]);

  const hasListData = plans.length > 0 || tasks.length > 0;
  const listLoadingLabel = hasListData ? 'Refreshing plans and tasks' : 'Loading plans and tasks';
  const header = (
    <header className="page-header">
      <div className="page-header-title">
        <div className="icon-frame">
          <ClipboardList className="h-6 w-6" aria-hidden="true" />
        </div>
        <div className="min-w-0">
          <h1 className="font-display text-[34px] leading-none text-ink md:text-[40px]">Plans &amp; Tasks</h1>
          <div className="mt-2 flex min-w-0 items-center gap-2">
            <span className="status-dot" />
            <span className="truncate text-xs font-medium uppercase leading-none tracking-widest text-muted-soft">
              {formatNumber(plans.length)} plans / {formatNumber(tasks.length)} tasks
            </span>
          </div>
        </div>
      </div>
      <div className="page-header-aside">
        <button
          aria-label="Refresh plans and tasks"
          className="inline-flex items-center gap-2 rounded-md border border-hairline-soft bg-canvas px-3 py-2 text-xs font-semibold uppercase tracking-[0.12em] text-muted transition-colors hover:bg-surface-soft hover:text-ink disabled:pointer-events-none disabled:opacity-60"
          disabled={loading}
          onClick={fetchLists}
          type="button"
        >
          <RefreshCcw className="h-3.5 w-3.5" aria-hidden="true" />
          Refresh
        </button>
      </div>
    </header>
  );

  if (loading && !hasListData) {
    return (
      <div className="space-y-5">
        {header}
        <section aria-busy={true} className="panel loading-boundary plans-tasks-initial-loading">
          <div aria-hidden="true" className="section-loading-placeholder plans-tasks-initial-placeholder" />
          <LoadingOverlay label={listLoadingLabel} />
        </section>
      </div>
    );
  }

  if (error && !hasListData) {
    return (
      <div className="rounded-md border border-error/30 bg-error/5 px-4 py-3 text-error">
        <p className="font-medium">Failed to load plans and tasks</p>
        <p className="mt-1 text-sm text-error">{error}</p>
        <button
          className="mt-3 rounded-md border border-error/25 px-2.5 py-1.5 text-xs font-semibold text-error transition-colors hover:bg-error/10"
          onClick={fetchLists}
          type="button"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div aria-busy={loading} className="space-y-5">
      {header}

      <div className="plans-tasks-content loading-boundary">
        <div className="grid gap-3 md:grid-cols-4">
          <ControlStat label="Active Tasks" value={summary.activeTasks} />
          <ControlStat label="Blocked" value={summary.blockedTasks} tone={summary.blockedTasks > 0 ? 'warning' : 'default'} />
          <ControlStat label="Plan Files" value={summary.planFiles} />
          <ControlStat label="Open Checklist" value={summary.pendingPlanItems} />
        </div>

        <DiagnosticsStrip diagnostics={diagnostics} />

        <div className="flex gap-1 rounded-md border border-hairline-soft bg-surface-soft/50 p-1" role="tablist" aria-label="Plans and tasks">
          <TabButton
            active={tab === 'plans'}
            controls="plans-tasks-plans-panel"
            count={plans.length}
            id="plans-tasks-plans-tab"
            onClick={() => setTab('plans')}
          >
            <FileText className="h-3.5 w-3.5" aria-hidden="true" />
            Plans
          </TabButton>
          <TabButton
            active={tab === 'tasks'}
            controls="plans-tasks-tasks-panel"
            count={tasks.length}
            id="plans-tasks-tasks-tab"
            onClick={() => setTab('tasks')}
          >
            <ListChecks className="h-3.5 w-3.5" aria-hidden="true" />
            Tasks
          </TabButton>
        </div>

        {tab === 'plans' ? (
          <div className="min-h-0" id="plans-tasks-plans-panel" role="tabpanel" aria-labelledby="plans-tasks-plans-tab">
            <PlansView
              detailLoading={planDetailLoading}
              onOpenSession={onOpenSession}
              onSelectPlan={setSelectedPlanId}
              planDetailError={planDetailError}
              planDetail={planDetail}
              plans={plans}
              selectedPlanId={selectedPlanId}
            />
          </div>
        ) : (
          <div className="min-h-0" id="plans-tasks-tasks-panel" role="tabpanel" aria-labelledby="plans-tasks-tasks-tab">
            <TasksView
              detailLoading={taskDetailLoading}
              onOpenSession={onOpenSession}
              onSelectTask={setSelectedTaskId}
              selectedTaskId={selectedTaskId}
              taskDetailError={taskDetailError}
              taskDetail={taskDetail}
              tasks={tasks}
              tasksByStatus={tasksByStatus}
            />
          </div>
        )}

        {loading ? <LoadingOverlay label={listLoadingLabel} /> : null}
      </div>
    </div>
  );
}

function ControlStat({
  label,
  tone = 'default',
  value,
}: {
  label: string;
  tone?: 'default' | 'warning';
  value: number;
}) {
  return (
    <div className={cn('quick-stat', tone === 'warning' && 'quick-stat-warning')}>
      <span>{label}</span>
      <strong>{formatNumber(value)}</strong>
    </div>
  );
}

function DiagnosticsStrip({ diagnostics }: { diagnostics: Diagnostic[] }) {
  if (diagnostics.length === 0) return null;

  return (
    <div className="rounded-md border border-warning/25 bg-warning/10 px-4 py-3">
      <div className="flex items-center gap-2 text-sm font-semibold text-warning">
        <AlertTriangle className="h-4 w-4" aria-hidden="true" />
        {diagnostics.length} diagnostic{diagnostics.length === 1 ? '' : 's'} while reading plans and tasks
      </div>
      <div className="custom-scrollbar mt-2 max-h-44 space-y-1 overflow-y-auto pr-1">
        {diagnostics.map((diagnostic, index) => (
          <p className="text-xs text-body" key={`${diagnostic.level}-${diagnostic.message}-${index}`}>
            <span className="font-semibold uppercase text-muted-soft">{diagnostic.level}</span>
            {' '}
            {diagnostic.message}
            {diagnostic.path ? (
              <span className="ml-2 font-mono text-muted-soft">{diagnostic.path}</span>
            ) : null}
          </p>
        ))}
      </div>
    </div>
  );
}

function TabButton({
  active,
  children,
  controls,
  count,
  id,
  onClick,
}: {
  active: boolean;
  children: ReactNode;
  controls: string;
  count: number;
  id: string;
  onClick: () => void;
}) {
  return (
    <button
      aria-controls={controls}
      aria-selected={active}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition-colors',
        active ? 'bg-canvas text-ink shadow-sm' : 'text-muted hover:text-ink',
      )}
      id={id}
      onClick={onClick}
      role="tab"
      type="button"
    >
      {children}
      <span className={cn('ml-0.5 rounded-full px-1.5 py-0.5 text-[10px]', active ? 'bg-primary/10 text-primary' : 'bg-canvas text-muted')}>
        {formatNumber(count)}
      </span>
    </button>
  );
}

function PlansView({
  detailLoading,
  onOpenSession,
  onSelectPlan,
  planDetailError,
  planDetail,
  plans,
  selectedPlanId,
}: {
  detailLoading: boolean;
  onOpenSession: OpenSessionHandler;
  onSelectPlan: (id: string) => void;
  planDetailError: string | null;
  planDetail: PlanDetailsResponse | null;
  plans: PlanSummary[];
  selectedPlanId: string | null;
}) {
  if (plans.length === 0) {
    return <EmptyPanel label="No saved plan files are linked to this project yet." />;
  }

  return (
    <div className="plans-tasks-workspace">
      <div className="plans-tasks-pane plans-tasks-list custom-scrollbar overflow-y-auto rounded-md border border-hairline-soft/70 bg-canvas">
        <div className="sticky top-0 z-10 grid grid-cols-[minmax(0,1fr)_92px] border-b border-hairline-soft bg-surface-soft/95 px-3 py-2 text-[11px] font-bold uppercase tracking-[0.12em] text-muted-soft backdrop-blur">
          <span>Plan</span>
          <span className="text-right">Updated</span>
        </div>
        {plans.map((plan) => {
          const linkedSessions = planSessions(plan);
          const primarySession = linkedSessions[0];
          return (
            <button
              className={cn(
                'w-full border-b border-hairline-soft/35 px-3 py-3 text-left transition-colors last:border-b-0',
                plan.id === selectedPlanId ? 'border-l-2 border-l-primary bg-primary/5' : 'hover:bg-surface-soft/60',
              )}
              key={plan.id}
              onClick={() => onSelectPlan(plan.id)}
              type="button"
            >
              <div className="flex min-w-0 items-start justify-between gap-2">
                <span className={cn('min-w-0 truncate text-sm font-semibold leading-tight text-ink', !plan.exists && 'italic text-muted')}>
                  {plan.title}
                </span>
                {!plan.exists ? (
                  <span className="shrink-0 rounded-full bg-warning/15 px-1.5 py-0.5 text-[10px] font-bold text-warning">
                    Missing
                  </span>
                ) : null}
              </div>
              {plan.preview ? (
                <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted">{plan.preview}</p>
              ) : null}
              {primarySession ? (
                <div className="mt-2 flex min-w-0 items-center gap-1.5 text-[11px] font-medium text-muted-soft">
                  <MessageSquareText className="h-3 w-3 shrink-0" aria-hidden="true" />
                  <span className="min-w-0 truncate">{primarySession.title}</span>
                </div>
              ) : null}
              <div className="mt-2 flex min-w-0 items-center gap-3 text-[11px] font-medium text-muted-soft">
                {plan.checklist.total > 0 ? (
                  <span className="inline-flex items-center gap-1">
                    <Check className="h-3 w-3" aria-hidden="true" />
                    {plan.checklist.completed}/{plan.checklist.total}
                  </span>
                ) : null}
                {linkedSessions.length > 0 ? (
                  <span>{formatNumber(linkedSessions.length)} session{linkedSessions.length === 1 ? '' : 's'}</span>
                ) : null}
                <span className="ml-auto shrink-0">{relativeDate(plan.modifiedAt)}</span>
              </div>
            </button>
          );
        })}
      </div>

      <div className="plans-tasks-pane loading-boundary custom-scrollbar overflow-y-auto rounded-md border border-hairline-soft/70 bg-canvas">
        {detailLoading && !planDetail ? (
          <div aria-hidden="true" className="section-loading-placeholder plans-tasks-detail-loading-placeholder" />
        ) : planDetailError ? (
          <DetailErrorPanel label={planDetailError} />
        ) : selectedPlanId && planDetail ? (
          <PlanDetail detail={planDetail} onOpenSession={onOpenSession} />
        ) : selectedPlanId ? (
          <EmptyPanel label="Plan not found for this project." compact />
        ) : (
          <EmptyPanel label="Select a plan to inspect the current file, checklist progress, and linked sessions." compact />
        )}
        {detailLoading ? <LoadingOverlay label="Loading plan details" /> : null}
      </div>
    </div>
  );
}

function PlanDetail({ detail, onOpenSession }: { detail: PlanDetailsResponse; onOpenSession: OpenSessionHandler }) {
  const plan = detail.plan;
  const linkedSessions = planSessions(plan);
  const checklistItems = useMemo(() => parseChecklistItems(plan.content), [plan.content]);

  return (
    <div className="p-4">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-base font-semibold text-ink">{plan.title}</h2>
          <div className="mt-2 flex flex-wrap items-center gap-3 text-xs font-medium text-muted">
            <span>{formatNumber(plan.wordCount)} words</span>
            <span>{formatNumber(plan.lineCount)} lines</span>
            <span>{formatBytes(plan.sizeBytes)}</span>
            <span>{relativeDate(plan.modifiedAt)}</span>
          </div>
        </div>
        {plan.exists ? null : (
          <span className="rounded-full bg-warning/15 px-2 py-1 text-[11px] font-bold uppercase tracking-[0.1em] text-warning">
            Missing file
          </span>
        )}
      </div>

      {plan.checklist.total > 0 ? (
        <section
          aria-label="Plan checklist"
          className="mt-4 rounded-md border border-hairline-soft bg-surface-soft/45 p-3"
        >
          <div className="flex items-center justify-between text-xs font-semibold text-muted">
            <span>Checklist</span>
            <span>{plan.checklist.completed}/{plan.checklist.total}</span>
          </div>
          <div className="mt-2 h-2 rounded-full bg-canvas">
            <div
              className="h-full rounded-full bg-primary transition-all"
              style={{ width: `${(plan.checklist.completed / plan.checklist.total) * 100}%` }}
            />
          </div>
          {checklistItems.length > 0 ? (
            <div className="custom-scrollbar mt-3 max-h-64 space-y-1 overflow-y-auto pr-1">
              {checklistItems.map((item) => (
                <label
                  className="flex items-start gap-2 rounded-md border border-hairline-soft/50 bg-canvas px-2.5 py-2 text-sm leading-snug text-body"
                  key={`${item.line}-${item.text}`}
                >
                  <input
                    checked={item.checked}
                    className="mt-0.5 h-3.5 w-3.5 shrink-0 rounded border-hairline-soft text-primary"
                    readOnly
                    type="checkbox"
                  />
                  <span className={cn('min-w-0 break-words', item.checked && 'text-muted line-through')}>
                    {item.text}
                  </span>
                </label>
              ))}
            </div>
          ) : (
            <p className="mt-3 rounded-md border border-hairline-soft/50 bg-canvas px-2.5 py-2 text-xs text-muted">
              Checklist lines were detected, but the visible plan content does not include checklist item text.
            </p>
          )}
        </section>
      ) : null}

      {linkedSessions.length > 0 ? (
        <div className="mt-4 rounded-md border border-hairline-soft bg-surface-soft/45 p-3">
          <div className="mb-2 flex items-center gap-2 text-xs font-bold uppercase tracking-[0.12em] text-muted-soft">
            <MessageSquareText className="h-3.5 w-3.5" aria-hidden="true" />
            Linked Sessions
          </div>
          <div className="space-y-2">
            {linkedSessions.map((session) => (
              <button
                aria-label={`Open session ${session.title}`}
                className="flex w-full min-w-0 items-center justify-between gap-3 rounded-md border border-hairline-soft bg-canvas px-3 py-2 text-left transition-colors hover:bg-surface-soft disabled:cursor-default disabled:opacity-60"
                disabled={!onOpenSession}
                key={session.id}
                onClick={() => onOpenSession?.(session.id)}
                type="button"
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm font-semibold text-ink">{session.title}</span>
                  <span className="mt-0.5 block truncate font-mono text-[11px] text-muted-soft">{session.id}</span>
                </span>
                <span className="shrink-0 text-[11px] font-medium text-muted-soft">{relativeDate(session.lastTimestamp)}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {!plan.exists ? (
        <div className="mt-4 rounded-md border border-warning/25 bg-warning/10 px-3 py-2 text-sm text-body">
          No local Markdown file is available for this referenced plan.
        </div>
      ) : null}

      <div className="mt-4 border-t border-hairline-soft/40 pt-4">
        {plan.content.trim() ? <MarkdownContent content={plan.content} /> : <EmptyPanel label="No plan content recorded." compact />}
      </div>
    </div>
  );
}

function planSessions(plan: PlanSummary) {
  const sessions = Array.isArray(plan.sessions) ? plan.sessions : [];
  if (sessions.length > 0) {
    return sessions;
  }

  const sessionIds = Array.isArray(plan.sessionIds) ? plan.sessionIds : [];
  return sessionIds.map((id) => ({
    id,
    title: `Session ${id.slice(0, 8)}`,
    lastTimestamp: plan.latestSessionAt ?? plan.modifiedAt,
  }));
}

function parseChecklistItems(content: string): Array<{ checked: boolean; line: number; text: string }> {
  return content.split(/\r?\n/).flatMap((line, index) => {
    const match = /^\s*[-*]\s+\[([ xX])]\s+(.*)$/.exec(line);
    if (!match?.[2]) return [];
    return [{
      checked: (match[1] ?? '').toLowerCase() === 'x',
      line: index + 1,
      text: match[2].trim(),
    }];
  });
}

function TasksView({
  detailLoading,
  onOpenSession,
  onSelectTask,
  selectedTaskId,
  taskDetailError,
  taskDetail,
  tasks,
  tasksByStatus,
}: {
  detailLoading: boolean;
  onOpenSession: OpenSessionHandler;
  onSelectTask: (id: string) => void;
  selectedTaskId: string | null;
  taskDetailError: string | null;
  taskDetail: TaskDetailsResponse | null;
  tasks: TaskSummary[];
  tasksByStatus: Map<string, TaskSummary[]>;
}) {
  if (tasks.length === 0) {
    return <EmptyPanel label="No task files are linked to this project yet." />;
  }

  const groupedStatuses = new Set(statusGroupOrder.map((group) => group.key));
  const otherStatuses = [...tasksByStatus.keys()].filter((status) => !groupedStatuses.has(status));

  return (
    <div className="plans-tasks-workspace">
      <div className="plans-tasks-pane plans-tasks-list custom-scrollbar overflow-y-auto rounded-md border border-hairline-soft/70 bg-canvas">
        {statusGroupOrder.map((group) => {
          const groupTasks = tasksByStatus.get(group.key);
          if (!groupTasks || groupTasks.length === 0) return null;
          return (
            <TaskGroup
              key={group.key}
              label={group.label}
              onSelectTask={onSelectTask}
              selectedTaskId={selectedTaskId}
              tasks={groupTasks}
            />
          );
        })}
        {otherStatuses.map((status) => (
          <TaskGroup
            key={status}
            label={statusLabel(status)}
            onSelectTask={onSelectTask}
            selectedTaskId={selectedTaskId}
            tasks={tasksByStatus.get(status) ?? []}
          />
        ))}
      </div>

      <div className="plans-tasks-pane loading-boundary custom-scrollbar overflow-y-auto rounded-md border border-hairline-soft/70 bg-canvas">
        {detailLoading && !taskDetail ? (
          <div aria-hidden="true" className="section-loading-placeholder plans-tasks-detail-loading-placeholder" />
        ) : taskDetailError ? (
          <DetailErrorPanel label={taskDetailError} />
        ) : selectedTaskId && taskDetail ? (
          <TaskDetail detail={taskDetail} onOpenSession={onOpenSession} />
        ) : selectedTaskId ? (
          <EmptyPanel label="Task not found for this project." compact />
        ) : (
          <EmptyPanel label="Select a task to inspect its state, session context, and source JSON." compact />
        )}
        {detailLoading ? <LoadingOverlay label="Loading task details" /> : null}
      </div>
    </div>
  );
}

function TaskGroup({
  label,
  onSelectTask,
  selectedTaskId,
  tasks,
}: {
  label: string;
  onSelectTask: (id: string) => void;
  selectedTaskId: string | null;
  tasks: TaskSummary[];
}) {
  return (
    <section>
      <div className="sticky top-0 z-10 flex items-center justify-between border-b border-hairline-soft bg-surface-soft/95 px-3 py-2 text-[11px] font-bold uppercase tracking-[0.12em] text-muted-soft backdrop-blur">
        <span>{label}</span>
        <span>{formatNumber(tasks.length)}</span>
      </div>
      {tasks.map((task) => (
        <TaskItem
          key={task.id}
          onClick={() => onSelectTask(task.id)}
          selected={task.id === selectedTaskId}
          task={task}
        />
      ))}
    </section>
  );
}

function TaskItem({
  onClick,
  selected,
  task,
}: {
  onClick: () => void;
  selected: boolean;
  task: TaskSummary;
}) {
  return (
    <button
      className={cn(
        'w-full border-b border-hairline-soft/35 px-3 py-3 text-left transition-colors last:border-b-0',
        selected ? 'border-l-2 border-l-primary bg-primary/5' : 'hover:bg-surface-soft/60',
      )}
      onClick={onClick}
      type="button"
    >
      <div className="flex min-w-0 items-start gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-semibold leading-tight text-ink">{task.title}</span>
        <StatusBadge status={task.status} />
      </div>
      {task.description ? (
        <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted">{task.description}</p>
      ) : null}
      <div className="mt-2 flex min-w-0 items-center gap-2 text-[11px] font-medium text-muted-soft">
        <CircleDot className="h-3 w-3 shrink-0" aria-hidden="true" />
        <span className="min-w-0 truncate">{task.sessionTitle}</span>
        <span className="ml-auto shrink-0">{relativeDate(task.modifiedAt)}</span>
      </div>
    </button>
  );
}

function TaskDetail({ detail, onOpenSession }: { detail: TaskDetailsResponse; onOpenSession: OpenSessionHandler }) {
  const task = detail.task;
  return (
    <div className="p-4">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-base font-semibold text-ink">{task.title}</h2>
          {task.activeForm ? <p className="mt-1 text-xs font-medium text-primary">{task.activeForm}</p> : null}
        </div>
        <StatusBadge status={task.status} />
      </div>
      <div className="mt-3 grid gap-3 text-xs font-medium text-muted sm:grid-cols-2 xl:grid-cols-4">
        <Info label="Task" value={task.taskId} />
        <SessionInfo onOpenSession={onOpenSession} sessionId={task.sessionId} sessionTitle={task.sessionTitle} />
        <Info label="Size" value={formatBytes(task.sizeBytes)} />
        <Info label="Updated" value={relativeDate(task.modifiedAt)} />
      </div>
      {task.description ? (
        <p className="mt-4 rounded-md border border-hairline-soft bg-surface-soft/45 px-3 py-2 text-sm leading-relaxed text-body">
          {task.description}
        </p>
      ) : null}
      <div className="mt-4 border-t border-hairline-soft/40 pt-4">
        <div className="mb-2 flex items-center gap-2 text-xs font-bold uppercase tracking-[0.12em] text-muted-soft">
          <ListChecks className="h-3.5 w-3.5" aria-hidden="true" />
          Source JSON
        </div>
        <pre className="custom-scrollbar max-h-[min(520px,calc(100vh-420px))] overflow-auto rounded-md border border-code-panel-border bg-code-panel p-3 text-xs leading-relaxed text-code-panel-text">
          {formatJson(task.content)}
        </pre>
      </div>
    </div>
  );
}

function SessionInfo({
  onOpenSession,
  sessionId,
  sessionTitle,
}: {
  onOpenSession: OpenSessionHandler;
  sessionId: string;
  sessionTitle: string;
}) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-muted-soft">Session</div>
      <button
        aria-label={`Open session ${sessionTitle}`}
        className="mt-1 inline-flex max-w-full min-w-0 items-center gap-1.5 rounded-sm text-left text-sm font-semibold text-ink transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/35 disabled:cursor-default disabled:text-muted"
        disabled={!onOpenSession}
        onClick={() => onOpenSession?.(sessionId)}
        title={sessionTitle}
        type="button"
      >
        <span className="min-w-0 truncate">{sessionTitle}</span>
        <MessageSquareText className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
      </button>
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-muted-soft">{label}</div>
      <div className="mt-1 truncate text-sm font-semibold text-ink" title={value}>{value}</div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const key = taskStatusKey(status);
  return (
    <span className={cn(
      'inline-flex h-6 shrink-0 items-center gap-1.5 rounded-md border px-2 text-[11px] font-semibold leading-none',
      statusBadgeStyles[key] ?? 'border-hairline-soft bg-surface-soft/80 text-muted',
    )}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current opacity-70" aria-hidden="true" />
      {statusLabel(key)}
    </span>
  );
}

function DetailErrorPanel({ label }: { label: string }) {
  return (
    <div className="flex min-h-[300px] items-center justify-center px-6 py-8 text-center" role="alert">
      <div className="max-w-md">
        <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-md border border-warning/25 bg-warning/10 text-warning">
          <AlertTriangle className="h-5 w-5" aria-hidden="true" />
        </div>
        <p className="mt-3 text-sm font-semibold text-ink">{label}</p>
        <p className="mt-1 text-xs leading-relaxed text-muted">
          Refresh this page or select another item to try again.
        </p>
      </div>
    </div>
  );
}

function EmptyPanel({ compact = false, label }: { compact?: boolean; label: string }) {
  return (
    <div className={cn('flex items-center justify-center rounded-md border border-dashed border-hairline-soft bg-surface-soft/30 px-6 text-center text-sm text-muted', compact ? 'min-h-[300px] py-8' : 'min-h-[320px] py-12')}>
      {label}
    </div>
  );
}

function normalizePlanSummaries(value: unknown): PlanSummary[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map(normalizePlanSummary);
}

function normalizePlanDetailsResponse(value: unknown): PlanDetailsResponse {
  const raw: Record<string, unknown> = isRecord(value) ? value : {};
  const rawPlan: Record<string, unknown> = isRecord(raw.plan) ? raw.plan : {};
  return {
    plan: {
      ...normalizePlanSummary(rawPlan),
      content: stringOr(rawPlan.content, ''),
    },
    diagnostics: normalizeDiagnostics(raw.diagnostics),
  };
}

function normalizePlanSummary(value: Record<string, unknown>): PlanSummary {
  const id = stringOr(value.id, 'unknown-plan');
  const checklist = isRecord(value.checklist) ? value.checklist : {};
  return {
    id,
    title: stringOr(value.title, id),
    exists: booleanOr(value.exists, false),
    modifiedAt: stringOr(value.modifiedAt, new Date(0).toISOString()),
    sizeBytes: numberOrZero(value.sizeBytes),
    wordCount: numberOrZero(value.wordCount),
    lineCount: numberOrZero(value.lineCount),
    preview: stringOr(value.preview, ''),
    checklist: {
      total: numberOrZero(checklist.total),
      completed: numberOrZero(checklist.completed),
      pending: numberOrZero(checklist.pending),
    },
    sessionIds: stringArray(value.sessionIds),
    sessions: normalizeArtifactSessions(value.sessions),
    latestSessionAt: stringOrNull(value.latestSessionAt),
  };
}

function normalizeTaskSummaries(value: unknown): TaskSummary[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map(normalizeTaskSummary);
}

function normalizeTaskDetailsResponse(value: unknown): TaskDetailsResponse {
  const raw: Record<string, unknown> = isRecord(value) ? value : {};
  const rawTask: Record<string, unknown> = isRecord(raw.task) ? raw.task : {};
  return {
    task: {
      ...normalizeTaskSummary(rawTask),
      content: stringOr(rawTask.content, ''),
    },
    diagnostics: normalizeDiagnostics(raw.diagnostics),
  };
}

function normalizeTaskSummary(value: Record<string, unknown>): TaskSummary {
  const sessionId = stringOr(value.sessionId, 'unknown-session');
  const taskId = stringOr(value.taskId, 'unknown-task');
  return {
    id: stringOr(value.id, `${sessionId}:${taskId}`),
    taskId,
    title: stringOr(value.title, `Task ${taskId}`),
    status: stringOr(value.status, 'unknown'),
    description: stringOr(value.description, ''),
    activeForm: stringOrNull(value.activeForm),
    sessionId,
    sessionTitle: stringOr(value.sessionTitle, `Session ${sessionId.slice(0, 8)}`),
    modifiedAt: stringOr(value.modifiedAt, new Date(0).toISOString()),
    sizeBytes: numberOrZero(value.sizeBytes),
  };
}

function normalizeArtifactSessions(value: unknown): ArtifactSessionSummary[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((session) => {
    const id = stringOr(session.id, 'unknown-session');
    return {
      id,
      title: stringOr(session.title, `Session ${id.slice(0, 8)}`),
      lastTimestamp: stringOr(session.lastTimestamp, new Date(0).toISOString()),
    };
  });
}

function normalizeDiagnostics(value: unknown): Diagnostic[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).flatMap((diagnostic) => {
    if (diagnostic.level !== 'info' && diagnostic.level !== 'warn' && diagnostic.level !== 'error') return [];
    return [{
      level: diagnostic.level,
      message: stringOr(diagnostic.message, 'Unknown diagnostic.'),
      ...(typeof diagnostic.path === 'string' ? { path: diagnostic.path } : {}),
    }];
  });
}

function errorMessage(error: unknown, fallback: string): string {
  const detail = error instanceof Error ? error.message.trim() : '';
  return detail ? `${fallback} ${detail}` : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function booleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function MarkdownContent({ content }: { content: string }) {
  const blocks = useMemo(() => parseMarkdown(content), [content]);
  return (
    <div className="space-y-3 break-words text-sm leading-relaxed text-body">
      {blocks.map((block, index) => {
        if (block.type === 'heading') {
          const Heading = block.depth === 1 ? 'h2' : block.depth === 2 ? 'h3' : 'h4';
          return (
            <Heading
              className={cn(
                'font-semibold leading-snug text-ink',
                block.depth === 1 ? 'text-lg' : block.depth === 2 ? 'text-base' : 'text-sm',
              )}
              key={`${block.type}-${index}`}
            >
              {block.text}
            </Heading>
          );
        }

        if (block.type === 'check') {
          return (
            <label className="flex items-start gap-2 text-sm text-body" key={`${block.type}-${index}`}>
              <input checked={block.checked} className="mt-0.5 h-3.5 w-3.5 shrink-0 rounded" readOnly type="checkbox" />
              <span className={cn(block.checked && 'text-muted line-through')}>{block.text}</span>
            </label>
          );
        }

        if (block.type === 'list') {
          const List = block.ordered ? 'ol' : 'ul';
          return (
            <List
              className={cn('space-y-1 pl-5 marker:text-primary', block.ordered ? 'list-decimal' : 'list-disc')}
              key={`${block.type}-${block.ordered}-${index}`}
            >
              {block.items.map((item, itemIndex) => (
                <li key={itemIndex}>{item}</li>
              ))}
            </List>
          );
        }

        if (block.type === 'code') {
          return (
            <div className="overflow-hidden rounded-md border border-code-panel-border bg-code-panel" key={`${block.type}-${index}`}>
              {block.language ? (
                <div className="border-b border-code-panel-border bg-code-panel-elevated px-3 py-2 font-mono text-[11px] font-bold uppercase tracking-[0.12em] text-code-panel-muted">
                  {block.language}
                </div>
              ) : null}
              <pre className="custom-scrollbar overflow-x-auto p-3 font-mono text-xs leading-relaxed text-code-panel-text">
                <code>{block.code}</code>
              </pre>
            </div>
          );
        }

        return <p className="whitespace-pre-wrap text-sm leading-relaxed text-body" key={`${block.type}-${index}`}>{block.text}</p>;
      })}
    </div>
  );
}

type MarkdownBlock =
  | { type: 'heading'; depth: number; text: string }
  | { type: 'check'; checked: boolean; text: string }
  | { type: 'code'; code: string; language: string }
  | { type: 'list'; items: string[]; ordered: boolean }
  | { type: 'paragraph'; text: string };

function parseMarkdown(content: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  let paragraph: string[] = [];
  let index = 0;

  function flushParagraph() {
    const text = paragraph.join(' ').trim();
    if (text) blocks.push({ type: 'paragraph', text });
    paragraph = [];
  }

  while (index < lines.length) {
    const line = lines[index] ?? '';
    const trimmed = line.trim();
    if (!trimmed) {
      flushParagraph();
      index += 1;
      continue;
    }

    const fence = /^```([A-Za-z0-9_-]*)\s*$/.exec(trimmed);
    if (fence) {
      flushParagraph();
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

    const heading = /^(#{1,4})\s+(.+?)\s*$/.exec(trimmed);
    if (heading?.[1] && heading[2]) {
      flushParagraph();
      blocks.push({ type: 'heading', depth: heading[1].length, text: heading[2] });
      index += 1;
      continue;
    }

    const check = /^\s*[-*]\s+\[([ xX])]\s+(.*)$/.exec(line);
    if (check?.[2] != null) {
      flushParagraph();
      blocks.push({ type: 'check', checked: (check[1] ?? '').toLowerCase() === 'x', text: check[2] });
      index += 1;
      continue;
    }

    const unordered = /^\s*[-*]\s+(.*)$/.exec(line);
    const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (unordered || ordered) {
      flushParagraph();
      const orderedList = Boolean(ordered);
      const items: string[] = [];
      while (index < lines.length) {
        const item = orderedList
          ? /^\s*\d+[.)]\s+(.*)$/.exec(lines[index] ?? '')
          : /^\s*[-*]\s+(.*)$/.exec(lines[index] ?? '');
        if (!item?.[1]) break;
        items.push(item[1].trim());
        index += 1;
      }
      blocks.push({ type: 'list', ordered: orderedList, items });
      continue;
    }

    paragraph.push(trimmed);
    index += 1;
  }

  flushParagraph();
  return blocks;
}

function taskStatusKey(status: string | null | undefined): string {
  return String(status ?? 'unknown').trim().toLowerCase().replace(/[\s-]+/g, '_') || 'unknown';
}

function statusLabel(status: string | null | undefined): string {
  return taskStatusKey(status)
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function dedupeDiagnostics(diagnostics: Diagnostic[]): Diagnostic[] {
  const byKey = new Map<string, Diagnostic>();
  for (const diagnostic of diagnostics) {
    byKey.set(`${diagnostic.level}:${diagnostic.message}:${diagnostic.path ?? ''}`, diagnostic);
  }
  return [...byKey.values()];
}

function resolveSelection<T extends { id: string }>(items: T[], current: string | null): string | null {
  return current && items.some((item) => item.id === current) ? current : items[0]?.id ?? null;
}

function relativeDate(iso: string): string {
  const timestamp = new Date(iso).getTime();
  if (!Number.isFinite(timestamp)) return '';

  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

function formatJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat().format(value);
}
