import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import {
  assertContainedPath,
  readBoundedTextFile,
  readContainedBoundedTextFile,
} from './safeFile.js';

describe('safe file helpers', () => {
  test('rejects traversal outside root', () => {
    expect(() => assertContainedPath('/tmp/root', '/tmp/root/../secret.txt')).toThrow(/outside/);
  });

  test('reads bounded regular text files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ocs-safe-'));
    const file = join(dir, 'log.txt');
    await writeFile(file, 'line one\nline two\n', 'utf8');

    const result = await readBoundedTextFile(file, { maxBytes: 100 });

    expect(result.exists).toBe(true);
    expect(result.content).toBe('line one\nline two\n');
    expect(result.truncated).toBe(false);
  });

  test('truncates files over the requested byte limit', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ocs-safe-'));
    const file = join(dir, 'log.txt');
    await writeFile(file, 'abcdef', 'utf8');

    const result = await readBoundedTextFile(file, { maxBytes: 3 });

    expect(result.content).toBe('abc');
    expect(result.truncated).toBe(true);
    expect(result.diagnostics[0]?.level).toBe('warn');
  });

  test('refuses symlinked files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ocs-safe-'));
    const target = join(dir, 'target.txt');
    const link = join(dir, 'link.txt');
    await writeFile(target, 'secret', 'utf8');
    await symlink(target, link);

    const result = await readBoundedTextFile(link, { maxBytes: 100 });

    expect(result.exists).toBe(false);
    expect(result.diagnostics[0]?.level).toBe('warn');
  });

  test('rejects files reached through symlinked directories', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ocs-safe-'));
    const root = join(dir, 'root');
    const outside = join(dir, 'outside');
    await mkdir(root);
    await mkdir(outside);
    await writeFile(join(outside, 'secret.txt'), 'secret', 'utf8');
    await symlink(outside, join(root, 'linked-dir'));

    await expect(
      readContainedBoundedTextFile(root, join(root, 'linked-dir', 'secret.txt'), { maxBytes: 100 }),
    ).rejects.toThrow(/outside/);
  });
});
