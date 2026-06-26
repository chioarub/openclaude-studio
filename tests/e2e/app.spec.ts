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
  await mkdir(join(projectPath, 'src'), { recursive: true });
  await writeFile(join(projectPath, 'src', 'api.ts'), 'export const value = 1;\n', 'utf8');
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
  await mkdir(join(paths.fileHistoryDir, 'session-1'), { recursive: true });
  await writeFile(join(paths.fileHistoryDir, 'session-1', 'api@v1'), 'export const value = 0;\n', 'utf8');
  await writeFile(
    join(paths.projectsDir, encodeProjectPath(projectPath), 'session-1.replay.json'),
    JSON.stringify({
      sessionId: 'session-1',
      version: 1,
      createdAt: '2026-05-28T08:00:00.000Z',
      summary: {
        totalSteps: 1,
        toolBreakdown: { Edit: 1 },
        filesModified: ['src/api.ts'],
        durationMs: 1500,
        startTimestamp: '2026-05-28T08:00:00.000Z',
        endTimestamp: '2026-05-28T08:00:01.500Z',
        userRequests: 1,
      },
      steps: [
        {
          type: 'tool',
          stepNumber: 1,
          toolName: 'Edit',
          toolUseId: 'tool-edit',
          inputSummary: 'Edit src/api.ts',
          resultStatus: 'success',
          durationMs: 100,
          timestamp: '2026-05-28T08:00:00.500Z',
          filesModified: ['src/api.ts'],
        },
      ],
    }),
    'utf8',
  );
  await writeFile(
    join(paths.projectsDir, encodeProjectPath(projectPath), 'session-1.jsonl'),
    [
      JSON.stringify({
        type: 'user',
        sessionId: 'session-1',
        timestamp: '2026-05-28T08:00:00.000Z',
        cwd: projectPath,
        slug: 'release-plan',
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
          content: [
            { type: 'text', text: 'Done' },
            { type: 'tool_use', id: 'tool-edit', name: 'Edit', input: { file_path: 'src/api.ts' } },
            { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'npm test' } },
          ],
        },
      }),
      JSON.stringify({
        type: 'file-history-snapshot',
        timestamp: '2026-05-28T08:01:30.000Z',
        snapshot: {
          messageId: 'message-1',
          timestamp: '2026-05-28T08:01:30.000Z',
          trackedFileBackups: {
            'src/api.ts': {
              backupFileName: 'api@v1',
              version: 1,
              backupTime: '2026-05-28T08:01:30.000Z',
            },
          },
        },
      }),
      JSON.stringify({
        type: 'user',
        sessionId: 'session-1',
        timestamp: '2026-05-28T08:02:00.000Z',
        cwd: projectPath,
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok\n' }],
        },
        toolUseResult: { stdout: 'ok\n', interrupted: false },
      }),
    ].join('\n'),
    'utf8',
  );
  await writeFile(
    join(paths.projectsDir, encodeProjectPath(projectPath), 'session-2.jsonl'),
    [
      JSON.stringify({
        type: 'user',
        sessionId: 'session-2',
        timestamp: '2026-05-28T08:03:00.000Z',
        cwd: projectPath,
        message: { role: 'user', content: 'Inspect missing replay' },
      }),
      JSON.stringify({
        type: 'assistant',
        sessionId: 'session-2',
        timestamp: '2026-05-28T08:03:30.000Z',
        cwd: projectPath,
        message: {
          role: 'assistant',
          model: 'claude-sonnet',
          usage: { input_tokens: 4, output_tokens: 6 },
          content: [{ type: 'text', text: 'No replay sidecar exists.' }],
        },
      }),
    ].join('\n'),
    'utf8',
  );
  await mkdir(paths.plansDir, { recursive: true });
  await writeFile(
    join(paths.plansDir, 'release-plan.md'),
    '# Release Plan\n\nPrepare the public release.\n\n- [x] Build\n- [ ] Publish\n',
    'utf8',
  );
  await mkdir(join(paths.tasksDir, 'session-1'), { recursive: true });
  await writeFile(
    join(paths.tasksDir, 'session-1', '1.json'),
    `${JSON.stringify({
      subject: 'Prepare release',
      status: 'in_progress',
      description: 'Finish the public release checklist.',
      activeForm: 'Working',
    }, null, 2)}\n`,
    'utf8',
  );
  await writeFile(join(paths.tasksDir, 'session-1', 'broken.json'), '{not json\n', 'utf8');
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
  await page.getByRole('link', { name: /^Providers$/ }).click();
  await expect(page.getByText('Provider Profiles', { exact: true })).toBeVisible();
  await expect(page.getByText('Safe Templates')).toHaveCount(0);
  await expect(page.getByText('credential saved')).toBeVisible();
  await expect(page.getByRole('textbox', { name: /openclaude command for anthropic/i })).toHaveValue(
    'openclaude --provider anthropic --model claude-sonnet',
  );
  await expect(page.getByRole('button', { name: /add provider profile/i })).toHaveCount(1);
  await page.getByRole('button', { name: /add provider profile/i }).click();
  const providerDialog = page.getByRole('dialog', { name: /new provider profile/i });
  await expect(providerDialog).toBeVisible();
  await providerDialog.getByRole('button', { name: /template/i }).click();
  await expect(providerDialog.getByRole('listbox', { name: /provider template/i })).toBeVisible();
  await providerDialog.getByRole('option', { name: /ollama/i }).click();
  await expect(providerDialog.getByLabel(/generated openclaude command/i)).toHaveValue(
    'openclaude --provider ollama --model llama3.1:8b',
  );
  await providerDialog.getByRole('button', { name: /close dialog/i }).click();
  await page.getByRole('link', { name: /^Sessions$/ }).click();
  await page.locator('tr[aria-label="Open details for Build the API"]').click();
  const detailsDialog = page.getByRole('dialog', { name: 'Session Details' });
  await expect(detailsDialog).toBeVisible();
  await expect(detailsDialog).toHaveCSS('overflow-y', 'hidden');
  await expect(page.getByTestId('session-details-sidebar')).toHaveCSS('overflow-y', 'auto');
  await expect(detailsDialog.getByText('Build the API').first()).toBeVisible();
  await expect(detailsDialog.getByText('Successful')).toBeVisible();
  await expect(detailsDialog.getByText('claude-sonnet')).toBeVisible();
  await expect(detailsDialog.getByText('Usage')).toBeVisible();
  await expect(detailsDialog.getByText('Run command')).toBeVisible();
  await expect(detailsDialog.getByText('npm test')).toBeVisible();
  await expect(detailsDialog.getByText('Command output')).toBeVisible();
  await expect(detailsDialog.locator('code').filter({ hasText: /^ok\s*$/ })).toBeVisible();
  await detailsDialog.getByRole('tab', { name: /Review Changes/ }).click();
  await expect(detailsDialog.getByText('Changed files')).toBeVisible();
  await expect(detailsDialog.getByRole('navigation', { name: 'Changed files' }).getByRole('button', { name: 'src/api.ts' })).toBeVisible();
  await expect(detailsDialog.getByRole('article', { name: 'Diff for src/api.ts' })).toBeVisible();
  await detailsDialog.getByRole('button', { name: 'Hide file tree' }).click();
  await expect(detailsDialog.getByRole('navigation', { name: 'Changed files' })).toBeHidden();
  await expect(detailsDialog.getByRole('article', { name: 'Diff for src/api.ts' })).toBeVisible();
  await detailsDialog.getByRole('button', { name: 'Show file tree' }).click();
  await expect(detailsDialog.getByRole('navigation', { name: 'Changed files' })).toBeVisible();
  await expect(detailsDialog.getByText('@@ -1,1 +1,1 @@')).toBeVisible();
  await expect(detailsDialog.getByText('export const value = 0;')).toBeVisible();
  await expect(detailsDialog.getByText('export const value = 1;')).toBeVisible();
  await detailsDialog.getByRole('tab', { name: /Conversation/ }).click();
  await detailsDialog.getByRole('button', { name: /tools used/i }).click();
  await expect(detailsDialog.getByText('Bash x1')).toBeVisible();
  await detailsDialog.getByRole('tab', { name: /Replay/i }).click();
  await expect(detailsDialog.getByRole('tabpanel', { name: /Replay/i })).toBeVisible();
  await expect(detailsDialog.getByText('Edit src/api.ts')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(detailsDialog).toBeHidden();
  await page.locator('tr[aria-label="Open details for Inspect missing replay"]').click();
  await expect(detailsDialog).toBeVisible();
  await detailsDialog.getByRole('tab', { name: /Replay/i }).click();
  await expect(detailsDialog.getByText('No replay data available for this session.')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(detailsDialog).toBeHidden();
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

  let releaseWarnSearch: (() => void) | null = null;
  let warnSearchStarted = false;
  const warnSearchRelease = new Promise<void>((resolve) => {
    releaseWarnSearch = resolve;
  });

  await page.route('http://127.0.0.1:43111/api/logs/search**', async (route) => {
    const requestUrl = new URL(route.request().url());
    if (!warnSearchStarted && requestUrl.searchParams.get('level') === 'warn') {
      warnSearchStarted = true;
      await warnSearchRelease;
    }
    await route.continue();
  });

  await page.getByRole('button', { name: 'warn' }).click();
  await expect.poll(() => warnSearchStarted).toBe(true);

  const logConsole = page.locator('.log-console');
  const logLoadingOverlay = page.locator('.log-console-loading-overlay.loading-overlay');
  await expect(logLoadingOverlay.getByText('Loading logs')).toBeVisible();
  await expect(logLoadingOverlay.locator('.loading-overlay-card')).toBeVisible();
  const [overlayBox, logConsoleBox] = await Promise.all([
    logLoadingOverlay.boundingBox(),
    logConsole.boundingBox(),
  ]);
  expect(overlayBox).not.toBeNull();
  expect(logConsoleBox).not.toBeNull();
  expect(overlayBox!.y).toBeGreaterThanOrEqual(logConsoleBox!.y);
  expect(overlayBox!.y + overlayBox!.height).toBeLessThanOrEqual(logConsoleBox!.y + logConsoleBox!.height);
  releaseWarnSearch?.();
  await expect(logLoadingOverlay).toBeHidden();
});

test('loads project plans and tasks with route diagnostics', async ({ page }) => {
  await page.addInitScript((serverUrl) => {
    window.localStorage.setItem('openclaude-studio:server-url', serverUrl);
  }, 'http://127.0.0.1:43111');

  await page.goto('/plans-tasks');

  await expect(page.getByRole('heading', { name: 'Plans & Tasks' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Release Plan.*Prepare the public release/ })).toBeVisible();
  await expect(page.getByText('1 diagnostic while reading plans and tasks')).toBeVisible();
  await expect(page.getByText('Invalid task JSON')).toBeVisible();
  await page.getByRole('button', { name: /Release Plan.*Prepare the public release/ }).click();
  await page.getByRole('button', { name: /Open session Build the API/ }).click();
  const detailsDialog = page.getByRole('dialog', { name: 'Session Details' });
  await expect(detailsDialog).toBeVisible();
  await detailsDialog.getByRole('button', { name: /Plans 1/ }).click();
  await expect(detailsDialog.getByText('Release Plan')).toBeVisible();
  await detailsDialog.getByRole('button', { name: /Tasks 1/ }).click();
  await expect(detailsDialog.getByText('Prepare release')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(detailsDialog).toBeHidden();

  await page.getByRole('tab', { name: /Tasks/ }).click();

  const taskButton = page.getByRole('button', { name: /Prepare release.*Finish the public release checklist/ });
  await expect(taskButton).toBeVisible();
  await expect(taskButton.getByText('In Progress')).toBeVisible();
  await taskButton.click();
  await page.getByRole('button', { name: /Open session Build the API/ }).click();
  await expect(detailsDialog).toBeVisible();
  await page.keyboard.press('Escape');

  await page.getByRole('link', { name: /Diagnostics/ }).click();

  await expect(page.getByRole('heading', { name: 'Diagnostics' })).toBeVisible();
  await expect(page.getByText('Invalid task JSON')).toBeVisible();
  await expect(page.getByText(/broken\.json/)).toBeVisible();
});
