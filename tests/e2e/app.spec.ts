import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';
import type { FastifyInstance } from 'fastify';

import { buildServer } from '../../apps/server/src/http/server.js';
import { createOpenClaudePaths, encodeProjectPath } from '../../apps/server/src/services/paths.js';

let server: FastifyInstance;

test.beforeAll(async () => {
  const home = await mkdtemp(join(tmpdir(), 'ocs-e2e-'));
  const projectPath = join(home, 'project-a');
  const paths = createOpenClaudePaths({ home, env: {} });

  await mkdir(join(projectPath, '.git'), { recursive: true });
  await writeFile(join(projectPath, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
  await writeFile(
    paths.openClaudeConfig,
    JSON.stringify({
      activeProviderProfileId: 'provider-1',
      providerProfiles: [
        {
          id: 'provider-1',
          name: 'Anthropic',
          provider: 'anthropic',
          model: 'claude-sonnet',
          baseUrl: 'https://example.com/v1',
          apiKey: 'secret',
        },
      ],
      projects: {
        [projectPath]: {
          lastGracefulShutdown: '2026-05-28T08:00:00.000Z',
          lastSessionId: 'session-1',
          lastCost: 0.25,
        },
      },
    }),
    'utf8',
  );
  await mkdir(join(paths.projectsDir, encodeProjectPath(projectPath)), { recursive: true });
  await writeFile(
    join(paths.projectsDir, encodeProjectPath(projectPath), 'session-1.jsonl'),
    [
      JSON.stringify({
        type: 'user',
        sessionId: 'session-1',
        timestamp: '2026-05-28T08:00:00.000Z',
        cwd: projectPath,
        message: { role: 'user', content: 'Build the API' },
      }),
      JSON.stringify({
        type: 'assistant',
        sessionId: 'session-1',
        timestamp: '2026-05-28T08:01:00.000Z',
        cwd: projectPath,
        message: {
          role: 'assistant',
          model: 'claude-sonnet',
          usage: { input_tokens: 10, output_tokens: 20 },
          content: [{ type: 'text', text: 'Done' }],
        },
      }),
    ].join('\n'),
    'utf8',
  );
  await mkdir(paths.debugDir, { recursive: true });
  const logLines = Array.from(
    { length: 799 },
    (_, index) => `2026-05-28T08:${String(index % 60).padStart(2, '0')}:00.000Z INFO line-${index + 1}`,
  );
  logLines.push('2026-05-28T09:00:00.000Z WARN OPENAI_API_KEY=secret-value slow');
  await writeFile(
    join(paths.debugDir, 'session-1.txt'),
    `${logLines.join('\n')}\n`,
    'utf8',
  );

  server = await buildServer({ env: {}, home, version: '0.0.1-test' });
  await server.listen({ host: '127.0.0.1', port: 43111 });
});

test.afterAll(async () => {
  await server.close();
});

test('loads project overview, sessions, provider, and logs', async ({ page }) => {
  await page.addInitScript((serverUrl) => {
    window.localStorage.setItem('openclaude-studio:server-url', serverUrl);
  }, 'http://127.0.0.1:43111');

  await page.goto('/');

  await expect(page.getByRole('button', { name: /project-a.*main/i })).toBeVisible();
  await expect(page.getByText('Anthropic')).toBeVisible();
  await expect(page.getByText('Build the API')).toBeVisible();
  await page.getByRole('link', { name: /^Logs$/ }).click();
  await expect(page.getByText('OPENAI_API_KEY=<redacted> slow')).toBeVisible();
  await expect(page.getByText(/^line-1$/)).toHaveCount(0);

  const logView = page.getByRole('region', { name: /log entries/i });
  await expect.poll(async () => (
    logView.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight)
  )).toBeLessThan(2);

  const headerDeltas = await page.locator('.log-table-header').evaluate((header) => {
    const headerRect = header.getBoundingClientRect();
    const headerCenter = headerRect.top + headerRect.height / 2;
    return Array.from(header.querySelectorAll('span')).map((label) => {
      const labelRect = label.getBoundingClientRect();
      return Math.abs(labelRect.top + labelRect.height / 2 - headerCenter);
    });
  });
  expect(Math.max(...headerDeltas)).toBeLessThan(2);
});
