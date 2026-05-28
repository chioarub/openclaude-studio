#!/usr/bin/env node

import { buildServer } from './http/server.js';

const port = readPort(process.argv) ?? Number.parseInt(process.env.OPENCLAUDE_STUDIO_PORT ?? '43110', 10);
const host = process.env.OPENCLAUDE_STUDIO_HOST ?? '127.0.0.1';
const authToken = process.env.OPENCLAUDE_STUDIO_TOKEN;

const server = await buildServer(authToken ? { authToken } : {});
await server.listen({ host, port });

console.log(`OpenClaude Studio server listening at http://${host}:${port}`);
if (authToken) {
  console.log('OpenClaude Studio API token protection enabled.');
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close().finally(() => process.exit(0));
  });
}

function readPort(argv: string[]): number | null {
  const index = argv.indexOf('--port');
  if (index < 0) return null;
  const value = argv[index + 1];
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}
