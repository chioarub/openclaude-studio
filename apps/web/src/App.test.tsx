import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { ProjectSummary } from '@openclaude-studio/shared';

import App from './App';

const serverUrlStorageKey = 'openclaude-studio:server-url';
const legacyConnectionStorageKey = 'openclaude-studio.connection';

let localStorageData: Record<string, string>;
let sessionStorageData: Record<string, string>;

beforeEach(() => {
  localStorageData = {};
  sessionStorageData = {};
  window.history.pushState(null, '', '/');
  Object.defineProperty(window, 'localStorage', { configurable: true, value: storageStub('local') });
  Object.defineProperty(window, 'sessionStorage', { configurable: true, value: storageStub('session') });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('App', () => {
  test('explains how to start the local server when the hosted UI cannot reach the API', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    const writeText = vi.spyOn(window.navigator.clipboard, 'writeText').mockResolvedValue(undefined);

    render(<App />);

    const status = await screen.findByRole('status');
    expect(within(status).getByText('Start the local OpenClaude Studio server')).toBeInTheDocument();
    expect(within(status).getByText('The hosted UI needs the local read-only API. Run this in a terminal, keep it open, then refresh.')).toBeInTheDocument();
    expect(within(status).getByText('npx openclaude-studio')).toBeInTheDocument();
    await user.click(within(status).getByRole('button', { name: /copy local server command/i }));
    expect(writeText).toHaveBeenCalledWith('npx openclaude-studio');
    expect(within(status).getByText('Expected API: http://127.0.0.1:43110')).toBeInTheDocument();
    expect(within(status).getByText('Last error: Failed to fetch')).toBeInTheDocument();

    const apiInput = within(status).getByLabelText('Local API URL');
    expect(apiInput).toHaveValue('http://127.0.0.1:43110');
    await user.clear(apiInput);
    await user.type(apiInput, 'http://127.0.0.1:43111/');
    await user.click(within(status).getByRole('button', { name: /save api url/i }));

    await waitFor(() => {
      expect(window.localStorage.getItem(serverUrlStorageKey)).toBe('http://127.0.0.1:43111');
    });
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        'http://127.0.0.1:43111/api/projects',
        expect.objectContaining({ headers: { accept: 'application/json' } }),
      );
    });
  });

  test('resets a custom local API URL to the default from the disconnected banner', async () => {
    window.localStorage.setItem(serverUrlStorageKey, 'http://127.0.0.1:43112');
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    vi.spyOn(window.navigator.clipboard, 'writeText').mockResolvedValue(undefined);

    render(<App />);

    const status = await screen.findByRole('status');
    const apiInput = within(status).getByLabelText('Local API URL');
    expect(apiInput).toHaveValue('http://127.0.0.1:43112');

    await user.click(within(status).getByRole('button', { name: /reset api url/i }));

    await waitFor(() => {
      expect(window.localStorage.getItem(serverUrlStorageKey)).toBe('http://127.0.0.1:43110');
    });
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        'http://127.0.0.1:43110/api/projects',
        expect.objectContaining({ headers: { accept: 'application/json' } }),
      );
    });
  });

  test('ignores stale health responses after changing the local API URL', async () => {
    window.localStorage.setItem(serverUrlStorageKey, 'http://127.0.0.1:43112');
    const staleHealth = deferred<Response>();
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === 'http://127.0.0.1:43112/api/health') {
        return staleHealth.promise;
      }
      return Promise.reject(new TypeError('Failed to fetch'));
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    vi.spyOn(window.navigator.clipboard, 'writeText').mockResolvedValue(undefined);

    render(<App />);

    const status = await screen.findByRole('status');
    const apiInput = within(status).getByLabelText('Local API URL');
    await user.clear(apiInput);
    await user.type(apiInput, 'http://127.0.0.1:43111');
    await user.click(within(status).getByRole('button', { name: /save api url/i }));

    await waitFor(() => {
      expect(window.localStorage.getItem(serverUrlStorageKey)).toBe('http://127.0.0.1:43111');
    });

    await act(async () => {
      staleHealth.resolve(jsonResponse({
        status: 'ok',
        version: 'stale-health',
        serverTime: '2026-05-28T08:00:00.000Z',
        uptime: 1,
      }));
      await staleHealth.promise;
    });

    expect(screen.queryByText(/vstale-health/i)).not.toBeInTheDocument();
    expect(await screen.findByText('Expected API: http://127.0.0.1:43111')).toBeInTheDocument();
  });

  test('loads the read-only workspace from the local API without a token prompt', async () => {
    const fetchMock = mockApi();
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    expect(await screen.findByRole('button', { name: /project-a main/i })).toBeInTheDocument();
    expect(screen.queryByLabelText('API token')).not.toBeInTheDocument();
    expect(screen.queryByText('Selected project')).not.toBeInTheDocument();
    expect(screen.getAllByText('v0.0.1-test').length).toBeGreaterThan(0);
    expect(screen.getByText('Anthropic')).toBeInTheDocument();
    expect(screen.getByText('Build the API')).toBeInTheDocument();
    const projectOverview = screen.getByText('Project Overview').closest('section');
    expect(projectOverview).not.toBeNull();
    expect(within(projectOverview!).getByText('Usage Overview')).toBeInTheDocument();
    expect(within(projectOverview!).getByRole('img', { name: /recorded spend chart/i })).toBeInTheDocument();
    expect(within(projectOverview!).getAllByText('$0.25').length).toBeGreaterThan(0);
    fireEvent.pointerEnter(within(projectOverview!).getByLabelText('2026-05-28: $0.25'));
    const tooltip = await within(projectOverview!).findByRole('tooltip');
    expect(within(tooltip).getByText('Recorded cost')).toBeInTheDocument();
    expect(within(tooltip).getAllByText('$0.25').length).toBeGreaterThan(0);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:43110/api/projects',
      expect.objectContaining({ headers: { accept: 'application/json' } }),
    );
  });

  test('defaults the overview chart to tokens when cost is not recorded', async () => {
    vi.stubGlobal('fetch', mockApi({ overviewUsageSeries: tokenOnlyUsageSeriesFixture() }));

    render(<App />);

    const projectOverview = (await screen.findByText('Project Overview')).closest('section');
    expect(projectOverview).not.toBeNull();
    expect(within(projectOverview!).getByRole('img', { name: /token throughput chart/i })).toBeInTheDocument();
    expect(within(projectOverview!).getByRole('button', { name: 'Tokens' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(projectOverview!).getByRole('button', { name: 'Cost' })).toHaveAttribute('aria-disabled', 'true');
    expect(within(projectOverview!).getByText('Recorded cost unavailable')).toBeInTheDocument();
  });

  test('renders legacy overview responses without usage series', async () => {
    vi.stubGlobal('fetch', mockApi({ omitOverviewUsageSeries: true }));

    render(<App />);

    const projectOverview = (await screen.findByText('Project Overview')).closest('section');
    expect(projectOverview).not.toBeNull();
    expect(within(projectOverview!).getByText('0 usage days')).toBeInTheDocument();
    expect(within(projectOverview!).getByText('No token usage recorded')).toBeInTheDocument();
  });

  test('clears the usage chart tooltip when the timeframe changes', async () => {
    vi.stubGlobal('fetch', mockApi());
    const user = userEvent.setup();

    render(<App />);

    const projectOverview = (await screen.findByText('Project Overview')).closest('section');
    expect(projectOverview).not.toBeNull();

    await user.click(within(projectOverview!).getByRole('button', { name: 'All' }));
    fireEvent.pointerEnter(within(projectOverview!).getByLabelText('2026-05-27: $0.00'));
    expect(await within(projectOverview!).findByRole('tooltip')).toBeInTheDocument();

    await user.click(within(projectOverview!).getByRole('button', { name: '14D' }));

    expect(within(projectOverview!).queryByRole('tooltip')).not.toBeInTheDocument();
  });

  test('uses the saved server URL without reusing a stale persistent token', async () => {
    window.localStorage.setItem(
      legacyConnectionStorageKey,
      JSON.stringify({ baseUrl: 'http://127.0.0.1:43112/', token: 'stale-token' }),
    );
    const fetchMock = mockApi({ baseUrl: 'http://127.0.0.1:43112' });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await screen.findByRole('button', { name: /project-a main/i });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:43112/api/projects',
      expect.objectContaining({ headers: { accept: 'application/json' } }),
    );
    expect(window.localStorage.getItem(serverUrlStorageKey)).toBe('http://127.0.0.1:43112');
    expect(window.localStorage.getItem(legacyConnectionStorageKey)).toBeNull();
  });

  test('ignores invalid saved server URLs before loading the workspace', async () => {
    window.localStorage.setItem(serverUrlStorageKey, 'javascript:alert(1)');
    const fetchMock = mockApi();
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await screen.findByRole('button', { name: /project-a main/i });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:43110/api/projects',
      expect.objectContaining({ headers: { accept: 'application/json' } }),
    );
    expect(window.localStorage.getItem(serverUrlStorageKey)).toBe('http://127.0.0.1:43110');
  });

  test('keeps logs and sessions on their own routes', async () => {
    vi.stubGlobal('fetch', mockApi());
    const user = userEvent.setup();
    const writeText = vi.spyOn(window.navigator.clipboard, 'writeText').mockResolvedValue(undefined);

    render(<App />);

    await screen.findByRole('button', { name: /project-a main/i });
    const logsLink = screen.getAllByRole('link', { name: /^Logs$/i })[0];
    expect(logsLink).toBeDefined();
    await user.click(logsLink!);
    expect(await screen.findByText('OPENAI_API_KEY=<redacted> slow')).toBeInTheDocument();
    await user.hover(screen.getByText('OPENAI_API_KEY=<redacted> slow'));
    const copyButton = screen.getByRole('button', { name: /copy log message/i });
    await user.click(copyButton);
    expect(writeText).toHaveBeenCalledWith('OPENAI_API_KEY=<redacted> slow');
    expect(document.activeElement).not.toBe(copyButton);
    expect(screen.queryByRole('combobox', { name: /debug log file/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /debug log file/i }));
    expect(screen.getByRole('listbox', { name: /debug log file/i })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /session-1\.txt/i })).toBeInTheDocument();

    const sessionsLink = screen.getAllByRole('link', { name: /^Sessions$/i })[0];
    expect(sessionsLink).toBeDefined();
    await user.click(sessionsLink!);
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByText('Build the API')).toBeInTheDocument();
  });

  test('opens a session details timeline from the sessions table', async () => {
    const fetchMock = mockApi();
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    const writeText = vi.spyOn(window.navigator.clipboard, 'writeText').mockResolvedValue(undefined);

    render(<App />);

    await screen.findByRole('button', { name: /project-a main/i });
    await user.click(screen.getAllByRole('link', { name: /^Sessions$/i })[0]!);
    const sessionRow = screen.getByLabelText('Open details for Build the API');
    await user.click(sessionRow);

    const dialog = await screen.findByRole('dialog', { name: /session details/i });
    await waitFor(() => expect(within(dialog).getByRole('button', { name: /close dialog/i })).toHaveFocus());
    expect(within(dialog).getAllByText('Build the API').length).toBeGreaterThan(0);
    expect(within(dialog).getByText('Run command')).toBeInTheDocument();
    expect(within(dialog).getByText('npm test')).toBeInTheDocument();
    expect(within(dialog).getByText('Command output')).toBeInTheDocument();
    expect(within(dialog).getByText('ok')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: /^plans/i }));
    expect(within(dialog).getAllByText('Session Details').length).toBeGreaterThan(0);
    expect(within(dialog).getByText('session-details')).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: /copy timeline/i }));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('[TOOL] Run command\nnpm test'));
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:43110/api/projects/project-1/sessions/session-1',
      expect.objectContaining({ headers: { accept: 'application/json' } }),
    );

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /session details/i })).not.toBeInTheDocument());
    expect(sessionRow).toHaveFocus();
  });

  test('renders the plans and tasks control tower for the selected project', async () => {
    const fetchMock = mockApi();
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(<App />);

    await screen.findByRole('button', { name: /project-a main/i });
    await user.click(screen.getAllByRole('link', { name: /^Plans & Tasks$/i })[0]!);

    expect(await screen.findByRole('heading', { name: 'Plans & Tasks' })).toBeInTheDocument();
    expect(screen.getByText('Active Tasks')).toBeInTheDocument();
    expect(screen.getByText('Plan Files')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Launch plan/i })).toBeInTheDocument();
    expect((await screen.findAllByText('Review release checklist')).length).toBeGreaterThan(1);

    await user.click(screen.getByRole('button', { name: /Launch plan/i }));
    expect(screen.getAllByText('Review release checklist').length).toBeGreaterThan(1);
    const checklist = screen.getByRole('region', { name: /plan checklist/i });
    expect(within(checklist).getByText('Build')).toBeInTheDocument();
    expect(within(checklist).getByText('Publish')).toBeInTheDocument();
    expect(within(checklist).getByRole('checkbox', { name: 'Build' })).toBeChecked();
    expect(within(checklist).getByRole('checkbox', { name: 'Publish' })).not.toBeChecked();
    await user.click(await screen.findByRole('button', { name: /Open session Build the API/i }));
    expect(await screen.findByRole('dialog', { name: 'Session Details' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Session Details' })).not.toBeInTheDocument());

    const tablist = screen.getByRole('tablist', { name: /plans and tasks/i });
    await user.click(within(tablist).getByRole('tab', { name: /tasks/i }));
    expect(screen.getByRole('button', { name: /Ship task/i })).toBeInTheDocument();
    expect(await screen.findByText('Source JSON')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Ship task/i }));
    expect(screen.getAllByText(/Prepare the public release/i).length).toBeGreaterThan(1);
    const taskSessionButton = screen.getByRole('button', { name: /Open session Build the API/i });
    expect(within(taskSessionButton).getByText('Build the API')).toBeInTheDocument();
    expect(screen.queryByText(/^Open Session$/i)).not.toBeInTheDocument();
    await user.click(taskSessionButton);
    expect(await screen.findByRole('dialog', { name: 'Session Details' })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:43110/api/projects/project-1/plans',
      expect.objectContaining({ headers: { accept: 'application/json' } }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:43110/api/projects/project-1/tasks/session-1/1',
      expect.objectContaining({ headers: { accept: 'application/json' } }),
    );
  });

  test('keeps plans and tasks diagnostics visible on the diagnostics route', async () => {
    const taskDiagnostic = {
      level: 'error',
      message: 'Invalid task JSON: Unexpected token',
      path: '/tmp/.openclaude/tasks/session-1/broken.json',
    };
    vi.stubGlobal('fetch', mockApi({
      tasksResponse: {
        ...tasksFixture(),
        diagnostics: [taskDiagnostic],
      },
    }));
    const user = userEvent.setup();

    render(<App />);

    await screen.findByRole('button', { name: /project-a main/i });
    await user.click(screen.getAllByRole('link', { name: /^Plans & Tasks$/i })[0]!);
    expect(await screen.findByText('1 diagnostic while reading plans and tasks')).toBeInTheDocument();

    await user.click(screen.getAllByRole('link', { name: /Diagnostics/i })[0]!);

    expect(await screen.findByRole('heading', { name: 'Diagnostics' })).toBeInTheDocument();
    expect(screen.getByText('Invalid task JSON: Unexpected token')).toBeInTheDocument();
    expect(screen.getByText('/tmp/.openclaude/tasks/session-1/broken.json')).toBeInTheDocument();
  });

  test('shows a route-level error when plans and tasks list loading fails', async () => {
    vi.stubGlobal('fetch', mockApi({ failPlansListOnce: true }));
    const user = userEvent.setup();

    render(<App />);

    await screen.findByRole('button', { name: /project-a main/i });
    await user.click(screen.getAllByRole('link', { name: /^Plans & Tasks$/i })[0]!);

    expect(await screen.findByText('Failed to load plans and tasks')).toBeInTheDocument();
    expect(screen.getByText('Injected plans failure')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByRole('heading', { name: 'Plans & Tasks' })).toBeInTheDocument();
    expect(screen.getAllByText('Launch plan').length).toBeGreaterThan(0);
  });

  test('handles partial plans and tasks payloads without crashing', async () => {
    vi.stubGlobal('fetch', mockApi({
      plansResponse: {
        ...plansFixture(),
        plans: [
          {
            id: 'legacy-plan',
            title: 'Legacy plan',
            exists: true,
            modifiedAt: '2026-05-28T08:00:00.000Z',
          },
        ],
        diagnostics: undefined,
      },
      tasksResponse: {
        ...tasksFixture(),
        tasks: [
          {
            id: 'session-1:legacy',
            taskId: 'legacy',
            title: 'Legacy task',
            sessionId: 'session-1',
            sessionTitle: 'Build the API',
            modifiedAt: '2026-05-28T08:02:00.000Z',
          },
        ],
        diagnostics: undefined,
      },
    }));
    const user = userEvent.setup();

    render(<App />);

    await screen.findByRole('button', { name: /project-a main/i });
    await user.click(screen.getAllByRole('link', { name: /^Plans & Tasks$/i })[0]!);

    expect(await screen.findByRole('heading', { name: 'Plans & Tasks' })).toBeInTheDocument();
    expect(screen.getByText('Legacy plan')).toBeInTheDocument();

    const tablist = screen.getByRole('tablist', { name: /plans and tasks/i });
    await user.click(within(tablist).getByRole('tab', { name: /tasks/i }));

    expect(screen.getByText('Legacy task')).toBeInTheDocument();
    expect(screen.getAllByText('Unknown').length).toBeGreaterThan(0);
  });

  test('surfaces plan and task detail fetch failures as degraded panels', async () => {
    vi.stubGlobal('fetch', mockApi({ failPlanDetails: true, failTaskDetails: true }));
    const user = userEvent.setup();

    render(<App />);

    await screen.findByRole('button', { name: /project-a main/i });
    await user.click(screen.getAllByRole('link', { name: /^Plans & Tasks$/i })[0]!);

    expect(await screen.findByText(/Unable to load plan details\. Injected plan detail failure/i)).toBeInTheDocument();

    const tablist = screen.getByRole('tablist', { name: /plans and tasks/i });
    await user.click(within(tablist).getByRole('tab', { name: /tasks/i }));

    expect(await screen.findByText(/Unable to load task details\. Injected task detail failure/i)).toBeInTheDocument();
  });

  test('renders legacy partial session details without crashing', async () => {
    vi.stubGlobal('fetch', mockApi({ sessionDetails: legacySessionDetailsFixture() }));
    const user = userEvent.setup();

    render(<App />);

    await screen.findByRole('button', { name: /project-a main/i });
    await user.click(screen.getAllByRole('link', { name: /^Sessions$/i })[0]!);
    await user.click(screen.getByLabelText('Open details for Build the API'));

    const dialog = await screen.findByRole('dialog', { name: /session details/i });
    expect(within(dialog).getByText('unknown model')).toBeInTheDocument();
    expect(within(dialog).getByText('No files were altered.')).toBeInTheDocument();
    expect(within(dialog).getByText('No conversation events were recorded for this session.')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: /tools used/i }));
    expect(within(dialog).getByText('No tool calls recorded.')).toBeInTheDocument();
    expect(within(dialog).getAllByText('0').length).toBeGreaterThan(0);
  });

  test('summarizes repeated file-history snapshots by file path', async () => {
    vi.stubGlobal('fetch', mockApi({ sessionDetails: repeatedFileHistorySessionDetailsFixture() }));
    const user = userEvent.setup();

    render(<App />);

    await screen.findByRole('button', { name: /project-a main/i });
    await user.click(screen.getAllByRole('link', { name: /^Sessions$/i })[0]!);
    await user.click(screen.getByLabelText('Open details for Build the API'));

    const dialog = await screen.findByRole('dialog', { name: /session details/i });
    await user.click(within(dialog).getByRole('button', { name: /file history/i }));

    const displayPath = '.../specs/2026-04-23-jinx-full-app-design.md';
    expect(within(dialog).getAllByText(displayPath)).toHaveLength(1);
    expect(within(dialog).getByText('Latest v2')).toBeInTheDocument();
    expect(within(dialog).getByText('2 versions')).toBeInTheDocument();
  });

  test('debounces additional log window requests as the log view scrolls', async () => {
    const fetchMock = mockApi({ logTotalLines: 1200 });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(<App />);

    await screen.findByRole('button', { name: /project-a main/i });
    const logsLink = screen.getAllByRole('link', { name: /^Logs$/i })[0];
    expect(logsLink).toBeDefined();
    await user.click(logsLink!);
    await screen.findByText('line-1200');
    expect(wasFetchedWithQuery(fetchMock, '/api/logs/window', 'tail', 'true')).toBe(true);
    const initialLogRequests = fetchCountByPath(fetchMock, '/api/logs/window');

    const logView = screen.getByRole('region', { name: /log entries/i });
    Object.defineProperty(logView, 'clientHeight', { configurable: true, value: 320 });
    logView.scrollTop = 12_000;
    fireEvent.scroll(logView);
    logView.scrollTop = 9_000;
    fireEvent.scroll(logView);
    logView.scrollTop = 6_000;
    fireEvent.scroll(logView);

    await waitFor(() => {
      expect(wasFetchedWithQuery(fetchMock, '/api/logs/window', 'start', '0')).toBe(true);
    });
    expect(fetchCountByPath(fetchMock, '/api/logs/window')).toBe(initialLogRequests + 1);
  });

  test('recovers lazy log loading after a failed range request', async () => {
    const fetchMock = mockApi({ failLogWindowStartOnce: 0, logTotalLines: 1200 });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(<App />);

    await screen.findByRole('button', { name: /project-a main/i });
    const logsLink = screen.getAllByRole('link', { name: /^Logs$/i })[0];
    expect(logsLink).toBeDefined();
    await user.click(logsLink!);
    await screen.findByText('line-1200');
    const initialLogRequests = fetchCountByPath(fetchMock, '/api/logs/window');

    const logView = screen.getByRole('region', { name: /log entries/i });
    Object.defineProperty(logView, 'clientHeight', { configurable: true, value: 320 });
    logView.scrollTop = 0;
    fireEvent.scroll(logView);

    expect(await screen.findByText('Unable to load data')).toBeInTheDocument();
    expect(screen.getByText('Last error: Injected log failure')).toBeInTheDocument();
    expect(screen.queryByText('npx openclaude-studio')).not.toBeInTheDocument();
    expect(fetchCountByPath(fetchMock, '/api/logs/window')).toBe(initialLogRequests + 1);

    logView.scrollTop = 3_000;
    fireEvent.scroll(logView);

    await waitFor(() => {
      expect(fetchCountByPath(fetchMock, '/api/logs/window')).toBe(initialLogRequests + 2);
    });
    expect(wasFetchedWithQuery(fetchMock, '/api/logs/window', 'start', '0')).toBe(true);
    await waitFor(() => expect(screen.queryByText(/Injected log failure/i)).not.toBeInTheDocument());
  });

  test('loads the latest matching log window when filters change', async () => {
    const fetchMock = mockApi({ logTotalLines: 1200 });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(<App />);

    await screen.findByRole('button', { name: /project-a main/i });
    const logsLink = screen.getAllByRole('link', { name: /^Logs$/i })[0];
    expect(logsLink).toBeDefined();
    await user.click(logsLink!);
    await screen.findByText('line-1200');

    await user.click(screen.getByRole('button', { name: 'warn' }));

    await waitFor(() => {
      expect(wasFetchedWithQuery(fetchMock, '/api/logs/search', 'tail', 'true')).toBe(true);
      expect(wasFetchedWithQuery(fetchMock, '/api/logs/search', 'level', 'warn')).toBe(true);
    });
    expect(await screen.findByText('line-1200')).toBeInTheDocument();
  });

  test('surfaces API diagnostics on the diagnostics route', async () => {
    vi.stubGlobal(
      'fetch',
      mockApi({
        projectDiagnostics: [
          {
            level: 'error',
            message: 'Unable to parse global config.',
            path: '/tmp/.openclaude.json',
          },
        ],
        projects: [],
      }),
    );
    const user = userEvent.setup();

    render(<App />);

    await screen.findByText('No projects loaded');
    await user.click(screen.getByRole('link', { name: /diagnostics/i }));
    expect(await screen.findByText('Unable to parse global config.')).toBeInTheDocument();
    expect(screen.getByText('error')).toBeInTheDocument();
    expect(screen.getByLabelText('1 diagnostic error')).toBeInTheDocument();
  });

  test('scopes log and project diagnostics to the selected project', async () => {
    const fetchMock = mockApi({
      projects: [
        projectFixture({
          diagnostics: [{ level: 'warn', message: 'Selected project warning.' }],
        }),
        projectFixture({
          id: 'project-2',
          name: 'project-b',
          path: '/tmp/project-b',
          active: false,
          branch: 'feature',
          diagnostics: [{ level: 'error', message: 'Other project warning.' }],
        }),
      ],
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(<App />);

    await screen.findByRole('button', { name: /project-a main/i });
    expect(wasFetchedWithQuery(fetchMock, '/api/logs/window', 'projectId', 'project-1')).toBe(true);

    await user.click(screen.getByRole('link', { name: /diagnostics/i }));
    expect(await screen.findByText('Selected project warning.')).toBeInTheDocument();
    expect(screen.queryByText('Other project warning.')).not.toBeInTheDocument();
  });

  test('filters projects in the header selector and toggles theme', async () => {
    vi.stubGlobal(
      'fetch',
      mockApi({
        projects: [
          projectFixture({ id: 'project-1', name: 'project-a', path: '/tmp/project-a', active: true }),
          projectFixture({
            id: 'project-2',
            name: 'archived',
            path: '/tmp/archived',
            exists: false,
            branch: 'legacy',
            diagnostics: [
              { level: 'error', message: 'Missing project.' },
              { level: 'warn', message: 'Config is stale.' },
            ],
          }),
        ],
      }),
    );
    const user = userEvent.setup();

    render(<App />);

    await user.click(await screen.findByRole('button', { name: /project-a main/i }));
    await user.type(screen.getByPlaceholderText('Search projects, paths, branches...'), 'arch');
    const menu = screen.getByRole('dialog', { name: /project selector/i });
    expect(within(menu).getByRole('button', { name: /archived.*legacy/i })).toBeInTheDocument();
    expect(within(menu).queryByRole('button', { name: /project-a main/i })).not.toBeInTheDocument();
    expect(within(menu).getByLabelText('1 diagnostic error')).toHaveAttribute('title', '1 diagnostic error');
    expect(within(menu).getByLabelText('1 diagnostic warning')).toHaveAttribute('title', '1 diagnostic warning');

    await user.click(screen.getByRole('button', { name: /switch to dark mode/i }));
    await waitFor(() => expect(document.documentElement).toHaveClass('dark'));
  });

  test('ignores stale workspace responses from superseded project loads', async () => {
    const slowOverview = deferred<Response>();
    const slowSessions = deferred<Response>();
    const fetchMock = mockApiWithSlowProjectTwo(slowOverview.promise, slowSessions.promise);
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(<App />);

    await screen.findByRole('button', { name: /project-a main/i });
    await user.click(screen.getByRole('button', { name: /project-a main/i }));
    await user.click(
      within(screen.getByRole('dialog', { name: /project selector/i })).getByRole('button', {
        name: /project-b feature/i,
      }),
    );
    await waitFor(() => expect(wasFetched(fetchMock, '/api/projects/project-2/overview')).toBe(true));

    await user.click(screen.getByRole('button', { name: /project-a main/i }));
    await user.click(
      within(screen.getByRole('dialog', { name: /project selector/i })).getByRole('button', {
        name: /project-a main/i,
      }),
    );
    await waitFor(() => expect(fetchCount(fetchMock, '/api/projects/project-1/overview')).toBe(2));

    await act(async () => {
      slowOverview.resolve(jsonResponse(projectTwoOverviewFixture()));
      slowSessions.resolve(jsonResponse({ sessions: [projectTwoSessionFixture()] }));
      await slowOverview.promise;
      await slowSessions.promise;
    });

    expect(screen.getByRole('button', { name: /project-a main/i })).toBeInTheDocument();
    expect(screen.queryByText('OpenAI')).not.toBeInTheDocument();
    expect(screen.queryByText('Project B stale session')).not.toBeInTheDocument();
  });
});

function storageStub(kind: 'local' | 'session'): Storage {
  const data = () => (kind === 'local' ? localStorageData : sessionStorageData);
  return {
    clear: vi.fn(() => {
      if (kind === 'local') {
        localStorageData = {};
      } else {
        sessionStorageData = {};
      }
    }),
    getItem: vi.fn((key: string) => data()[key] ?? null),
    key: vi.fn((index: number) => Object.keys(data())[index] ?? null),
    removeItem: vi.fn((key: string) => {
      delete data()[key];
    }),
    setItem: vi.fn((key: string, value: string) => {
      data()[key] = value;
    }),
    get length() {
      return Object.keys(data()).length;
    },
  };
}

type MockApiOptions = {
  baseUrl?: string;
  failPlanDetails?: boolean;
  failPlansListOnce?: boolean;
  failTaskDetails?: boolean;
  failLogWindowStartOnce?: number;
  logTotalLines?: number;
  omitOverviewUsageSeries?: boolean;
  overviewUsageSeries?: unknown[];
  plansResponse?: unknown;
  projectDiagnostics?: unknown[];
  projects?: unknown[];
  sessionDetails?: unknown;
  tasksResponse?: unknown;
};

function mockApi(options: MockApiOptions = {}) {
  const baseUrl = options.baseUrl ?? 'http://127.0.0.1:43110';
  let failedLogWindowStart = false;
  let failedPlansList = false;

  return vi.fn(async (input: RequestInfo | URL) => {
    const requestUrl = new URL(String(input), baseUrl);
    const path = requestUrl.pathname;

    if (path === '/api/health') {
      return jsonResponse({
        status: 'ok',
        version: '0.0.1-test',
        serverTime: '2026-05-28T08:00:00.000Z',
        uptime: 1,
      });
    }

    if (path === '/api/projects') {
      return jsonResponse({
        diagnostics: options.projectDiagnostics ?? [],
        projects: options.projects ?? [projectFixture()],
      });
    }

    if (path === '/api/projects/project-1/overview') {
      return jsonResponse({
        project: projectFixture(),
        provider: {
          id: 'provider-1',
          name: 'Anthropic',
          provider: 'anthropic',
          model: 'claude-sonnet',
          baseUrl: 'https://example.com/v1',
          active: true,
          apiKeySet: true,
          authHeaderValueSet: false,
        },
        cards: {
          sessionCount: 1,
          failedSessionCount: 0,
          changedFileCount: 1,
          totalTokens: 30,
          totalCostUsd: 0.25,
          logWarningCount: 1,
          logErrorCount: 0,
        },
        recentSessions: [],
        ...(options.omitOverviewUsageSeries
          ? {}
          : { usageSeries: options.overviewUsageSeries ?? usageSeriesFixture() }),
        diagnostics: [],
      });
    }

    if (path === '/api/projects/project-1/sessions') {
      return jsonResponse({
        sessions: [
          {
            id: 'session-1',
            title: 'Build the API',
            status: 'completed',
            firstTimestamp: '2026-05-28T08:00:00.000Z',
            lastTimestamp: '2026-05-28T08:01:00.000Z',
            modelSet: ['claude-sonnet'],
            changedFiles: ['src/api.ts'],
            tokens: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0 },
            costUsd: 0.25,
            linkedPlanCount: 0,
            linkedTaskCount: 0,
          },
        ],
      });
    }

    if (path === '/api/projects/project-1/sessions/session-1') {
      return jsonResponse(options.sessionDetails ?? sessionDetailsFixture());
    }

    if (path === '/api/projects/project-1/plans') {
      if (options.failPlansListOnce && !failedPlansList) {
        failedPlansList = true;
        return jsonResponse({ error: 'Injected plans failure' }, 500);
      }
      return jsonResponse(options.plansResponse ?? plansFixture());
    }

    if (path === '/api/projects/project-1/plans/launch-plan') {
      if (options.failPlanDetails) {
        return jsonResponse({ error: 'Injected plan detail failure' }, 500);
      }
      return jsonResponse(planDetailsFixture());
    }

    if (path === '/api/projects/project-1/tasks') {
      return jsonResponse(options.tasksResponse ?? tasksFixture());
    }

    if (path === '/api/projects/project-1/tasks/session-1/1') {
      if (options.failTaskDetails) {
        return jsonResponse({ error: 'Injected task detail failure' }, 500);
      }
      return jsonResponse(taskDetailsFixture());
    }

    if (path === '/api/logs/window') {
      const projectId = requestUrl.searchParams.get('projectId');
      const requestedCount = Number(requestUrl.searchParams.get('count') ?? 250);
      const totalLines = options.logTotalLines ?? 1;
      const shouldTail = requestUrl.searchParams.get('tail') === 'true';
      const start = shouldTail
        ? Math.max(0, totalLines - requestedCount)
        : Number(requestUrl.searchParams.get('start') ?? 0);
      if (options.failLogWindowStartOnce === start && !failedLogWindowStart) {
        failedLogWindowStart = true;
        return jsonResponse({ error: 'Injected log failure' }, 500);
      }
      if (projectId && projectId !== 'project-1') {
        return jsonResponse({ ...logsFixture(), files: [], selectedFile: null, entries: [], totalLines: 0 });
      }
      return jsonResponse(logsFixture({
        count: requestedCount,
        start,
        totalLines,
      }));
    }

    if (path === '/api/logs/search') {
      const projectId = requestUrl.searchParams.get('projectId');
      const requestedCount = Number(requestUrl.searchParams.get('count') ?? 250);
      const totalMatches = options.logTotalLines ?? 1;
      const shouldTail = requestUrl.searchParams.get('tail') === 'true';
      const start = shouldTail
        ? Math.max(0, totalMatches - requestedCount)
        : Number(requestUrl.searchParams.get('start') ?? 0);
      if (projectId && projectId !== 'project-1') {
        return jsonResponse({
          ...logsFixture(),
          files: [],
          selectedFile: null,
          entries: [],
          query: requestUrl.searchParams.get('query') ?? '',
          totalLines: 0,
          totalMatches: 0,
        });
      }
      return jsonResponse({
        ...logsFixture({
          count: requestedCount,
          start,
          totalLines: totalMatches,
        }),
        query: requestUrl.searchParams.get('query') ?? '',
        totalMatches,
      });
    }

    return jsonResponse({ error: 'Not found' }, 404);
  });
}

function projectFixture(overrides: Partial<ProjectSummary> = {}): ProjectSummary {
  return {
    id: 'project-1',
    name: 'project-a',
    path: '/tmp/project-a',
    exists: true,
    active: true,
    branch: 'main',
    lastUpdated: 'just now',
    diagnostics: [],
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0.25,
      lastSessionId: 'session-1',
    },
    ...overrides,
  };
}

function usageSeriesFixture() {
  return [
    {
      date: '2026-05-27',
      name: '05-27',
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      sessionCount: 0,
      sessionIds: [],
    },
    {
      date: '2026-05-28',
      name: '05-28',
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 30,
      costUsd: 0.25,
      sessionCount: 1,
      sessionIds: ['session-1'],
    },
  ];
}

function tokenOnlyUsageSeriesFixture() {
  return usageSeriesFixture().map((point) => ({ ...point, costUsd: 0 }));
}

function logsFixture(options: { count?: number; start?: number; totalLines?: number } = {}) {
  const start = options.start ?? 0;
  const totalLines = options.totalLines ?? 1;
  const count = Math.max(0, Math.min(options.count ?? 250, totalLines - start));
  const entries = totalLines === 1
    ? [
        {
          id: 'session-1.txt:1',
          lineNumber: 1,
          timestamp: '2026-05-28T08:00:00.000Z',
          level: 'warn' as const,
          message: 'OPENAI_API_KEY=<redacted> slow',
        },
      ]
    : Array.from({ length: count }, (_, index) => {
        const lineNumber = start + index + 1;
        return {
          id: `session-1.txt:${lineNumber}`,
          lineNumber,
          timestamp: '2026-05-28T08:00:00.000Z',
          level: 'info' as const,
          message: `line-${lineNumber}`,
        };
      });

  return {
    files: [
      {
        name: 'session-1.txt',
        sizeBytes: 72,
        modifiedAt: '2026-05-28T08:00:00.000Z',
        sessionId: 'session-1',
      },
    ],
    selectedFile: {
      name: 'session-1.txt',
      sizeBytes: 72,
      modifiedAt: '2026-05-28T08:00:00.000Z',
      sessionId: 'session-1',
    },
    entries,
    start,
    count: options.count ?? 250,
    totalLines,
    diagnostics: [],
  };
}

function plansFixture() {
  return {
    project: { id: 'project-1', name: 'project-a', path: '/tmp/project-a', exists: true },
    plansDir: '/tmp/.openclaude/plans',
    exists: true,
    plans: [
      {
        id: 'launch-plan',
        title: 'Launch plan',
        exists: true,
        modifiedAt: '2026-05-28T08:00:00.000Z',
        sizeBytes: 96,
        wordCount: 8,
        lineCount: 5,
        preview: 'Review release checklist',
        checklist: { total: 2, completed: 1, pending: 1 },
        sessionIds: ['session-1'],
        sessions: [
          {
            id: 'session-1',
            title: 'Build the API',
            lastTimestamp: '2026-05-28T08:01:00.000Z',
          },
        ],
        latestSessionAt: '2026-05-28T08:01:00.000Z',
      },
    ],
    diagnostics: [],
  };
}

function planDetailsFixture() {
  return {
    plan: {
      ...plansFixture().plans[0]!,
      content: '# Launch plan\n\nReview release checklist\n\n- [x] Build\n- [ ] Publish\n',
    },
    diagnostics: [],
  };
}

function tasksFixture() {
  return {
    project: { id: 'project-1', name: 'project-a', path: '/tmp/project-a', exists: true },
    tasksDir: '/tmp/.openclaude/tasks',
    exists: true,
    tasks: [
      {
        id: 'session-1:1',
        taskId: '1',
        title: 'Ship task',
        status: 'in_progress',
        description: 'Prepare the public release',
        activeForm: 'Working',
        sessionId: 'session-1',
        sessionTitle: 'Build the API',
        modifiedAt: '2026-05-28T08:02:00.000Z',
        sizeBytes: 128,
      },
    ],
    diagnostics: [],
  };
}

function taskDetailsFixture() {
  return {
    task: {
      ...tasksFixture().tasks[0]!,
      content: JSON.stringify(
        {
          subject: 'Ship task',
          status: 'in_progress',
          description: 'Prepare the public release',
          activeForm: 'Working',
        },
        null,
        2,
      ),
    },
    diagnostics: [],
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
    status,
  });
}

function mockApiWithSlowProjectTwo(slowOverview: Promise<Response>, slowSessions: Promise<Response>) {
  const baseUrl = 'http://127.0.0.1:43110';
  const projectTwo = projectFixture({
    id: 'project-2',
    name: 'project-b',
    path: '/tmp/project-b',
    active: false,
    branch: 'feature',
  });

  return vi.fn((input: RequestInfo | URL) => {
    const requestUrl = new URL(String(input), baseUrl);
    const path = requestUrl.pathname;

    if (path === '/api/health') {
      return Promise.resolve(
        jsonResponse({
          status: 'ok',
          version: '0.0.1-test',
          serverTime: '2026-05-28T08:00:00.000Z',
          uptime: 1,
        }),
      );
    }

    if (path === '/api/projects') {
      return Promise.resolve(jsonResponse({ diagnostics: [], projects: [projectFixture(), projectTwo] }));
    }

    if (path === '/api/projects/project-1/overview') {
      return Promise.resolve(
        jsonResponse({
          project: projectFixture(),
          provider: {
            id: 'provider-1',
            name: 'Anthropic',
            provider: 'anthropic',
            model: 'claude-sonnet',
            baseUrl: 'https://example.com/v1',
            active: true,
            apiKeySet: true,
            authHeaderValueSet: false,
          },
          cards: {
            sessionCount: 1,
            failedSessionCount: 0,
            changedFileCount: 1,
            totalTokens: 30,
            totalCostUsd: 0.25,
            logWarningCount: 1,
            logErrorCount: 0,
          },
          recentSessions: [],
          usageSeries: usageSeriesFixture(),
          diagnostics: [],
        }),
      );
    }

    if (path === '/api/projects/project-1/sessions') {
      return Promise.resolve(jsonResponse({ sessions: [projectOneSessionFixture()] }));
    }

    if (path === '/api/projects/project-2/overview') {
      return slowOverview;
    }

    if (path === '/api/projects/project-2/sessions') {
      return slowSessions;
    }

    if (path === '/api/logs/window') {
      return Promise.resolve(jsonResponse(logsFixture()));
    }

    return Promise.resolve(jsonResponse({ error: 'Not found' }, 404));
  });
}

function projectOneSessionFixture() {
  return {
    id: 'session-1',
    title: 'Build the API',
    status: 'completed',
    firstTimestamp: '2026-05-28T08:00:00.000Z',
    lastTimestamp: '2026-05-28T08:01:00.000Z',
    modelSet: ['claude-sonnet'],
    changedFiles: ['src/api.ts'],
    tokens: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0 },
    costUsd: 0.25,
    linkedPlanCount: 0,
    linkedTaskCount: 0,
  };
}

function sessionDetailsFixture() {
  return {
    session: {
      ...projectOneSessionFixture(),
      messageCount: 2,
      toolsUsed: [{ name: 'Bash', count: 1 }],
      fileHistoryAvailable: true,
      fileHistory: [
        {
          filePath: 'src/api.ts',
          backupFileName: 'abc123@v1',
          version: 1,
          backupTime: '2026-05-28T08:00:30.000Z',
          backupExists: true,
        },
      ],
      linkedTasks: [
        {
          id: '1',
          title: 'Build API endpoint',
          status: 'completed',
          description: 'Expose session details',
          activeForm: null,
        },
      ],
      linkedPlans: [
        {
          slug: 'session-details',
          title: 'Session Details',
          exists: true,
        },
      ],
    },
    timeline: [
      {
        id: 'session-1-0-user',
        timestamp: '2026-05-28T08:00:00.000Z',
        kind: 'user',
        title: 'User message',
        content: 'Build the API',
      },
      {
        id: 'session-1-1-assistant',
        timestamp: '2026-05-28T08:00:10.000Z',
        kind: 'assistant',
        title: 'claude-sonnet',
        content: 'I will run the tests.',
      },
      {
        id: 'session-1-2-tool',
        timestamp: '2026-05-28T08:00:20.000Z',
        kind: 'tool',
        title: 'Run command',
        content: 'npm test',
        tool: {
          phase: 'call',
          name: 'Bash',
          status: 'unknown',
          command: 'npm test',
          filePath: null,
          outputType: 'command',
        },
      },
      {
        id: 'session-1-3-tool',
        timestamp: '2026-05-28T08:00:30.000Z',
        kind: 'tool',
        title: 'Command output',
        content: 'ok',
        tool: {
          phase: 'result',
          name: 'Bash',
          status: 'success',
          command: 'npm test',
          filePath: null,
          outputType: 'stdout',
        },
      },
    ],
  };
}

function legacySessionDetailsFixture() {
  const full = sessionDetailsFixture();
  return {
    ...full,
    timeline: [
      {
        id: 42,
        timestamp: 'not-a-date',
        kind: 'tool',
        title: null,
        content: null,
        tool: {
          phase: 'invalid',
          name: 42,
          status: 'invalid',
          command: 42,
          filePath: 42,
          outputType: 'invalid',
        },
      },
    ],
    session: {
      ...full.session,
      modelSet: undefined,
      changedFiles: undefined,
      tokens: undefined,
      toolsUsed: undefined,
      fileHistory: undefined,
      linkedTasks: undefined,
      linkedPlans: undefined,
    },
  };
}

function repeatedFileHistorySessionDetailsFixture() {
  const full = sessionDetailsFixture();
  return {
    ...full,
    session: {
      ...full.session,
      fileHistory: [
        {
          filePath: 'docs/specs/2026-04-23-jinx-full-app-design.md',
          backupFileName: 'jinx-design@v1',
          version: 1,
          backupTime: '2026-04-23T02:36:00.000Z',
          backupExists: true,
        },
        {
          filePath: 'docs/specs/2026-04-23-jinx-full-app-design.md',
          backupFileName: 'jinx-design@v2',
          version: 2,
          backupTime: '2026-04-23T02:37:00.000Z',
          backupExists: true,
        },
        {
          filePath: 'docs/specs/2026-04-23-jinx-full-app-design.md',
          backupFileName: 'jinx-design@v2',
          version: 2,
          backupTime: '2026-04-23T02:37:00.000Z',
          backupExists: true,
        },
      ],
    },
  };
}

function projectTwoOverviewFixture() {
  return {
    project: projectFixture({
      id: 'project-2',
      name: 'project-b',
      path: '/tmp/project-b',
      active: false,
      branch: 'feature',
    }),
    provider: {
      id: 'provider-2',
      name: 'OpenAI',
      provider: 'openai',
      model: 'gpt-5',
      baseUrl: 'https://example.com/v1',
      active: true,
      apiKeySet: true,
      authHeaderValueSet: false,
    },
    cards: {
      sessionCount: 1,
      failedSessionCount: 0,
      changedFileCount: 1,
      totalTokens: 20,
      totalCostUsd: 0.1,
      logWarningCount: 0,
      logErrorCount: 0,
    },
    recentSessions: [],
    usageSeries: [
      {
        date: '2026-05-28',
        name: '05-28',
        inputTokens: 10,
        outputTokens: 10,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 20,
        costUsd: 0.1,
        sessionCount: 1,
        sessionIds: ['session-2'],
      },
    ],
    diagnostics: [],
  };
}

function projectTwoSessionFixture() {
  return {
    id: 'session-2',
    title: 'Project B stale session',
    status: 'completed',
    firstTimestamp: '2026-05-28T08:02:00.000Z',
    lastTimestamp: '2026-05-28T08:03:00.000Z',
    modelSet: ['gpt-5'],
    changedFiles: ['src/other.ts'],
    tokens: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 },
    costUsd: 0.1,
    linkedPlanCount: 0,
    linkedTaskCount: 0,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function wasFetched(fetchMock: ReturnType<typeof vi.fn>, path: string): boolean {
  return fetchMock.mock.calls.some(([input]) => String(input).endsWith(path));
}

function fetchCount(fetchMock: ReturnType<typeof vi.fn>, path: string): number {
  return fetchMock.mock.calls.filter(([input]) => String(input).endsWith(path)).length;
}

function fetchCountByPath(fetchMock: ReturnType<typeof vi.fn>, path: string): number {
  return fetchMock.mock.calls.filter(([input]) => new URL(String(input)).pathname === path).length;
}

function wasFetchedWithQuery(
  fetchMock: ReturnType<typeof vi.fn>,
  path: string,
  key: string,
  value: string,
): boolean {
  return fetchMock.mock.calls.some(([input]) => {
    const url = new URL(String(input));
    return url.pathname === path && url.searchParams.get(key) === value;
  });
}
