# OpenClaude Studio Local API

This package runs the read-only local API used by OpenClaude Studio.

The hosted frontend cannot read OpenClaude files directly from a browser. Run this server on the same machine as OpenClaude, then open the OpenClaude Studio frontend in your browser:

```text
https://openclaude-studio.pages.dev/
```

## Usage

Requires Node.js 22 or newer.

```bash
npx openclaude-studio
```

Keep the command running while you use the hosted frontend. Stop it with `Ctrl+C` when you are done.

The server binds to `127.0.0.1:43110` by default and reads:

- `~/.openclaude.json`
- `~/.openclaude/projects/`
- `~/.openclaude/plans/`
- `~/.openclaude/tasks/`
- `~/.openclaude/file-history/`
- `~/.openclaude/debug/`

Project discovery uses `~/.openclaude.json` and bounded transcript metadata from `~/.openclaude/projects/`, so historical project paths may appear even when they are no longer present on disk.

Startup output includes the local API URL, the hosted dashboard URL, read-only mode, and the allowed browser origins:

```text
OpenClaude Studio local API
  API: http://127.0.0.1:43110
  Dashboard: https://openclaude-studio.pages.dev/
  Mode: read-only
  Allowed browser origins: loopback plus https://openclaude-studio.pages.dev

Next step:
  Open the dashboard in your browser and keep this terminal running.
```

If `OPENCLAUDE_STUDIO_TOKEN` is enabled, startup output says token protection is enabled but never prints the token.

Opening the local API root in a browser shows a small read-only landing page with dashboard and health-check links.

Provider profile routes return redacted profile summaries, validation diagnostics, and safe templates only. They do not mutate OpenClaude provider profiles or test provider connections.

For connection and setup help, see the repository [troubleshooting guide](https://github.com/chioarub/openclaude-studio/blob/main/docs/troubleshooting.md).

## Hosted Frontend Origins

The official hosted frontend at `https://openclaude-studio.pages.dev` is allowed by default.

When using a custom hosted frontend, allow its exact origin:

```bash
npx openclaude-studio --allowed-origin https://studio.example.com
```

You can also use an environment variable:

```bash
OPENCLAUDE_STUDIO_ALLOWED_ORIGINS=https://studio.example.com npx openclaude-studio
```

## Options

```text
--host <host>                 Host to bind. Defaults to 127.0.0.1.
--port <port>                 Port to listen on. Defaults to 43110.
--allowed-origin <origin>     Additional hosted frontend origin to allow. Repeat or comma-separate values.
--version, -v                 Print version.
--help, -h                    Print help.
```

## Safety

The local API is read-only. It does not write OpenClaude settings, sessions, logs, provider profiles, project files, tasks, plans, or file-history data.

Keep the server bound to a loopback address unless you provide your own trusted access control.
