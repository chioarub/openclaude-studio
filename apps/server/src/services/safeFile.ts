import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

import type { Diagnostic } from '@openclaude-studio/shared';

import { invalidRequest } from '../http/errors.js';

export type BoundedTextRead = {
  path: string;
  exists: boolean;
  content: string;
  truncated: boolean;
  diagnostics: Diagnostic[];
};

export function assertContainedPath(root: string, target: string): string {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);

  if (isPathInside(resolvedRoot, resolvedTarget)) {
    return resolvedTarget;
  }

  throw invalidRequest('Requested path is outside the allowed root.');
}

export async function readContainedBoundedTextFile(
  root: string,
  target: string,
  options: { maxBytes: number },
): Promise<BoundedTextRead> {
  const containedTarget = assertContainedPath(root, target);

  try {
    const [realRoot, realTarget] = await Promise.all([realpath(root), realpath(containedTarget)]);
    if (!isPathInside(realRoot, realTarget)) {
      throw invalidRequest('Requested path is outside the allowed root.');
    }
  } catch (error) {
    if (isNodeFileError(error, 'ENOENT')) {
      return unreadable(containedTarget, 'info', 'File does not exist.');
    }

    throw error;
  }

  return readBoundedTextFile(containedTarget, options);
}

export async function readBoundedTextFile(
  path: string,
  options: { maxBytes: number },
): Promise<BoundedTextRead> {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1) {
    throw invalidRequest('maxBytes must be a positive integer.');
  }

  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink()) {
      return unreadable(path, 'warn', 'Symlinked files are not read.');
    }

    if (!stats.isFile()) {
      return unreadable(path, 'warn', 'Path exists but is not a regular file.');
    }

    const noFollowFlag = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
    const handle = await open(path, constants.O_RDONLY | noFollowFlag);

    try {
      const bytesToRead = Math.min(stats.size, options.maxBytes);
      const buffer = Buffer.alloc(bytesToRead);
      const { bytesRead } = await handle.read(buffer, 0, bytesToRead, 0);

      return {
        path,
        exists: true,
        content: buffer.subarray(0, bytesRead).toString('utf8'),
        truncated: stats.size > options.maxBytes,
        diagnostics:
          stats.size > options.maxBytes
            ? [{ level: 'warn', message: `File was truncated to ${options.maxBytes} bytes.`, path }]
            : [],
      };
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (isNodeFileError(error, 'ENOENT')) {
      return unreadable(path, 'info', 'File does not exist.');
    }

    if (isNodeFileError(error, 'ELOOP')) {
      return unreadable(path, 'warn', 'Symlinked files are not read.');
    }

    throw error;
  }
}

function unreadable(
  path: string,
  level: Diagnostic['level'],
  message: string,
): BoundedTextRead {
  return {
    path,
    exists: false,
    content: '',
    truncated: false,
    diagnostics: [{ level, message, path }],
  };
}

function isNodeFileError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}

function isPathInside(root: string, target: string): boolean {
  const relativePath = relative(root, target);
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
}
