import { readFileSync } from 'node:fs';

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

type TextQueryScope = Pick<typeof screen, 'getAllByText'>;

function getLoadingLiveRegion(label: string, scope: TextQueryScope = screen): HTMLElement {
  const liveRegion = scope
    .getAllByText(label)
    .map((element) => element.closest('[aria-live="polite"]'))
    .find((element): element is HTMLElement => element instanceof HTMLElement);

  if (!liveRegion) {
    throw new Error(`Unable to find aria-live loading region for "${label}"`);
  }

  return liveRegion;
}

function getLoadingOverlay(label: string, scope: TextQueryScope = screen): HTMLElement {
  const overlay = getLoadingLiveRegion(label, scope).closest('.loading-overlay');
  if (!(overlay instanceof HTMLElement)) {
    throw new Error(`Unable to find loading overlay for "${label}"`);
  }
  return overlay;
}

function getPageHeader(title: string): HTMLElement {
  const header = screen.getByRole('heading', { name: title }).closest('header');
  if (!(header instanceof HTMLElement)) {
    throw new Error(`Unable to find page header for "${title}"`);
  }
  return header;
}

async function findLoadingLiveRegion(label: string, scope: TextQueryScope = screen): Promise<HTMLElement> {
  await waitFor(() => expect(getLoadingLiveRegion(label, scope)).toBeInTheDocument());
  return getLoadingLiveRegion(label, scope);
}

describe('App', () => {
  test('does not reference undefined CSS custom properties', () => {
    const css = readFileSync('src/index.css', 'utf8');
    const definedProperties = new Set([...css.matchAll(/(--[A-Za-z0-9_-]+)\s*:/g)].map((match) => match[1]));
    const referencedProperties = [...css.matchAll(/var\((--[A-Za-z0-9_-]+)/g)].map((match) => match[1]);
    const undefinedReferences = [...new Set(referencedProperties.filter((property) => !definedProperties.has(property)))];

    expect(undefinedReferences).toEqual([]);
  });

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
    fireEvent.focus(within(projectOverview!).getByLabelText('2026-05-28: $0.25'));
    const tooltip = await within(projectOverview!).findByRole('tooltip');
    expect(within(tooltip).getByText('Recorded cost')).toBeInTheDocument();
    expect(within(tooltip).getAllByText('$0.25').length).toBeGreaterThan(0);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:43110/api/projects',
      expect.objectContaining({ headers: { accept: 'application/json' } }),
    );
  });

  test('shows an accessible workspace loading indicator while the initial project request is pending', async () => {
    const slowProjects = deferred<Response>();
    const fetchMock = mockApi({ projectsPromiseOnce: slowProjects.promise });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    const workspaceLoadingRegion = await findLoadingLiveRegion('Loading workspace');
    expect(within(workspaceLoadingRegion).queryByRole('progressbar')).not.toBeInTheDocument();
    expect(screen.queryByText('No project selected')).not.toBeInTheDocument();

    await act(async () => {
      slowProjects.resolve(jsonResponse({ diagnostics: [], projects: [projectFixture()] }));
      await slowProjects.promise;
    });

    expect(await screen.findByRole('button', { name: /project-a main/i })).toBeInTheDocument();
  });

  test('keeps a workspace refresh indicator over all control center data blocks', async () => {
    const slowProjects = deferred<Response>();
    const defaultApi = mockApi();
    let projectRequestCount = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const requestUrl = new URL(String(input), 'http://127.0.0.1:43110');
      if (requestUrl.pathname === '/api/projects') {
        projectRequestCount += 1;
        if (projectRequestCount === 2) {
          return slowProjects.promise;
        }
      }
      return defaultApi(input);
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(<App />);

    await screen.findByRole('button', { name: /project-a main/i });
    expect(screen.getByText('Project Overview')).toBeInTheDocument();
    expect(screen.getByText('Active Provider')).toBeInTheDocument();
    expect(screen.getByText('Recent Sessions')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /refresh project list/i }));
    await waitFor(() => expect(projectRequestCount).toBe(2));

    const refreshButton = screen.getByRole('button', { name: /refresh project list/i });
    expect(refreshButton.querySelector('.animate-spin')).toBeInTheDocument();

    const controlCenterContent = document.querySelector('.control-center-content');
    expect(controlCenterContent).toBeInstanceOf(HTMLElement);
    const workspaceOverlay = getLoadingOverlay('Refreshing workspace', within(controlCenterContent as HTMLElement));
    const pageHeader = getPageHeader('Control Center');
    expect(within(pageHeader).queryByText('Refreshing workspace')).not.toBeInTheDocument();
    expect(pageHeader.querySelector('.animate-spin')).not.toBeInTheDocument();
    expect(within(pageHeader).getByText('project-a / main')).toBeInTheDocument();
    expect(controlCenterContent).toContainElement(workspaceOverlay);
    expect(controlCenterContent).toContainElement(screen.getByText('Project Overview'));
    expect(controlCenterContent).toContainElement(screen.getByText('Active Provider'));
    expect(controlCenterContent).toContainElement(screen.getByText('Recent Sessions'));

    await act(async () => {
      slowProjects.resolve(jsonResponse({ diagnostics: [], projects: [projectFixture()] }));
      await slowProjects.promise;
    });

    await waitFor(() => expect(screen.queryByText('Refreshing workspace')).not.toBeInTheDocument());
  });

  test('labels the compact server status while the health check is pending', async () => {
    const slowHealth = deferred<Response>();
    const api = mockApi();
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const requestUrl = new URL(String(input), 'http://127.0.0.1:43110');
      if (requestUrl.pathname === '/api/health') {
        return slowHealth.promise;
      }
      return api(input);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    expect(screen.getByLabelText('Checking server')).toBeInTheDocument();

    await act(async () => {
      slowHealth.resolve(jsonResponse({
        status: 'ok',
        version: '0.0.1-test',
        serverTime: '2026-05-28T08:00:00.000Z',
        uptime: 1,
      }));
      await slowHealth.promise;
    });

    expect(await screen.findByLabelText('Server connected v0.0.1-test')).toBeInTheDocument();
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
    fireEvent.focus(within(projectOverview!).getByLabelText('2026-05-27: $0.00'));
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

  test('shows an accessible sessions loading indicator instead of an empty table while sessions are pending', async () => {
    window.history.pushState(null, '', '/sessions');
    const slowSessions = deferred<Response>();
    const fetchMock = mockApi({ sessionsPromiseOnce: slowSessions.promise });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await waitFor(() => expect(wasFetched(fetchMock, '/api/projects/project-1/sessions')).toBe(true));
    const sessionsLoadingOverlay = getLoadingOverlay('Loading sessions');
    const sessionsPanel = sessionsLoadingOverlay.closest('section');
    expect(sessionsPanel).not.toBeNull();
    expect(sessionsPanel).toContainElement(sessionsLoadingOverlay);
    expect(sessionsLoadingOverlay.querySelector('.loading-overlay-card')).toBeInTheDocument();
    expect(screen.queryByText('No sessions found')).not.toBeInTheDocument();

    await act(async () => {
      slowSessions.resolve(jsonResponse({ sessions: [projectOneSessionFixture()] }));
      await slowSessions.promise;
    });

    expect(await screen.findByText('Build the API')).toBeInTheDocument();
  });

  test('keeps the sessions loading indicator over the loaded sessions section during refreshes', async () => {
    window.history.pushState(null, '', '/sessions');
    const slowRefreshSessions = deferred<Response>();
    const defaultApi = mockApi();
    let sessionsRequestCount = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const requestUrl = new URL(String(input), 'http://127.0.0.1:43110');
      if (requestUrl.pathname === '/api/projects/project-1/sessions') {
        sessionsRequestCount += 1;
        if (sessionsRequestCount === 2) {
          return slowRefreshSessions.promise;
        }
      }
      return defaultApi(input);
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(<App />);

    expect(await screen.findByText('Build the API')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /refresh project list/i }));
    await waitFor(() => expect(sessionsRequestCount).toBe(2));

    const sessionsTable = screen.getByRole('table');
    const sessionsLoadingOverlay = getLoadingOverlay('Loading sessions');
    const sessionsPanel = sessionsTable.closest('section');
    expect(sessionsPanel).not.toBeNull();
    expect(sessionsPanel).toContainElement(sessionsTable);
    expect(sessionsPanel).toContainElement(sessionsLoadingOverlay);

    await act(async () => {
      slowRefreshSessions.resolve(jsonResponse({ sessions: [projectOneSessionFixture()] }));
      await slowRefreshSessions.promise;
    });

    await waitFor(() => expect(screen.queryByText('Loading sessions')).not.toBeInTheDocument());
  });

  test('renders provider profile management and opens a template-driven add profile modal', async () => {
    const fetchMock = mockApi({ providerProfilesResponse: providerProfilesFixture() });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    const writeText = vi.spyOn(window.navigator.clipboard, 'writeText').mockResolvedValue(undefined);

    render(<App />);

    await screen.findByRole('button', { name: /project-a main/i });
    await user.click(screen.getAllByRole('link', { name: /^Providers$/i })[0]!);

    expect(await screen.findByRole('heading', { name: 'Providers' })).toBeInTheDocument();
    expect(await screen.findByText('Provider Profiles')).toBeInTheDocument();
    expect(screen.getByText('2 profiles')).toBeInTheDocument();
    expect(screen.getByText('OpenAI Team')).toBeInTheDocument();
    expect(screen.getByText('Local Lab')).toBeInTheDocument();
    expect(screen.getByText('Needs review')).toBeInTheDocument();
    expect(screen.getByText('No saved credential is visible in this profile.')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /openclaude command for openai team/i })).toHaveValue(
      'openclaude --provider openai --model gpt-example',
    );
    expect(screen.getByRole('textbox', { name: /openclaude command for local lab/i })).toHaveValue(
      'OPENAI_BASE_URL=http://127.0.0.1:11434/v1 openclaude --provider openai --model local-model',
    );
    await user.click(screen.getByRole('button', { name: /copy openclaude command for local lab/i }));
    expect(writeText).toHaveBeenCalledWith(
      'OPENAI_BASE_URL=http://127.0.0.1:11434/v1 openclaude --provider openai --model local-model',
    );
    expect(screen.queryByText('Safe Templates')).not.toBeInTheDocument();
    const addProviderButtons = screen.getAllByRole('button', { name: /add provider profile/i });
    expect(addProviderButtons).toHaveLength(1);

    await user.click(addProviderButtons[0]!);

    const dialog = await screen.findByRole('dialog', { name: /new provider profile/i });
    expect(within(dialog).getByText('Choose a provider template')).toBeInTheDocument();
    expect(within(dialog).getByText('Start from a safe preset, then review the generated fields below.')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /template.*openai gpt/i })).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: /^ollama$/i })).not.toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: /template.*openai gpt/i }));
    const templateListbox = within(dialog).getByRole('listbox', { name: /provider template/i });
    expect(within(templateListbox).getByRole('option', { name: /codex oauth \/ codexplan/i })).toBeInTheDocument();
    await user.click(within(templateListbox).getByRole('option', { name: /ollama/i }));
    expect(within(dialog).getByRole('button', { name: /template.*ollama/i })).toBeInTheDocument();
    await user.clear(within(dialog).getByLabelText(/profile name/i));
    await user.type(within(dialog).getByLabelText(/profile name/i), 'Lab Ollama');
    await user.clear(within(dialog).getByLabelText(/model/i));
    await user.type(within(dialog).getByLabelText(/model/i), 'qwen2.5-coder:7b');
    await user.click(within(dialog).getByLabelText(/make active/i));

    expect(within(dialog).getByLabelText(/generated openclaude command/i)).toHaveValue(
      'openclaude --provider ollama --model qwen2.5-coder:7b',
    );
    await user.clear(within(dialog).getByLabelText(/base url/i));
    await user.type(within(dialog).getByLabelText(/base url/i), 'http://localhost:11435/v1');
    expect(within(dialog).getByLabelText(/generated openclaude command/i)).toHaveValue(
      'OPENAI_BASE_URL=http://localhost:11435/v1 openclaude --provider ollama --model qwen2.5-coder:7b',
    );
    await user.click(within(dialog).getByRole('button', { name: /copy command/i }));
    expect(writeText).toHaveBeenCalledWith(
      'OPENAI_BASE_URL=http://localhost:11435/v1 openclaude --provider ollama --model qwen2.5-coder:7b',
    );

    await user.click(within(dialog).getByText(/advanced provider settings/i));
    await user.type(within(dialog).getByLabelText(/custom headers/i), 'Authorization: Bearer private\nX-Team: platform');
    expect(within(dialog).getByText(/sensitive-looking custom header names are omitted/i)).toBeInTheDocument();

    const generatedJson = within(dialog).getByLabelText(/generated provider profile json/i);
    expect(generatedJson).toHaveTextContent('"provider": "ollama"');
    expect(generatedJson).toHaveTextContent('"model": "qwen2.5-coder:7b"');
    expect(generatedJson).toHaveTextContent('"baseUrl": "http://localhost:11435/v1"');
    expect(generatedJson).toHaveTextContent('"X-Team": "platform"');
    expect(generatedJson).not.toHaveTextContent('Authorization');
    expect(within(dialog).queryByText(/apiKey/)).not.toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: /copy safe json/i }));

    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('"provider": "ollama"'));
    expect(writeText.mock.calls.at(-1)?.[0]).not.toContain('apiKey');
    expect(writeText.mock.calls.at(-1)?.[0]).not.toContain('authHeaderValue');
    expect(writeText.mock.calls.at(-1)?.[0]).not.toContain('"activeProviderProfileId"');
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:43110/api/provider/profiles',
      expect.objectContaining({ headers: { accept: 'application/json' } }),
    );
  });

  test('shows an accessible provider profile loading indicator while provider profiles are pending', async () => {
    const slowProfiles = deferred<Response>();
    const fetchMock = mockApi({ providerProfilesPromiseOnce: slowProfiles.promise });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(<App />);

    await screen.findByRole('button', { name: /project-a main/i });
    await user.click(screen.getAllByRole('link', { name: /^Providers$/i })[0]!);

    await waitFor(() => expect(wasFetched(fetchMock, '/api/provider/profiles')).toBe(true));
    const pageHeader = getPageHeader('Providers');
    expect(within(pageHeader).queryByText('Loading provider profiles')).not.toBeInTheDocument();
    expect(pageHeader.querySelector('.animate-spin')).not.toBeInTheDocument();
    const providerOverlay = getLoadingOverlay('Loading provider profiles');
    const providerPanel = screen.getByText('Provider Profiles').closest('section');
    expect(providerPanel).not.toBeNull();
    expect(providerPanel).toContainElement(providerOverlay);

    await act(async () => {
      slowProfiles.resolve(jsonResponse(providerProfilesFixture()));
      await slowProfiles.promise;
    });

    expect(await screen.findByText('OpenAI Team')).toBeInTheDocument();
  });

  test('keeps a workspace refresh indicator over the providers page content', async () => {
    const slowProjects = deferred<Response>();
    const defaultApi = mockApi();
    let projectRequestCount = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const requestUrl = new URL(String(input), 'http://127.0.0.1:43110');
      if (requestUrl.pathname === '/api/projects') {
        projectRequestCount += 1;
        if (projectRequestCount === 2) {
          return slowProjects.promise;
        }
      }
      return defaultApi(input);
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(<App />);

    await screen.findByRole('button', { name: /project-a main/i });
    await user.click(screen.getAllByRole('link', { name: /^Providers$/i })[0]!);
    expect(await screen.findByText('OpenAI Team')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /refresh project list/i }));
    await waitFor(() => expect(projectRequestCount).toBe(2));

    const providerOverlay = getLoadingOverlay('Refreshing workspace');
    const providerPanel = screen.getByText('Provider Profiles').closest('section');
    expect(providerPanel).not.toBeNull();
    expect(providerPanel).toContainElement(providerOverlay);

    await act(async () => {
      slowProjects.resolve(jsonResponse({ diagnostics: [], projects: [projectFixture()] }));
      await slowProjects.promise;
    });

    await waitFor(() => expect(screen.queryByText('Refreshing workspace')).not.toBeInTheDocument());
  });

  test('shows a degraded provider profile state for older local servers', async () => {
    vi.stubGlobal('fetch', mockApi({ providerProfilesStatus: 404 }));
    const user = userEvent.setup();

    render(<App />);

    await screen.findByRole('button', { name: /project-a main/i });
    await user.click(screen.getAllByRole('link', { name: /^Providers$/i })[0]!);

    expect(await screen.findByText('Provider profile management requires a newer local server')).toBeInTheDocument();
    expect(screen.getByText('Active Provider')).toBeInTheDocument();
    expect(screen.getByText('Anthropic')).toBeInTheDocument();
  });

  test('keeps provider diagnostics visible when no profiles are configured', async () => {
    vi.stubGlobal('fetch', mockApi({
      providerProfilesResponse: {
        ...providerProfilesFixture(),
        activeProviderProfileId: null,
        summary: {
          total: 0,
          active: 0,
          valid: 0,
          warnings: 0,
          errors: 0,
          templates: 3,
        },
        diagnostics: [{ level: 'warn', message: 'No provider profiles are configured.' }],
        profiles: [],
      },
    }));
    const user = userEvent.setup();

    render(<App />);

    await screen.findByRole('button', { name: /project-a main/i });
    await user.click(screen.getAllByRole('link', { name: /^Providers$/i })[0]!);

    expect(await screen.findByText('No provider profiles are configured.')).toBeInTheDocument();
    expect(screen.getByText('No provider profiles configured')).toBeInTheDocument();
    expect(screen.queryByText('Safe Templates')).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /add provider profile/i })).toHaveLength(1);
  });

  test('renders legacy partial provider profile payloads without crashing', async () => {
    vi.stubGlobal('fetch', mockApi({
      providerProfilesResponse: {
        path: '/tmp/.openclaude.json',
        exists: true,
        activeProviderProfileId: null,
        sensitiveFieldsRedacted: true,
      },
    }));
    const user = userEvent.setup();

    render(<App />);

    await screen.findByRole('button', { name: /project-a main/i });
    await user.click(screen.getAllByRole('link', { name: /^Providers$/i })[0]!);

    expect(await screen.findByRole('heading', { name: 'Providers' })).toBeInTheDocument();
    expect(screen.getByText('0 profiles')).toBeInTheDocument();
    expect(screen.getByText('0 templates')).toBeInTheDocument();
    expect(screen.getByText('No provider profiles configured')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /add provider profile/i })).not.toBeInTheDocument();
    expect(screen.queryByText('Provider profile management requires a newer local server')).not.toBeInTheDocument();
  });

  test('renders non-object provider profile payloads without crashing', async () => {
    vi.stubGlobal('fetch', mockApi({ providerProfilesResponse: null }));
    const user = userEvent.setup();

    render(<App />);

    await screen.findByRole('button', { name: /project-a main/i });
    await user.click(screen.getAllByRole('link', { name: /^Providers$/i })[0]!);

    expect(await screen.findByRole('heading', { name: 'Providers' })).toBeInTheDocument();
    expect(screen.getByText('0 profiles')).toBeInTheDocument();
    expect(screen.getByText('0 templates')).toBeInTheDocument();
    expect(screen.getByText('No provider profiles configured')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /add provider profile/i })).not.toBeInTheDocument();
  });

  test('normalizes malformed provider profile and template entries from partial payloads', async () => {
    vi.stubGlobal('fetch', mockApi({
      providerProfilesResponse: {
        path: '/tmp/.openclaude.json',
        exists: true,
        sensitiveFieldsRedacted: true,
        profiles: [{}],
        templates: [{}],
      },
    }));
    const user = userEvent.setup();

    render(<App />);

    await screen.findByRole('button', { name: /project-a main/i });
    await user.click(screen.getAllByRole('link', { name: /^Providers$/i })[0]!);

    expect(await screen.findByText('Unnamed provider')).toBeInTheDocument();
    expect(screen.getByText('1 profile')).toBeInTheDocument();
    expect(screen.getByText('1 template')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /openclaude command for unnamed provider/i })).toHaveValue(
      'openclaude --provider openai --model MODEL_ID',
    );

    await user.click(screen.getByRole('button', { name: /add provider profile/i }));

    const dialog = await screen.findByRole('dialog', { name: /new provider profile/i });
    expect(within(dialog).getByRole('button', { name: /template.*custom openai-compatible/i })).toBeInTheDocument();
    expect(within(dialog).getByLabelText(/generated openclaude command/i)).toHaveValue(
      'openclaude --provider openai --model MODEL_ID',
    );
  });

  test('preserves unknown provider template ids from newer local servers', async () => {
    const providerProfiles = providerProfilesFixture();

    vi.stubGlobal('fetch', mockApi({
      providerProfilesResponse: {
        ...providerProfiles,
        templates: [
          ...providerProfiles.templates,
          {
            id: 'future-provider',
            label: 'Future Provider',
            category: 'hosted',
            description: 'Newer local server template.',
            provider: 'openai',
            baseUrl: 'https://future.example/v1',
            model: 'future-model',
            modelPlaceholder: 'Future model id',
            requiresSecret: false,
            requiredFields: ['name', 'provider', 'baseUrl', 'model'],
            advancedFields: [],
            apiFormat: null,
            authHeader: null,
            authScheme: null,
            customHeaders: [],
            credential: null,
          },
        ],
      },
    }));
    const user = userEvent.setup();

    render(<App />);

    await screen.findByRole('button', { name: /project-a main/i });
    await user.click(screen.getAllByRole('link', { name: /^Providers$/i })[0]!);
    await user.click(await screen.findByRole('button', { name: /add provider profile/i }));

    const dialog = await screen.findByRole('dialog', { name: /new provider profile/i });
    await user.click(within(dialog).getByRole('button', { name: /template.*openai gpt/i }));

    expect(within(dialog).getByRole('option', { name: /future provider/i })).toBeInTheDocument();

    await user.click(within(dialog).getByRole('option', { name: /future provider/i }));

    expect(within(dialog).getByRole('button', { name: /template.*future provider/i })).toBeInTheDocument();
    expect(within(dialog).getByLabelText(/generated openclaude command/i)).toHaveValue(
      'OPENAI_BASE_URL=https://future.example/v1 openclaude --provider openai --model future-model',
    );
  });

  test('keeps the add provider dialog open when Escape closes the template selector', async () => {
    vi.stubGlobal('fetch', mockApi({ providerProfilesResponse: providerProfilesFixture() }));
    const user = userEvent.setup();

    render(<App />);

    await screen.findByRole('button', { name: /project-a main/i });
    await user.click(screen.getAllByRole('link', { name: /^Providers$/i })[0]!);
    await user.click(await screen.findByRole('button', { name: /add provider profile/i }));

    const dialog = await screen.findByRole('dialog', { name: /new provider profile/i });
    await user.click(within(dialog).getByRole('button', { name: /template.*openai gpt/i }));
    expect(within(dialog).getByRole('listbox', { name: /provider template/i })).toBeInTheDocument();

    await user.keyboard('{Escape}');

    expect(dialog).toBeInTheDocument();
    expect(within(dialog).queryByRole('listbox', { name: /provider template/i })).not.toBeInTheDocument();

    await user.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('dialog', { name: /new provider profile/i })).not.toBeInTheDocument());
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
    expect(within(dialog).queryByRole('tab', { name: /artifacts/i })).not.toBeInTheDocument();
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

  test('lazy-loads and renders a session change review from the details modal', async () => {
    const fetchMock = mockApi();
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    const writeText = vi.spyOn(window.navigator.clipboard, 'writeText').mockResolvedValue(undefined);

    render(<App />);

    await screen.findByRole('button', { name: /project-a main/i });
    await user.click(screen.getAllByRole('link', { name: /^Sessions$/i })[0]!);
    await user.click(screen.getByLabelText('Open details for Build the API'));

    const dialog = await screen.findByRole('dialog', { name: /session details/i });
    expect(fetchCountByPath(fetchMock, '/api/projects/project-1/sessions/session-1/changes')).toBe(0);

    await user.click(within(dialog).getByRole('tab', { name: /review changes/i }));

    expect(await within(dialog).findByRole('navigation', { name: /changed files/i })).toBeInTheDocument();
    expect(within(dialog).getByRole('region', { name: /file diffs/i })).toBeInTheDocument();
    expect(within(dialog).getByRole('tabpanel', { name: /review changes/i })).toBeVisible();
    expect(within(dialog).getByRole('tab', { name: /review changes/i })).toHaveAttribute('aria-controls');
    const changedFiles = within(dialog).getByRole('navigation', { name: /changed files/i });
    expect(within(changedFiles).getByRole('button', { name: /src folder/i })).toHaveAttribute('aria-expanded', 'true');
    expect(within(changedFiles).getByRole('button', { name: /^src\/api\.ts$/i })).toHaveAttribute('aria-current', 'true');
    expect(within(dialog).queryByText('1 diffable')).not.toBeInTheDocument();
    expect(within(dialog).getByText('1 changed file')).toBeInTheDocument();
    expect(within(dialog).getAllByText('+1').length).toBeGreaterThan(0);
    expect(within(dialog).getAllByText('-1').length).toBeGreaterThan(0);
    expect(within(dialog).getByText('Large change')).toBeInTheDocument();
    expect(within(dialog).getByText(/Edit file/)).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Diff for src/api.ts')).toBeInTheDocument();
    expect(within(dialog).getByText('@@ -1,2 +1,2 @@')).toBeInTheDocument();
    expect(within(dialog).getByText('export const value = 0;')).toBeInTheDocument();
    expect(within(dialog).getByText('export const value = 1;')).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: /hide file tree/i }));
    expect(within(dialog).queryByRole('navigation', { name: /changed files/i })).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /show file tree/i })).toHaveAttribute('aria-expanded', 'false');
    expect(within(dialog).getByLabelText('Diff for src/api.ts')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: /show file tree/i }));
    expect(within(dialog).getByRole('navigation', { name: /changed files/i })).toBeInTheDocument();

    await user.click(within(dialog).getByRole('tab', { name: /review changes/i }));
    await user.keyboard('{ArrowLeft}');
    await waitFor(() => expect(within(dialog).getByRole('tab', { name: /conversation/i })).toHaveFocus());
    expect(within(dialog).getByRole('tabpanel', { name: /conversation/i })).toBeVisible();
    await user.keyboard('{ArrowRight}');
    await waitFor(() => expect(within(dialog).getByRole('tab', { name: /review changes/i })).toHaveFocus());

    await user.click(within(dialog).getByRole('button', { name: /copy diff for src\/api\.ts/i }));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('+export const value = 1;'));
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:43110/api/projects/project-1/sessions/session-1/changes',
      expect.objectContaining({ headers: { accept: 'application/json' } }),
    );
  });

  test('shows an accessible session details loading indicator while session details are pending', async () => {
    const slowSessionDetails = deferred<Response>();
    vi.stubGlobal('fetch', mockApi({ sessionDetailsPromiseOnce: slowSessionDetails.promise }));
    const user = userEvent.setup();

    render(<App />);

    await screen.findByRole('button', { name: /project-a main/i });
    await user.click(screen.getAllByRole('link', { name: /^Sessions$/i })[0]!);
    await user.click(screen.getByRole('row', { name: /open details for build the api/i }));

    const dialog = await screen.findByRole('dialog', { name: 'Session Details' });
    const sessionDetailsOverlay = getLoadingOverlay('Loading session details', within(dialog));
    expect(dialog).toContainElement(sessionDetailsOverlay);
    expect(sessionDetailsOverlay.querySelector('.loading-overlay-card')).toBeInTheDocument();

    await act(async () => {
      slowSessionDetails.resolve(jsonResponse(sessionDetailsFixture()));
      await slowSessionDetails.promise;
    });

    expect(await screen.findByRole('dialog', { name: 'Session Details' })).toBeInTheDocument();
  });

  test('shows an accessible change review loading indicator while change review data is pending', async () => {
    const slowChangeReview = deferred<Response>();
    vi.stubGlobal('fetch', mockApi({ sessionChangesPromiseOnce: slowChangeReview.promise }));
    const user = userEvent.setup();

    render(<App />);

    await screen.findByRole('button', { name: /project-a main/i });
    await user.click(screen.getAllByRole('link', { name: /^Sessions$/i })[0]!);
    await user.click(screen.getByRole('row', { name: /open details for build the api/i }));
    const dialog = await screen.findByRole('dialog', { name: 'Session Details' });
    await user.click(within(dialog).getByRole('tab', { name: /review changes/i }));

    const changeReviewOverlay = getLoadingOverlay('Loading change review', within(dialog));
    expect(within(dialog).getByRole('tabpanel', { name: /review changes/i })).toContainElement(changeReviewOverlay);
    expect(changeReviewOverlay.querySelector('.loading-overlay-card')).toBeInTheDocument();

    await act(async () => {
      slowChangeReview.resolve(jsonResponse(sessionChangesFixture()));
      await slowChangeReview.promise;
    });

    expect(await within(dialog).findByText('Changed files')).toBeInTheDocument();
  });

  test('keeps the change review loading indicator over existing review content during refreshes', async () => {
    const slowRefresh = deferred<Response>();
    const defaultApi = mockApi();
    let changeReviewRequestCount = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const requestUrl = new URL(String(input), 'http://127.0.0.1:43110');
      if (requestUrl.pathname === '/api/projects/project-1/sessions/session-1/changes') {
        changeReviewRequestCount += 1;
        if (changeReviewRequestCount === 2) {
          return slowRefresh.promise;
        }
      }
      return defaultApi(input);
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(<App />);

    await screen.findByRole('button', { name: /project-a main/i });
    await user.click(screen.getAllByRole('link', { name: /^Sessions$/i })[0]!);
    await user.click(screen.getByRole('row', { name: /open details for build the api/i }));
    const dialog = await screen.findByRole('dialog', { name: 'Session Details' });
    await user.click(within(dialog).getByRole('tab', { name: /review changes/i }));
    expect(await within(dialog).findByText('Changed files')).toBeInTheDocument();

    await user.click(within(dialog).getByRole('tab', { name: /conversation/i }));
    await user.click(within(dialog).getByRole('tab', { name: /review changes/i }));
    await waitFor(() => expect(changeReviewRequestCount).toBe(2));

    const reviewPanel = within(dialog).getByRole('tabpanel', { name: /review changes/i });
    const changeReviewOverlay = getLoadingOverlay('Loading change review', within(reviewPanel));
    expect(reviewPanel).toContainElement(changeReviewOverlay);
    expect(within(reviewPanel).getByText('Changed files')).toBeInTheDocument();

    await act(async () => {
      slowRefresh.resolve(jsonResponse(sessionChangesFixture()));
      await slowRefresh.promise;
    });

    await waitFor(() => expect(within(reviewPanel).queryByText('Loading change review')).not.toBeInTheDocument());
  });

  test('shows an empty state when a session has no reviewable changed files', async () => {
    vi.stubGlobal('fetch', mockApi({ sessionChangesResponse: emptySessionChangesFixture() }));
    const user = userEvent.setup();

    render(<App />);

    await screen.findByRole('button', { name: /project-a main/i });
    await user.click(screen.getAllByRole('link', { name: /^Sessions$/i })[0]!);
    await user.click(screen.getByLabelText('Open details for Build the API'));

    const dialog = await screen.findByRole('dialog', { name: /session details/i });
    await user.click(within(dialog).getByRole('tab', { name: /review changes/i }));

    expect(await within(dialog).findByText('No reviewable file changes were derived from this session.')).toBeInTheDocument();
  });

  test('does not reserve an empty old-line column for add-only diffs', async () => {
    vi.stubGlobal('fetch', mockApi({ sessionChangesResponse: addOnlySessionChangesFixture() }));
    const user = userEvent.setup();

    render(<App />);

    await screen.findByRole('button', { name: /project-a main/i });
    await user.click(screen.getAllByRole('link', { name: /^Sessions$/i })[0]!);
    await user.click(screen.getByLabelText('Open details for Build the API'));

    const dialog = await screen.findByRole('dialog', { name: /session details/i });
    await user.click(within(dialog).getByRole('tab', { name: /review changes/i }));

    const addedLineText = await within(dialog).findByText('export const created = true;');
    const addedLineRow = addedLineText.parentElement;
    expect(addedLineRow).not.toBeNull();
    expect(addedLineRow?.children).toHaveLength(3);
    expect(addedLineRow?.children[0]).toHaveTextContent('1');
    expect(addedLineRow?.children[1]).toHaveTextContent('+');
  });

  test('summarizes unavailable temporary worktree changes without fake zero-line diff controls', async () => {
    vi.stubGlobal('fetch', mockApi({ sessionChangesResponse: unavailableWorktreeSessionChangesFixture() }));
    const user = userEvent.setup();

    render(<App />);

    await screen.findByRole('button', { name: /project-a main/i });
    await user.click(screen.getAllByRole('link', { name: /^Sessions$/i })[0]!);
    await user.click(screen.getByLabelText('Open details for Build the API'));

    const dialog = await screen.findByRole('dialog', { name: /session details/i });
    await user.click(within(dialog).getByRole('tab', { name: /review changes/i }));

    expect(await within(dialog).findByLabelText('2 files cannot be diffed')).toBeInTheDocument();
    expect(within(dialog).getByRole('navigation', { name: /changed files/i })).toBeInTheDocument();
    expect(within(dialog).getAllByText('2 unavailable')).toHaveLength(1);
    expect(within(dialog).queryByText('Unavailable 2')).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/Studio found these file changes in the session transcript/i)).not.toBeInTheDocument();
    expect(within(dialog).getAllByText('Cannot show diff')).toHaveLength(2);
    expect(within(dialog).getAllByText('Temporary worktree unavailable')).toHaveLength(2);
    expect(within(dialog).queryByText('+0 added')).not.toBeInTheDocument();
    expect(within(dialog).queryByText('-0 removed')).not.toBeInTheDocument();
    expect(within(dialog).queryByText('No textual diff')).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: /copy diff for .*eventHub/i })).not.toBeInTheDocument();
    const changedFiles = within(dialog).getByRole('navigation', { name: /changed files/i });
    expect(
      within(changedFiles).getByRole('button', { name: /\.claude\/worktrees\/application-redesign\/apps\/server\/src\/events\/eventHub\.ts/i }),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByLabelText('Change details for .claude/worktrees/application-redesign/apps/server/src/events/eventHub.ts'),
    ).toBeInTheDocument();
  });

  test('shows a retryable error when session change review loading fails', async () => {
    vi.stubGlobal('fetch', mockApi({ failSessionChangesOnce: true }));
    const user = userEvent.setup();

    render(<App />);

    await screen.findByRole('button', { name: /project-a main/i });
    await user.click(screen.getAllByRole('link', { name: /^Sessions$/i })[0]!);
    await user.click(screen.getByLabelText('Open details for Build the API'));

    const dialog = await screen.findByRole('dialog', { name: /session details/i });
    await user.click(within(dialog).getByRole('tab', { name: /review changes/i }));

    expect(await within(dialog).findByText('Unable to load change review')).toBeInTheDocument();
    expect(within(dialog).getByText('Injected change review failure')).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: /retry/i }));

    const changedFiles = await within(dialog).findByRole('navigation', { name: /changed files/i });
    expect(within(changedFiles).getByRole('button', { name: /^src\/api\.ts$/i })).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Diff for src/api.ts')).toBeInTheDocument();
    expect(within(dialog).queryByText('Injected change review failure')).not.toBeInTheDocument();
  });

  test('shows a degraded compatibility state when the local server lacks change review support', async () => {
    vi.stubGlobal('fetch', mockApi({ sessionChangesStatus: 404 }));
    const user = userEvent.setup();

    render(<App />);

    await screen.findByRole('button', { name: /project-a main/i });
    await user.click(screen.getAllByRole('link', { name: /^Sessions$/i })[0]!);
    await user.click(screen.getByLabelText('Open details for Build the API'));

    const dialog = await screen.findByRole('dialog', { name: /session details/i });
    await user.click(within(dialog).getByRole('tab', { name: /review changes/i }));

    expect(await within(dialog).findByText('Review Changes requires a newer local server')).toBeInTheDocument();
    expect(within(dialog).getByRole('tab', { name: /review changes 1/i })).toBeInTheDocument();
    expect(within(dialog).getByText(/Update or restart the local OpenClaude Studio server/i)).toBeInTheDocument();
    expect(within(dialog).queryByText('Unable to load change review')).not.toBeInTheDocument();
    expect(within(dialog).queryByText('No reviewable file changes were derived from this session.')).not.toBeInTheDocument();
  });

  test('derives change review totals and renders diagnostics for partial local API responses', async () => {
    vi.stubGlobal('fetch', mockApi({ sessionChangesResponse: legacySessionChangesFixture() }));
    const user = userEvent.setup();

    render(<App />);

    await screen.findByRole('button', { name: /project-a main/i });
    await user.click(screen.getAllByRole('link', { name: /^Sessions$/i })[0]!);
    await user.click(screen.getByLabelText('Open details for Build the API'));

    const dialog = await screen.findByRole('dialog', { name: /session details/i });
    await user.click(within(dialog).getByRole('tab', { name: /review changes/i }));

    const changedFiles = await within(dialog).findByRole('navigation', { name: /changed files/i });
    expect(within(changedFiles).getByRole('button', { name: /^legacy\/change\.ts$/i })).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Change details for legacy/change.ts')).toBeInTheDocument();
    expect(within(dialog).getByText('1 changed file')).toBeInTheDocument();
    expect(within(dialog).getAllByText('+2').length).toBeGreaterThan(0);
    expect(within(dialog).getAllByText('-1').length).toBeGreaterThan(0);
    expect(within(dialog).getByText('1 risk flag')).toBeInTheDocument();
    expect(within(dialog).getByText('Legacy diagnostic')).toBeInTheDocument();
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

  test('shows an accessible plans and tasks loading indicator while lists are pending', async () => {
    const slowPlans = deferred<Response>();
    const slowTasks = deferred<Response>();
    vi.stubGlobal('fetch', mockApi({
      plansPromiseOnce: slowPlans.promise,
      tasksPromiseOnce: slowTasks.promise,
    }));
    const user = userEvent.setup();

    render(<App />);

    await screen.findByRole('button', { name: /project-a main/i });
    await user.click(screen.getAllByRole('link', { name: /^Plans & Tasks$/i })[0]!);

    const pageHeader = getPageHeader('Plans & Tasks');
    expect(within(pageHeader).queryByText('Loading plans and tasks')).not.toBeInTheDocument();
    expect(pageHeader.querySelector('.animate-spin')).not.toBeInTheDocument();
    const plansTasksOverlay = getLoadingOverlay('Loading plans and tasks');
    const loadingPanel = plansTasksOverlay.closest('section');
    expect(loadingPanel).not.toBeNull();
    expect(loadingPanel).toContainElement(plansTasksOverlay);

    await act(async () => {
      slowPlans.resolve(jsonResponse(plansFixture()));
      slowTasks.resolve(jsonResponse(tasksFixture()));
      await slowPlans.promise;
      await slowTasks.promise;
    });

    expect(await screen.findByRole('heading', { name: 'Plans & Tasks' })).toBeInTheDocument();
  });

  test('shows a plans and tasks loading overlay while the workspace project is pending', async () => {
    window.history.pushState(null, '', '/plans-tasks');
    const slowProjects = deferred<Response>();
    const fetchMock = mockApi({ projectsPromiseOnce: slowProjects.promise });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    const pageHeader = getPageHeader('Plans & Tasks');
    expect(within(pageHeader).queryByText('Loading workspace')).not.toBeInTheDocument();
    expect(pageHeader.querySelector('.animate-spin')).not.toBeInTheDocument();
    const plansTasksOverlay = getLoadingOverlay('Loading workspace');
    const loadingPanel = plansTasksOverlay.closest('section');
    expect(loadingPanel).not.toBeNull();
    expect(loadingPanel).toContainElement(plansTasksOverlay);
    expect(screen.queryByText('Select a project to inspect linked plans and tasks.')).not.toBeInTheDocument();

    await act(async () => {
      slowProjects.resolve(jsonResponse({ diagnostics: [], projects: [projectFixture()] }));
      await slowProjects.promise;
    });

    expect(await screen.findByRole('button', { name: /Launch plan/i })).toBeInTheDocument();
  });

  test('keeps the plans and tasks loading indicator over the content area during refreshes', async () => {
    const slowRefreshPlans = deferred<Response>();
    const defaultApi = mockApi();
    let plansRequestCount = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const requestUrl = new URL(String(input), 'http://127.0.0.1:43110');
      if (requestUrl.pathname === '/api/projects/project-1/plans') {
        plansRequestCount += 1;
        if (plansRequestCount === 2) {
          return slowRefreshPlans.promise;
        }
      }
      return defaultApi(input);
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(<App />);

    await screen.findByRole('button', { name: /project-a main/i });
    await user.click(screen.getAllByRole('link', { name: /^Plans & Tasks$/i })[0]!);
    expect(await screen.findByRole('heading', { name: 'Plans & Tasks' })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /Launch plan/i })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /refresh plans and tasks/i }));
    await waitFor(() => expect(plansRequestCount).toBe(2));

    const contentBoundary = document.querySelector('.plans-tasks-content');
    const refreshOverlay = getLoadingOverlay('Refreshing plans and tasks');
    expect(contentBoundary).toContainElement(refreshOverlay);
    expect(contentBoundary).toContainElement(screen.getByRole('tablist', { name: /plans and tasks/i }));

    await act(async () => {
      slowRefreshPlans.resolve(jsonResponse(plansFixture()));
      await slowRefreshPlans.promise;
    });

    await waitFor(() => expect(screen.queryByText('Refreshing plans and tasks')).not.toBeInTheDocument());
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
    const slowSearch = deferred<Response>();
    const fetchMock = mockApi({ logSearchPromiseOnce: slowSearch.promise, logTotalLines: 1200 });
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
    const logEntries = screen.getByRole('region', { name: /log entries/i });
    const logLoadingRegion = getLoadingLiveRegion('Loading logs');
    const logLoadingOverlay = getLoadingOverlay('Loading logs');
    const pageHeader = getPageHeader('System Logs');
    expect(within(pageHeader).queryByText('Loading logs')).not.toBeInTheDocument();
    expect(pageHeader.querySelector('.animate-spin')).not.toBeInTheDocument();
    expect(within(pageHeader).getAllByText('session-1.txt').length).toBeGreaterThan(0);
    expect(logEntries).not.toContainElement(logLoadingRegion);
    expect(logLoadingOverlay).toHaveClass('log-console-loading-overlay');
    expect(logLoadingOverlay.querySelector('.loading-overlay-card')).toBeInTheDocument();
    expect(logLoadingRegion.closest('.log-console')).toContainElement(logEntries);
    expect(logEntries).toHaveAttribute('aria-busy', 'true');

    await act(async () => {
      slowSearch.resolve(jsonResponse({
        ...logsFixture({ count: 500, start: 700, totalLines: 1200 }),
        query: '',
        totalMatches: 1200,
      }));
      await slowSearch.promise;
    });

    expect(await screen.findByText('line-1200')).toBeInTheDocument();
    expect(logEntries).toHaveAttribute('aria-busy', 'false');
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

  test('keeps a workspace refresh indicator over the diagnostics page content', async () => {
    const slowProjects = deferred<Response>();
    const diagnostic = {
      level: 'error',
      message: 'Unable to parse global config.',
      path: '/tmp/.openclaude.json',
    };
    const defaultApi = mockApi({ projectDiagnostics: [diagnostic] });
    let projectRequestCount = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const requestUrl = new URL(String(input), 'http://127.0.0.1:43110');
      if (requestUrl.pathname === '/api/projects') {
        projectRequestCount += 1;
        if (projectRequestCount === 2) {
          return slowProjects.promise;
        }
      }
      return defaultApi(input);
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(<App />);

    await screen.findByRole('button', { name: /project-a main/i });
    await user.click(screen.getAllByRole('link', { name: /Diagnostics/i })[0]!);
    expect(await screen.findByText('Unable to parse global config.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /refresh project list/i }));
    await waitFor(() => expect(projectRequestCount).toBe(2));

    const diagnosticsOverlay = getLoadingOverlay('Refreshing workspace');
    const diagnosticsPanel = screen.getByText('Unable to parse global config.').closest('section');
    expect(diagnosticsPanel).not.toBeNull();
    expect(diagnosticsPanel).toContainElement(diagnosticsOverlay);

    await act(async () => {
      slowProjects.resolve(jsonResponse({ diagnostics: [diagnostic], projects: [projectFixture()] }));
      await slowProjects.promise;
    });

    await waitFor(() => expect(screen.queryByText('Refreshing workspace')).not.toBeInTheDocument());
  });

  test('renders the OPENCLAUDE_CONFIG_DIR conflict warning from /api/projects', async () => {
    const fetchMock = mockApi({
      projectDiagnostics: [
        {
          level: 'warn',
          message:
            'Both OPENCLAUDE_CONFIG_DIR and CLAUDE_CONFIG_DIR are set to different values. OpenClaude Studio uses OPENCLAUDE_CONFIG_DIR (preferred) and ignores CLAUDE_CONFIG_DIR. Align the values to silence this warning.',
        },
      ],
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(<App />);

    await screen.findByRole('button', { name: /project-a main/i });
    await user.click(screen.getAllByRole('link', { name: /Diagnostics/i })[0]!);

    expect(
      await screen.findByText(/Both OPENCLAUDE_CONFIG_DIR and CLAUDE_CONFIG_DIR are set to different values/),
    ).toBeInTheDocument();
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

  test('renders the background sessions page with sessions and status counters', async () => {
    window.history.pushState(null, '', '/background-sessions');
    const fetchMock = mockApi({
      backgroundSessions: [
        {
          id: 'bg-running-001',
          shortId: 'bg-runni',
          name: 'long-task',
          pid: 4242,
          cwd: '/tmp/project',
          recordedStatus: 'running',
          terminal: false,
          processPresence: 'unknown',
          provider: 'anthropic',
          model: 'claude-sonnet-4',
          sessionId: 'sess-1',
          startedAt: '2026-06-01T10:00:00.000Z',
          updatedAt: '2026-06-01T10:05:00.000Z',
          durationMs: 300000,
          commandSummary: { binary: 'openclaude', flagCount: 2, truncated: false },
          project: null,
          sessionLink: null,
          stdoutLogAvailable: true,
          stderrLogAvailable: false,
        },
      ],
      backgroundStatusCounts: {
        running: 1,
        unknown: 0,
        exited: 0,
        failed: 0,
        stale: 0,
        killed: 0,
      },
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Background Sessions' })).toBeInTheDocument();
    expect(await screen.findByText('long-task')).toBeInTheDocument();
    expect(screen.getByText('1 session')).toBeInTheDocument();
  });

  test('opens the detail panel via keyboard activation', async () => {
    window.history.pushState(null, '', '/background-sessions');
    const user = userEvent.setup();
    const fetchMock = mockApi({
      backgroundSessions: [
        {
          id: 'bg-kb-001',
          shortId: 'bg-kb',
          name: 'kb-task',
          pid: 1,
          cwd: '/tmp',
          recordedStatus: 'running',
          terminal: false,
          processPresence: 'unknown',
          provider: 'anthropic',
          model: 'claude-sonnet-4',
          sessionId: null,
          startedAt: '2026-06-01T10:00:00.000Z',
          updatedAt: '2026-06-01T10:05:00.000Z',
          durationMs: 300000,
          commandSummary: { binary: 'openclaude', flagCount: 1, truncated: false },
          project: null,
          sessionLink: null,
          stdoutLogAvailable: false,
          stderrLogAvailable: false,
        },
      ],
      backgroundStatusCounts: {
        running: 1,
        unknown: 0,
        exited: 0,
        failed: 0,
        stale: 0,
        killed: 0,
      },
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await screen.findByRole('heading', { name: 'Background Sessions' });

    // Enter activation
    let row = screen.getByRole('button', { name: /Open details for kb-task/i });
    row.focus();
    await user.keyboard('{Enter}');
    let dialog = await screen.findByRole('dialog', { name: /kb-task details/i });
    expect(dialog).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Close detail' }));

    // Space activation (separate branch with preventDefault to avoid page scroll)
    row = screen.getByRole('button', { name: /Open details for kb-task/i });
    row.focus();
    await user.keyboard(' ');
    dialog = await screen.findByRole('dialog', { name: /kb-task details/i });
    expect(dialog).toBeInTheDocument();
  });

  test('shows an empty state when no background sessions exist', async () => {
    window.history.pushState(null, '', '/background-sessions');
    const fetchMock = mockApi();
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    expect(await screen.findByText('No background sessions found')).toBeInTheDocument();
  });

  test('shows a degraded state when the local server is older', async () => {
    window.history.pushState(null, '', '/background-sessions');
    const fetchMock = mockApi({ backgroundSessionsStatus: 404 });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    expect(
      await screen.findByText('Background session monitoring requires a newer local server.'),
    ).toBeInTheDocument();
  });

  test('opens a detail panel with bounded redacted logs on row click', async () => {
    window.history.pushState(null, '', '/background-sessions');
    const user = userEvent.setup();
    const fetchMock = mockApi({
      backgroundSessions: [
        {
          id: 'bg-logs-001',
          shortId: 'bg-logs',
          name: 'with-logs',
          pid: 1,
          cwd: '/tmp',
          recordedStatus: 'running',
          terminal: false,
          processPresence: 'unknown',
          provider: 'anthropic',
          model: 'claude-sonnet-4',
          sessionId: null,
          startedAt: '2026-06-01T10:00:00.000Z',
          updatedAt: '2026-06-01T10:05:00.000Z',
          durationMs: 300000,
          commandSummary: { binary: 'openclaude', flagCount: 1, truncated: false },
          project: null,
          sessionLink: null,
          stdoutLogAvailable: true,
          stderrLogAvailable: false,
        },
      ],
      backgroundStatusCounts: {
        running: 1,
        unknown: 0,
        exited: 0,
        failed: 0,
        stale: 0,
        killed: 0,
      },
      backgroundLogEntries: [
        { id: 'bg-logs-001:stdout:1', lineNumber: 1, text: 'OPENAI_API_KEY=<redacted> leak' },
      ],
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await screen.findByRole('heading', { name: 'Background Sessions' });
    await user.click(screen.getByText('with-logs'));

    expect(await screen.findByRole('dialog', { name: /with-logs details/i })).toBeInTheDocument();
    expect(screen.getByText('OPENAI_API_KEY=<redacted> leak')).toBeInTheDocument();
  });

  test('opens the linked session transcript and surfaces the details modal', async () => {
    window.history.pushState(null, '', '/background-sessions');
    const user = userEvent.setup();
    const fetchMock = mockApi({
      backgroundSessions: [
        {
          id: 'bg-linked-001',
          shortId: 'bg-link',
          name: 'linked-task',
          pid: 1,
          cwd: '/tmp',
          recordedStatus: 'running',
          terminal: false,
          processPresence: 'unknown',
          provider: 'anthropic',
          model: 'claude-sonnet-4',
          sessionId: 'session-1',
          startedAt: '2026-06-01T10:00:00.000Z',
          updatedAt: '2026-06-01T10:05:00.000Z',
          durationMs: 300000,
          commandSummary: { binary: 'openclaude', flagCount: 1, truncated: false },
          project: { projectId: 'project-1', projectName: 'project-a' },
          sessionLink: { projectId: 'project-1', sessionId: 'session-1' },
          stdoutLogAvailable: true,
          stderrLogAvailable: false,
        },
      ],
      backgroundStatusCounts: {
        running: 1,
        unknown: 0,
        exited: 0,
        failed: 0,
        stale: 0,
        killed: 0,
      },
      sessionDetails: legacySessionDetailsFixture(),
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await screen.findByRole('heading', { name: 'Background Sessions' });
    await user.click(screen.getByText('linked-task'));
    expect(await screen.findByRole('dialog', { name: /linked-task details/i })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Open session transcript' }));

    // The handler selects proj-A + session-1 and routes to /sessions, which
    // surfaces the existing session-details modal with the linked transcript.
    await waitFor(() => expect(window.location.pathname).toBe('/sessions'));
    const transcriptDialog = await screen.findByRole('dialog', { name: /session details/i });
    expect(transcriptDialog).toBeInTheDocument();
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
  backgroundSessions?: unknown[];
  backgroundStatusCounts?: unknown;
  backgroundDiagnostics?: unknown[];
  backgroundLogEntries?: unknown[];
  backgroundLogsResponse?: unknown;
  backgroundSessionsStatus?: number;
  failPlanDetails?: boolean;
  failPlansListOnce?: boolean;
  failTaskDetails?: boolean;
  failLogWindowStartOnce?: number;
  logTotalLines?: number;
  logSearchPromiseOnce?: Promise<Response>;
  omitOverviewUsageSeries?: boolean;
  overviewUsageSeries?: unknown[];
  plansPromiseOnce?: Promise<Response>;
  plansResponse?: unknown;
  projectDiagnostics?: unknown[];
  projectsPromiseOnce?: Promise<Response>;
  projects?: unknown[];
  failSessionChangesOnce?: boolean;
  providerProfilesPromiseOnce?: Promise<Response>;
  providerProfilesResponse?: unknown;
  providerProfilesStatus?: number;
  sessionChangesPromiseOnce?: Promise<Response>;
  sessionChangesStatus?: number;
  sessionChangesResponse?: unknown;
  sessionDetailsPromiseOnce?: Promise<Response>;
  sessionDetails?: unknown;
  sessionsPromiseOnce?: Promise<Response>;
  tasksPromiseOnce?: Promise<Response>;
  tasksResponse?: unknown;
};

function mockApi(options: MockApiOptions = {}) {
  const baseUrl = options.baseUrl ?? 'http://127.0.0.1:43110';
  let failedLogWindowStart = false;
  let failedPlansList = false;
  let failedSessionChanges = false;
  let usedLogSearchPromise = false;
  let usedPlansPromise = false;
  let usedProjectsPromise = false;
  let usedProviderProfilesPromise = false;
  let usedSessionChangesPromise = false;
  let usedSessionDetailsPromise = false;
  let usedSessionsPromise = false;
  let usedTasksPromise = false;

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
      if (options.projectsPromiseOnce && !usedProjectsPromise) {
        usedProjectsPromise = true;
        return options.projectsPromiseOnce;
      }
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
      if (options.sessionsPromiseOnce && !usedSessionsPromise) {
        usedSessionsPromise = true;
        return options.sessionsPromiseOnce;
      }
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

    if (path === '/api/provider/profiles') {
      if (options.providerProfilesPromiseOnce && !usedProviderProfilesPromise) {
        usedProviderProfilesPromise = true;
        return options.providerProfilesPromiseOnce;
      }
      if (options.providerProfilesStatus) {
        return jsonResponse({ error: `Injected provider profiles ${options.providerProfilesStatus}` }, options.providerProfilesStatus);
      }
      return jsonResponse('providerProfilesResponse' in options ? options.providerProfilesResponse : providerProfilesFixture());
    }

    if (path === '/api/projects/project-1/sessions/session-1') {
      if (options.sessionDetailsPromiseOnce && !usedSessionDetailsPromise) {
        usedSessionDetailsPromise = true;
        return options.sessionDetailsPromiseOnce;
      }
      return jsonResponse(options.sessionDetails ?? sessionDetailsFixture());
    }

    if (path === '/api/projects/project-1/sessions/session-1/changes') {
      if (options.sessionChangesPromiseOnce && !usedSessionChangesPromise) {
        usedSessionChangesPromise = true;
        return options.sessionChangesPromiseOnce;
      }
      if (options.failSessionChangesOnce && !failedSessionChanges) {
        failedSessionChanges = true;
        return jsonResponse({ error: 'Injected change review failure' }, 500);
      }
      if (options.sessionChangesStatus) {
        return jsonResponse({ error: `Injected change review ${options.sessionChangesStatus}` }, options.sessionChangesStatus);
      }
      return jsonResponse(options.sessionChangesResponse ?? sessionChangesFixture());
    }

    if (path === '/api/projects/project-1/plans') {
      if (options.plansPromiseOnce && !usedPlansPromise) {
        usedPlansPromise = true;
        return options.plansPromiseOnce;
      }
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
      if (options.tasksPromiseOnce && !usedTasksPromise) {
        usedTasksPromise = true;
        return options.tasksPromiseOnce;
      }
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
      if (options.logSearchPromiseOnce && !usedLogSearchPromise) {
        usedLogSearchPromise = true;
        return options.logSearchPromiseOnce;
      }
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

    if (path === '/api/background-sessions') {
      if (options.backgroundSessionsStatus) {
        return jsonResponse({ error: 'Not found' }, options.backgroundSessionsStatus);
      }
      return jsonResponse({
        sessions: options.backgroundSessions ?? [],
        statusCounts: options.backgroundStatusCounts ?? {
          running: 0,
          unknown: 0,
          exited: 0,
          failed: 0,
          stale: 0,
          killed: 0,
        },
        diagnostics: options.backgroundDiagnostics ?? [],
      });
    }

    if (path.startsWith('/api/background-sessions/') && path.endsWith('/logs')) {
      const sessionId = path.split('/')[3] ?? 'bg-1';
      return jsonResponse(
        options.backgroundLogsResponse ?? {
          sessionId,
          stream: requestUrl.searchParams.get('stream') === 'stderr' ? 'stderr' : 'stdout',
          entries: options.backgroundLogEntries ?? [],
          start: 0,
          count: 100,
          totalLines: options.backgroundLogEntries?.length ?? 0,
          truncated: false,
          diagnostics: [],
        },
      );
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

function providerProfilesFixture() {
  return {
    path: '/tmp/.openclaude.json',
    exists: true,
    activeProviderProfileId: 'provider-1',
    sensitiveFieldsRedacted: true,
    summary: {
      total: 2,
      active: 1,
      valid: 1,
      warnings: 1,
      errors: 0,
      templates: 3,
    },
    diagnostics: [],
    profiles: [
      {
        id: 'provider-1',
        name: 'OpenAI Team',
        provider: 'openai',
        model: 'gpt-example',
        baseUrl: 'https://api.openai.com/v1',
        active: true,
        apiKeySet: true,
        authHeaderValueSet: false,
        apiFormat: 'responses',
        authHeader: null,
        authScheme: null,
        customHeaders: [],
        templateId: 'openai',
        templateLabel: 'OpenAI GPT',
        validation: { status: 'valid', issues: [] },
      },
      {
        id: 'provider-2',
        name: 'Local Lab',
        provider: 'openai',
        model: 'local-model',
        baseUrl: 'http://127.0.0.1:11434/v1',
        active: false,
        apiKeySet: false,
        authHeaderValueSet: false,
        apiFormat: 'chat_completions',
        authHeader: null,
        authScheme: null,
        customHeaders: [{ name: 'X-Workspace', valueSet: true, sensitive: false }],
        templateId: 'custom-openai',
        templateLabel: 'Custom OpenAI-compatible',
        validation: {
          status: 'warning',
          issues: [
            {
              severity: 'warn',
              field: 'credential',
              message: 'No saved credential is visible in this profile.',
            },
          ],
        },
      },
    ],
    templates: [
      {
        id: 'openai',
        label: 'OpenAI GPT',
        category: 'hosted',
        description: 'OpenAI-compatible profile for OpenAI hosted models.',
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        model: '',
        modelPlaceholder: 'OpenAI model id',
        requiresSecret: true,
        requiredFields: ['name', 'provider', 'baseUrl', 'model', 'credential'],
        advancedFields: ['apiFormat', 'authHeader', 'authScheme', 'customHeaders'],
        apiFormat: 'responses',
        authHeader: null,
        authScheme: null,
        customHeaders: [],
        credential: {
          label: 'OpenAI credential',
          envVar: 'OPENAI_API_KEY',
          placeholder: 'Set outside Studio before using this profile',
        },
      },
      {
        id: 'codex-oauth',
        label: 'Codex OAuth / codexplan',
        category: 'subscription',
        description: 'Codex backend profile that relies on existing OpenClaude OAuth credentials.',
        provider: 'openai',
        baseUrl: 'https://chatgpt.com/backend-api/codex',
        model: 'codexplan',
        modelPlaceholder: 'codexplan',
        requiresSecret: false,
        requiredFields: ['name', 'provider', 'baseUrl', 'model'],
        advancedFields: [],
        apiFormat: null,
        authHeader: null,
        authScheme: null,
        customHeaders: [],
        credential: null,
      },
      {
        id: 'ollama',
        label: 'Ollama',
        category: 'local',
        description: 'Local Ollama profile using its OpenAI-compatible endpoint.',
        provider: 'ollama',
        baseUrl: 'http://127.0.0.1:11434/v1',
        model: 'llama3.1:8b',
        modelPlaceholder: 'Ollama model tag',
        requiresSecret: false,
        requiredFields: ['name', 'provider', 'baseUrl', 'model'],
        advancedFields: ['authHeader', 'authScheme', 'customHeaders'],
        apiFormat: null,
        authHeader: null,
        authScheme: null,
        customHeaders: [],
        credential: null,
      },
    ],
  };
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

function sessionChangesFixture() {
  return {
    sessionId: 'session-1',
    files: [
      {
        id: 'session-1-change-0',
        filePath: 'src/api.ts',
        status: 'modified',
        language: 'typescript',
        backupFileName: 'abc123@v1',
        backupExists: true,
        backupVersion: 1,
        backupTime: '2026-05-28T08:00:30.000Z',
        beforeTruncated: false,
        afterTruncated: false,
        additions: 1,
        deletions: 1,
        riskFlags: [
          {
            level: 'warn',
            label: 'Large change',
            message: 'This file changed more lines than usual for a single session.',
          },
        ],
        relatedEvents: [
          {
            id: 'session-1-2-tool',
            timestamp: '2026-05-28T08:00:20.000Z',
            title: 'Edit file',
            toolName: 'Edit',
            command: null,
          },
        ],
        diff: {
          hunks: [
            {
              oldStart: 1,
              oldLines: 2,
              newStart: 1,
              newLines: 2,
              lines: [
                { kind: 'context', oldLine: 1, newLine: 1, text: 'export const token = "<redacted>";' },
                { kind: 'remove', oldLine: 2, newLine: null, text: 'export const value = 0;' },
                { kind: 'add', oldLine: null, newLine: 2, text: 'export const value = 1;' },
              ],
            },
          ],
        },
        diagnostics: [],
      },
    ],
    totals: {
      fileCount: 1,
      additions: 1,
      deletions: 1,
      backupCount: 1,
      riskFlagCount: 1,
    },
    diagnostics: [],
  };
}

function emptySessionChangesFixture() {
  return {
    sessionId: 'session-1',
    files: [],
    totals: {
      fileCount: 0,
      additions: 0,
      deletions: 0,
      backupCount: 0,
      riskFlagCount: 0,
    },
    diagnostics: [],
  };
}

function addOnlySessionChangesFixture() {
  return {
    sessionId: 'session-1',
    files: [
      {
        id: 'session-1-change-created',
        filePath: 'src/created.ts',
        status: 'created',
        language: 'typescript',
        backupFileName: null,
        backupExists: false,
        backupVersion: null,
        backupTime: null,
        beforeTruncated: false,
        afterTruncated: false,
        additions: 1,
        deletions: 0,
        riskFlags: [],
        relatedEvents: [
          {
            id: 'session-1-created-tool',
            timestamp: '2026-05-28T08:00:20.000Z',
            title: 'Write file',
            toolName: 'Write',
            command: null,
          },
        ],
        diff: {
          hunks: [
            {
              oldStart: 0,
              oldLines: 0,
              newStart: 1,
              newLines: 1,
              lines: [
                { kind: 'add', oldLine: null, newLine: 1, text: 'export const created = true;' },
              ],
            },
          ],
        },
        diagnostics: [],
      },
    ],
    totals: {
      fileCount: 1,
      additions: 1,
      deletions: 0,
      backupCount: 0,
      riskFlagCount: 0,
    },
    diagnostics: [],
  };
}

function unavailableWorktreeSessionChangesFixture() {
  return {
    sessionId: 'session-1',
    files: [
      unavailableWorktreeFile(
        'session-1-change-0',
        '.claude/worktrees/application-redesign/apps/server/src/events/eventHub.ts',
        '2026-05-28T14:30:00.000Z',
      ),
      unavailableWorktreeFile(
        'session-1-change-1',
        '.claude/worktrees/application-redesign/apps/server/src/services/diagnosticsService.ts',
        '2026-05-28T14:48:00.000Z',
      ),
    ],
    totals: {
      fileCount: 2,
      additions: 0,
      deletions: 0,
      backupCount: 0,
      riskFlagCount: 2,
    },
    diagnostics: [],
  };
}

function unavailableWorktreeFile(id: string, filePath: string, timestamp: string) {
  return {
    id,
    filePath,
    status: 'unavailable',
    language: 'typescript',
    backupFileName: null,
    backupExists: false,
    backupVersion: null,
    backupTime: null,
    beforeTruncated: false,
    afterTruncated: false,
    additions: 0,
    deletions: 0,
    riskFlags: [
      {
        level: 'warn',
        label: 'Unavailable content',
        message: 'Studio could not safely read one side of this change.',
      },
    ],
    relatedEvents: [
      {
        id: `${id}-event`,
        timestamp,
        title: 'Edit file',
        toolName: 'Edit',
        command: null,
      },
    ],
    diff: null,
    diagnostics: [
      {
        level: 'info',
        message: 'File does not exist.',
        path: filePath,
      },
    ],
  };
}

function legacySessionChangesFixture() {
  return {
    sessionId: 'session-1',
    files: [
      {
        id: 'legacy-change-0',
        filePath: 'legacy/change.ts',
        status: 'modified',
        backupExists: true,
        additions: 2,
        deletions: 1,
        riskFlags: [
          {
            level: 'warn',
            label: 'Legacy risk',
            message: 'Legacy response risk flag.',
          },
        ],
        relatedEvents: [],
        diff: null,
        diagnostics: [],
      },
    ],
    diagnostics: [{ level: 'warn', message: 'Legacy diagnostic' }],
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
