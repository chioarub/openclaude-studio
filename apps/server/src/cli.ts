#!/usr/bin/env node

const port = readPort(process.argv) ?? Number.parseInt(process.env.OPENCLAUDE_STUDIO_PORT ?? '43110', 10);
const host = process.env.OPENCLAUDE_STUDIO_HOST ?? '127.0.0.1';

console.log(`OpenClaude Studio server scaffold ready at http://${host}:${port}`);

function readPort(argv: string[]): number | null {
  const index = argv.indexOf('--port');
  if (index < 0) return null;
  const value = argv[index + 1];
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}
