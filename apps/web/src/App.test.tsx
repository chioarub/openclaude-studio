import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import App from './App';

const connectionStorageKey = 'openclaude-studio.connection';
let storage: Record<string, string>;

beforeEach(() => {
  storage = {};
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      clear: vi.fn(() => {
        storage = {};
      }),
      getItem: vi.fn((key: string) => storage[key] ?? null),
      removeItem: vi.fn((key: string) => {
        delete storage[key];
      }),
      setItem: vi.fn((key: string, value: string) => {
        storage[key] = value;
      }),
    },
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('App', () => {
  test('loads the read-only workspace from the local API', async () => {
    window.localStorage.setItem(
      connectionStorageKey,
      JSON.stringify({ baseUrl: 'http://127.0.0.1:43110', token: 'test-token' }),
    );
    const fetchMock = mockApi();
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    expect(await screen.findByText('project-a')).toBeInTheDocument();
    expect(screen.getByText('Anthropic')).toBeInTheDocument();
    expect(screen.getByText('Build the API')).toBeInTheDocument();
    expect(screen.getByText('OPENAI_API_KEY=<redacted> slow')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:43110/api/projects',
      expect.objectContaining({ headers: { 'x-openclaude-studio-token': 'test-token' } }),
    );
  });

  test('keeps the workspace idle until a token is provided', () => {
    vi.stubGlobal('fetch', vi.fn());

    render(<App />);

    expect(screen.getByText('Connect to local server')).toBeInTheDocument();
    expect(screen.getByLabelText('API token')).toHaveValue('');
  });

  test('saves connection settings from the header form', async () => {
    const fetchMock = mockApi();
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(<App />);

    await user.clear(screen.getByLabelText('Server URL'));
    await user.type(screen.getByLabelText('Server URL'), 'http://127.0.0.1:43110/');
    await user.type(screen.getByLabelText('API token'), 'test-token');
    await user.click(screen.getByRole('button', { name: /refresh/i }));

    await screen.findByText('project-a');
    await waitFor(() => {
      expect(JSON.parse(window.localStorage.getItem(connectionStorageKey) ?? '{}')).toEqual({
        baseUrl: 'http://127.0.0.1:43110',
        token: 'test-token',
      });
    });
  });
});

function mockApi() {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/api/projects')) {
      return jsonResponse({
        projects: [
          {
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
          },
        ],
      });
    }
    if (url.endsWith('/api/projects/project-1/overview')) {
      return jsonResponse({
        project: {
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
        },
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
        diagnostics: [],
      });
    }
    if (url.endsWith('/api/projects/project-1/sessions')) {
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
    if (url.endsWith('/api/logs/window?count=250')) {
      return jsonResponse({
        files: [{ name: 'session-1.txt', sizeBytes: 72, modifiedAt: '2026-05-28T08:00:00.000Z', sessionId: 'session-1' }],
        selectedFile: { name: 'session-1.txt', sizeBytes: 72, modifiedAt: '2026-05-28T08:00:00.000Z', sessionId: 'session-1' },
        entries: [
          {
            id: 'session-1.txt:1',
            lineNumber: 1,
            timestamp: '2026-05-28T08:00:00.000Z',
            level: 'warn',
            message: 'OPENAI_API_KEY=<redacted> slow',
          },
        ],
        start: 0,
        count: 250,
        totalLines: 1,
        diagnostics: [],
      });
    }
    return jsonResponse({ error: 'Not found' }, 404);
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
    status,
  });
}
