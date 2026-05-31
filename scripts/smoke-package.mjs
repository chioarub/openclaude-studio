#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageJsonPath = join(repositoryRoot, 'apps/server/package.json');
const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'));
const expectedVersion = packageJson.version;
let tarballPath;
let tempDir;

try {
  const { stdout } = await execFileAsync('npm', ['pack', '--json', '-w', 'openclaude-studio'], {
    cwd: repositoryRoot,
    maxBuffer: 1024 * 1024,
  });
  const [packed] = JSON.parse(stdout);
  if (!packed?.filename) {
    throw new Error('npm pack did not report a tarball filename.');
  }

  tarballPath = join(repositoryRoot, packed.filename);
  tempDir = await mkdtemp(join(tmpdir(), 'openclaude-studio-package-'));
  await writeFile(join(tempDir, 'package.json'), '{ "private": true, "type": "module" }\n', 'utf8');
  await execFileAsync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', tarballPath], {
    cwd: tempDir,
    maxBuffer: 1024 * 1024,
  });

  const binaryPath = join(tempDir, 'node_modules/.bin/openclaude-studio');
  const binary = process.platform === 'win32' ? `${binaryPath}.cmd` : binaryPath;
  const { stdout: versionOutput } = await execFileAsync(binary, ['--version'], {
    cwd: tempDir,
    maxBuffer: 1024 * 1024,
  });
  const actualVersion = versionOutput.trim();
  if (actualVersion !== expectedVersion) {
    throw new Error(`Expected CLI version ${expectedVersion}, received ${actualVersion || '<empty>'}.`);
  }

  const { stdout: helpOutput } = await execFileAsync(binary, ['--help'], {
    cwd: tempDir,
    maxBuffer: 1024 * 1024,
  });
  if (
    !helpOutput.includes('--port <port>') ||
    !helpOutput.includes('--allowed-origin <origin>') ||
    !helpOutput.includes('https://openclaude-studio.pages.dev/')
  ) {
    throw new Error('CLI help output is missing expected options.');
  }

  console.log(`Packed package smoke test passed for openclaude-studio@${expectedVersion}.`);
} finally {
  if (tempDir) {
    await rm(tempDir, { force: true, recursive: true });
  }
  if (tarballPath) {
    await rm(tarballPath, { force: true });
  }
}
