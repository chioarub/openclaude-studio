import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import type { ProjectSummary } from '@openclaude-studio/shared';

import { createOpenClaudePaths, encodeProjectPath } from './paths.js';
import { listProjectPlans, readProjectPlan } from './plans.js';
import { isUnsupportedSymlinkError } from '../test-support/symlink.js';

type ProjectInput = Pick<ProjectSummary, 'id' | 'name' | 'path' | 'exists'>;

describe('project plans', () => {
  test('returns an empty scoped list when the plans directory does not exist', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ocs-plans-'));
    const paths = createOpenClaudePaths({ home, env: {} });
    const project = projectFixture(home);

    const result = await listProjectPlans(paths, project);

    expect(result.exists).toBe(false);
    expect(result.plans).toEqual([]);
    expect(result.diagnostics).toEqual([
      { level: 'info', message: 'Plans directory does not exist yet.', path: paths.plansDir },
    ]);
  });

  test('lists only plans referenced by selected-project sessions', async () => {
    const { paths, project, otherProjectPath } = await makePlansHome();

    await writePlan(paths.plansDir, 'selected-plan', [
      '# Selected Plan',
      '',
      'Selected implementation detail.',
      '- [x] Done thing',
      '- [ ] Pending thing',
      '',
    ].join('\n'));
    await writePlan(paths.plansDir, 'other-plan', '# Other Plan\n\nother-only detail\n');
    await writePlan(paths.plansDir, 'orphan-plan', '# Orphan Plan\n\nnot referenced\n');
    await writeTranscript(paths, project.path, 'session-selected', 'selected-plan', 'Use selected plan');
    await writeTranscript(paths, otherProjectPath, 'session-other', 'other-plan', 'Use other plan');

    const result = await listProjectPlans(paths, project);

    expect(result.project).toEqual(project);
    expect(result.plansDir).toBe(paths.plansDir);
    expect(result.plans).toHaveLength(1);
    expect(result.plans[0]).toMatchObject({
      id: 'selected-plan',
      title: 'Selected Plan',
      exists: true,
      checklist: { total: 2, completed: 1, pending: 1 },
      sessionIds: ['session-selected'],
      sessions: [
        {
          id: 'session-selected',
          title: 'Use selected plan',
          lastTimestamp: '2026-05-16T10:00:00.000Z',
        },
      ],
    });
    expect(JSON.stringify(result.plans)).not.toContain('Other Plan');
    expect(JSON.stringify(result.plans)).not.toContain('Orphan Plan');
  });

  test('lists plans referenced by selected-project worktree sessions', async () => {
    const { paths, project } = await makePlansHome();
    const worktreePath = join(project.path, '.claude', 'worktrees', 'feature-a');
    await writePlan(paths.plansDir, 'worktree-plan', '# Worktree Plan\n\nBuild from a worktree.\n');
    await writeTranscriptRows(paths, worktreePath, 'session-worktree', [
      {
        type: 'user',
        timestamp: '2026-05-16T10:00:00.000Z',
        sessionId: 'session-worktree',
        cwd: worktreePath,
        slug: 'worktree-plan',
        message: { role: 'user', content: 'Use worktree plan' },
      },
    ]);

    const result = await listProjectPlans(paths, project);

    expect(result.plans).toHaveLength(1);
    expect(result.plans[0]).toMatchObject({
      id: 'worktree-plan',
      title: 'Worktree Plan',
      sessionIds: ['session-worktree'],
      sessions: [
        {
          id: 'session-worktree',
          title: 'Use worktree plan',
          lastTimestamp: '2026-05-16T10:00:00.000Z',
        },
      ],
    });
    expect(result.diagnostics).toEqual([]);
  });

  test('restricts plan details to plans linked to the selected project', async () => {
    const { paths, project, otherProjectPath } = await makePlansHome();
    await writePlan(paths.plansDir, 'selected-plan', '# Selected Plan\n\nneedle implementation detail\n');
    await writePlan(paths.plansDir, 'other-plan', '# Other Plan\n\nother-only detail\n');
    await writeTranscript(paths, project.path, 'session-selected', 'selected-plan', 'Use selected plan');
    await writeTranscript(paths, otherProjectPath, 'session-other', 'other-plan', 'Use other plan');

    const details = await readProjectPlan(paths, project, 'selected-plan');

    expect(details.plan.id).toBe('selected-plan');
    expect(details.plan.content).toContain('needle implementation detail');
    expect(details.plan.sessionIds).toEqual(['session-selected']);
    expect(details.plan.sessions).toEqual([
      {
        id: 'session-selected',
        title: 'Use selected plan',
        lastTimestamp: '2026-05-16T10:00:00.000Z',
      },
    ]);
    await expect(readProjectPlan(paths, project, 'other-plan')).rejects.toThrow('Plan not found');
    await expect(readProjectPlan(paths, project, '../outside')).rejects.toThrow('Invalid plan ID');
  });

  test('ignores stale plan references when the Markdown file is not present locally', async () => {
    const { paths, project } = await makePlansHome();
    await writeTranscript(paths, project.path, 'session-missing', 'missing-plan', 'Use missing plan');

    const result = await listProjectPlans(paths, project);

    expect(result.plans).toEqual([]);
    expect(result.diagnostics).toEqual([]);
    await expect(readProjectPlan(paths, project, 'missing-plan')).rejects.toThrow('Plan not found');
  });

  test('ignores dot-prefixed transcript slugs and unreferenced agent plan files', async () => {
    const { paths, project } = await makePlansHome();
    await writePlan(paths.plansDir, 'selected-plan-agent-worker', '# Agent Worker\n\nnot directly linked\n');
    await writeTranscript(paths, project.path, 'session-hidden', '.hidden-plan', 'Use hidden plan');

    const result = await listProjectPlans(paths, project);

    expect(result.plans).toEqual([]);
    await expect(readProjectPlan(paths, project, 'selected-plan-agent-worker')).rejects.toThrow('Plan not found');
    await expect(readProjectPlan(paths, project, '.hidden-plan')).rejects.toThrow('Invalid plan ID');
  });

  test('does not list or read referenced symlinked plans', async () => {
    const { paths, project, home } = await makePlansHome();
    const outsidePlan = join(home, 'outside-plan.md');
    const symlinkPlan = join(paths.plansDir, 'symlink-plan.md');
    await writeFile(outsidePlan, '# Outside Plan\n\noutside secret\n');
    try {
      await symlink(outsidePlan, symlinkPlan);
    } catch (error) {
      if (isUnsupportedSymlinkError(error)) return;
      throw error;
    }
    await writeTranscript(paths, project.path, 'session-symlink', 'symlink-plan', 'Use symlink plan');

    const result = await listProjectPlans(paths, project);

    expect(result.plans).toEqual([]);
    expect(result.diagnostics).toEqual([
      {
        level: 'warn',
        message: 'Referenced plan path exists but is not a regular readable file.',
        path: symlinkPlan,
      },
    ]);
    await expect(readProjectPlan(paths, project, 'symlink-plan')).rejects.toThrow('Plan not found');
  });

  test('redacts sensitive values in plan detail content', async () => {
    const { paths, project } = await makePlansHome();
    await writePlan(paths.plansDir, 'secret-plan', '# Secret Plan\n\nOPENAI_API_KEY=sk-secretvalue\n');
    await writeTranscript(paths, project.path, 'session-secret', 'secret-plan', 'Use secret plan');

    const details = await readProjectPlan(paths, project, 'secret-plan');

    expect(details.plan.content).toContain('OPENAI_API_KEY=<redacted>');
    expect(details.plan.content).not.toContain('sk-secretvalue');
  });

  test('deduplicates plan session references and uses the latest session timestamp', async () => {
    const { paths, project } = await makePlansHome();
    await writePlan(paths.plansDir, 'selected-plan', '# Selected Plan\n\nBody\n');
    await writeTranscriptRows(paths, project.path, 'session-part-1', [
      {
        type: 'user',
        timestamp: '2026-05-16T10:00:00.000Z',
        sessionId: 'session-selected',
        cwd: project.path,
        slug: 'selected-plan',
        message: { role: 'user', content: 'Use selected plan' },
      },
    ]);
    await writeTranscriptRows(paths, project.path, 'session-part-2', [
      {
        type: 'assistant',
        timestamp: '2026-05-16T11:30:00.000Z',
        sessionId: 'session-selected',
        cwd: project.path,
        message: { role: 'assistant', content: [{ type: 'text', text: 'Still working' }] },
      },
    ]);

    const result = await listProjectPlans(paths, project);

    expect(result.plans).toHaveLength(1);
    expect(result.plans[0]?.sessionIds).toEqual(['session-selected']);
    expect(result.plans[0]?.latestSessionAt).toBe('2026-05-16T11:30:00.000Z');
  });

  test('reports truncated plan summaries instead of hiding partial reads', async () => {
    const { paths, project } = await makePlansHome();
    await writePlan(paths.plansDir, 'large-plan', `# Large Plan\n\n${'open item '.repeat(8_000)}\n`);
    await writeTranscript(paths, project.path, 'session-large', 'large-plan', 'Use large plan');

    const result = await listProjectPlans(paths, project);

    expect(result.plans).toHaveLength(1);
    expect(result.plans[0]?.id).toBe('large-plan');
    expect(result.diagnostics).toContainEqual({
      level: 'warn',
      message: 'File was truncated to 65536 bytes.',
      path: join(paths.plansDir, 'large-plan.md'),
    });
  });
});

async function makePlansHome() {
  const home = await mkdtemp(join(tmpdir(), 'ocs-plans-'));
  const paths = createOpenClaudePaths({ home, env: {} });
  const project = projectFixture(home);
  const otherProjectPath = join(home, 'other-project');
  await mkdir(paths.plansDir, { recursive: true });
  return { home, paths, project, otherProjectPath };
}

function projectFixture(home: string): ProjectInput {
  return {
    id: 'project-1',
    name: 'selected-project',
    path: join(home, 'selected-project'),
    exists: true,
  };
}

async function writePlan(plansDir: string, slug: string, content: string) {
  await mkdir(plansDir, { recursive: true });
  await writeFile(join(plansDir, `${slug}.md`), content);
}

async function writeTranscript(
  paths: ReturnType<typeof createOpenClaudePaths>,
  projectPath: string,
  sessionId: string,
  slug: string,
  content: string,
) {
  return writeTranscriptRows(paths, projectPath, sessionId, [
    {
      type: 'user',
      timestamp: '2026-05-16T10:00:00.000Z',
      sessionId,
      cwd: projectPath,
      slug,
      message: { role: 'user', content },
    },
  ]);
}

async function writeTranscriptRows(
  paths: ReturnType<typeof createOpenClaudePaths>,
  projectPath: string,
  fileName: string,
  rows: unknown[],
) {
  const transcriptDir = join(paths.projectsDir, encodeProjectPath(projectPath));
  await mkdir(transcriptDir, { recursive: true });
  await writeFile(
    join(transcriptDir, `${fileName}.jsonl`),
    `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`,
  );
}
