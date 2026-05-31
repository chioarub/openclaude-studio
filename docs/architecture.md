# Architecture

OpenClaude Studio is split into three workspaces:

- `apps/server`: local Fastify API and npm CLI package
- `apps/web`: hosted or local React dashboard
- `packages/shared`: TypeScript API response contracts shared by server and web

The browser does not read local OpenClaude files directly. Instead, users run the local API on the same machine as OpenClaude and the web app calls that API over HTTP.

```text
Browser UI
  |
  | HTTP JSON
  v
Local API on 127.0.0.1:43110
  |
  | read-only file access
  v
~/.openclaude.json
~/.openclaude/projects/
~/.openclaude/plans/
~/.openclaude/tasks/
~/.openclaude/debug/
<project>/.openclaude/file-history/
```

## Server Responsibilities

The server is intentionally narrow:

- Discover OpenClaude projects from local config.
- Read session summaries and rich session details from local project session files.
- Read project-scoped plans, tasks, and file-history context.
- Read provider configuration with secret fields redacted.
- Read debug logs through bounded, indexed windows.
- Scope logs and diagnostics to the selected project where possible.
- Return typed JSON responses.

The server should not mutate OpenClaude settings, sessions, logs, provider profiles, project files, tasks, or plans in the current MVP line.

## Web Responsibilities

The web app is a read-only dashboard:

- Project selector and route navigation
- Control center overview
- Session table and session details inspector
- Plans & Tasks route with linked session context
- Provider summary
- System logs with filtering, search, virtualization, and copy-to-clipboard
- Diagnostics
- Light and dark themes

The web app defaults to `http://127.0.0.1:43110` for the local API. Hosted deployments must still connect to a local server running on the user's machine.

## Shared Contracts

All public API response shapes should be defined in `packages/shared/src/api.ts`. Server changes that add or modify response fields should update shared types and corresponding web usage in the same pull request.

## Data Flow Rules

- Keep API endpoints read-only by default.
- Keep file reads bounded.
- Avoid following symlinks for sensitive local file reads.
- Redact likely secrets before sending data to the browser.
- Scope project-specific views by project/session identifiers when available.
- Prefer explicit diagnostics over silent failure when local data is missing or malformed.
