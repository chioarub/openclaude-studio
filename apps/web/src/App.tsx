import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { BrowserRouter, Link, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import {
  Activity,
  AlertTriangle,
  ArrowDownAZ,
  BarChart3,
  Check,
  ChevronDown,
  CircleDot,
  CircleDollarSign,
  Copy,
  Clock3,
  Database,
  FileTerminal,
  Folder,
  GitBranch,
  KeyRound,
  LayoutDashboard,
  Menu,
  MessageSquareText,
  Moon,
  RefreshCcw,
  Search,
  Server,
  ShieldCheck,
  Sun,
  Terminal,
  X,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import type {
  Diagnostic,
  HealthResponse,
  LogEntry,
  LogFileSummary,
  LogsSearchResponse,
  LogsWindowResponse,
  OverviewResponse,
  ProjectSummary,
  SessionSummary,
} from '@openclaude-studio/shared';

import { createApiClient, normalizeBaseUrl } from './api';

const serverUrlStorageKey = 'openclaude-studio:server-url';
const legacyConnectionStorageKey = 'openclaude-studio.connection';
const activeProjectStorageKey = 'openclaude-studio:active-project';
const defaultServerUrl = 'http://127.0.0.1:43110';

type LoadState = 'idle' | 'loading' | 'ready' | 'error';
type HealthState = HealthResponse | { status: 'error' } | null;
type ProjectFilter = 'all' | 'active' | 'missing';
type ProjectSort = 'recent' | 'name' | 'branch' | 'usage';
type LogLevelFilter = 'all' | LogEntry['level'];
type Theme = 'light' | 'dark';
type UsageMetric = 'cost' | 'tokens';
type UsageTimeframe = '7d' | '14d' | 'all';
type LogRange = {
  start: number;
  count: number;
};

type DiagnosticCounts = {
  errors: number;
  warnings: number;
};

type Snapshot = {
  projects: ProjectSummary[];
  projectResponseDiagnostics: Diagnostic[];
  overview: OverviewResponse | null;
  sessions: SessionSummary[];
  logs: LogsWindowResponse | LogsSearchResponse | null;
  diagnostics: Diagnostic[];
};

type AppRoute = {
  name: string;
  shortName?: string;
  path: string;
  group: 'overview' | 'global' | 'maintenance';
  icon: LucideIcon;
};

const appRoutes: AppRoute[] = [
  {
    name: 'Control Center',
    shortName: 'Home',
    path: '/',
    group: 'overview',
    icon: LayoutDashboard,
  },
  {
    name: 'Sessions',
    path: '/sessions',
    group: 'overview',
    icon: MessageSquareText,
  },
  {
    name: 'Providers',
    path: '/providers',
    group: 'global',
    icon: Server,
  },
  {
    name: 'Logs',
    path: '/logs',
    group: 'maintenance',
    icon: FileTerminal,
  },
  {
    name: 'Diagnostics',
    path: '/diagnostics',
    group: 'maintenance',
    icon: AlertTriangle,
  },
];

const navigationGroups: Array<{ id: AppRoute['group']; label: string; sections: AppRoute[] }> = [
  { id: 'overview', label: 'Overview', sections: appRoutes.filter((route) => route.group === 'overview') },
  { id: 'global', label: 'Global Settings', sections: appRoutes.filter((route) => route.group === 'global') },
  { id: 'maintenance', label: 'Maintenance', sections: appRoutes.filter((route) => route.group === 'maintenance') },
];

const mobilePrimaryPaths = new Set(['/', '/sessions', '/logs']);
const defaultLogWindowCount = 500;
const logRowHeight = 30;
const logFetchOverscan = 250;
const logFetchLimit = 800;
const logRangeDebounceMs = 160;
const usageChartWidth = 720;
const usageChartHeight = 248;
const usageChartPadding = { top: 18, right: 18, bottom: 34, left: 54 };

const usageTimeframeOptions: Array<{ value: UsageTimeframe; label: string }> = [
  { value: '7d', label: '7D' },
  { value: '14d', label: '14D' },
  { value: 'all', label: 'All' },
];

const projectFilters: Array<{ value: ProjectFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'missing', label: 'Missing' },
];

const projectSorts: Array<{ value: ProjectSort; label: string; icon: LucideIcon }> = [
  { value: 'recent', label: 'Recent', icon: Clock3 },
  { value: 'name', label: 'Name', icon: ArrowDownAZ },
  { value: 'branch', label: 'Branch', icon: GitBranch },
  { value: 'usage', label: 'Usage', icon: BarChart3 },
];

const emptySnapshot: Snapshot = {
  projects: [],
  projectResponseDiagnostics: [],
  overview: null,
  sessions: [],
  logs: null,
  diagnostics: [],
};

const ThemeContext = createContext<
  | {
      theme: Theme;
      toggleTheme: () => void;
    }
  | undefined
>(undefined);

export default function App() {
  return (
    <ThemeProvider>
      <BrowserRouter>
        <StudioApp />
      </BrowserRouter>
    </ThemeProvider>
  );
}

function StudioApp() {
  const [baseUrl] = useState(() => normalizeBaseUrl(loadServerUrl()));
  const [selectedProjectId, setSelectedProjectId] = useState(() => loadActiveProjectId());
  const [selectedLogFile, setSelectedLogFile] = useState<string | undefined>();
  const [logQuery, setLogQuery] = useState('');
  const [logLevel, setLogLevel] = useState<LogLevelFilter>('all');
  const [status, setStatus] = useState<LoadState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [health, setHealth] = useState<HealthState>(null);
  const [snapshot, setSnapshot] = useState<Snapshot>(emptySnapshot);
  const workspaceRequestIdRef = useRef(0);
  const logsRequestIdRef = useRef(0);

  const api = useMemo(() => createApiClient({ baseUrl }), [baseUrl]);
  const selectedProject = snapshot.projects.find((project) => project.id === selectedProjectId) ?? null;

  async function refreshHealth() {
    try {
      setHealth(await api.health());
    } catch {
      setHealth({ status: 'error' });
    }
  }

  async function loadWorkspace(
    input: {
      projectId?: string | null;
      fileName?: string | undefined;
      level?: LogLevelFilter;
      query?: string;
      start?: number;
      count?: number;
    } = {},
  ) {
    const requestId = workspaceRequestIdRef.current + 1;
    workspaceRequestIdRef.current = requestId;
    logsRequestIdRef.current += 1;
    setStatus('loading');
    setError(null);
    saveServerUrl(baseUrl);

    try {
      const projectsResponse = await api.projects();
      const projectId = resolveProjectId(projectsResponse.projects, input.projectId ?? selectedProjectId);
      const isSameProject = projectId === selectedProjectId;
      const fileName = input.fileName ?? (isSameProject ? selectedLogFile : undefined);
      const query = input.query ?? logQuery;
      const level = input.level ?? logLevel;
      const shouldTail = input.start === undefined;
      const start = input.start ?? 0;
      const count = input.count ?? defaultLogWindowCount;
      const logsInput = query.trim() || level !== 'all'
        ? api.logSearch(logSearchInput(fileName, query.trim(), level, projectId, start, count, shouldTail))
        : api.logWindow(logWindowInput(fileName, projectId, start, count, shouldTail));
      const [overview, sessionsResponse, logs] = projectId
        ? await Promise.all([api.overview(projectId), api.sessions(projectId), logsInput])
        : [null, { sessions: [] as SessionSummary[] }, await logsInput];

      if (requestId !== workspaceRequestIdRef.current) {
        return;
      }

      setSelectedProjectId(projectId);
      saveActiveProjectId(projectId);
      setSelectedLogFile(logs.selectedFile?.name ?? undefined);
      setSnapshot({
        projects: projectsResponse.projects,
        projectResponseDiagnostics: projectsResponse.diagnostics ?? [],
        overview,
        sessions: sessionsResponse.sessions,
        logs,
        diagnostics: collectDiagnostics(
          projectsResponse.diagnostics ?? [],
          projectsResponse.projects.find((project) => project.id === projectId) ?? null,
          overview,
          logs,
        ),
      });
      setStatus('ready');
    } catch (caught) {
      if (requestId !== workspaceRequestIdRef.current) {
        return;
      }

      setStatus('error');
      setError(caught instanceof Error ? caught.message : 'Unable to load workspace.');
    }
  }

  async function loadLogs(
    input: {
      fileName?: string | undefined;
      level?: LogLevelFilter;
      query?: string;
      start?: number;
      count?: number;
    } = {},
  ) {
    const requestId = logsRequestIdRef.current + 1;
    logsRequestIdRef.current = requestId;
    setError(null);

    try {
      const projectId = selectedProjectId;
      const fileName = input.fileName ?? selectedLogFile;
      const query = input.query ?? logQuery;
      const level = input.level ?? logLevel;
      const shouldTail = input.start === undefined;
      const start = input.start ?? 0;
      const count = input.count ?? defaultLogWindowCount;
      const logs = query.trim() || level !== 'all'
        ? await api.logSearch(logSearchInput(fileName, query.trim(), level, projectId, start, count, shouldTail))
        : await api.logWindow(logWindowInput(fileName, projectId, start, count, shouldTail));

      if (requestId !== logsRequestIdRef.current) {
        return;
      }

      setSelectedLogFile(logs.selectedFile?.name ?? undefined);
      setSnapshot((current) => ({
        ...current,
        logs,
        diagnostics: collectDiagnostics(
          current.projectResponseDiagnostics,
          current.projects.find((project) => project.id === projectId) ?? null,
          current.overview,
          logs,
        ),
      }));
    } catch (caught) {
      if (requestId !== logsRequestIdRef.current) {
        return;
      }
      setError(caught instanceof Error ? caught.message : 'Unable to load logs.');
    }
  }

  useEffect(() => {
    void refreshHealth();
    void loadWorkspace();

    const interval = window.setInterval(() => {
      void refreshHealth();
    }, 30_000);

    return () => window.clearInterval(interval);
    // Initial load only; explicit refreshes own later state updates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="min-h-screen bg-canvas text-ink md:flex">
      <Sidebar diagnostics={snapshot.diagnostics} health={health} />
      <div className="min-h-screen min-w-0 flex-1 pb-16 md:pb-0">
        <Header
          baseUrl={baseUrl}
          health={health}
          isLoading={status === 'loading'}
          projects={snapshot.projects}
          selectedProject={selectedProject}
          selectedProjectId={selectedProjectId}
          onProjectSelect={(projectId) => {
            void loadWorkspace({ projectId });
          }}
          onRefresh={() => {
            void refreshHealth();
            void loadWorkspace();
          }}
        />
        <main className="mx-auto w-full max-w-[1420px] px-4 py-5 md:px-6 lg:px-8">
          {error ? <StatusBanner baseUrl={baseUrl} error={error} isConnected={health?.status === 'ok'} /> : null}
          <Routes>
            <Route
              path="/"
              element={
                <ControlCenterPage
                  isLoading={status === 'loading'}
                  overview={snapshot.overview}
                  project={selectedProject}
                  sessions={snapshot.sessions}
                />
              }
            />
            <Route path="/sessions" element={<SessionsPage sessions={snapshot.sessions} />} />
            <Route path="/providers" element={<ProviderPage overview={snapshot.overview} />} />
            <Route
              path="/logs"
              element={
                <LogsPage
                  isLoading={status === 'loading'}
                  logs={snapshot.logs}
                  level={logLevel}
                  query={logQuery}
                  selectedFile={selectedLogFile}
                  onFileChange={(fileName) => {
                    setSelectedLogFile(fileName);
                    void loadWorkspace({ fileName, level: logLevel, query: logQuery, count: defaultLogWindowCount });
                  }}
                  onLevelChange={(level) => {
                    setLogLevel(level);
                    void loadWorkspace({ level, query: logQuery, count: defaultLogWindowCount });
                  }}
                  onSearch={(query) => {
                    setLogQuery(query);
                    void loadWorkspace({ level: logLevel, query, count: defaultLogWindowCount });
                  }}
                  onWindowChange={(start, count) => {
                    return loadLogs({ start, count });
                  }}
                />
              }
            />
            <Route path="/diagnostics" element={<DiagnosticsPage diagnostics={snapshot.diagnostics} />} />
            <Route path="*" element={<Navigate replace to="/" />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}

function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(() => readTheme());

  useEffect(() => {
    const root = window.document.documentElement;
    root.classList.remove('light', 'dark');
    root.classList.add(theme);
    safeStorage('localStorage')?.setItem('theme', theme);
  }, [theme]);

  return (
    <ThemeContext.Provider
      value={{
        theme,
        toggleTheme: () => setTheme((current) => (current === 'light' ? 'dark' : 'light')),
      }}
    >
      {children}
    </ThemeContext.Provider>
  );
}

function useTheme() {
  const value = useContext(ThemeContext);
  if (!value) {
    throw new Error('useTheme must be used inside ThemeProvider.');
  }
  return value;
}

function Header({
  baseUrl,
  health,
  isLoading,
  projects,
  selectedProject,
  selectedProjectId,
  onProjectSelect,
  onRefresh,
}: {
  baseUrl: string;
  health: HealthState;
  isLoading: boolean;
  projects: ProjectSummary[];
  selectedProject: ProjectSummary | null;
  selectedProjectId: string | null;
  onProjectSelect: (projectId: string) => void;
  onRefresh: () => void;
}) {
  const { theme, toggleTheme } = useTheme();
  const connected = health?.status === 'ok';
  const serverVersion = connected && 'version' in health ? `v${health.version}` : null;

  return (
    <header className="sticky top-0 z-40 flex h-16 shrink-0 items-center justify-between gap-3 border-b border-hairline bg-canvas px-4 md:px-6">
      <div className="flex min-w-0 flex-1 items-center">
        <ProjectSelector
          activeProject={selectedProject}
          activeProjectId={selectedProjectId}
          isLoading={isLoading}
          onSelect={onProjectSelect}
          projects={projects}
        />
      </div>

      <div className="flex shrink-0 items-center gap-3 md:gap-6">
        <button
          aria-label="Refresh project list"
          className="hidden h-9 w-9 items-center justify-center rounded-md border border-hairline bg-canvas text-muted transition-colors hover:bg-surface-soft hover:text-ink disabled:pointer-events-none disabled:opacity-50 md:inline-flex"
          disabled={isLoading}
          onClick={onRefresh}
          title="Refresh project list"
          type="button"
        >
          <RefreshCcw className={cn('h-4 w-4', isLoading && 'animate-spin')} />
        </button>

        <div className="flex items-center gap-2 text-sm">
          {connected ? (
            <span className="flex items-center text-sm font-medium text-success" title={baseUrl}>
              <Activity className="h-4 w-4 sm:mr-1" />
              <span className="hidden sm:inline">Connected</span>
              {serverVersion ? <span className="ml-1 text-xs font-semibold tabular-nums">{serverVersion}</span> : null}
            </span>
          ) : (
            <span className="flex items-center text-sm font-medium text-error" title={baseUrl}>
              <Activity className="h-4 w-4 sm:mr-1" />
              <span className="hidden sm:inline">Disconnected</span>
            </span>
          )}
        </div>

        <button
          aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`}
          className="rounded-full p-2 text-muted transition-colors hover:bg-surface-soft hover:text-ink"
          onClick={toggleTheme}
          title={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`}
          type="button"
        >
          {theme === 'light' ? <Moon className="h-5 w-5" /> : <Sun className="h-5 w-5" />}
        </button>
      </div>
    </header>
  );
}

function ProjectSelector({
  activeProject,
  activeProjectId,
  isLoading,
  onSelect,
  projects,
}: {
  activeProject: ProjectSummary | null;
  activeProjectId: string | null;
  isLoading: boolean;
  onSelect: (projectId: string) => void;
  projects: ProjectSummary[];
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<ProjectFilter>('all');
  const [sort, setSort] = useState<ProjectSort>('recent');
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return undefined;

    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [isOpen]);

  const visibleProjects = useMemo(() => {
    const normalizedQuery = search.trim().toLowerCase();
    const originalOrder = new Map(projects.map((project, index) => [project.id, index]));

    return projects
      .filter((project) => {
        const matchesQuery =
          normalizedQuery === '' ||
          project.name.toLowerCase().includes(normalizedQuery) ||
          project.path.toLowerCase().includes(normalizedQuery) ||
          project.branch.toLowerCase().includes(normalizedQuery);
        const matchesFilter =
          filter === 'all' ||
          (filter === 'active' && project.active) ||
          (filter === 'missing' && !project.exists);
        return matchesQuery && matchesFilter;
      })
      .sort((a, b) => {
        if (sort === 'name') return a.name.localeCompare(b.name);
        if (sort === 'branch') return a.branch.localeCompare(b.branch) || a.name.localeCompare(b.name);
        if (sort === 'usage') return projectTokenTotal(b) - projectTokenTotal(a) || a.name.localeCompare(b.name);
        return (originalOrder.get(a.id) ?? 0) - (originalOrder.get(b.id) ?? 0);
      });
  }, [filter, projects, search, sort]);

  return (
    <div className="relative w-full max-w-[340px]" ref={menuRef}>
      <button
        aria-controls="project-selector-menu"
        aria-expanded={isOpen}
        aria-haspopup="dialog"
        className={cn(
          'flex h-10 w-full items-center gap-2.5 rounded-md border border-hairline bg-surface-soft/30 px-3 text-left text-[14px] text-ink transition-colors hover:border-primary/40 hover:bg-canvas focus:outline-none focus:ring-[3px] focus:ring-primary/15',
          projects.length === 0 && 'cursor-not-allowed opacity-50 hover:border-hairline',
        )}
        disabled={projects.length === 0}
        onClick={() => setIsOpen((current) => !current)}
        type="button"
      >
        <Folder className="h-4 w-4 shrink-0 text-muted" />
        <span className="min-w-0 flex-1 truncate font-medium">
          {activeProject?.name ?? (isLoading ? 'Loading projects...' : 'No projects loaded')}
        </span>
        {activeProject ? (
          <span className="hidden max-w-[96px] shrink-0 truncate rounded border border-hairline-soft bg-canvas px-2 py-0.5 font-mono text-xs text-muted-soft sm:block">
            {activeProject.branch || 'no branch'}
          </span>
        ) : null}
        <ChevronDown className={cn('h-4 w-4 shrink-0 text-muted transition-transform', isOpen && 'rotate-180')} />
      </button>

      {isOpen && projects.length > 0 ? (
        <div
          aria-label="Project selector"
          className="absolute left-0 top-full z-50 mt-2 w-[30rem] max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg border border-hairline bg-canvas shadow-sm shadow-black/10"
          id="project-selector-menu"
          role="dialog"
        >
          <div className="space-y-3 border-b border-hairline-soft bg-surface-soft/40 p-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-soft" />
              <input
                aria-label="Search projects"
                className="h-10 w-full rounded-md border border-hairline bg-canvas pl-9 pr-3 text-[13px] text-ink placeholder:text-muted-soft focus:border-primary focus:outline-none focus:ring-[3px] focus:ring-primary/15"
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search projects, paths, branches..."
                value={search}
              />
            </div>

            <div className="hide-scrollbar flex items-center gap-1 overflow-x-auto">
              {projectFilters.map((item) => (
                <button
                  className={cn(
                    'h-8 rounded-md px-3 text-xs font-medium uppercase tracking-[1.5px] transition-colors',
                    filter === item.value
                      ? 'bg-canvas text-primary shadow-sm shadow-black/5'
                      : 'text-muted hover:bg-canvas/70 hover:text-ink',
                  )}
                  key={item.value}
                  onClick={() => setFilter(item.value)}
                  type="button"
                >
                  {item.label}
                </button>
              ))}
            </div>

            <div className="grid grid-cols-4 gap-1 rounded-md border border-hairline-soft bg-canvas p-1">
              {projectSorts.map((item) => {
                const Icon = item.icon;
                return (
                  <button
                    className={cn(
                      'flex h-8 items-center justify-center gap-1.5 rounded px-2 text-xs font-medium transition-colors',
                      sort === item.value ? 'bg-primary text-on-primary' : 'text-muted hover:bg-surface-soft hover:text-ink',
                    )}
                    key={item.value}
                    onClick={() => setSort(item.value)}
                    type="button"
                  >
                    <Icon className="h-3.5 w-3.5" />
                    <span className="hidden sm:inline">{item.label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="custom-scrollbar max-h-80 overflow-y-auto py-1">
            {visibleProjects.length > 0 ? (
              visibleProjects.map((project) => {
                const isSelected = project.id === activeProjectId;
                const diagnosticCounts = countDiagnostics(project.diagnostics);
                return (
                  <button
                    aria-current={isSelected ? 'true' : undefined}
                    className={cn(
                      'flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-surface-soft focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/15',
                      isSelected && 'bg-primary/5',
                    )}
                    key={project.id}
                    onClick={() => {
                      onSelect(project.id);
                      setIsOpen(false);
                    }}
                    type="button"
                  >
                    <div
                      className={cn(
                        'mt-0.5 rounded-md border p-2',
                        isSelected ? 'border-primary/30 text-primary' : 'border-hairline-soft text-muted',
                      )}
                    >
                      <Folder className="h-4 w-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className={cn('truncate text-[14px] font-medium', isSelected ? 'text-primary' : 'text-ink')}>
                          {project.name}
                        </span>
                        {project.active ? <CircleDot className="h-3.5 w-3.5 shrink-0 text-success" /> : null}
                        {diagnosticCounts.errors > 0 ? (
                          <ProjectDiagnosticIndicator count={diagnosticCounts.errors} tone="error" />
                        ) : !project.exists ? (
                          <ProjectDiagnosticIndicator count={1} tone="error" />
                        ) : null}
                        {diagnosticCounts.warnings > 0 ? (
                          <ProjectDiagnosticIndicator count={diagnosticCounts.warnings} tone="warning" />
                        ) : null}
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted-soft">
                        <span className="inline-flex min-w-0 items-center gap-1">
                          <GitBranch className="h-3 w-3 shrink-0" />
                          <span className="truncate">{project.branch || 'no branch'}</span>
                        </span>
                        <span>{project.lastUpdated}</span>
                        <span>{formatNumber(projectTokenTotal(project))} tokens</span>
                      </div>
                      <span className="mt-1 block truncate font-mono text-xs text-muted-soft">{project.path}</span>
                    </div>
                    {isSelected ? <Check className="mt-1 h-4 w-4 shrink-0 text-primary" /> : null}
                  </button>
                );
              })
            ) : (
              <div className="px-4 py-8 text-center text-sm text-muted">No projects match the current filters.</div>
            )}
          </div>

          <div className="border-t border-hairline-soft bg-surface-soft/40 px-4 py-2 text-xs text-muted-soft">
            Showing {visibleProjects.length} of {projects.length} projects
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ProjectDiagnosticIndicator({ count, tone }: { count: number; tone: 'error' | 'warning' }) {
  const label = `${formatNumber(count)} diagnostic ${tone}${count === 1 ? '' : 's'}`;
  const Icon = tone === 'error' ? XCircle : AlertTriangle;

  return (
    <span
      aria-label={label}
      className={`project-diagnostic-indicator project-diagnostic-${tone}`}
      data-tooltip={label}
      title={label}
    >
      <Icon className="h-3.5 w-3.5" />
    </span>
  );
}

function Sidebar({ diagnostics, health }: { diagnostics: Diagnostic[]; health: HealthState }) {
  const location = useLocation();
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const mobilePrimaryLinks = appRoutes.filter((route) => mobilePrimaryPaths.has(route.path));
  const mobileOverflowLinks = appRoutes.filter((route) => !mobilePrimaryPaths.has(route.path));
  const serverOnline = health?.status === 'ok';
  const statusLabel = health === null ? 'Checking server' : serverOnline ? 'Server online' : 'Server disconnected';
  const isMoreActive = mobileOverflowLinks.some((route) => isActivePath(location.pathname, route.path));
  const diagnosticCounts = countDiagnostics(diagnostics);

  useEffect(() => {
    setIsMobileMenuOpen(false);
  }, [location.pathname]);

  return (
    <>
      <aside className="relative z-10 hidden h-screen w-64 shrink-0 flex-col border-r border-hairline bg-surface-soft transition-colors md:sticky md:top-0 md:flex">
        <div className="flex h-16 shrink-0 items-center gap-3 border-b border-hairline bg-canvas px-5">
          <div className="relative">
            <div className="flex h-9 w-9 items-center justify-center overflow-hidden rounded-lg border border-white/5 bg-surface-dark">
              <Terminal className="relative z-10 h-5 w-5 text-primary" />
            </div>
            <div
              className={cn(
                'absolute -right-0.5 -top-0.5 z-20 h-2.5 w-2.5 rounded-full border border-canvas',
                serverOnline ? 'bg-success' : health === null ? 'bg-muted-soft' : 'bg-error',
              )}
            />
          </div>
          <div className="flex flex-col">
            <span className="mb-0.5 text-[15px] font-medium leading-none tracking-normal text-ink">OpenClaude</span>
            <div className="flex items-center gap-1.5">
              <span className="text-xs font-medium uppercase leading-none tracking-[0.15em] text-primary">Studio</span>
              <div className="h-[2px] flex-1 rounded-full bg-primary/20" />
            </div>
          </div>
        </div>

        <nav className="custom-scrollbar flex-1 space-y-1 overflow-y-auto px-3 py-6" aria-label="Primary">
          {navigationGroups.map((group, groupIndex) => (
            <div className="space-y-1" key={group.id}>
              <div
                className={cn(
                  'px-2 pb-1 text-xs font-medium uppercase tracking-[0.14em] text-muted-soft',
                  groupIndex === 0 ? 'pt-0' : 'pt-3',
                )}
              >
                {group.label}
              </div>
              {group.sections.map((route) => {
                const active = isActivePath(location.pathname, route.path);
                const Icon = route.icon;
                return (
                  <Link
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'group flex items-center gap-3 rounded-md border px-3 py-2.5 text-sm font-medium transition-all',
                      active
                        ? 'border-hairline bg-canvas text-primary'
                        : 'border-transparent text-muted hover:bg-canvas hover:text-ink',
                    )}
                    key={route.path}
                    to={route.path}
                  >
                    <Icon
                      className={cn(
                        'h-4 w-4 transition-colors',
                        active ? 'text-primary' : 'text-muted-soft group-hover:text-ink',
                      )}
                    />
                    <span className="min-w-0 flex-1 truncate">{route.name}</span>
                    {route.path === '/diagnostics' ? <DiagnosticsNavPills counts={diagnosticCounts} /> : null}
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>

        <div className="shrink-0 border-t border-hairline bg-surface-soft/50 p-4">
          <div className="rounded-lg border border-hairline bg-canvas p-3">
            <div className="mb-1 flex items-center justify-between">
              <span className="text-xs font-medium text-ink">
                {serverOnline && 'version' in health ? `v${health.version}` : 'Local server'}
              </span>
              <span
                className={cn(
                  'h-2 w-2 rounded-full',
                  serverOnline ? 'bg-success' : health === null ? 'bg-muted-soft' : 'bg-error',
                )}
              />
            </div>
            <div className="font-mono text-xs font-medium uppercase tracking-widest text-muted-soft">{statusLabel}</div>
          </div>
        </div>
      </aside>

      {isMobileMenuOpen ? (
        <div className="custom-scrollbar fixed inset-x-3 bottom-20 z-50 max-h-[70vh] overflow-y-auto rounded-xl border border-hairline bg-canvas shadow-sm md:hidden">
          <div className="flex items-center justify-between border-b border-hairline-soft px-4 py-3">
            <span className="text-xs font-medium uppercase tracking-[1.5px] text-muted-soft">Navigation</span>
            <button
              aria-label="Close navigation menu"
              className="rounded-md p-2 text-muted-soft hover:bg-surface-soft hover:text-ink"
              onClick={() => setIsMobileMenuOpen(false)}
              type="button"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <nav aria-label="More navigation" className="space-y-4 p-4">
            {navigationGroups.map((group) => (
              <section className="space-y-2" key={group.id}>
                <h2 className="px-1 text-xs font-medium uppercase tracking-[1.5px] text-muted-soft">{group.label}</h2>
                <div className="grid grid-cols-1 gap-1">
                  {group.sections.map((route) => {
                    const active = isActivePath(location.pathname, route.path);
                    const Icon = route.icon;
                    return (
                      <Link
                        aria-current={active ? 'page' : undefined}
                        className={cn(
                          'flex items-center gap-3 rounded-lg border px-3 py-3 text-sm font-medium transition-colors',
                          active
                            ? 'border-primary/20 bg-primary/5 text-primary'
                            : 'border-transparent text-muted hover:border-hairline-soft hover:bg-surface-soft hover:text-ink',
                        )}
                        key={route.path}
                        to={route.path}
                      >
                        <Icon className={cn('h-4 w-4', active ? 'text-primary' : 'text-muted-soft')} />
                        <span className="min-w-0 flex-1 truncate">{route.name}</span>
                        {route.path === '/diagnostics' ? <DiagnosticsNavPills counts={diagnosticCounts} /> : null}
                      </Link>
                    );
                  })}
                </div>
              </section>
            ))}
          </nav>
        </div>
      ) : null}

      <nav
        aria-label="Primary navigation"
        className="fixed inset-x-0 bottom-0 z-50 h-16 border-t border-hairline bg-canvas md:hidden"
      >
        <div className="grid h-full grid-cols-4">
          {mobilePrimaryLinks.map((route) => {
            const active = isActivePath(location.pathname, route.path);
            const Icon = route.icon;
            return (
              <Link
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex min-w-0 flex-col items-center justify-center gap-1 px-1 text-xs font-medium leading-none transition-colors',
                  active ? 'text-primary' : 'text-muted-soft hover:text-ink',
                )}
                key={route.path}
                to={route.path}
              >
                <Icon className={cn('h-4 w-4', active ? 'text-primary' : 'text-muted-soft')} />
                <span className="max-w-full truncate">{route.shortName ?? route.name}</span>
              </Link>
            );
          })}
          <button
            aria-expanded={isMobileMenuOpen}
            aria-label={isMobileMenuOpen ? 'Close more navigation' : 'Open more navigation'}
            className={cn(
              'flex min-w-0 flex-col items-center justify-center gap-1 px-1 text-xs font-medium leading-none transition-colors',
              isMoreActive || isMobileMenuOpen ? 'text-primary' : 'text-muted-soft hover:text-ink',
            )}
            onClick={() => setIsMobileMenuOpen((current) => !current)}
            type="button"
          >
            <Menu className={cn('h-4 w-4', isMoreActive || isMobileMenuOpen ? 'text-primary' : 'text-muted-soft')} />
            <span className="max-w-full truncate">More</span>
          </button>
        </div>
      </nav>
    </>
  );
}

function DiagnosticsNavPills({ counts }: { counts: DiagnosticCounts }) {
  if (counts.errors === 0 && counts.warnings === 0) {
    return null;
  }

  return (
    <span className="nav-diagnostic-pills">
      {counts.errors > 0 ? (
        <span
          aria-label={`${formatNumber(counts.errors)} diagnostic ${counts.errors === 1 ? 'error' : 'errors'}`}
          className="nav-diagnostic-pill nav-diagnostic-error"
        >
          {formatNumber(counts.errors)}
        </span>
      ) : null}
      {counts.warnings > 0 ? (
        <span
          aria-label={`${formatNumber(counts.warnings)} diagnostic ${counts.warnings === 1 ? 'warning' : 'warnings'}`}
          className="nav-diagnostic-pill nav-diagnostic-warning"
        >
          {formatNumber(counts.warnings)}
        </span>
      ) : null}
    </span>
  );
}

function ControlCenterPage({
  isLoading,
  overview,
  project,
  sessions,
}: {
  isLoading: boolean;
  overview: OverviewResponse | null;
  project: ProjectSummary | null;
  sessions: SessionSummary[];
}) {
  return (
    <PageStack>
      <PageHeader
        icon={LayoutDashboard}
        status={project ? `${project.name} / ${project.branch || 'no branch'}` : 'Waiting for project'}
        title="Control Center"
        aside={
          <div className="page-header-stats">
            <QuickStat label="Warnings" value={overview?.cards.logWarningCount ?? 0} />
            <QuickStat label="Failed" value={overview?.cards.failedSessionCount ?? 0} />
          </div>
        }
      />

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <Metric icon={<MessageSquareText />} label="Sessions" value={overview?.cards.sessionCount ?? 0} />
        <Metric icon={<Database />} label="Tokens" value={formatNumber(overview?.cards.totalTokens ?? 0)} />
        <Metric icon={<CircleDollarSign />} label="Cost" value={formatUsd(overview?.cards.totalCostUsd ?? 0)} />
        <Metric icon={<AlertTriangle />} label="Log issues" value={logIssueCount(overview)} />
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
        <section className="panel project-overview-panel">
          <div className="section-heading-row">
            <SectionHeading icon={ShieldCheck} label="Project Overview" />
            {overview ? <Badge label={`${formatNumber(overview.usageSeries.length)} usage days`} tone="muted" /> : null}
          </div>
          {project && overview ? (
            <div className="project-overview-content">
              <UsageOverviewChart series={overview.usageSeries} />
              <div className="project-overview-facts">
                <Info label="Path" value={project.path} />
                <Info label="Branch" value={project.branch || 'no branch'} />
                <Info label="Changed files" value={String(overview.cards.changedFileCount)} />
                <Info label="Failed sessions" value={String(overview.cards.failedSessionCount)} />
              </div>
            </div>
          ) : (
            <EmptyState label={isLoading ? 'Loading workspace' : 'No project selected'} />
          )}
        </section>

        <ProviderSummaryCard overview={overview} />
      </div>

      <SessionsTable sessions={sessions.slice(0, 8)} title="Recent Sessions" />
    </PageStack>
  );
}

function SessionsPage({ sessions }: { sessions: SessionSummary[] }) {
  const failedCount = sessions.filter((session) => session.status === 'failed').length;

  return (
    <PageStack>
      <PageHeader
        icon={MessageSquareText}
        status={`${sessions.length} sessions loaded`}
        title="Sessions"
        aside={
          <div className="page-header-stats">
            <QuickStat label="Completed" value={sessions.length - failedCount} />
            <QuickStat label="Failed" value={failedCount} />
          </div>
        }
      />
      <SessionsTable sessions={sessions} title="Sessions" />
    </PageStack>
  );
}

function ProviderPage({ overview }: { overview: OverviewResponse | null }) {
  const provider = overview?.provider;
  return (
    <PageStack>
      <PageHeader
        icon={Server}
        status={provider ? `${provider.provider} / ${provider.model}` : 'No provider profile'}
        title="Providers"
      />
      <section className="panel">
        <SectionHeading icon={KeyRound} label="Providers" />
        {provider ? (
          <div className="mt-5 grid gap-4 lg:grid-cols-2">
            <Info label="Name" value={provider.name} />
            <Info label="Provider" value={provider.provider} />
            <Info label="Model" value={provider.model} />
            <Info label="Base URL" value={provider.baseUrl ?? 'default'} />
            <div className="flex flex-wrap gap-2 lg:col-span-2">
              <Badge label={provider.active ? 'active' : 'inactive'} tone={provider.active ? 'success' : 'muted'} />
              <Badge label={provider.apiKeySet ? 'api key set' : 'no api key'} tone={provider.apiKeySet ? 'success' : 'muted'} />
              <Badge
                label={provider.authHeaderValueSet ? 'auth header set' : 'no auth header'}
                tone={provider.authHeaderValueSet ? 'success' : 'muted'}
              />
            </div>
          </div>
        ) : (
          <EmptyState label="No active provider" />
        )}
      </section>
    </PageStack>
  );
}

function LogsPage({
  isLoading,
  level,
  logs,
  onLevelChange,
  onFileChange,
  onSearch,
  onWindowChange,
  query,
  selectedFile,
}: {
  isLoading: boolean;
  level: LogLevelFilter;
  logs: LogsWindowResponse | LogsSearchResponse | null;
  onLevelChange: (level: LogLevelFilter) => void;
  onFileChange: (fileName: string | undefined) => void;
  onSearch: (query: string) => void;
  onWindowChange: (start: number, count: number) => Promise<void> | void;
  query: string;
  selectedFile: string | undefined;
}) {
  const [draftQuery, setDraftQuery] = useState(query);
  const logViewRef = useRef<HTMLDivElement>(null);
  const activeRangeRef = useRef<LogRange | null>(null);
  const pendingRangeRef = useRef<LogRange | null>(null);
  const rangeTimerRef = useRef<number | null>(null);
  const isMountedRef = useRef(true);
  const shouldScrollToLatestRef = useRef(true);
  const onWindowChangeRef = useRef(onWindowChange);
  const selectedLog = logs?.selectedFile ?? null;
  const isSearchResponse = Boolean(logs && 'totalMatches' in logs);
  const totalRows = isSearchResponse ? (logs as LogsSearchResponse).totalMatches : logs?.totalLines ?? 0;
  const visibleRows = logs?.entries.length ?? 0;
  const matches = isSearchResponse ? totalRows : logs?.totalLines ?? 0;
  const loadedStart = logs?.start ?? 0;
  const totalHeight = Math.max(totalRows * logRowHeight, visibleRows * logRowHeight);

  useEffect(() => {
    setDraftQuery(query);
  }, [query]);

  useEffect(() => {
    onWindowChangeRef.current = onWindowChange;
  }, [onWindowChange]);

  useEffect(() => {
    if (rangeTimerRef.current !== null) {
      window.clearTimeout(rangeTimerRef.current);
      rangeTimerRef.current = null;
    }
    activeRangeRef.current = null;
    pendingRangeRef.current = null;
    shouldScrollToLatestRef.current = true;
  }, [level, query, selectedLog?.name]);

  useEffect(() => {
    if (isLoading || !shouldScrollToLatestRef.current || !logs || totalRows === 0) {
      return undefined;
    }

    const logView = logViewRef.current;
    if (!logView) {
      return undefined;
    }

    const frame = window.requestAnimationFrame(() => {
      logView.scrollTop = logView.scrollHeight;
      shouldScrollToLatestRef.current = false;
    });

    return () => window.cancelAnimationFrame(frame);
  }, [isLoading, logs, totalRows]);

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
      activeRangeRef.current = null;
      pendingRangeRef.current = null;
      if (rangeTimerRef.current !== null) {
        window.clearTimeout(rangeTimerRef.current);
        rangeTimerRef.current = null;
      }
    };
  }, []);

  const flushPendingRange = useCallback(() => {
    if (!isMountedRef.current) {
      return;
    }
    rangeTimerRef.current = null;
    const pendingRange = pendingRangeRef.current;
    if (!pendingRange) {
      return;
    }

    pendingRangeRef.current = null;
    activeRangeRef.current = pendingRange;
    void Promise.resolve()
      .then(() => onWindowChangeRef.current(pendingRange.start, pendingRange.count))
      .catch(() => undefined)
      .finally(() => {
        if (!isMountedRef.current) {
          return;
        }
        if (activeRangeRef.current !== pendingRange) {
          return;
        }
        activeRangeRef.current = null;
        if (pendingRangeRef.current && rangeTimerRef.current === null) {
          rangeTimerRef.current = window.setTimeout(flushPendingRange, logRangeDebounceMs);
        }
      });
  }, []);

  const scheduleRangeRequest = useCallback(
    (range: LogRange) => {
      pendingRangeRef.current = range;
      if (rangeTimerRef.current !== null) {
        window.clearTimeout(rangeTimerRef.current);
      }
      rangeTimerRef.current = window.setTimeout(flushPendingRange, logRangeDebounceMs);
    },
    [flushPendingRange],
  );

  useEffect(() => {
    activeRangeRef.current = null;
    const pendingRange = pendingRangeRef.current;
    if (!pendingRange) {
      return;
    }

    if (isLogRangeCovered({ start: loadedStart, count: visibleRows }, pendingRange)) {
      pendingRangeRef.current = null;
      return;
    }

    scheduleRangeRequest(pendingRange);
  }, [loadedStart, scheduleRangeRequest, visibleRows]);

  const requestLogRange = useCallback(
    (nextScrollTop: number, viewportHeight: number) => {
      if (!logs || totalRows === 0) {
        return;
      }

      const range = getVirtualLogRange({
        scrollTop: nextScrollTop,
        viewportHeight,
        rowHeight: logRowHeight,
        totalRows,
        overscan: logFetchOverscan,
        maxCount: logFetchLimit,
      });
      if (range.count === 0 || isLogRangeCovered({ start: loadedStart, count: visibleRows }, range)) {
        return;
      }

      const activeRange = activeRangeRef.current;
      if (activeRange) {
        if (!isLogRangeCovered(activeRange, range)) {
          pendingRangeRef.current = range;
        }
        return;
      }

      const pendingRange = pendingRangeRef.current;
      if (!pendingRange || !isLogRangeCovered(pendingRange, range)) {
        scheduleRangeRequest(range);
      }
    },
    [loadedStart, logs, scheduleRangeRequest, totalRows, visibleRows],
  );

  return (
    <PageStack>
      <PageHeader
        icon={FileTerminal}
        status={selectedLog?.name ?? 'No log file selected'}
        title="System Logs"
        aside={
          <LogFileSelect
            files={logs?.files ?? []}
            onChange={onFileChange}
            selectedFile={selectedFile}
          />
        }
      />

      <section className="log-console">
        <div className="log-console-toolbar">
          <div className="log-console-title">
            <div className="log-mark" aria-hidden="true">
              <span />
              <span />
            </div>
            <div className="min-w-0">
              <div className="text-[12px] font-semibold uppercase tracking-[1.5px] text-code-panel-text">
                Debug Log
              </div>
              <div className="mt-1 truncate text-xs font-medium uppercase tracking-[1.5px] text-code-panel-muted">
                {selectedLog?.name ?? 'No file selected'}
              </div>
            </div>
          </div>

          <form
            className="log-console-controls"
            onSubmit={(event) => {
              event.preventDefault();
              onSearch(draftQuery);
            }}
          >
            <div className="relative min-w-0 flex-1">
              <Search className="absolute left-3.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-code-panel-muted" />
              <input
                aria-label="Search logs"
                className="log-search-input"
                onChange={(event) => setDraftQuery(event.target.value)}
                placeholder="Search log messages..."
                value={draftQuery}
              />
            </div>
            <button className="log-search-button" type="submit">
              <Search className="h-4 w-4" />
              Search
            </button>
          </form>
        </div>

        <div className="log-level-bar">
          {(['all', 'info', 'warn', 'error', 'debug'] as LogLevelFilter[]).map((item) => (
            <button
              className={cn('log-level-button', level === item && 'log-level-button-active')}
              key={item}
              onClick={() => onLevelChange(item)}
              type="button"
            >
              {item}
            </button>
          ))}
        </div>

        {selectedLog ? (
          <div className="log-console-meta">
            <MetaItem label="Size" value={formatBytes(selectedLog.sizeBytes)} />
            <MetaItem label="Modified" value={formatDateTime(selectedLog.modifiedAt)} />
            <MetaItem label={isSearchResponse ? 'Matches' : 'Rows'} value={formatNumber(matches)} />
            {isSearchResponse ? <MetaItem label="Total" value={formatNumber(logs?.totalLines ?? 0)} /> : null}
          </div>
        ) : null}

        <div
          aria-label="Log entries"
          className="log-view"
          onScroll={(event) => {
            const target = event.currentTarget;
            requestLogRange(target.scrollTop, target.clientHeight);
          }}
          ref={logViewRef}
          role="region"
        >
          <div className="log-table-header" role="row">
            <span>Time</span>
            <span>Line</span>
            <span>Level</span>
            <span>Message</span>
            <span aria-label="Actions" />
          </div>
          {logs?.entries.length ? (
            <div className="log-spacer" style={{ height: `${totalHeight}px` }}>
              {logs.entries.map((entry, index) => (
                <LogLine
                  entry={entry}
                  key={entry.id}
                  style={{ transform: `translateY(${(logs.start + index) * logRowHeight}px)` }}
                />
              ))}
            </div>
          ) : (
            <EmptyState label="No log entries" />
          )}
        </div>
      </section>
    </PageStack>
  );
}

function LogFileSelect({
  files,
  onChange,
  selectedFile,
}: {
  files: LogFileSummary[];
  onChange: (fileName: string | undefined) => void;
  selectedFile: string | undefined;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const activeFile = files.find((file) => file.name === selectedFile) ?? files[0] ?? null;

  useEffect(() => {
    if (!isOpen) return undefined;

    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [isOpen]);

  return (
    <div className="custom-select" ref={menuRef}>
      <button
        aria-controls="log-file-selector-menu"
        aria-expanded={isOpen}
        aria-haspopup="listbox"
        aria-label="Debug log file"
        className={cn('custom-select-trigger', files.length === 0 && 'custom-select-trigger-disabled')}
        disabled={files.length === 0}
        onClick={() => setIsOpen((current) => !current)}
        type="button"
      >
        <span className="custom-select-trigger-content">
          <FileTerminal className="h-4 w-4 shrink-0 text-muted" />
          <span className="min-w-0 flex-1 truncate font-medium">
            {activeFile?.name ?? 'No logs'}
          </span>
        </span>
        <ChevronDown className={cn('h-4 w-4 shrink-0 text-muted transition-transform', isOpen && 'rotate-180')} />
      </button>

      {isOpen && files.length > 0 ? (
        <div
          aria-label="Debug log file"
          className="custom-select-menu custom-scrollbar"
          id="log-file-selector-menu"
          role="listbox"
        >
          {files.map((file) => {
            const isSelected = file.name === activeFile?.name;
            return (
              <button
                aria-selected={isSelected}
                className={cn('custom-select-option', isSelected && 'custom-select-option-active')}
                key={file.name}
                onClick={() => {
                  onChange(file.name);
                  setIsOpen(false);
                }}
                role="option"
                type="button"
              >
                <FileTerminal className={cn('mt-0.5 h-4 w-4 shrink-0', isSelected ? 'text-primary' : 'text-muted')} />
                <span className="min-w-0 flex-1">
                  <span className={cn('block truncate text-[14px] font-medium', isSelected ? 'text-primary' : 'text-ink')}>
                    {file.name}
                  </span>
                  <span className="mt-0.5 block truncate text-[12px] text-muted">
                    {formatBytes(file.sizeBytes)} / {formatDateTime(file.modifiedAt)}
                  </span>
                </span>
                {isSelected ? <Check className="mt-0.5 h-4 w-4 shrink-0 text-primary" /> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function DiagnosticsPage({ diagnostics }: { diagnostics: Diagnostic[] }) {
  return (
    <PageStack>
      <PageHeader
        icon={AlertTriangle}
        status={`${diagnostics.length} diagnostics`}
        title="Diagnostics"
      />
      <section className="panel">
        <SectionHeading icon={AlertTriangle} label="Diagnostics" />
        {diagnostics.length > 0 ? (
          <div className="diagnostics-list mt-4">
            {diagnostics.map((diagnostic) => (
              <DiagnosticRow diagnostic={diagnostic} key={diagnosticKey(diagnostic)} />
            ))}
          </div>
        ) : (
          <EmptyState label="No diagnostics" />
        )}
      </section>
    </PageStack>
  );
}

function UsageOverviewChart({ series }: { series: OverviewResponse['usageSeries'] }) {
  const [metric, setMetric] = useState<UsageMetric>(() => preferredUsageMetric(series));
  const [timeframe, setTimeframe] = useState<UsageTimeframe>('14d');
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);

  useEffect(() => {
    setMetric((current) => hasUsageData(series, current) ? current : preferredUsageMetric(series));
  }, [series]);

  const visibleSeries = useMemo(() => filterUsageSeries(series, timeframe), [series, timeframe]);
  const plot = useMemo(() => buildUsageChartPlot(visibleSeries, metric), [metric, visibleSeries]);
  const hasRecordedCost = hasUsageData(series, 'cost');
  const totalValue = visibleSeries.reduce((total, point) => total + usageValue(point, metric), 0);
  const latestPoint = visibleSeries.at(-1);
  const latestValue = latestPoint ? usageValue(latestPoint, metric) : 0;
  const xLabelIndexes = usageChartLabelIndexes(visibleSeries.length);
  const metricLabel = metric === 'cost' ? 'Recorded spend' : 'Token throughput';
  const hoveredPoint = hoveredIndex === null ? null : plot.points[hoveredIndex] ?? null;
  const emptyLabel = metric === 'cost' ? 'No recorded cost in this range' : 'No token usage recorded';

  return (
    <div className="usage-overview">
      <div className="usage-overview-toolbar">
        <div className="min-w-0">
          <div className="usage-overview-title">Usage Overview</div>
          <div className="usage-overview-subtitle">
            <span>{metricLabel}</span>
            <span>{timeframe.toUpperCase()}</span>
            {!hasRecordedCost ? <span>Recorded cost unavailable</span> : null}
          </div>
        </div>
        <div className="usage-overview-controls" aria-label="Usage chart controls">
          <div className="segmented-control" aria-label="Usage metric">
            {(['cost', 'tokens'] as const).map((value) => (
              <button
                aria-pressed={metric === value}
                className="segmented-control-button"
                key={value}
                aria-disabled={value === 'cost' && !hasRecordedCost ? 'true' : undefined}
                onClick={() => {
                  if (value === 'cost' && !hasRecordedCost) {
                    return;
                  }
                  setMetric(value);
                  setHoveredIndex(null);
                }}
                title={
                  value === 'cost' && !hasRecordedCost
                    ? 'This project has token usage, but OpenClaude has not saved recorded cost for it.'
                    : undefined
                }
                type="button"
              >
                {value === 'cost' ? 'Cost' : 'Tokens'}
              </button>
            ))}
          </div>
          <div className="segmented-control" aria-label="Usage timeframe">
            {usageTimeframeOptions.map((option) => (
              <button
                aria-pressed={timeframe === option.value}
                className="segmented-control-button"
                key={option.value}
                onClick={() => setTimeframe(option.value)}
                type="button"
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="usage-chart-shell">
        <div className="usage-chart-summary">
          <div>
            <span>Total</span>
            <strong>{formatUsageValue(totalValue, metric)}</strong>
          </div>
          <div>
            <span>Latest</span>
            <strong>{formatUsageValue(latestValue, metric)}</strong>
          </div>
        </div>

        {plot.hasData ? (
          <div className="usage-chart-frame" onPointerLeave={() => setHoveredIndex(null)}>
            <svg
              aria-label={`${metricLabel} chart`}
              className="usage-chart"
              role="img"
              viewBox={`0 0 ${usageChartWidth} ${usageChartHeight}`}
            >
              <defs>
                <linearGradient id={`usage-chart-fill-${metric}`} x1="0" x2="0" y1="0" y2="1">
                  <stop offset="5%" stopColor={metric === 'cost' ? 'var(--color-primary)' : 'var(--color-accent-teal)'} stopOpacity="0.48" />
                  <stop offset="100%" stopColor={metric === 'cost' ? 'var(--color-primary)' : 'var(--color-accent-teal)'} stopOpacity="0" />
                </linearGradient>
              </defs>

              {plot.ticks.map((tick) => (
                <g key={tick.value}>
                  <line className="usage-chart-grid" x1={plot.left} x2={plot.right} y1={tick.y} y2={tick.y} />
                  <text className="usage-chart-y-label" x={plot.left - 10} y={tick.y + 4}>
                    {formatUsageAxisValue(tick.value, metric)}
                  </text>
                </g>
              ))}

              <path className="usage-chart-area" d={plot.areaPath} fill={`url(#usage-chart-fill-${metric})`} />
              <path className={cn('usage-chart-line', metric === 'tokens' && 'usage-chart-line-tokens')} d={plot.linePath} />

              {hoveredPoint ? (
                <line
                  className="usage-chart-crosshair"
                  x1={hoveredPoint.x}
                  x2={hoveredPoint.x}
                  y1={plot.top}
                  y2={plot.bottom}
                />
              ) : null}

              {plot.points.map((point) => (
                <circle
                  className={cn(
                    'usage-chart-point',
                    metric === 'tokens' && 'usage-chart-point-tokens',
                    hoveredIndex === point.index && 'usage-chart-point-active',
                  )}
                  cx={point.x}
                  cy={point.y}
                  key={`${point.date}-${point.index}`}
                  r={hoveredIndex === point.index ? 4.5 : 3.5}
                />
              ))}

              {plot.points.map((point, index) => (
                <rect
                  aria-label={`${point.date}: ${formatUsageValue(point.value, metric)}`}
                  className="usage-chart-hit-target"
                  height={plot.bottom - plot.top}
                  key={`${point.date}-hit-target`}
                  onBlur={() => setHoveredIndex(null)}
                  onFocus={() => setHoveredIndex(index)}
                  onPointerEnter={() => setHoveredIndex(index)}
                  tabIndex={0}
                  width={plot.hitTargetWidth}
                  x={point.x - plot.hitTargetWidth / 2}
                  y={plot.top}
                />
              ))}

              {xLabelIndexes.map((index) => {
                const point = plot.points[index];
                return point ? (
                  <text className="usage-chart-x-label" key={point.date} x={point.x} y={usageChartHeight - 8}>
                    {point.name}
                  </text>
                ) : null;
              })}
            </svg>
            {hoveredPoint ? (
              <UsageChartTooltip metric={metric} point={hoveredPoint} />
            ) : null}
          </div>
        ) : (
          <EmptyState label={emptyLabel} />
        )}
      </div>
    </div>
  );
}

function UsageChartTooltip({
  metric,
  point,
}: {
  metric: UsageMetric;
  point: ReturnType<typeof buildUsageChartPlot>['points'][number];
}) {
  return (
    <div
      className={cn('usage-chart-tooltip', usageTooltipAlignment(point.x))}
      role="tooltip"
      style={{
        left: `${(point.x / usageChartWidth) * 100}%`,
        top: `${(point.y / usageChartHeight) * 100}%`,
      }}
    >
      <div className="usage-chart-tooltip-date">{formatUsageTooltipDate(point.date)}</div>
      <div className="usage-chart-tooltip-value">{formatUsageValue(point.value, metric)}</div>
      <div className="usage-chart-tooltip-grid">
        <span>Sessions</span>
        <strong>{formatNumber(point.sessionCount)}</strong>
        <span>Tokens</span>
        <strong>{formatCompactNumber(point.totalTokens)}</strong>
        <span>Recorded cost</span>
        <strong>{point.costUsd > 0 ? formatUsd(point.costUsd) : 'Not recorded'}</strong>
      </div>
    </div>
  );
}

function ProviderSummaryCard({ overview }: { overview: OverviewResponse | null }) {
  const provider = overview?.provider;
  return (
    <section className="panel">
      <SectionHeading icon={KeyRound} label="Active Provider" />
      {provider ? (
        <div className="mt-5 space-y-4">
          <Info label="Name" value={provider.name} />
          <Info label="Model" value={provider.model} />
          <Info label="Base URL" value={provider.baseUrl ?? 'default'} />
          <div className="flex flex-wrap gap-2">
            <Badge label={provider.apiKeySet ? 'API key set' : 'No API key'} tone={provider.apiKeySet ? 'success' : 'muted'} />
            <Badge
              label={provider.authHeaderValueSet ? 'Auth header set' : 'No auth header'}
              tone={provider.authHeaderValueSet ? 'success' : 'muted'}
            />
          </div>
        </div>
      ) : (
        <EmptyState label="No active provider" />
      )}
    </section>
  );
}

function SessionsTable({ sessions, title }: { sessions: SessionSummary[]; title: string }) {
  return (
    <section className="panel">
      <SectionHeading icon={MessageSquareText} label={title} />
      <div className="mt-4 overflow-x-auto">
        {sessions.length === 0 ? (
          <EmptyState label="No sessions found" />
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Title</th>
                <th>Status</th>
                <th>Models</th>
                <th>Changed</th>
                <th>Tokens</th>
                <th>Cost</th>
                <th>Last seen</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((session) => (
                <tr key={session.id}>
                  <td className="max-w-[380px] truncate">{session.title}</td>
                  <td>
                    <Badge tone={session.status === 'failed' ? 'danger' : 'success'} label={session.status} />
                  </td>
                  <td className="max-w-[260px] truncate">{session.modelSet.join(', ') || 'unknown'}</td>
                  <td>{session.changedFiles.length}</td>
                  <td>{formatNumber(sessionTokenTotal(session))}</td>
                  <td>{formatUsd(session.costUsd)}</td>
                  <td>{formatDateTime(session.lastTimestamp)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}

function PageHeader({
  aside,
  icon: Icon,
  status,
  title,
}: {
  aside?: ReactNode;
  icon: LucideIcon;
  status: string;
  title: string;
}) {
  return (
    <header className="page-header">
      <div className="page-header-title">
        <div className="icon-frame">
          <Icon className="h-6 w-6" />
        </div>
        <div className="min-w-0">
          <h1 className="font-display text-[34px] leading-none text-ink md:text-[40px]">{title}</h1>
          <div className="mt-2 flex min-w-0 items-center gap-2">
            <span className="status-dot" />
            <span className="truncate text-xs font-medium uppercase leading-none tracking-widest text-muted-soft">
              {status}
            </span>
          </div>
        </div>
      </div>
      {aside ? <div className="page-header-aside">{aside}</div> : null}
    </header>
  );
}

function QuickStat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="quick-stat">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function Metric({ icon, label, value }: { icon: ReactNode; label: string; value: string | number }) {
  return (
    <div className="metric">
      <div className="metric-icon">{icon}</div>
      <div className="min-w-0">
        <div className="text-xs font-medium text-muted">{label}</div>
        <div className="mt-1 truncate text-xl font-semibold">{value}</div>
      </div>
    </div>
  );
}

function SectionHeading({ icon: Icon, label }: { icon: LucideIcon; label: string }) {
  return (
    <div className="section-heading">
      <Icon className="h-4 w-4" aria-hidden="true" />
      {label}
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-xs font-medium text-muted">{label}</div>
      <div className="mt-1 truncate text-sm font-medium text-ink" title={value}>
        {value}
      </div>
    </div>
  );
}

function Badge({ label, tone }: { label: string; tone: 'danger' | 'muted' | 'success' | 'warning' }) {
  return <span className={`badge badge-${tone}`}>{label}</span>;
}

function EmptyState({ label }: { label: string }) {
  return <div className="empty-state">{label}</div>;
}

function PageStack({ children }: { children: ReactNode }) {
  return <div className="space-y-5">{children}</div>;
}

function StatusBanner({ baseUrl, error, isConnected }: { baseUrl: string; error: string; isConnected: boolean }) {
  const likelyConnectionError = !isConnected || /failed to fetch|load failed|networkerror/i.test(error);
  const command = 'npx openclaude-studio';
  const [copiedCommand, setCopiedCommand] = useState(false);

  function copyCommand() {
    void window.navigator.clipboard?.writeText(command);
    setCopiedCommand(true);
  }

  return (
    <div aria-live="polite" className="status-banner mb-5" role="status">
      <div className="status-banner-icon">
        <AlertTriangle className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="status-banner-title">
          {likelyConnectionError ? 'Start the local OpenClaude Studio server' : 'Unable to load data'}
        </div>
        {likelyConnectionError ? (
          <>
            <p className="status-banner-copy">
              The hosted UI needs the local read-only API. Run this in a terminal, keep it open, then refresh.
            </p>
            <div className="status-banner-command" aria-label="Local server command">
              <Terminal className="h-3.5 w-3.5" aria-hidden="true" />
              <code>{command}</code>
              <button
                aria-label="Copy local server command"
                className="status-banner-command-copy"
                onClick={copyCommand}
                title="Copy command"
                type="button"
              >
                {copiedCommand ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              </button>
            </div>
          </>
        ) : (
          <p className="status-banner-copy">
            The local server is reachable, but the last request failed. Refresh the app or check the local server terminal
            for details.
          </p>
        )}
        <div className="status-banner-meta">
          <span>Expected API: {baseUrl}</span>
          <span title={error}>Last error: {error}</span>
        </div>
      </div>
    </div>
  );
}

function LogLine({ entry, style }: { entry: LogEntry; style?: CSSProperties }) {
  return (
    <div className={`log-line log-${entry.level}`} style={style}>
      <span className="tabular-nums text-code-panel-muted">{entry.timestamp?.slice(11, 23) ?? '--:--:--'}</span>
      <span className="tabular-nums text-code-panel-muted">{entry.lineNumber}</span>
      <span className="uppercase">[{entry.level}]</span>
      <span className="min-w-0 truncate">{entry.message}</span>
      <button
        aria-label="Copy log message"
        className="log-copy-button"
        onClick={(event) => {
          void window.navigator.clipboard?.writeText(entry.message);
          event.currentTarget.blur();
        }}
        title="Copy log message"
        type="button"
      >
        <Copy className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function MetaItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="meta-item">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function DiagnosticRow({ diagnostic }: { diagnostic: Diagnostic }) {
  return (
    <div className={`diagnostic-item diagnostic-${diagnostic.level}`}>
      <span className="diagnostic-level">{diagnostic.level}</span>
      <span
        className="diagnostic-body"
        title={diagnostic.path ? `${diagnostic.message} (${diagnostic.path})` : diagnostic.message}
      >
        <span className="truncate">{diagnostic.message}</span>
        {diagnostic.path ? <span className="diagnostic-path truncate">{diagnostic.path}</span> : null}
      </span>
    </div>
  );
}

function countDiagnostics(diagnostics: readonly Diagnostic[]): DiagnosticCounts {
  return diagnostics.reduce(
    (counts, diagnostic) => {
      if (diagnostic.level === 'error') {
        counts.errors += 1;
      } else if (diagnostic.level === 'warn') {
        counts.warnings += 1;
      }
      return counts;
    },
    { errors: 0, warnings: 0 },
  );
}

function getVirtualLogRange(input: {
  scrollTop: number;
  viewportHeight: number;
  rowHeight: number;
  totalRows: number;
  overscan: number;
  maxCount: number;
}) {
  const totalRows = Math.max(0, Math.floor(input.totalRows));
  const rowHeight = Math.max(1, input.rowHeight);
  const viewportHeight = Math.max(0, input.viewportHeight);
  const overscan = Math.max(0, Math.floor(input.overscan));
  const maxCount = Math.max(0, Math.floor(input.maxCount));
  const firstVisible = Math.min(totalRows, Math.max(0, Math.floor(Math.max(0, input.scrollTop) / rowHeight)));
  const visibleCount = Math.min(Math.max(0, totalRows - firstVisible), Math.ceil(viewportHeight / rowHeight));
  const start = Math.max(0, firstVisible - overscan);
  const requestedCount = Math.min(totalRows - start, visibleCount + overscan * 2);

  return {
    start,
    count: Math.min(maxCount, Math.max(0, requestedCount)),
  };
}

function isLogRangeCovered(loaded: { start: number; count: number }, requested: { start: number; count: number }): boolean {
  const loadedStart = Math.max(0, Math.floor(loaded.start));
  const requestedStart = Math.max(0, Math.floor(requested.start));
  const loadedEnd = loadedStart + Math.max(0, Math.floor(loaded.count));
  const requestedEnd = requestedStart + Math.max(0, Math.floor(requested.count));

  return loadedStart <= requestedStart && loadedEnd >= requestedEnd;
}

function resolveProjectId(projects: ProjectSummary[], requested: string | null | undefined): string | null {
  if (requested && projects.some((project) => project.id === requested)) {
    return requested;
  }
  return projects.find((project) => project.active)?.id ?? projects[0]?.id ?? null;
}

function logWindowInput(
  fileName: string | undefined,
  projectId: string | null,
  start: number,
  count: number,
  tail: boolean,
) {
  const input: { count: number; fileName?: string; projectId?: string; start?: number; tail?: boolean } = { count };
  if (tail) {
    input.tail = true;
  } else {
    input.start = start;
  }
  if (fileName) {
    input.fileName = fileName;
  }
  if (projectId) {
    input.projectId = projectId;
  }
  return input;
}

function logSearchInput(
  fileName: string | undefined,
  query: string,
  level: LogLevelFilter,
  projectId: string | null,
  start: number,
  count: number,
  tail: boolean,
) {
  const input: {
    count: number;
    fileName?: string;
    level?: string;
    projectId?: string;
    query: string;
    start?: number;
    tail?: boolean;
  } = { query, count };
  if (tail) {
    input.tail = true;
  } else {
    input.start = start;
  }
  if (fileName) {
    input.fileName = fileName;
  }
  if (level !== 'all') {
    input.level = level;
  }
  if (projectId) {
    input.projectId = projectId;
  }
  return input;
}

function collectDiagnostics(
  projectResponseDiagnostics: Diagnostic[],
  project: ProjectSummary | null,
  overview: OverviewResponse | null,
  logs: LogsWindowResponse | LogsSearchResponse | null,
): Diagnostic[] {
  const allDiagnostics = [
    ...projectResponseDiagnostics,
    ...(project?.diagnostics ?? []),
    ...(overview?.diagnostics ?? []),
    ...(logs?.diagnostics ?? []),
  ];
  const byKey = new Map<string, Diagnostic>();

  for (const diagnostic of allDiagnostics) {
    byKey.set(diagnosticKey(diagnostic), diagnostic);
  }

  return [...byKey.values()];
}

function diagnosticKey(diagnostic: Diagnostic): string {
  return `${diagnostic.level}:${diagnostic.message}:${diagnostic.path ?? ''}`;
}

function loadServerUrl(): string {
  const storage = safeStorage('localStorage');
  const value = storage?.getItem(serverUrlStorageKey);
  if (value) {
    return value;
  }

  const legacyConnection = readLegacyConnection(storage);
  if (legacyConnection.baseUrl) {
    storage?.setItem(serverUrlStorageKey, normalizeBaseUrl(legacyConnection.baseUrl));
    storage?.removeItem(legacyConnectionStorageKey);
    return legacyConnection.baseUrl;
  }

  return defaultServerUrl;
}

function saveServerUrl(baseUrl: string) {
  safeStorage('localStorage')?.setItem(serverUrlStorageKey, normalizeBaseUrl(baseUrl));
}

function loadActiveProjectId(): string | null {
  return safeStorage('localStorage')?.getItem(activeProjectStorageKey) ?? null;
}

function saveActiveProjectId(projectId: string | null) {
  const storage = safeStorage('localStorage');
  if (!storage) return;
  if (projectId) {
    storage.setItem(activeProjectStorageKey, projectId);
  } else {
    storage.removeItem(activeProjectStorageKey);
  }
}

function readLegacyConnection(storage: Storage | null): { baseUrl?: string } {
  if (!storage) {
    return {};
  }

  try {
    const parsed = JSON.parse(storage.getItem(legacyConnectionStorageKey) ?? '') as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && typeof (parsed as { baseUrl?: unknown }).baseUrl === 'string') {
      return { baseUrl: (parsed as { baseUrl: string }).baseUrl };
    }
  } catch {
    return {};
  }

  return {};
}

function readTheme(): Theme {
  const saved = safeStorage('localStorage')?.getItem('theme');
  return saved === 'dark' || saved === 'light' ? saved : 'light';
}

function safeStorage(name: 'localStorage' | 'sessionStorage'): Storage | null {
  try {
    return window[name];
  } catch {
    return null;
  }
}

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

function projectTokenTotal(project: ProjectSummary): number {
  return (
    project.usage.inputTokens +
    project.usage.outputTokens +
    project.usage.cacheReadTokens +
    project.usage.cacheWriteTokens
  );
}

function sessionTokenTotal(session: SessionSummary): number {
  return session.tokens.input + session.tokens.output + session.tokens.cacheRead + session.tokens.cacheWrite;
}

function logIssueCount(overview: OverviewResponse | null): number {
  if (!overview) return 0;
  return overview.cards.logWarningCount + overview.cards.logErrorCount;
}

function filterUsageSeries(
  series: OverviewResponse['usageSeries'],
  timeframe: UsageTimeframe,
): OverviewResponse['usageSeries'] {
  if (timeframe === 'all') {
    return series;
  }

  const count = timeframe === '7d' ? 7 : 14;
  const datedSeries = series.filter((point) => /^\d{4}-\d{2}-\d{2}$/.test(point.date));
  if (datedSeries.length !== series.length) {
    return series.slice(Math.max(0, series.length - count));
  }

  const latestDate = datedSeries.map((point) => point.date).sort().at(-1);
  if (!latestDate) {
    return [];
  }

  const byDate = new Map(datedSeries.map((point) => [point.date, point]));
  const start = addUtcDays(latestDate, -(count - 1));
  return Array.from({ length: count }, (_, index) => {
    const date = formatUtcDate(addUtcDays(start, index));
    return byDate.get(date) ?? emptyUsagePoint(date);
  });
}

function emptyUsagePoint(date: string): OverviewResponse['usageSeries'][number] {
  return {
    date,
    name: date.slice(5),
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    sessionCount: 0,
    sessionIds: [],
  };
}

function addUtcDays(date: string | Date, days: number) {
  const value = typeof date === 'string'
    ? new Date(`${date}T00:00:00.000Z`)
    : new Date(date.getTime());
  value.setUTCDate(value.getUTCDate() + days);
  return value;
}

function formatUtcDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

function buildUsageChartPlot(series: OverviewResponse['usageSeries'], metric: UsageMetric) {
  const left = usageChartPadding.left;
  const right = usageChartWidth - usageChartPadding.right;
  const top = usageChartPadding.top;
  const bottom = usageChartHeight - usageChartPadding.bottom;
  const values = series.map((point) => usageValue(point, metric));
  const hasData = values.some((value) => value > 0);
  const maxValue = Math.max(...values, 1);
  const plotWidth = right - left;
  const plotHeight = bottom - top;
  const points = series.map((point, index) => {
    const x = series.length === 1 ? left + plotWidth / 2 : left + (plotWidth * index) / Math.max(1, series.length - 1);
    const value = values[index] ?? 0;
    const y = bottom - (value / maxValue) * plotHeight;
    return {
      costUsd: point.costUsd,
      date: point.date,
      index,
      name: point.name,
      sessionCount: point.sessionCount,
      totalTokens: point.totalTokens,
      value,
      x,
      y,
    };
  });
  const linePath = points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' ');
  const areaPath = points.length > 0
    ? `${linePath} L ${points.at(-1)?.x ?? right} ${bottom} L ${points[0]?.x ?? left} ${bottom} Z`
    : '';

  return {
    areaPath,
    bottom,
    hasData,
    hitTargetWidth: Math.max(28, plotWidth / Math.max(1, series.length)),
    left,
    linePath,
    points,
    right,
    top,
    ticks: [1, 0.5, 0].map((ratio) => ({
      value: maxValue * ratio,
      y: bottom - ratio * plotHeight,
    })),
  };
}

function usageValue(point: OverviewResponse['usageSeries'][number], metric: UsageMetric): number {
  return metric === 'cost' ? point.costUsd : point.totalTokens;
}

function preferredUsageMetric(series: OverviewResponse['usageSeries']): UsageMetric {
  return hasUsageData(series, 'cost') ? 'cost' : 'tokens';
}

function hasUsageData(series: OverviewResponse['usageSeries'], metric: UsageMetric): boolean {
  return series.some((point) => usageValue(point, metric) > 0);
}

function usageChartLabelIndexes(length: number): number[] {
  if (length <= 0) {
    return [];
  }
  const indexes = new Set([0, Math.floor((length - 1) / 2), length - 1]);
  return [...indexes].sort((left, right) => left - right);
}

function formatUsageValue(value: number, metric: UsageMetric): string {
  return metric === 'cost' ? formatUsd(value) : `${formatCompactNumber(value)} tokens`;
}

function formatUsageAxisValue(value: number, metric: UsageMetric): string {
  return metric === 'cost' ? formatShortUsd(value) : formatCompactNumber(value);
}

function formatCompactNumber(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 1, notation: 'compact' }).format(value);
}

function formatShortUsd(value: number): string {
  if (value === 0) {
    return '$0';
  }
  if (value < 1) {
    return `$${value.toFixed(2)}`;
  }
  return new Intl.NumberFormat(undefined, {
    currency: 'USD',
    maximumFractionDigits: 1,
    notation: 'compact',
    style: 'currency',
  }).format(value);
}

function formatUsageTooltipDate(value: string): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat(undefined, {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
    year: 'numeric',
  }).format(date);
}

function usageTooltipAlignment(x: number): string {
  if (x < usageChartWidth * 0.25) {
    return 'usage-chart-tooltip-left';
  }
  if (x > usageChartWidth * 0.75) {
    return 'usage-chart-tooltip-right';
  }
  return 'usage-chart-tooltip-center';
}

function isActivePath(pathname: string, path: string) {
  return path === '/' ? pathname === '/' : pathname === path || pathname.startsWith(`${path}/`);
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat().format(value);
}

function formatUsd(value: number): string {
  return new Intl.NumberFormat(undefined, { currency: 'USD', style: 'currency' }).format(value);
}

function formatBytes(bytes: number): string {
  if (!bytes) {
    return '0 B';
  }
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, index);
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return 'unknown';
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}
