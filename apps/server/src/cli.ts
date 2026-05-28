#!/usr/bin/env node

import { readFileSync } from 'node:fs';

import { buildServer, defaultAllowedOrigins } from './http/server.js';

const version = readPackageVersion();
const options = readCliOptions(process.argv.slice(2));

if (options.help) {
  printHelp();
  process.exit(0);
}

if (options.version) {
  console.log(version);
  process.exit(0);
}

const port = options.port ?? Number.parseInt(process.env.OPENCLAUDE_STUDIO_PORT ?? '43110', 10);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  console.error(`Invalid port: ${String(port)}`);
  process.exit(1);
}

const host = options.host ?? process.env.OPENCLAUDE_STUDIO_HOST ?? '127.0.0.1';
const authToken = process.env.OPENCLAUDE_STUDIO_TOKEN;
const allowedOrigins = options.allowedOrigins;
const envAllowedOrigins = splitOrigins(process.env.OPENCLAUDE_STUDIO_ALLOWED_ORIGINS ?? '');
const displayedAllowedOrigins = [...new Set([...defaultAllowedOrigins, ...envAllowedOrigins, ...allowedOrigins])];

const server = await buildServer({
  ...(authToken ? { authToken } : {}),
  ...(allowedOrigins.length > 0 ? { allowedOrigins } : {}),
  version,
});
await server.listen({ host, port });

console.log('OpenClaude Studio local API');
console.log(`  URL: http://${host}:${port}`);
console.log('  Mode: read-only');
console.log(`  Allowed browser origins: loopback plus ${displayedAllowedOrigins.join(', ')}`);
if (authToken) {
  console.log('  API token protection: enabled');
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close().finally(() => process.exit(0));
  });
}

type CliOptions = {
  allowedOrigins: string[];
  help: boolean;
  host?: string;
  port?: number;
  version: boolean;
};

function readCliOptions(argv: string[]): CliOptions {
  const result: CliOptions = { allowedOrigins: [], help: false, version: false };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';
    if (arg === '--help' || arg === '-h') {
      result.help = true;
    } else if (arg === '--version' || arg === '-v') {
      result.version = true;
    } else if (arg === '--port') {
      result.port = readPortValue(argv[++index]);
    } else if (arg.startsWith('--port=')) {
      result.port = readPortValue(arg.slice('--port='.length));
    } else if (arg === '--host') {
      result.host = readRequiredValue('--host', argv[++index]);
    } else if (arg.startsWith('--host=')) {
      result.host = arg.slice('--host='.length);
    } else if (arg === '--allowed-origin') {
      result.allowedOrigins.push(...splitOrigins(readRequiredValue('--allowed-origin', argv[++index])));
    } else if (arg.startsWith('--allowed-origin=')) {
      result.allowedOrigins.push(...splitOrigins(arg.slice('--allowed-origin='.length)));
    } else {
      console.error(`Unknown option: ${arg}`);
      console.error('Run openclaude-studio --help for usage.');
      process.exit(1);
    }
  }

  return {
    ...result,
    allowedOrigins: [...new Set(result.allowedOrigins)],
  };
}

function readRequiredValue(flag: string, value: string | undefined): string {
  if (!value || value.startsWith('--')) {
    console.error(`Missing value for ${flag}.`);
    process.exit(1);
  }
  return value;
}

function readPortValue(value: string | undefined): number {
  const raw = readRequiredValue('--port', value);
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    console.error(`Invalid port: ${raw}`);
    process.exit(1);
  }
  return parsed;
}

function splitOrigins(value: string): string[] {
  return value
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function printHelp() {
  console.log(`OpenClaude Studio local API ${version}

Usage:
  openclaude-studio [options]

Options:
  --host <host>                 Host to bind. Defaults to OPENCLAUDE_STUDIO_HOST or 127.0.0.1.
  --port <port>                 Port to listen on. Defaults to OPENCLAUDE_STUDIO_PORT or 43110.
  --allowed-origin <origin>     Additional hosted frontend origin to allow. Repeat or comma-separate values.
  --version, -v                 Print version.
  --help, -h                    Print help.

Environment:
  OPENCLAUDE_STUDIO_ALLOWED_ORIGINS   Comma-separated additional hosted frontend origins.
  OPENCLAUDE_STUDIO_TOKEN             Optional API token for custom clients.
  CLAUDE_CONFIG_DIR                   Override OpenClaude config directory.
`);
}

function readPackageVersion(): string {
  try {
    const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version?: unknown;
    };
    return typeof packageJson.version === 'string' ? packageJson.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}
