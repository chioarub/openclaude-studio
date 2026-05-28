# OpenClaude Studio

OpenClaude Studio is a read-only local companion for OpenClaude. The web UI can be hosted anywhere, while the local server runs on your machine and reads OpenClaude's local files over a token-protected localhost API.

Version `0.0.1` keeps the scope deliberately small:

- Project selector from `~/.openclaude.json`
- Active provider diagnostics with secret fields redacted
- Recent session summaries without full transcript views
- Bounded, redacted log viewing and search
- Read-only local API with no write endpoints

## Quick Start

```bash
npm install
npm run dev
```

The server prints a local URL and API token. Open the web UI at `http://127.0.0.1:5173`, paste the token, and refresh.

For a production-style local run:

```bash
npm run build
OPENCLAUDE_STUDIO_TOKEN="$(openssl rand -base64 24)" npm run start -w @openclaude-studio/server
```

## Scripts

```bash
npm test
npm run lint
npm run build
npm run test:e2e
```

## Architecture

- `apps/server`: Fastify local API and CLI binary
- `apps/web`: Vite + React dashboard
- `packages/shared`: API response types shared by server and web

The server reads:

- `~/.openclaude.json`
- `~/.openclaude/projects`
- `~/.openclaude/debug`

It refuses unsafe paths, avoids symlink traversal for file reads, bounds log/transcript reads, and redacts likely secrets before returning provider URLs, log lines, and session titles.

## Safety Model

OpenClaude Studio `0.0.1` is read-only. It does not modify OpenClaude settings, sessions, logs, project files, provider profiles, or tasks.

The local API binds to `127.0.0.1` by default and requires `x-openclaude-studio-token` for data endpoints. Keep that token private.
