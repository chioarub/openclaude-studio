# Local Server

The local server is the read-only bridge between the hosted dashboard and local OpenClaude files.

## Start the Server

```bash
npx openclaude-studio
```

By default, the server listens at:

```text
http://127.0.0.1:43110
```

Keep the command running while using the dashboard. Stopping the process stops the local API.

Startup output includes the local API URL, hosted dashboard URL, read-only mode, and allowed browser origins. It also reminds users to keep the terminal running.

Opening `http://127.0.0.1:43110/` in a browser shows a small read-only landing page with dashboard and health-check links. It does not read local OpenClaude data.

Provider profile endpoints are read-only. They expose redacted profile summaries, validation diagnostics, and safe copyable templates, but they do not create, update, delete, activate, or test provider profiles.

## CLI Options

```text
--host <host>                 Host to bind. Defaults to 127.0.0.1.
--port <port>                 Port to listen on. Defaults to 43110.
--allowed-origin <origin>     Additional hosted frontend origin to allow. Repeat or comma-separate values.
--version, -v                 Print version.
--help, -h                    Print help.
```

## Environment Variables

| Variable | Default | Description |
| --- | --- | --- |
| `OPENCLAUDE_STUDIO_HOST` | `127.0.0.1` | Host for the local API server. |
| `OPENCLAUDE_STUDIO_PORT` | `43110` | Port for the local API server. |
| `OPENCLAUDE_STUDIO_ALLOWED_ORIGINS` | official hosted app plus loopback browser origins | Comma-separated additional hosted web origins allowed to call the local API. |
| `OPENCLAUDE_STUDIO_TOKEN` | unset | Optional API token for custom callers or deployments with their own access flow. |
| `OPENCLAUDE_CONFIG_DIR` | `~/.openclaude` | OpenClaude config directory override (preferred). Studio reads the same root OpenClaude uses. `.config.json` is checked first, followed by `.openclaude.json`; under an override, `.claude.json` is a legacy fallback if the modern file is missing. |
| `CLAUDE_CONFIG_DIR` | `~/.openclaude` | OpenClaude config directory override (legacy alias). Honored only when `OPENCLAUDE_CONFIG_DIR` is unset or blank. If both are set to different values, `OPENCLAUDE_CONFIG_DIR` wins and Studio surfaces a warning in `/api/projects` diagnostics. |

The bundled web UI does not prompt for `OPENCLAUDE_STUDIO_TOKEN`. If you enable a token, use it for custom clients or your own access flow.

## Browser Origins

Loopback browser origins are allowed so local development works without extra configuration. The official hosted frontend is allowed by default:

```text
https://openclaude-studio.pages.dev
```

For a custom hosted frontend, allow the exact origin:

```bash
npx openclaude-studio --allowed-origin https://studio.example.com
```

or:

```bash
OPENCLAUDE_STUDIO_ALLOWED_ORIGINS=https://studio.example.com npx openclaude-studio
```

## Safety Notes

Keep the server bound to loopback unless you have a trusted network and an explicit access-control model. The server reads local OpenClaude files and should not be exposed to public networks.

## Background Sessions

The local server exposes read-only monitoring of OpenClaude's detached background sessions (started with `openclaude --bg`).

Read scope is limited to:

```text
<resolved OpenClaude config root>/bg-sessions/sessions/*.json
<resolved OpenClaude config root>/bg-sessions/logs/<id>.out.log
<resolved OpenClaude config root>/bg-sessions/logs/<id>.err.log
```

Studio derives log paths from validated session ids and the trusted logs root. It does not trust `stdoutLogPath` or `stderrLogPath` values embedded in metadata as read authorization.

Endpoints:

- `GET /api/background-sessions` — lists safe session summaries with status counters.
- `GET /api/background-sessions/:sessionId/logs?stream=stdout|stderr&start=...&count=...&tail=true` — returns a bounded, redacted window of stdout or stderr.

Studio reports `recordedStatus` from the metadata file. It does not probe processes or claim a session is live; `processPresence` is always `unknown` in this version. Studio never manages, kills, or spawns processes — there are no write or control endpoints.

## Troubleshooting

See [Troubleshooting](troubleshooting.md) for connection failures, custom ports, token mode, missing projects, and safe bug-reporting guidance.
