# OpenClaude Studio

OpenClaude Studio is a read-only local companion for OpenClaude. It gives you a clean browser UI for inspecting OpenClaude projects, sessions, provider status, diagnostics, and debug logs without editing your local OpenClaude data.

The project is intentionally small in `0.0.1`: a hosted or local web app talks to a local server running on your machine. The server reads OpenClaude files from disk, redacts likely secrets, and exposes only read-only HTTP endpoints.

## Current Scope

OpenClaude Studio `0.0.1` includes:

- Project selector backed by `~/.openclaude.json`
- Project overview with recent sessions, usage, log issue counts, and provider status
- Session summaries for the selected project
- Active provider inspection with secret fields redacted
- Project-scoped diagnostics
- Project-scoped debug log viewing, filtering, search, virtualized scrolling, and copy-to-clipboard for log messages
- Dark and light themes
- Read-only local API with no write endpoints

It does not currently edit OpenClaude settings, provider profiles, sessions, logs, project files, tasks, or plans.

## How It Works

```text
Browser UI
  |
  | HTTP JSON
  v
Local server on 127.0.0.1:43110
  |
  | read-only file access
  v
~/.openclaude.json
~/.openclaude/projects/
~/.openclaude/debug/
```

The web UI can run locally during development or be hosted as static assets. The server should run on the same machine as OpenClaude because it reads local OpenClaude files.

## Requirements

- Node.js 22 or newer
- npm
- OpenClaude installed and used at least once, so local config/session files exist

## Quick Start

For normal use, run the local API with npm and open the hosted frontend once it has been deployed:

```bash
npx openclaude-studio --allowed-origin https://your-project.pages.dev
```

The `--allowed-origin` value must match the exact Cloudflare Pages origin that serves the frontend. After the official hosted URL is finalized, this documentation will be updated with that URL.

## Local Development

Install dependencies:

```bash
npm install
```

Run the local server and web app:

```bash
npm run dev
```

Open the web UI at:

```text
http://127.0.0.1:5173
```

The local API listens at:

```text
http://127.0.0.1:43110
```

## Production-Style Local Run

Build all workspaces:

```bash
npm run build
```

Start the local API:

```bash
npm run start -w openclaude-studio
```

By default, the server binds to `127.0.0.1` and listens on port `43110`.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `OPENCLAUDE_STUDIO_HOST` | `127.0.0.1` | Host for the local API server. Keep this on loopback unless you provide your own trusted access control. |
| `OPENCLAUDE_STUDIO_PORT` | `43110` | Port for the local API server. |
| `OPENCLAUDE_STUDIO_ALLOWED_ORIGINS` | loopback browser origins | Comma-separated hosted web origins allowed to call the local API. |
| `OPENCLAUDE_STUDIO_TOKEN` | unset | Optional API token for custom callers or deployments with their own access flow. The bundled web UI does not prompt for tokens. |
| `CLAUDE_CONFIG_DIR` | `~/.openclaude` | OpenClaude config directory override, useful for testing alternate local data roots. |

If you host the web UI somewhere other than localhost, add that origin:

```bash
OPENCLAUDE_STUDIO_ALLOWED_ORIGINS=https://studio.example.com npm run start -w openclaude-studio
```

## Development

Useful commands:

```bash
npm run lint
npm test
npm run build
npm run test:e2e
```

Workspace layout:

- `apps/server`: Fastify local API and CLI binary
- `apps/web`: Vite, React, Tailwind CSS dashboard
- `packages/shared`: API response types shared by server and web
- `tests/e2e`: Playwright coverage for the integrated app

## Safety Model

OpenClaude Studio is designed to be conservative by default:

- The `0.0.1` API is read-only.
- The server binds to loopback by default.
- Browser origins are restricted to loopback unless explicitly configured.
- File reads are bounded.
- Symlink traversal is avoided for sensitive local file reads.
- Provider URLs, auth fields, bearer tokens, common API key formats, and log messages are redacted where possible.

Redaction is defense in depth, not a guarantee for every possible secret format. Avoid sharing screenshots or logs without reviewing them.

## Roadmap

The current release focuses on a useful read-only foundation. Future work will be prioritized by real user feedback. Valuable next areas include:

- Rich session timeline with transcript, tool call, file change, and error details
- Global project search across sessions, logs, config, prompt assets, plans, and tasks
- Plans and tasks views linked back to the sessions that created them
- File history and backup inspection for selected projects
- Config source explorer for user settings, project settings, local settings, and managed config
- Prompt asset inventory for instructions, agents, commands, skills, workflows, and output styles
- Hooks and permissions diagnostics
- Provider profile management with safe templates and validation
- Live log streaming with pause, filtering, and retention controls
- Hosted web deployment guidance and an installable local server package
- Optional write workflows after the write model, review UX, backups, and security boundaries are designed explicitly

Ideas, bug reports, and focused pull requests are welcome. If you propose a write-capable feature, please include the expected safety model and rollback behavior.

## Contributing

Please read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. Keep changes focused, include tests for behavior changes, and avoid committing local data, generated output, logs, secrets, or machine-specific paths.

## Security

Please read [SECURITY.md](SECURITY.md) for the local data access model and vulnerability reporting guidance.

## License

MIT. See [LICENSE](LICENSE).
