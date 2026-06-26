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
import { BrowserRouter, Link, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';

import { cn } from './lib/cn.js';
import {
  Activity,
  AlertTriangle,
  ArrowDownAZ,
  BarChart3,
  Check,
  ChevronDown,
  CircleDot,
  ClipboardList,
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
  Plus,
  RefreshCcw,
  Search,
  Server,
  ShieldCheck,
  Sun,
  Terminal,
  TerminalSquare,
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
  ProviderCredentialMode,
  ProviderCredentialState,
  ProviderCustomHeaderSummary,
  ProviderProfileField,
  ProviderProfileTemplate,
  ProviderProfileValidationIssue,
  ProviderProfilesResponse,
  ProjectSummary,
  SafeProviderProfile,
  SessionSummary,
  StartupProviderCredential,
  StartupProviderProfileSummary,
  StudioProviderAuthKind,
  StudioProviderCategory,
  StudioProviderDiscoveryMode,
  StudioProviderRecognition,
  StudioProviderTransport,
} from '@openclaude-studio/shared';

import { ApiRequestError, createApiClient, normalizeBaseUrl, type ApiClient } from './api';
import { SessionDetailsModal } from './components/SessionDetailsModal';
import { PlansTasksPage } from './components/PlansTasksPage';
import { BackgroundSessionsPage } from './components/BackgroundSessionsPage';
import { LoadingOverlay, LoadingSpinner } from './components/LoadingState';
import {
  Badge,
  EmptyState,
  PageHeader,
  PageStack,
  QuickStat,
  SectionHeading,
} from './components/shared';

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
type ProviderProfileDraft = {
  templateId: ProviderProfileTemplate['id'];
  id: string;
  name: string;
  provider: string;
  baseUrl: string;
  model: string;
  apiFormat: string;
  authHeader: string;
  authScheme: string;
  customHeadersText: string;
  makeActive: boolean;
};
type ProviderOption = {
  value: string;
  label: string;
  description?: string;
};
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
    name: 'Plans & Tasks',
    path: '/plans-tasks',
    group: 'overview',
    icon: ClipboardList,
  },
  {
    name: 'Providers',
    path: '/providers',
    group: 'global',
    icon: Server,
  },
  {
    name: 'Background',
    shortName: 'BG Sessions',
    path: '/background-sessions',
    group: 'maintenance',
    icon: TerminalSquare,
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
  const navigate = useNavigate();
  const [baseUrl, setBaseUrl] = useState(() => normalizeBaseUrl(loadServerUrl()));
  const [selectedProjectId, setSelectedProjectId] = useState(() => loadActiveProjectId());
  const [selectedLogFile, setSelectedLogFile] = useState<string | undefined>();
  const [logQuery, setLogQuery] = useState('');
  const [logLevel, setLogLevel] = useState<LogLevelFilter>('all');
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [backgroundSessionsRefreshToken, setBackgroundSessionsRefreshToken] = useState(0);
  const [status, setStatus] = useState<LoadState>('idle');
  const [loadingLabel, setLoadingLabel] = useState('Loading workspace');
  const [logRangeLoading, setLogRangeLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [health, setHealth] = useState<HealthState>(null);
  const [snapshot, setSnapshot] = useState<Snapshot>(emptySnapshot);
  const [plansTasksDiagnostics, setPlansTasksDiagnostics] = useState<Diagnostic[]>([]);
  const healthRequestIdRef = useRef(0);
  const workspaceRequestIdRef = useRef(0);
  const logsRequestIdRef = useRef(0);

  const api = useMemo(() => createApiClient({ baseUrl }), [baseUrl]);
  const selectedProject = snapshot.projects.find((project) => project.id === selectedProjectId) ?? null;
  const diagnostics = useMemo(
    () => mergeDiagnostics(snapshot.diagnostics, plansTasksDiagnostics),
    [snapshot.diagnostics, plansTasksDiagnostics],
  );
  const handlePlansTasksDiagnosticsChange = useCallback((nextDiagnostics: Diagnostic[]) => {
    setPlansTasksDiagnostics(nextDiagnostics);
  }, []);

  // When opening a linked background session that belongs to a different
  // project, the project change would normally trigger the
  // useEffect([selectedProjectId]) below and clear selectedSessionId before
  // the details modal can open. Track the pending session so the clear is
  // suppressed once, then applied on subsequent manual project changes.
  const pendingLinkedSessionRef = useRef<string | null>(null);

  function handleOpenBackgroundSession(projectId: string, sessionId: string) {
    pendingLinkedSessionRef.current = projectId === selectedProjectId ? null : sessionId;
    setSelectedProjectId(projectId);
    setSelectedSessionId(sessionId);
    void loadWorkspace({ projectId });
    void navigate('/sessions');
  }

  useEffect(() => {
    const preserveSelectedSession = pendingLinkedSessionRef.current !== null;
    if (preserveSelectedSession) {
      // This project change was triggered by the link handler; preserve the
      // intended session selection instead of clearing it.
      pendingLinkedSessionRef.current = null;
    } else {
      setSelectedSessionId(null);
    }
    setPlansTasksDiagnostics([]);
  }, [selectedProjectId]);

  async function refreshHealth() {
    const requestId = healthRequestIdRef.current + 1;
    healthRequestIdRef.current = requestId;

    try {
      const nextHealth = await api.health();
      if (requestId === healthRequestIdRef.current) {
        setHealth(nextHealth);
      }
    } catch {
      if (requestId === healthRequestIdRef.current) {
        setHealth({ status: 'error' });
      }
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
    setLoadingLabel(workspaceLoadingLabel(input, selectedProjectId, snapshot.projects.length > 0 || snapshot.overview !== null));
    setLogRangeLoading(false);
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
    setLogRangeLoading(true);
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
    } finally {
      if (requestId === logsRequestIdRef.current) {
        setLogRangeLoading(false);
      }
    }
  }

  function refreshWorkspace() {
    setBackgroundSessionsRefreshToken((value) => value + 1);
    void refreshHealth();
    void loadWorkspace();
  }

  function updateServerUrl(nextBaseUrl: string) {
    const normalizedBaseUrl = normalizeBaseUrl(nextBaseUrl);
    saveServerUrl(normalizedBaseUrl);

    if (normalizedBaseUrl === baseUrl) {
      refreshWorkspace();
      return;
    }

    healthRequestIdRef.current += 1;
    workspaceRequestIdRef.current += 1;
    logsRequestIdRef.current += 1;
    setHealth(null);
    setError(null);
    setLogRangeLoading(false);
    setSelectedLogFile(undefined);
    setSnapshot(emptySnapshot);
    setBaseUrl(normalizedBaseUrl);
  }

  useEffect(() => {
    void refreshHealth();
    void loadWorkspace();

    const interval = window.setInterval(() => {
      void refreshHealth();
    }, 30_000);

    return () => window.clearInterval(interval);
    // Initial load and base URL changes only; explicit refreshes own later state updates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseUrl]);

  return (
    <div className="min-h-screen bg-canvas text-ink md:flex">
      <Sidebar diagnostics={diagnostics} health={health} />
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
            refreshWorkspace();
          }}
        />
        <main className="mx-auto w-full max-w-[1420px] px-4 py-5 md:px-6 lg:px-8">
          {error ? (
            <StatusBanner
              baseUrl={baseUrl}
              error={error}
              isConnected={health?.status === 'ok'}
              onServerUrlChange={updateServerUrl}
            />
          ) : null}
          <Routes>
            <Route
              path="/"
              element={
                <ControlCenterPage
                  isLoading={status === 'loading'}
                  loadingLabel={loadingLabel}
                  overview={snapshot.overview}
                  project={selectedProject}
                  sessions={snapshot.sessions}
                />
              }
            />
            <Route
              path="/sessions"
              element={
                <SessionsPage
                  isLoading={status === 'loading'}
                  sessions={snapshot.sessions}
                  onSessionClick={setSelectedSessionId}
                />
              }
            />
            <Route
              path="/plans-tasks"
              element={selectedProjectId ? (
                <PlansTasksPage
                  api={api}
                  onDiagnosticsChange={handlePlansTasksDiagnosticsChange}
                  onOpenSession={setSelectedSessionId}
                  projectId={selectedProjectId}
                />
              ) : (
                <NoProjectSelectionPage isLoading={status === 'loading'} loadingLabel={loadingLabel} />
              )}
            />
            <Route
              path="/providers"
              element={
                <ProviderPage
                  api={api}
                  isWorkspaceLoading={status === 'loading'}
                  overview={snapshot.overview}
                  workspaceLoadingLabel={loadingLabel}
                />
              }
            />
            <Route
              path="/background-sessions"
              element={
                <BackgroundSessionsPage
                  api={api}
                  onOpenSession={handleOpenBackgroundSession}
                  refreshToken={backgroundSessionsRefreshToken}
                />
              }
            />
            <Route
              path="/logs"
              element={
                <LogsPage
                  isLoading={status === 'loading'}
                  isRangeLoading={logRangeLoading}
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
            <Route
              path="/diagnostics"
              element={
                <DiagnosticsPage
                  diagnostics={diagnostics}
                  isLoading={status === 'loading'}
                  loadingLabel={loadingLabel}
                />
              }
            />
            <Route path="*" element={<Navigate replace to="/" />} />
          </Routes>
        </main>
      </div>
      <SessionDetailsModal
        sessionId={selectedSessionId}
        projectId={selectedProjectId}
        isOpen={selectedSessionId !== null}
        onClose={() => setSelectedSessionId(null)}
        api={api}
      />
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
  const healthStatusLabel = connected
    ? ['Server connected', serverVersion].filter(Boolean).join(' ')
    : health === null
      ? 'Checking server'
      : 'Server disconnected';

  return (
    <header className="sticky top-0 z-40 flex h-16 shrink-0 items-center justify-between gap-3 border-b border-hairline bg-canvas px-4 md:px-6">
      <div className="flex min-w-0 flex-1 items-center">
        <ProjectSelector
          activeProject={selectedProject}
          activeProjectId={selectedProjectId}
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
          <RefreshCcw aria-hidden="true" className={cn('h-4 w-4', isLoading && 'animate-spin')} />
        </button>

        <div className="flex items-center gap-2 text-sm">
          {connected ? (
            <span aria-label={healthStatusLabel} className="flex items-center text-sm font-medium text-success" title={baseUrl}>
              <Activity className="h-4 w-4 sm:mr-1" />
              <span className="hidden sm:inline">Connected</span>
              {serverVersion ? <span className="ml-1 text-xs font-semibold tabular-nums">{serverVersion}</span> : null}
            </span>
          ) : health === null ? (
            <span aria-label={healthStatusLabel} className="flex items-center text-sm font-medium text-muted" title={baseUrl}>
              <LoadingSpinner className="sm:mr-1" decorative label="Checking server" size="sm" />
              <span className="hidden sm:inline">Checking</span>
            </span>
          ) : (
            <span aria-label={healthStatusLabel} className="flex items-center text-sm font-medium text-error" title={baseUrl}>
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
  onSelect,
  projects,
}: {
  activeProject: ProjectSummary | null;
  activeProjectId: string | null;
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
          {activeProject?.name ?? 'No projects loaded'}
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
  loadingLabel,
  overview,
  project,
  sessions,
}: {
  isLoading: boolean;
  loadingLabel: string;
  overview: OverviewResponse | null;
  project: ProjectSummary | null;
  sessions: SessionSummary[];
}) {
  const usageSeries: OverviewResponse['usageSeries'] = Array.isArray(overview?.usageSeries)
    ? overview.usageSeries
    : [];
  const initialLoading = isLoading && !project && !overview;

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

      <div aria-busy={isLoading} className="control-center-content loading-boundary">
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
              {overview ? <Badge label={`${formatNumber(usageSeries.length)} usage days`} tone="muted" /> : null}
            </div>
            {project && overview ? (
              <div className="project-overview-content">
                <UsageOverviewChart series={usageSeries} />
                <div className="project-overview-facts">
                  <Info label="Path" value={project.path} />
                  <Info label="Branch" value={project.branch || 'no branch'} />
                  <Info label="Changed files" value={String(overview.cards.changedFileCount)} />
                  <Info label="Failed sessions" value={String(overview.cards.failedSessionCount)} />
                </div>
              </div>
            ) : (
              initialLoading ? <div aria-hidden="true" className="section-loading-placeholder" /> : <EmptyState label="No project selected" />
            )}
          </section>

          <ProviderSummaryCard overview={overview} />
        </div>

        <SessionsTable sessions={sessions.slice(0, 8)} title="Recent Sessions" />
        {isLoading ? <LoadingOverlay label={loadingLabel} /> : null}
      </div>
    </PageStack>
  );
}

function SessionsPage({
  isLoading,
  sessions,
  onSessionClick,
}: {
  isLoading: boolean;
  sessions: SessionSummary[];
  onSessionClick: (id: string) => void;
}) {
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
      <SessionsTable isLoading={isLoading} loadingLabel="Loading sessions" sessions={sessions} title="Sessions" onSessionClick={onSessionClick} />
    </PageStack>
  );
}

function ProviderPage({
  api,
  isWorkspaceLoading,
  overview,
  workspaceLoadingLabel,
}: {
  api: ApiClient;
  isWorkspaceLoading: boolean;
  overview: OverviewResponse | null;
  workspaceLoadingLabel: string;
}) {
  const provider = overview?.provider;
  const [profiles, setProfiles] = useState<ProviderProfilesResponse | null>(null);
  const [loadState, setLoadState] = useState<LoadState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [isProfileModalOpen, setIsProfileModalOpen] = useState(false);
  const [selectedTemplateId, setSelectedTemplateId] = useState<ProviderProfileTemplate['id'] | null>(null);
  const [draft, setDraft] = useState<ProviderProfileDraft | null>(null);
  const [copiedProviderArtifact, setCopiedProviderArtifact] = useState<'command' | 'json' | null>(null);
  const [copiedProfileCommandId, setCopiedProfileCommandId] = useState<string | null>(null);
  const requestIdRef = useRef(0);
  const copyResetTimerRef = useRef<number | null>(null);
  const profileCommandCopyResetTimerRef = useRef<number | null>(null);
  const selectedTemplate = useMemo(
    () => profiles?.templates.find((template) => template.id === selectedTemplateId) ?? profiles?.templates[0] ?? null,
    [profiles, selectedTemplateId],
  );

  const loadProfiles = useCallback(async () => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setLoadState('loading');
    setError(null);

    try {
      const response = normalizeProviderProfilesResponse(await api.providerProfiles());
      if (requestId !== requestIdRef.current) {
        return;
      }
      setProfiles(response);
      setSelectedTemplateId((current) =>
        current && response.templates.some((template) => template.id === current)
          ? current
          : response.templates[0]?.id ?? null,
      );
      setLoadState('ready');
    } catch (caught) {
      if (requestId !== requestIdRef.current) {
        return;
      }
      setProfiles(null);
      setIsProfileModalOpen(false);
      setDraft(null);
      setLoadState('error');
      if (caught instanceof ApiRequestError && caught.status === 404) {
        setError('Provider profile management requires a newer local server');
      } else {
        setError(caught instanceof Error ? caught.message : 'Unable to load provider profiles.');
      }
    }
  }, [api]);

  useEffect(() => {
    void loadProfiles();
  }, [loadProfiles]);

  useEffect(() => () => {
    if (copyResetTimerRef.current !== null) {
      window.clearTimeout(copyResetTimerRef.current);
    }
    if (profileCommandCopyResetTimerRef.current !== null) {
      window.clearTimeout(profileCommandCopyResetTimerRef.current);
    }
  }, []);

  const closeProfileModal = useCallback(() => {
    setIsProfileModalOpen(false);
  }, []);

  function openAddProfile(template = selectedTemplate) {
    if (!template) return;
    setSelectedTemplateId(template.id);
    setDraft(createProviderProfileDraft(template));
    setCopiedProviderArtifact(null);
    setIsProfileModalOpen(true);
  }

  function selectTemplate(template: ProviderProfileTemplate) {
    setSelectedTemplateId(template.id);
    setDraft(createProviderProfileDraft(template));
    setCopiedProviderArtifact(null);
  }

  function updateDraft(patch: Partial<ProviderProfileDraft>) {
    setDraft((current) => current ? { ...current, ...patch } : current);
  }

  function markProviderArtifactCopied(artifact: 'command' | 'json') {
    setCopiedProviderArtifact(artifact);
    if (copyResetTimerRef.current !== null) {
      window.clearTimeout(copyResetTimerRef.current);
    }
    copyResetTimerRef.current = window.setTimeout(() => {
      setCopiedProviderArtifact((current) => (current === artifact ? null : current));
      copyResetTimerRef.current = null;
    }, 1400);
  }

  function copyDraftCommand() {
    if (!draft) return;
    void window.navigator.clipboard?.writeText(providerLaunchCommand(draft));
    markProviderArtifactCopied('command');
  }

  function copyDraftJson() {
    if (!draft) return;
    void window.navigator.clipboard?.writeText(providerTemplateSnippet(draft));
    markProviderArtifactCopied('json');
  }

  function copyProfileCommand(profile: SafeProviderProfile) {
    void window.navigator.clipboard?.writeText(providerProfileLaunchCommand(profile));
    setCopiedProfileCommandId(profile.id);
    if (profileCommandCopyResetTimerRef.current !== null) {
      window.clearTimeout(profileCommandCopyResetTimerRef.current);
    }
    profileCommandCopyResetTimerRef.current = window.setTimeout(() => {
      setCopiedProfileCommandId((current) => (current === profile.id ? null : current));
      profileCommandCopyResetTimerRef.current = null;
    }, 1400);
  }

  const isProviderProfilesLoading = loadState === 'loading';
  const isPageLoading = isProviderProfilesLoading || isWorkspaceLoading;
  const pageLoadingLabel = isProviderProfilesLoading ? 'Loading provider profiles' : workspaceLoadingLabel;

  return (
    <PageStack>
      <PageHeader
        icon={Server}
        status={providerPageStatus(provider, profiles, loadState)}
        title="Providers"
        aside={profiles ? (
          <div className="page-header-stats">
            <QuickStat label="Profiles" value={profiles.summary.total} />
            <QuickStat label="Review" value={profiles.summary.warnings + profiles.summary.errors} />
            <QuickStat label="Templates" value={profiles.summary.templates} />
          </div>
        ) : undefined}
      />

      <section aria-busy={isPageLoading} className="panel loading-boundary">
        <div className="section-heading-row">
          <SectionHeading icon={ShieldCheck} label="Provider Profiles" />
          <div className="flex flex-wrap items-center justify-end gap-2">
            {profiles ? <Badge label={formatCount(profiles.summary.total, 'profile')} tone="muted" /> : null}
            {profiles ? <Badge label={formatCount(profiles.summary.templates, 'template')} tone="muted" /> : null}
            {profiles ? <Badge label={profiles.exists ? 'config found' : 'config missing'} tone={profiles.exists ? 'success' : 'warning'} /> : null}
          </div>
        </div>
        {error && loadState !== 'loading' ? (
          <div className="mt-5 rounded-lg border border-warning/25 bg-warning/[0.08] p-4">
            <div className="flex items-start gap-3">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
              <div className="min-w-0">
                <p className="text-sm font-semibold text-ink">{error}</p>
                <p className="mt-1 text-sm text-muted">The active provider summary is still available from the older overview response.</p>
                {provider ? (
                  <div className="mt-4 border-t border-warning/20 pt-4">
                    <SectionHeading icon={KeyRound} label="Active Provider" />
                    <div className="mt-3 grid gap-3 sm:grid-cols-3">
                      <Info label="Name" value={provider.name} />
                      <Info label="Model" value={provider.model} />
                      <Info label="Base URL" value={provider.baseUrl ?? 'default'} />
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        ) : profiles ? (
          <ProviderProfilesPanel
            copiedProfileCommandId={copiedProfileCommandId}
            onAddProfile={() => openAddProfile()}
            onCopyCommand={copyProfileCommand}
            response={profiles}
          />
        ) : loadState === 'loading' ? (
          <div aria-hidden="true" className="section-loading-placeholder provider-profiles-loading-placeholder" />
        ) : (
          <EmptyState label="No provider profile data loaded" />
        )}
        {isPageLoading ? <LoadingOverlay label={pageLoadingLabel} /> : null}
      </section>

      {profiles && selectedTemplate && draft && isProfileModalOpen ? (
        <ProviderProfileTemplateModal
          commandCopied={copiedProviderArtifact === 'command'}
          jsonCopied={copiedProviderArtifact === 'json'}
          draft={draft}
          onClose={closeProfileModal}
          onCopyCommand={copyDraftCommand}
          onCopyJson={copyDraftJson}
          onDraftChange={updateDraft}
          onSelectTemplate={selectTemplate}
          selectedTemplate={selectedTemplate}
          templates={profiles.templates}
        />
      ) : null}
    </PageStack>
  );
}

function normalizeProviderProfilesResponse(response: unknown): ProviderProfilesResponse {
  const payload = isRecord(response) ? response : {};
  const profiles = Array.isArray(payload.profiles)
    ? payload.profiles.map((profile, index) => normalizeSafeProviderProfile(profile, index))
    : [];
  const templates = Array.isArray(payload.templates)
    ? payload.templates.map((template) => normalizeProviderProfileTemplate(template))
    : [];
  const diagnostics = Array.isArray(payload.diagnostics)
    ? payload.diagnostics.map(normalizeDiagnostic)
    : [];
  const startupProfile = normalizeStartupProviderProfile(payload.startupProfile);
  const summary: Record<string, unknown> = isRecord(payload.summary) ? payload.summary : {};
  const warningCount = profiles.filter((profile) => profile.validation?.status === 'warning').length;
  const errorCount = profiles.filter((profile) => profile.validation?.status === 'error').length;
  const recognizedCount = profiles.filter((profile) => profile.recognizedProvider.id !== 'custom').length;

  return {
    path: stringOrFallback(payload.path, ''),
    exists: payload.exists === true,
    activeProviderProfileId: stringOrNull(payload.activeProviderProfileId),
    sensitiveFieldsRedacted: true,
    profiles,
    startupProfile,
    templates,
    summary: {
      total: finiteNumberOr(summary.total, profiles.length),
      active: finiteNumberOr(summary.active, profiles.filter((profile) => profile.active).length),
      valid: finiteNumberOr(summary.valid, profiles.filter((profile) => profile.validation?.status === 'valid').length),
      warnings: finiteNumberOr(summary.warnings, warningCount),
      errors: finiteNumberOr(summary.errors, errorCount),
      recognized: finiteNumberOr(summary.recognized, recognizedCount),
      startupProfileConfigured: typeof summary.startupProfileConfigured === 'boolean'
        ? summary.startupProfileConfigured
        : startupProfile.exists,
      templates: finiteNumberOr(summary.templates, templates.length),
    },
    diagnostics,
  };
}

const providerTemplateCategories: ReadonlyArray<ProviderProfileTemplate['category']> = [
  'hosted',
  'local',
  'subscription',
  'custom',
];
const providerProfileFields: readonly ProviderProfileField[] = [
  'id',
  'name',
  'provider',
  'baseUrl',
  'model',
  'credential',
  'apiFormat',
  'authHeader',
  'authScheme',
  'customHeaders',
  'activeProviderProfileId',
];
const validationSeverities: ReadonlyArray<ProviderProfileValidationIssue['severity']> = ['info', 'warn', 'error'];
const studioProviderCategories: ReadonlyArray<StudioProviderCategory> = [
  'hosted',
  'local',
  'aggregating',
  'subscription',
  'cloud',
  'custom',
  'unknown',
];
const studioProviderAuthKinds: ReadonlyArray<StudioProviderAuthKind> = [
  'api-key',
  'oauth',
  'token',
  'adc',
  'none',
  'unknown',
];
const studioProviderTransports: ReadonlyArray<StudioProviderTransport> = [
  'anthropic-native',
  'anthropic-proxy',
  'openai-compatible',
  'local',
  'gemini-native',
  'bedrock',
  'vertex',
  'foundry',
  'unknown',
];
const studioProviderDiscoveryModes: ReadonlyArray<StudioProviderDiscoveryMode> = [
  'static',
  'dynamic',
  'hybrid',
  'local',
  'unknown',
];
const providerCredentialModes: ReadonlyArray<ProviderCredentialMode> = ['none', 'single', 'pool', 'unknown'];

function normalizeSafeProviderProfile(input: unknown, index: number): SafeProviderProfile {
  const profile = isRecord(input) ? input : {};
  const validation = isRecord(profile.validation) ? profile.validation : {};
  const validationIssues = Array.isArray(validation.issues)
    ? validation.issues.map(normalizeProviderProfileValidationIssue)
    : [];
  const apiKeySet = profile.apiKeySet === true;
  const authHeaderValueSet = profile.authHeaderValueSet === true;
  const legacyCredentialFallback: ProviderCredentialState | undefined = apiKeySet || authHeaderValueSet
    ? {
        credentialMode: 'single',
        credentialCount: 1,
        credentialConfigured: true,
        credentialInvalid: false,
        credentialSources: [],
      }
    : undefined;

  return {
    id: stringOrFallback(profile.id, `provider_${index + 1}`),
    name: stringOrFallback(profile.name, 'Unnamed provider'),
    provider: stringOrFallback(profile.provider, 'openai'),
    model: stringOrFallback(profile.model, ''),
    baseUrl: stringOrNull(profile.baseUrl),
    active: profile.active === true,
    apiKeySet,
    authHeaderValueSet,
    apiFormat: stringOrNull(profile.apiFormat),
    authHeader: stringOrNull(profile.authHeader),
    authScheme: stringOrNull(profile.authScheme),
    customHeaders: Array.isArray(profile.customHeaders)
      ? profile.customHeaders.map(normalizeProviderCustomHeader).filter((header) => header.name.length > 0)
      : [],
    recognizedProvider: normalizeStudioProviderRecognition(profile.recognizedProvider, {
      ...defaultStudioProviderRecognition(),
      label: stringOrFallback(profile.templateLabel, 'Custom OpenAI-compatible'),
    }),
    credential: normalizeProviderCredentialState(profile.credential, legacyCredentialFallback),
    templateId: providerTemplateIdOr(profile.templateId, 'custom-openai'),
    templateLabel: stringOrFallback(profile.templateLabel, 'Custom OpenAI-compatible'),
    validation: {
      status: providerValidationStatusOr(validation.status, 'valid'),
      issues: validationIssues,
    },
  };
}

function normalizeStartupProviderProfile(input: unknown): StartupProviderProfileSummary {
  const profile = isRecord(input) ? input : {};

  return {
    path: stringOrFallback(profile.path, ''),
    exists: profile.exists === true,
    profile: stringOrNull(profile.profile),
    createdAt: stringOrNull(profile.createdAt),
    configuredNonSecretFields: stringArrayOrEmpty(profile.configuredNonSecretFields),
    credentials: Array.isArray(profile.credentials)
      ? profile.credentials.map(normalizeStartupProviderCredential).filter((credential) => credential.name.length > 0)
      : [],
    credential: normalizeProviderCredentialState(profile.credential),
    recognizedProvider: normalizeStudioProviderRecognition(profile.recognizedProvider),
    diagnostics: Array.isArray(profile.diagnostics) ? profile.diagnostics.map(normalizeDiagnostic) : [],
  };
}

function normalizeStartupProviderCredential(input: unknown): StartupProviderCredential {
  const credential = isRecord(input) ? input : {};

  return {
    name: stringOrFallback(credential.name, ''),
    configured: credential.configured === true,
  };
}

function normalizeStudioProviderRecognition(
  input: unknown,
  fallback: StudioProviderRecognition = defaultStudioProviderRecognition(),
): StudioProviderRecognition {
  const provider = isRecord(input) ? input : {};
  const id = stringOrFallback(provider.id, fallback.id).trim();

  return {
    id: id.length > 0 ? id : fallback.id,
    label: stringOrFallback(provider.label, fallback.label),
    category: studioProviderCategoryOr(provider.category, fallback.category),
    defaultBaseUrl: stringOrNull(provider.defaultBaseUrl),
    authKind: studioProviderAuthKindOr(provider.authKind, fallback.authKind),
    credentialEnvVars: stringArrayOrEmpty(provider.credentialEnvVars),
    transport: studioProviderTransportOr(provider.transport, fallback.transport),
    discoveryMode: studioProviderDiscoveryModeOr(provider.discoveryMode, fallback.discoveryMode),
    safeTemplateAvailable: provider.safeTemplateAvailable === true,
    inspectionOnly: provider.inspectionOnly === true,
  };
}

function defaultStudioProviderRecognition(): StudioProviderRecognition {
  return {
    id: 'custom',
    label: 'Custom OpenAI-compatible',
    category: 'custom',
    defaultBaseUrl: null,
    authKind: 'unknown',
    credentialEnvVars: [],
    transport: 'openai-compatible',
    discoveryMode: 'unknown',
    safeTemplateAvailable: false,
    inspectionOnly: false,
  };
}

function normalizeProviderCredentialState(input: unknown, fallback?: ProviderCredentialState): ProviderCredentialState {
  const credential = isRecord(input) ? input : {};

  return {
    credentialMode: providerCredentialModeOr(credential.credentialMode, fallback?.credentialMode ?? 'unknown'),
    credentialCount: typeof credential.credentialCount === 'number' && Number.isFinite(credential.credentialCount)
      ? Math.max(0, Math.trunc(credential.credentialCount))
      : fallback?.credentialCount ?? null,
    credentialConfigured: typeof credential.credentialConfigured === 'boolean'
      ? credential.credentialConfigured
      : fallback?.credentialConfigured ?? false,
    credentialInvalid: typeof credential.credentialInvalid === 'boolean'
      ? credential.credentialInvalid
      : fallback?.credentialInvalid ?? false,
    credentialSources: Array.isArray(credential.credentialSources)
      ? stringArrayOrEmpty(credential.credentialSources)
      : fallback?.credentialSources ?? [],
  };
}

function normalizeProviderProfileTemplate(input: unknown): ProviderProfileTemplate {
  const template = isRecord(input) ? input : {};

  return {
    id: providerTemplateIdOr(template.id, 'custom-openai'),
    label: stringOrFallback(template.label, 'Custom OpenAI-compatible'),
    category: providerTemplateCategoryOr(template.category, 'custom'),
    description: stringOrFallback(template.description, 'Custom provider profile template.'),
    provider: stringOrFallback(template.provider, 'openai'),
    baseUrl: stringOrFallback(template.baseUrl, ''),
    model: stringOrFallback(template.model, ''),
    modelPlaceholder: stringOrFallback(template.modelPlaceholder, 'Model id'),
    requiresSecret: template.requiresSecret === true,
    requiredFields: providerProfileFieldArrayOrEmpty(template.requiredFields),
    advancedFields: providerProfileFieldArrayOrEmpty(template.advancedFields),
    apiFormat: providerApiFormatOrNull(template.apiFormat),
    authHeader: stringOrNull(template.authHeader),
    authScheme: providerAuthSchemeOrNull(template.authScheme),
    customHeaders: Array.isArray(template.customHeaders)
      ? template.customHeaders.map(normalizeTemplateCustomHeader).filter((header) => header.name.length > 0)
      : [],
    credential: normalizeProviderTemplateCredential(template.credential),
  };
}

function normalizeProviderCustomHeader(input: unknown): ProviderCustomHeaderSummary {
  const header = isRecord(input) ? input : {};
  return {
    name: stringOrFallback(header.name, ''),
    valueSet: header.valueSet === true,
    sensitive: header.sensitive === true,
  };
}

function normalizeTemplateCustomHeader(input: unknown): { name: string; value: string } {
  const header = isRecord(input) ? input : {};
  return {
    name: stringOrFallback(header.name, ''),
    value: stringOrFallback(header.value, ''),
  };
}

function normalizeProviderProfileValidationIssue(input: unknown): ProviderProfileValidationIssue {
  const issue = isRecord(input) ? input : {};
  const field = providerProfileFieldOrNull(issue.field);
  return {
    severity: validationSeverityOr(issue.severity, 'warn'),
    ...(field ? { field } : {}),
    message: stringOrFallback(issue.message, 'Provider profile validation issue.'),
  };
}

function normalizeProviderTemplateCredential(input: unknown): ProviderProfileTemplate['credential'] {
  if (!isRecord(input)) {
    return null;
  }

  return {
    label: stringOrFallback(input.label, 'Provider credential'),
    envVar: stringOrFallback(input.envVar, 'OPENAI_API_KEY'),
    placeholder: stringOrFallback(input.placeholder, 'Set outside Studio before using this profile'),
  };
}

function normalizeDiagnostic(input: unknown): Diagnostic {
  const diagnostic = isRecord(input) ? input : {};
  return {
    level: diagnostic.level === 'error' || diagnostic.level === 'warn' ? diagnostic.level : 'info',
    message: stringOrFallback(diagnostic.message, 'Provider profile diagnostic.'),
    ...(typeof diagnostic.path === 'string' ? { path: diagnostic.path } : {}),
  };
}

function finiteNumberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function stringArrayOrEmpty(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
}

function stringOrFallback(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function providerTemplateIdOr(value: unknown, fallback: ProviderProfileTemplate['id']): ProviderProfileTemplate['id'] {
  return typeof value === 'string' && value.trim().length > 0 ? value as ProviderProfileTemplate['id'] : fallback;
}

function providerTemplateCategoryOr(
  value: unknown,
  fallback: ProviderProfileTemplate['category'],
): ProviderProfileTemplate['category'] {
  return providerTemplateCategories.includes(value as ProviderProfileTemplate['category'])
    ? value as ProviderProfileTemplate['category']
    : fallback;
}

function providerApiFormatOrNull(value: unknown): ProviderProfileTemplate['apiFormat'] {
  return value === 'responses' || value === 'chat_completions' ? value : null;
}

function providerAuthSchemeOrNull(value: unknown): ProviderProfileTemplate['authScheme'] {
  return value === 'bearer' || value === 'raw' ? value : null;
}

function providerValidationStatusOr(
  value: unknown,
  fallback: SafeProviderProfile['validation']['status'],
): SafeProviderProfile['validation']['status'] {
  return value === 'error' || value === 'warning' || value === 'valid' ? value : fallback;
}

function validationSeverityOr(
  value: unknown,
  fallback: ProviderProfileValidationIssue['severity'],
): ProviderProfileValidationIssue['severity'] {
  return validationSeverities.includes(value as ProviderProfileValidationIssue['severity'])
    ? value as ProviderProfileValidationIssue['severity']
    : fallback;
}

function studioProviderCategoryOr(value: unknown, fallback: StudioProviderCategory): StudioProviderCategory {
  return studioProviderCategories.includes(value as StudioProviderCategory)
    ? value as StudioProviderCategory
    : fallback;
}

function studioProviderAuthKindOr(value: unknown, fallback: StudioProviderAuthKind): StudioProviderAuthKind {
  return studioProviderAuthKinds.includes(value as StudioProviderAuthKind)
    ? value as StudioProviderAuthKind
    : fallback;
}

function studioProviderTransportOr(value: unknown, fallback: StudioProviderTransport): StudioProviderTransport {
  return studioProviderTransports.includes(value as StudioProviderTransport)
    ? value as StudioProviderTransport
    : fallback;
}

function studioProviderDiscoveryModeOr(
  value: unknown,
  fallback: StudioProviderDiscoveryMode,
): StudioProviderDiscoveryMode {
  return studioProviderDiscoveryModes.includes(value as StudioProviderDiscoveryMode)
    ? value as StudioProviderDiscoveryMode
    : fallback;
}

function providerCredentialModeOr(value: unknown, fallback: ProviderCredentialMode): ProviderCredentialMode {
  return providerCredentialModes.includes(value as ProviderCredentialMode)
    ? value as ProviderCredentialMode
    : fallback;
}

function providerProfileFieldOrNull(value: unknown): ProviderProfileField | null {
  return providerProfileFields.includes(value as ProviderProfileField) ? value as ProviderProfileField : null;
}

function providerProfileFieldArrayOrEmpty(value: unknown): ProviderProfileField[] {
  return Array.isArray(value)
    ? value.map(providerProfileFieldOrNull).filter((field): field is ProviderProfileField => field !== null)
    : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function ProviderProfilesPanel({
  copiedProfileCommandId,
  onAddProfile,
  onCopyCommand,
  response,
}: {
  copiedProfileCommandId: string | null;
  onAddProfile: () => void;
  onCopyCommand: (profile: SafeProviderProfile) => void;
  response: ProviderProfilesResponse;
}) {
  return (
    <div className="mt-5 space-y-5">
      {response.diagnostics.length > 0 ? (
        <div className="space-y-2">
          {response.diagnostics.map((diagnostic, index) => (
            <DiagnosticNotice diagnostic={diagnostic} key={`${diagnostic.level}-${index}`} />
          ))}
        </div>
      ) : null}
      {response.startupProfile.exists || response.startupProfile.diagnostics.length > 0 ? (
        <StartupProviderProfilePanel startupProfile={response.startupProfile} />
      ) : null}
      <div className="grid items-stretch gap-4 lg:grid-cols-2 2xl:grid-cols-3">
        {response.profiles.length === 0 ? (
          <div className="flex min-h-[260px] flex-col items-center justify-center rounded-lg border border-dashed border-hairline-soft bg-canvas px-5 py-8 text-center lg:col-span-2 2xl:col-span-2">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-hairline-soft bg-surface-soft text-primary">
              <ShieldCheck className="h-4 w-4" />
            </div>
            <p className="mt-3 text-sm font-semibold text-ink">No provider profiles configured</p>
            <p className="mt-1 max-w-md text-sm text-muted">Choose a safe template to generate a read-only profile snippet and launch command.</p>
          </div>
        ) : null}
        {response.profiles.map((profile, index) => (
          <ProviderProfileCard
            copied={copiedProfileCommandId === profile.id}
            key={`${profile.id}-${index}`}
            onCopyCommand={() => onCopyCommand(profile)}
            profile={profile}
          />
        ))}
        {response.templates.length > 0 ? (
          <button
            aria-label="Add provider profile"
            className="group flex min-h-[260px] flex-col items-center justify-center rounded-lg border border-dashed border-hairline-soft bg-surface-soft/45 px-5 py-8 text-center transition-colors hover:border-primary/40 hover:bg-surface-soft focus:outline-none focus:ring-[3px] focus:ring-primary/15"
            onClick={onAddProfile}
            type="button"
          >
            <span className="flex h-11 w-11 items-center justify-center rounded-lg border border-hairline-soft bg-canvas text-primary transition-colors group-hover:border-primary/40">
              <Plus className="h-5 w-5" />
            </span>
            <span className="mt-3 text-sm font-semibold text-ink">Add provider profile</span>
            <span className="mt-1 max-w-[260px] text-sm leading-relaxed text-muted">
              Select a template, validate safe fields, then copy JSON or an OpenClaude command.
            </span>
          </button>
        ) : null}
      </div>
    </div>
  );
}

function ProviderProfileCard({
  copied,
  onCopyCommand,
  profile,
}: {
  copied: boolean;
  onCopyCommand: () => void;
  profile: SafeProviderProfile;
}) {
  const statusTone = profile.validation.status === 'error'
    ? 'danger'
    : profile.validation.status === 'warning'
      ? 'warning'
      : 'success';
  const command = providerProfileLaunchCommand(profile);

  return (
    <article className="flex min-h-[260px] flex-col rounded-lg border border-hairline-soft bg-canvas p-4 shadow-[0_1px_0_rgb(0_0_0/0.03)]">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border bg-surface-soft', profile.active ? 'border-success/20 text-success' : 'border-hairline-soft text-muted')}>
            <CircleDot className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold text-ink">{profile.name}</h2>
            <p className="mt-1 truncate font-mono text-xs text-muted" title={`${profile.provider} / ${profile.model}`}>
              {profile.provider} / {profile.model}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-2">
          {profile.active ? <Badge label="active" tone="success" /> : null}
          {profile.recognizedProvider.inspectionOnly ? <Badge label="inspection only" tone="warning" /> : null}
          <Badge label={validationStatusLabel(profile.validation.status)} tone={statusTone} />
        </div>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <Info label="Provider" value={profile.recognizedProvider.label} />
        <Info label="Route" value={providerRouteLabel(profile.recognizedProvider)} />
        <Info label="Discovery" value={providerDiscoveryLabel(profile.recognizedProvider.discoveryMode)} />
        {profile.templateLabel !== profile.recognizedProvider.label ? (
          <Info label="Template" value={profile.templateLabel} />
        ) : null}
        <Info label="Base URL" value={profile.baseUrl ?? 'default'} />
        <Info label="API format" value={profile.apiFormat ?? 'provider default'} />
        <Info label="Auth header" value={profile.authHeader ?? 'provider default'} />
      </div>

      {profile.customHeaders.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {profile.customHeaders.map((header) => (
            <span
              className="rounded-md border border-hairline-soft bg-surface-soft px-2 py-1 font-mono text-xs text-muted"
              key={header.name}
              title={header.sensitive ? `${header.name}: redacted` : `${header.name}: set`}
            >
              {header.name}
            </span>
          ))}
        </div>
      ) : null}

      {profile.validation.issues.length > 0 ? (
        <div className="mt-3 space-y-2">
          {profile.validation.issues.map((issue, index) => (
            <div className="flex items-start gap-2 text-sm text-muted" key={`${issue.field ?? 'profile'}-${index}`}>
              {issue.severity === 'error' ? (
                <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-error" />
              ) : (
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
              )}
              <span>{issue.message}</span>
            </div>
          ))}
        </div>
      ) : null}

      <div className="mt-4 flex flex-wrap gap-2">
        <Badge label={providerCredentialLabel(profile.credential)} tone={providerCredentialTone(profile.credential)} />
        {profile.credential.credentialSources.map((source) => (
          <span
            className="rounded-md border border-hairline-soft bg-surface-soft px-2 py-1 text-xs text-muted"
            key={source}
          >
            {source}
          </span>
        ))}
      </div>

      <div className="mt-auto pt-4">
        <div className="flex min-w-0 items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-xs font-medium text-muted">OpenClaude command</div>
            <div className="mt-1 truncate font-mono text-[11px] text-muted-soft" title={profile.id}>{profile.id}</div>
          </div>
          <button
            aria-label={`Copy OpenClaude command for ${profile.name}`}
            className="secondary-button min-h-8 shrink-0 px-2.5 py-1 text-xs"
            onClick={onCopyCommand}
            type="button"
          >
            <Copy className="h-3.5 w-3.5" />
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
        <textarea
          aria-label={`OpenClaude command for ${profile.name}`}
          className="mt-2 min-h-[64px] w-full resize-none rounded-md border border-hairline bg-surface-soft px-3 py-2 font-mono text-xs leading-relaxed text-ink outline-none transition-colors focus:border-primary/50 focus:ring-[3px] focus:ring-primary/15"
          onFocus={(event) => event.currentTarget.select()}
          readOnly
          rows={3}
          value={command}
        />
      </div>
    </article>
  );
}

function StartupProviderProfilePanel({ startupProfile }: { startupProfile: StartupProviderProfileSummary }) {
  return (
    <section className="rounded-lg border border-hairline-soft bg-canvas p-4 shadow-[0_1px_0_rgb(0_0_0/0.03)]">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <SectionHeading icon={KeyRound} label="Startup Launch Profile" />
          <p className="mt-2 truncate text-sm text-muted" title={startupProfile.path}>
            {startupProfile.exists ? startupProfile.path : 'No startup launch profile detected'}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          {startupProfile.recognizedProvider.inspectionOnly ? <Badge label="inspection only" tone="warning" /> : null}
          <Badge label={providerCredentialLabel(startupProfile.credential)} tone={providerCredentialTone(startupProfile.credential)} />
        </div>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Info label="Provider" value={startupProfile.recognizedProvider.label} />
        <Info label="Profile" value={startupProfile.profile ?? 'unknown'} />
        <Info label="Route" value={providerRouteLabel(startupProfile.recognizedProvider)} />
        <Info label="Discovery" value={providerDiscoveryLabel(startupProfile.recognizedProvider.discoveryMode)} />
      </div>

      {startupProfile.configuredNonSecretFields.length > 0 ? (
        <div className="mt-4">
          <div className="text-xs font-medium text-muted">Configured Fields</div>
          <div className="mt-2 flex flex-wrap gap-2">
            {startupProfile.configuredNonSecretFields.map((field) => (
              <span className="rounded-md border border-hairline-soft bg-surface-soft px-2 py-1 font-mono text-xs text-muted" key={field}>
                {field}
              </span>
            ))}
          </div>
        </div>
      ) : null}

      {startupProfile.credentials.length > 0 || startupProfile.credential.credentialSources.length > 0 ? (
        <div className="mt-4">
          <div className="text-xs font-medium text-muted">Credential State</div>
          <div className="mt-2 flex flex-wrap gap-2">
            {startupProfile.credentials.map((credential) => (
              <span
                className="rounded-md border border-hairline-soft bg-surface-soft px-2 py-1 font-mono text-xs text-muted"
                key={credential.name}
              >
                {credential.name} {credential.configured ? 'configured' : 'not configured'}
              </span>
            ))}
            {startupProfile.credential.credentialSources.map((source) => (
              <span
                className="rounded-md border border-hairline-soft bg-surface-soft px-2 py-1 text-xs text-muted"
                key={source}
              >
                {source}
              </span>
            ))}
          </div>
        </div>
      ) : null}

      {startupProfile.diagnostics.length > 0 ? (
        <div className="mt-4 space-y-2">
          {startupProfile.diagnostics.map((diagnostic, index) => (
            <DiagnosticNotice diagnostic={diagnostic} key={`${diagnostic.level}-${index}`} />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function DiagnosticNotice({ diagnostic }: { diagnostic: Diagnostic }) {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-hairline-soft bg-surface-soft/60 px-3 py-2 text-sm text-muted">
      <AlertTriangle className={cn('mt-0.5 h-4 w-4 shrink-0', diagnostic.level === 'error' ? 'text-error' : 'text-warning')} />
      <div className="min-w-0">
        <div>{diagnostic.message}</div>
        {diagnostic.path ? <div className="mt-1 truncate font-mono text-xs text-muted-soft">{diagnostic.path}</div> : null}
      </div>
    </div>
  );
}

function providerPageStatus(
  provider: OverviewResponse['provider'] | null | undefined,
  profiles: ProviderProfilesResponse | null,
  loadState: LoadState,
): string {
  if (profiles) {
    const reviewCount = profiles.summary.warnings + profiles.summary.errors;
    const profileCount = formatCount(profiles.summary.total, 'profile');
    return reviewCount > 0
      ? `${profileCount} / ${formatCount(reviewCount, 'issue')} to review`
      : `${profileCount} validated`;
  }
  if (loadState === 'loading') {
    return provider ? `${provider.provider} / ${provider.model}` : 'Provider profiles';
  }
  return provider ? `${provider.provider} / ${provider.model}` : 'No provider profile';
}

function validationStatusLabel(status: SafeProviderProfile['validation']['status']): string {
  if (status === 'error') return 'Needs fix';
  if (status === 'warning') return 'Needs review';
  return 'Ready';
}

function providerRouteLabel(provider: StudioProviderRecognition): string {
  return `${provider.category} / ${provider.transport}`;
}

function providerDiscoveryLabel(discoveryMode: StudioProviderDiscoveryMode): string {
  return `${discoveryMode} discovery`;
}

function providerCredentialLabel(credential: ProviderCredentialState): string {
  if (credential.credentialInvalid) {
    return credential.credentialMode === 'pool' && credential.credentialCount !== null
      ? `credential pool invalid (${credential.credentialCount})`
      : 'credential invalid';
  }

  if (credential.credentialMode === 'pool') {
    if (!credential.credentialConfigured) {
      return 'credential pool not configured';
    }
    return credential.credentialCount !== null
      ? `credential pool (${credential.credentialCount})`
      : 'credential pool';
  }

  if (credential.credentialMode === 'single') {
    return credential.credentialConfigured ? 'credential configured' : 'credential not configured';
  }

  if (credential.credentialMode === 'none') {
    return 'no credential';
  }

  return 'credential state unavailable';
}

function providerCredentialTone(credential: ProviderCredentialState): 'danger' | 'muted' | 'success' | 'warning' {
  if (credential.credentialInvalid) return 'danger';
  if (credential.credentialConfigured) return 'success';
  if (credential.credentialMode === 'unknown') return 'warning';
  return 'muted';
}

const providerApiFormatOptions: ProviderOption[] = [
  { value: '', label: 'Provider default', description: 'Use the default API mode for this provider.' },
  { value: 'responses', label: 'Responses API', description: 'OpenAI-compatible Responses endpoint.' },
  { value: 'chat_completions', label: 'Chat Completions', description: 'OpenAI-compatible chat completions endpoint.' },
];

const providerAuthSchemeOptions: ProviderOption[] = [
  { value: 'bearer', label: 'Bearer token', description: 'Prefix the credential with Bearer.' },
  { value: 'raw', label: 'Raw header value', description: 'Use the credential exactly as provided.' },
];

function ProviderProfileTemplateModal({
  commandCopied,
  draft,
  jsonCopied,
  onClose,
  onCopyCommand,
  onCopyJson,
  onDraftChange,
  onSelectTemplate,
  selectedTemplate,
  templates,
}: {
  commandCopied: boolean;
  draft: ProviderProfileDraft;
  jsonCopied: boolean;
  onClose: () => void;
  onCopyCommand: () => void;
  onCopyJson: () => void;
  onDraftChange: (patch: Partial<ProviderProfileDraft>) => void;
  onSelectTemplate: (template: ProviderProfileTemplate) => void;
  selectedTemplate: ProviderProfileTemplate;
  templates: ProviderProfileTemplate[];
}) {
  const snippet = providerTemplateSnippet(draft);
  const command = providerLaunchCommand(draft);
  const omittedSensitiveHeaders = hasSensitiveCustomHeaderText(draft.customHeadersText);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (document.querySelector('[data-provider-profile-select-open="true"]')) {
          return;
        }
        onClose();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[1000] flex items-center justify-center overflow-y-auto overscroll-contain bg-surface-dark/55 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        aria-labelledby="provider-profile-modal-title"
        aria-modal="true"
        className="flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-lg border border-hairline bg-canvas shadow-sm"
        role="dialog"
      >
        <div className="flex shrink-0 items-center justify-between gap-4 border-b border-hairline-soft bg-surface-soft px-5 py-4">
          <div className="min-w-0">
            <h2 className="truncate text-[22px] font-medium leading-tight text-ink" id="provider-profile-modal-title">
              New Provider Profile
            </h2>
            <p className="mt-1 text-sm text-muted">Select a safe template, tune the profile, then copy the command or JSON.</p>
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

        <div className="custom-scrollbar min-h-0 flex-1 overflow-y-auto p-4 sm:p-5">
          <div className="min-w-0 space-y-4">
            <section className="rounded-lg border border-hairline-soft bg-surface-card p-4">
              <div className="min-w-0">
                <h3 className="text-base font-semibold text-ink">Choose a provider template</h3>
                <p className="mt-1 text-sm leading-relaxed text-muted">Start from a safe preset, then review the generated fields below.</p>
              </div>
              <div className="mt-4 grid gap-3 lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
                <div className="min-w-0 rounded-md border border-hairline-soft bg-canvas px-3 py-3">
                  <div className="mb-2 text-xs font-medium text-muted">Template</div>
                  <ProviderTemplateSelect
                    onSelectTemplate={onSelectTemplate}
                    selectedTemplate={selectedTemplate}
                    templates={templates}
                  />
                </div>
                <div className="min-w-0 rounded-md border border-hairline-soft bg-canvas px-3 py-3">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-semibold text-ink">{selectedTemplate.label}</span>
                    <Badge label={selectedTemplate.category} tone={selectedTemplate.category === 'local' ? 'success' : 'muted'} />
                    <Badge label={selectedTemplate.model || selectedTemplate.modelPlaceholder} tone="muted" />
                    <Badge
                      label={selectedTemplate.requiresSecret ? selectedTemplate.credential?.envVar ?? 'credential required' : 'no secret'}
                      tone={selectedTemplate.requiresSecret ? 'warning' : 'success'}
                    />
                  </div>
                  <p className="mt-2 text-sm leading-relaxed text-muted">{selectedTemplate.description}</p>
                </div>
              </div>
            </section>

            <section className="rounded-lg border border-hairline-soft bg-surface-card p-4">
              <div className="flex min-w-0 flex-wrap items-start justify-between gap-3 border-b border-hairline-soft pb-4">
                <div className="min-w-0">
                  <h3 className="truncate text-base font-semibold text-ink">Profile details</h3>
                  <p className="mt-1 text-sm text-muted">These safe fields are reflected in both generated outputs.</p>
                </div>
                <Badge label={selectedTemplate.provider} tone="muted" />
              </div>

              <div className="mt-4 grid gap-4 md:grid-cols-2">
                <ProviderDraftField id="provider-profile-id" label="Profile ID">
                  <input
                    className="w-full rounded-md border border-hairline bg-canvas px-3 py-2 font-mono text-sm text-ink outline-none transition-colors focus:border-primary/50 focus:ring-[3px] focus:ring-primary/15"
                    id="provider-profile-id"
                    onChange={(event) => onDraftChange({ id: event.target.value })}
                    value={draft.id}
                  />
                </ProviderDraftField>
                <ProviderDraftField id="provider-profile-name" label="Profile name">
                  <input
                    className="w-full rounded-md border border-hairline bg-canvas px-3 py-2 text-sm text-ink outline-none transition-colors focus:border-primary/50 focus:ring-[3px] focus:ring-primary/15"
                    id="provider-profile-name"
                    onChange={(event) => onDraftChange({ name: event.target.value })}
                    value={draft.name}
                  />
                </ProviderDraftField>
                <ProviderDraftField id="provider-profile-provider" label="Provider">
                  <input
                    className="w-full rounded-md border border-hairline bg-canvas px-3 py-2 font-mono text-sm text-ink outline-none transition-colors focus:border-primary/50 focus:ring-[3px] focus:ring-primary/15"
                    id="provider-profile-provider"
                    onChange={(event) => onDraftChange({ provider: event.target.value })}
                    value={draft.provider}
                  />
                </ProviderDraftField>
                <ProviderDraftField id="provider-profile-model" label="Model">
                  <input
                    className="w-full rounded-md border border-hairline bg-canvas px-3 py-2 font-mono text-sm text-ink outline-none transition-colors focus:border-primary/50 focus:ring-[3px] focus:ring-primary/15"
                    id="provider-profile-model"
                    onChange={(event) => onDraftChange({ model: event.target.value })}
                    placeholder={selectedTemplate.modelPlaceholder}
                    value={draft.model}
                  />
                </ProviderDraftField>
                <ProviderDraftField className="md:col-span-2" id="provider-profile-base-url" label="Base URL">
                  <input
                    className="w-full rounded-md border border-hairline bg-canvas px-3 py-2 font-mono text-sm text-ink outline-none transition-colors focus:border-primary/50 focus:ring-[3px] focus:ring-primary/15"
                    id="provider-profile-base-url"
                    onChange={(event) => onDraftChange({ baseUrl: event.target.value })}
                    placeholder="https://api.example.com/v1"
                    value={draft.baseUrl}
                  />
                </ProviderDraftField>
              </div>

              <div className="mt-4 grid gap-3 md:grid-cols-[minmax(0,1fr)_220px]">
                <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-hairline-soft bg-canvas px-3 py-3">
                  <input
                    checked={draft.makeActive}
                    className="mt-0.5 h-4 w-4 rounded border-hairline text-primary focus:ring-primary"
                    onChange={(event) => onDraftChange({ makeActive: event.target.checked })}
                    type="checkbox"
                  />
                  <span>
                    <span className="block text-sm font-medium text-ink">Make active</span>
                    <span className="mt-1 block text-xs leading-relaxed text-muted">Adds the active profile id to the copied JSON.</span>
                  </span>
                </label>
                <div className="rounded-lg border border-hairline-soft bg-canvas px-3 py-3">
                  <div className="text-xs font-medium text-muted">Credential</div>
                  <div className="mt-1 font-mono text-sm text-ink">
                    {selectedTemplate.requiresSecret ? selectedTemplate.credential?.envVar ?? 'required outside Studio' : 'not required'}
                  </div>
                </div>
              </div>
            </section>

            <details className="rounded-lg border border-hairline-soft bg-surface-card">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3">
                <span>
                  <span className="block text-sm font-medium text-ink">Advanced provider settings</span>
                  <span className="mt-1 block text-xs text-muted">API mode, auth header metadata, and non-sensitive custom headers.</span>
                </span>
                <ChevronDown className="h-4 w-4 text-muted" />
              </summary>
              <div className="grid gap-4 border-t border-hairline-soft p-4 md:grid-cols-2">
                <ProviderOptionField
                  id="provider-profile-api-format"
                  label="API mode"
                  onChange={(value) => onDraftChange({ apiFormat: value })}
                  options={providerApiFormatOptions}
                  value={draft.apiFormat}
                />
                <ProviderOptionField
                  id="provider-profile-auth-scheme"
                  label="Auth scheme"
                  onChange={(value) => onDraftChange({ authScheme: value })}
                  options={providerAuthSchemeOptions}
                  value={draft.authScheme}
                />
                <ProviderDraftField id="provider-profile-auth-header" label="Auth header">
                  <input
                    className="w-full rounded-md border border-hairline bg-canvas px-3 py-2 font-mono text-sm text-ink outline-none transition-colors focus:border-primary/50 focus:ring-[3px] focus:ring-primary/15"
                    id="provider-profile-auth-header"
                    onChange={(event) => onDraftChange({ authHeader: event.target.value })}
                    placeholder="Authorization"
                    value={draft.authHeader}
                  />
                </ProviderDraftField>
                <ProviderDraftField id="provider-profile-custom-headers" label="Custom headers">
                  <textarea
                    className="min-h-[84px] w-full resize-y rounded-md border border-hairline bg-canvas px-3 py-2 font-mono text-sm text-ink outline-none transition-colors focus:border-primary/50 focus:ring-[3px] focus:ring-primary/15"
                    id="provider-profile-custom-headers"
                    onChange={(event) => onDraftChange({ customHeadersText: event.target.value })}
                    placeholder="X-Provider-Feature: enabled"
                    value={draft.customHeadersText}
                  />
                </ProviderDraftField>
                {omittedSensitiveHeaders ? (
                  <div className="rounded-lg border border-warning/25 bg-warning/[0.08] px-3 py-2 text-xs leading-relaxed text-muted md:col-span-2">
                    Sensitive-looking custom header names are omitted from the safe JSON.
                  </div>
                ) : null}
              </div>
            </details>

            <section className="rounded-lg border border-hairline-soft bg-surface-card p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold text-ink">Generated OpenClaude command</div>
                  <div className="mt-1 text-xs text-muted">Uses OpenClaude's supported provider and model flags.</div>
                </div>
                <button className="secondary-button" onClick={onCopyCommand} type="button">
                  <Copy className="h-4 w-4" />
                  {commandCopied ? 'Copied' : 'Copy command'}
                </button>
              </div>
              <input
                aria-label="Generated OpenClaude command"
                className="mt-3 w-full rounded-md border border-hairline bg-canvas px-3 py-2 font-mono text-sm text-ink outline-none transition-colors focus:border-primary/50 focus:ring-[3px] focus:ring-primary/15"
                onFocus={(event) => event.currentTarget.select()}
                readOnly
                value={command}
              />
            </section>

            <section className="overflow-hidden rounded-lg border border-code-panel-border bg-code-panel">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-code-panel-border bg-code-panel-elevated px-4 py-3">
                <div>
                  <div className="text-sm font-semibold text-code-panel-text">Generated safe JSON</div>
                  <div className="mt-1 text-xs text-code-panel-muted">Secret fields are not included.</div>
                </div>
                <button className="secondary-button bg-canvas" onClick={onCopyJson} type="button">
                  <Copy className="h-4 w-4" />
                  {jsonCopied ? 'Copied' : 'Copy safe JSON'}
                </button>
              </div>
              <pre
                aria-label="Generated provider profile JSON"
                className="whitespace-pre-wrap break-words p-4 font-mono text-xs leading-relaxed text-code-panel-text"
              >
                {snippet}
              </pre>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}

function ProviderTemplateSelect({
  onSelectTemplate,
  selectedTemplate,
  templates,
}: {
  onSelectTemplate: (template: ProviderProfileTemplate) => void;
  selectedTemplate: ProviderProfileTemplate;
  templates: ProviderProfileTemplate[];
}) {
  const [isOpen, setIsOpen] = useState(false);
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

  return (
    <div
      className="custom-select provider-template-select"
      data-provider-profile-select-open={isOpen ? 'true' : undefined}
      ref={menuRef}
    >
      <button
        aria-controls="provider-template-selector-menu"
        aria-expanded={isOpen}
        aria-haspopup="listbox"
        aria-label={`Template ${selectedTemplate.label}`}
        className="custom-select-trigger min-h-[52px]"
        id="provider-template-select"
        onClick={() => setIsOpen((current) => !current)}
        type="button"
      >
        <span className="custom-select-trigger-content">
          <Database className="h-4 w-4 shrink-0 text-muted" />
          <span className="min-w-0 flex-1">
            <span className="block truncate font-medium">{selectedTemplate.label}</span>
            <span className="mt-0.5 block truncate text-[12px] font-normal text-muted">
              {selectedTemplate.category} / {selectedTemplate.provider}
            </span>
          </span>
        </span>
        <ChevronDown className={cn('h-4 w-4 shrink-0 text-muted transition-transform', isOpen && 'rotate-180')} />
      </button>

      {isOpen ? (
        <div
          aria-label="Provider template"
          className="custom-select-menu custom-scrollbar"
          id="provider-template-selector-menu"
          role="listbox"
        >
          {templates.map((template) => {
            const isSelected = template.id === selectedTemplate.id;
            return (
              <button
                aria-selected={isSelected}
                className={cn('custom-select-option', isSelected && 'custom-select-option-active')}
                key={template.id}
                onClick={() => {
                  onSelectTemplate(template);
                  setIsOpen(false);
                }}
                role="option"
                type="button"
              >
                <Database className={cn('mt-0.5 h-4 w-4 shrink-0', isSelected ? 'text-primary' : 'text-muted')} />
                <span className="min-w-0 flex-1">
                  <span className={cn('block truncate text-[14px] font-medium', isSelected ? 'text-primary' : 'text-ink')}>
                    {template.label}
                  </span>
                  <span className="mt-0.5 block truncate text-[12px] text-muted">
                    {template.category} / {template.provider} / {template.model || template.modelPlaceholder}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function ProviderOptionField({
  id,
  label,
  onChange,
  options,
  value,
}: {
  id: string;
  label: string;
  onChange: (value: string) => void;
  options: ProviderOption[];
  value: string;
}) {
  return (
    <div className="grid gap-2">
      <span className="text-xs font-medium text-muted" id={`${id}-label`}>{label}</span>
      <ProviderOptionSelect
        id={id}
        label={label}
        labelId={`${id}-label`}
        onChange={onChange}
        options={options}
        value={value}
      />
    </div>
  );
}

function ProviderOptionSelect({
  id,
  label,
  labelId,
  onChange,
  options,
  value,
}: {
  id: string;
  label: string;
  labelId: string;
  onChange: (value: string) => void;
  options: ProviderOption[];
  value: string;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const selectedOption = options.find((option) => option.value === value) ?? options[0] ?? { value: '', label: 'Select option' };
  const menuId = `${id}-menu`;

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
    <div
      className="custom-select provider-option-select"
      data-provider-profile-select-open={isOpen ? 'true' : undefined}
      ref={menuRef}
    >
      <button
        aria-controls={menuId}
        aria-expanded={isOpen}
        aria-haspopup="listbox"
        aria-labelledby={`${labelId} ${id}`}
        className="custom-select-trigger"
        id={id}
        onClick={() => setIsOpen((current) => !current)}
        type="button"
      >
        <span className="custom-select-trigger-content">
          <span className="min-w-0 flex-1">
            <span className="block truncate font-medium">{selectedOption.label}</span>
            {selectedOption.description ? (
              <span className="mt-0.5 block truncate text-[12px] font-normal text-muted">{selectedOption.description}</span>
            ) : null}
          </span>
        </span>
        <ChevronDown className={cn('h-4 w-4 shrink-0 text-muted transition-transform', isOpen && 'rotate-180')} />
      </button>

      {isOpen ? (
        <div aria-label={`${label} options`} className="custom-select-menu custom-scrollbar" id={menuId} role="listbox">
          {options.map((option) => {
            const isSelected = option.value === selectedOption.value;
            return (
              <button
                aria-selected={isSelected}
                className={cn('custom-select-option', isSelected && 'custom-select-option-active')}
                key={option.value || 'default'}
                onClick={() => {
                  onChange(option.value);
                  setIsOpen(false);
                }}
                role="option"
                type="button"
              >
                <Check className={cn('mt-0.5 h-4 w-4 shrink-0', isSelected ? 'text-primary' : 'text-transparent')} />
                <span className="min-w-0 flex-1">
                  <span className={cn('block truncate text-[14px] font-medium', isSelected ? 'text-primary' : 'text-ink')}>
                    {option.label}
                  </span>
                  {option.description ? (
                    <span className="mt-0.5 block truncate text-[12px] text-muted">{option.description}</span>
                  ) : null}
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function ProviderDraftField({
  children,
  className,
  id,
  label,
}: {
  children: ReactNode;
  className?: string;
  id: string;
  label: string;
}) {
  return (
    <label className={cn('grid gap-2', className)} htmlFor={id}>
      <span className="text-xs font-medium text-muted">{label}</span>
      {children}
    </label>
  );
}

function createProviderProfileDraft(template: ProviderProfileTemplate): ProviderProfileDraft {
  return {
    templateId: template.id,
    id: `provider_${template.id.replace(/[^a-z0-9]+/gi, '_')}`,
    name: template.label,
    provider: template.provider,
    baseUrl: template.baseUrl,
    model: template.model,
    apiFormat: template.apiFormat ?? '',
    authHeader: template.authHeader ?? '',
    authScheme: template.authScheme ?? 'bearer',
    customHeadersText: formatCustomHeaders(template.customHeaders),
    makeActive: true,
  };
}

function providerTemplateSnippet(draft: ProviderProfileDraft): string {
  const profile: Record<string, unknown> = {
    id: trimmedOrFallback(draft.id, 'provider_custom'),
    name: trimmedOrFallback(draft.name, 'New provider profile'),
    provider: trimmedOrFallback(draft.provider, 'openai'),
    baseUrl: trimmedOrFallback(draft.baseUrl, '<provider base URL>'),
    model: trimmedOrFallback(draft.model, '<model id>'),
  };
  const apiFormat = draft.apiFormat.trim();
  const authHeader = draft.authHeader.trim();
  const customHeaders = parseSafeCustomHeaders(draft.customHeadersText);

  if (apiFormat) profile.apiFormat = apiFormat;
  if (authHeader) {
    profile.authHeader = authHeader;
    profile.authScheme = draft.authScheme === 'raw' ? 'raw' : 'bearer';
  }
  if (customHeaders) {
    profile.customHeaders = customHeaders;
  }

  return JSON.stringify(
    draft.makeActive
      ? { activeProviderProfileId: profile.id, providerProfiles: [profile] }
      : { providerProfiles: [profile] },
    null,
    2,
  );
}

function providerLaunchCommand(draft: ProviderProfileDraft): string {
  return providerLaunchCommandFromValues({
    baseUrl: draft.baseUrl,
    model: draft.model,
    provider: draft.provider,
  });
}

function providerProfileLaunchCommand(profile: SafeProviderProfile): string {
  return providerLaunchCommandFromValues({
    baseUrl: profile.baseUrl,
    model: profile.model,
    provider: profile.provider,
  });
}

function providerLaunchCommandFromValues({
  baseUrl,
  model,
  provider,
}: {
  baseUrl: string | null | undefined;
  model: string;
  provider: string;
}): string {
  const safeProvider = trimmedOrFallback(provider, 'openai');
  const safeModel = model.trim();
  const commandParts = ['openclaude', '--provider', shellArg(safeProvider), '--model', safeModel ? shellArg(safeModel) : 'MODEL_ID'];
  const envPrefix = providerLaunchEnvPrefix(safeProvider, baseUrl);
  return envPrefix ? `${envPrefix} ${commandParts.join(' ')}` : commandParts.join(' ');
}

function providerLaunchEnvPrefix(providerValue: string, baseUrlValue: string | null | undefined): string {
  const provider = providerValue.trim().toLowerCase();
  const baseUrl = (baseUrlValue ?? '').trim().replace(/\/+$/, '');

  if (!baseUrl || !isSafeCommandBaseUrl(baseUrl)) {
    return '';
  }
  if (provider === 'openai' && baseUrl !== 'https://api.openai.com/v1') {
    return `OPENAI_BASE_URL=${shellArg(baseUrl)}`;
  }
  if (provider === 'ollama' && baseUrl !== 'http://127.0.0.1:11434/v1' && baseUrl !== 'http://localhost:11434/v1') {
    return `OPENAI_BASE_URL=${shellArg(baseUrl)}`;
  }
  return '';
}

function isSafeCommandBaseUrl(baseUrl: string): boolean {
  return !/[<>]/.test(baseUrl) && !/redacted/i.test(baseUrl);
}

function shellArg(value: string): string {
  return /^[A-Za-z0-9._~:/@%+=,-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

function formatCustomHeaders(headers: Array<{ name: string; value: string }>): string {
  return headers
    .map((header) => `${header.name}: ${header.value}`)
    .join('\n');
}

function parseSafeCustomHeaders(value: string): Record<string, string> | undefined {
  const entries = value
    .split('\n')
    .map((line) => {
      const separatorIndex = line.indexOf(':');
      if (separatorIndex === -1) return null;
      const key = line.slice(0, separatorIndex).trim();
      const headerValue = line.slice(separatorIndex + 1).trim();
      if (!key || !headerValue || isSensitiveHeaderKey(key)) return null;
      return [key, headerValue] as const;
    })
    .filter((entry): entry is readonly [string, string] => entry !== null);

  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function hasSensitiveCustomHeaderText(value: string): boolean {
  return value
    .split('\n')
    .some((line) => {
      const separatorIndex = line.indexOf(':');
      return separatorIndex !== -1 && isSensitiveHeaderKey(line.slice(0, separatorIndex).trim());
    });
}

function isSensitiveHeaderKey(key: string): boolean {
  return /authorization|token|secret|key|cookie|auth|session|credential/i.test(key);
}

function trimmedOrFallback(value: string, fallback: string): string {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function LogsPage({
  isLoading,
  isRangeLoading,
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
  isRangeLoading: boolean;
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
  const logBusy = isLoading || isRangeLoading;
  const logLoadingLabel = isLoading ? 'Loading logs' : 'Loading log entries';

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

      <section aria-busy={logBusy} className="log-console">
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

        <div className="log-view-shell">
          <div
            aria-label="Log entries"
            aria-busy={logBusy}
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
            {isLoading && !logs ? (
              <div aria-hidden="true" className="log-loading-placeholder" />
            ) : logs?.entries.length ? (
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
        </div>
        {logBusy ? <LoadingOverlay className="log-console-loading-overlay" label={logLoadingLabel} tone="code" /> : null}
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

function DiagnosticsPage({
  diagnostics,
  isLoading,
  loadingLabel,
}: {
  diagnostics: Diagnostic[];
  isLoading: boolean;
  loadingLabel: string;
}) {
  return (
    <PageStack>
      <PageHeader
        icon={AlertTriangle}
        status={`${diagnostics.length} diagnostics`}
        title="Diagnostics"
      />
      <section aria-busy={isLoading} className="panel loading-boundary">
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
        {isLoading ? <LoadingOverlay label={loadingLabel} /> : null}
      </section>
    </PageStack>
  );
}

function NoProjectSelectionPage({
  isLoading = false,
  loadingLabel = 'Loading workspace',
}: {
  isLoading?: boolean;
  loadingLabel?: string;
}) {
  return (
    <PageStack>
      <PageHeader
        icon={ClipboardList}
        status={isLoading ? 'Waiting for project' : 'No project selected'}
        title="Plans & Tasks"
      />
      <section aria-busy={isLoading} className="panel loading-boundary">
        {isLoading ? (
          <div
            aria-hidden="true"
            className="section-loading-placeholder plans-tasks-initial-placeholder"
          />
        ) : (
          <EmptyState label="Select a project to inspect linked plans and tasks." />
        )}
        {isLoading ? <LoadingOverlay label={loadingLabel} /> : null}
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
    setHoveredIndex(null);
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
                onClick={() => {
                  setTimeframe(option.value);
                  setHoveredIndex(null);
                }}
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

function SessionsTable({
  isLoading = false,
  loadingLabel = 'Loading sessions',
  sessions,
  title,
  onSessionClick,
}: {
  isLoading?: boolean;
  loadingLabel?: string;
  sessions: SessionSummary[];
  title: string;
  onSessionClick?: (id: string) => void;
}) {
  return (
    <section aria-busy={isLoading} className="panel loading-boundary">
      <SectionHeading icon={MessageSquareText} label={title} />
      <div className="mt-4 overflow-x-auto">
        {sessions.length === 0 ? (
          isLoading ? (
            <div aria-hidden="true" className="section-loading-placeholder sessions-loading-placeholder" />
          ) : (
            <EmptyState label="No sessions found" />
          )
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
                <tr
                  key={session.id}
                  onClick={() => onSessionClick?.(session.id)}
                  onKeyDown={(event) => {
                    if (!onSessionClick) return;
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      onSessionClick(session.id);
                    }
                  }}
                  tabIndex={onSessionClick ? 0 : undefined}
                  aria-label={onSessionClick ? `Open details for ${session.title}` : undefined}
                  className={onSessionClick ? 'cursor-pointer hover:bg-surface-soft/50 transition-colors' : undefined}
                >
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
      {isLoading ? <LoadingOverlay label={loadingLabel} /> : null}
    </section>
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

function StatusBanner({
  baseUrl,
  error,
  isConnected,
  onServerUrlChange,
}: {
  baseUrl: string;
  error: string;
  isConnected: boolean;
  onServerUrlChange: (baseUrl: string) => void;
}) {
  const likelyConnectionError = !isConnected || /failed to fetch|load failed|networkerror/i.test(error);
  const command = 'npx openclaude-studio';
  const [copiedCommand, setCopiedCommand] = useState(false);
  const [draftBaseUrl, setDraftBaseUrl] = useState(baseUrl);
  const [urlError, setUrlError] = useState<string | null>(null);

  useEffect(() => {
    setDraftBaseUrl(baseUrl);
    setUrlError(null);
  }, [baseUrl]);

  function copyCommand() {
    void window.navigator.clipboard?.writeText(command);
    setCopiedCommand(true);
  }

  function saveDraftBaseUrl() {
    const normalizedBaseUrl = normalizeBaseUrl(draftBaseUrl);
    if (!isHttpBaseUrl(normalizedBaseUrl)) {
      setUrlError('Enter a valid http:// or https:// URL.');
      return;
    }

    setUrlError(null);
    setDraftBaseUrl(normalizedBaseUrl);
    onServerUrlChange(normalizedBaseUrl);
  }

  function resetBaseUrl() {
    setUrlError(null);
    setDraftBaseUrl(defaultServerUrl);
    onServerUrlChange(defaultServerUrl);
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
        {likelyConnectionError ? (
          <form
            className="status-banner-connection"
            onSubmit={(event) => {
              event.preventDefault();
              saveDraftBaseUrl();
            }}
          >
            <label className="status-banner-field" htmlFor="local-api-url">
              <span>Local API URL</span>
              <input
                className="field-input status-banner-input"
                id="local-api-url"
                onChange={(event) => setDraftBaseUrl(event.target.value)}
                spellCheck={false}
                type="url"
                value={draftBaseUrl}
              />
            </label>
            <div className="status-banner-actions">
              <button className="status-banner-action status-banner-action-primary" type="submit">
                Save API URL
              </button>
              <button className="status-banner-action" onClick={resetBaseUrl} type="button">
                Reset API URL
              </button>
            </div>
            {urlError ? <div className="status-banner-validation" role="alert">{urlError}</div> : null}
          </form>
        ) : null}
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

function workspaceLoadingLabel(
  input: {
    projectId?: string | null;
    fileName?: string | undefined;
    level?: LogLevelFilter;
    query?: string;
    start?: number;
  },
  selectedProjectId: string | null,
  hasWorkspaceData: boolean,
): string {
  if (!hasWorkspaceData) return 'Loading workspace';
  if (
    input.fileName !== undefined ||
    input.level !== undefined ||
    input.query !== undefined ||
    input.start !== undefined
  ) {
    return 'Loading logs';
  }
  if (input.projectId && input.projectId !== selectedProjectId) {
    return 'Loading project data';
  }
  return 'Refreshing workspace';
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
  return mergeDiagnostics(
    projectResponseDiagnostics,
    project?.diagnostics ?? [],
    overview?.diagnostics ?? [],
    logs?.diagnostics ?? [],
  );
}

function mergeDiagnostics(...groups: Diagnostic[][]): Diagnostic[] {
  const allDiagnostics = groups.flat();
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
    const normalizedValue = normalizeBaseUrl(value);
    if (isHttpBaseUrl(normalizedValue)) {
      return normalizedValue;
    }
    storage?.removeItem(serverUrlStorageKey);
  }

  const legacyConnection = readLegacyConnection(storage);
  if (legacyConnection.baseUrl) {
    storage?.removeItem(legacyConnectionStorageKey);
    const normalizedLegacyBaseUrl = normalizeBaseUrl(legacyConnection.baseUrl);
    if (isHttpBaseUrl(normalizedLegacyBaseUrl)) {
      storage?.setItem(serverUrlStorageKey, normalizedLegacyBaseUrl);
      return normalizedLegacyBaseUrl;
    }
  }

  return defaultServerUrl;
}

function saveServerUrl(baseUrl: string) {
  safeStorage('localStorage')?.setItem(serverUrlStorageKey, normalizeBaseUrl(baseUrl));
}

function isHttpBaseUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.host.length > 0;
  } catch {
    return false;
  }
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

function formatCount(value: number, singular: string, plural = `${singular}s`): string {
  return `${formatNumber(value)} ${value === 1 ? singular : plural}`;
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
