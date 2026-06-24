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

Provider profile endpoints are read-only. They expose redacted profile summaries, provider recognition, credential-state metadata, validation diagnostics, startup launch profile diagnostics, and safe copyable templates, but they do not create, update, delete, activate, test provider profiles, or call provider APIs.

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

## Provider Inspection

The local server exposes read-only provider inspection through:

- `GET /api/provider/active` — returns the active provider summary used by the overview.
- `GET /api/provider/profiles` — returns saved provider profile summaries, startup launch profile summary, diagnostics, and curated safe templates.

Read scope is limited to the resolved OpenClaude configuration root already used by Studio, plus the startup profile file when present:

```text
<resolved OpenClaude config root>/.config.json
<resolved OpenClaude config root>/.openclaude.json
<resolved OpenClaude config root>/.claude.json
<resolved OpenClaude config root>/.openclaude-profile.json
```

The startup profile reader parses only documented `profile`, `env`, and `createdAt` fields from `.openclaude-profile.json`. Known credential fields are summarized as value-free booleans/counts, known-safe non-secret field names may be listed, and unknown `env` names are omitted. Unknown non-empty profile names degrade to custom recognition. The read is bounded and symlink-safe. Missing, malformed, oversized, or symlinked startup profile files are reported as typed diagnostics.

Provider recognition is best effort and derived from OpenClaude route identifiers and controlled host matches. Studio does not copy dynamic model catalogs or make network calls to discover or validate models. Unknown future providers degrade to a custom OpenAI-compatible classification.

When re-syncing provider recognition, compare Studio's static registry and startup `env` allowlists against current OpenClaude route descriptors and `providerProfile` `PROFILE_ENV_KEYS`. Keep the registry static and reviewed rather than importing OpenClaude at runtime.

Credential diagnostics are intentionally value-free. The API can report:

- `credentialMode`: `none`, `single`, `pool`, or `unknown`
- `credentialCount`: parsed non-empty credential count, or `null` when unknown
- `credentialConfigured`: boolean
- `credentialInvalid`: boolean for documented placeholder or malformed persisted values
- `credentialSources`: labels such as saved profile fields, inherited Studio server environment, or startup profile env keys

Credential values, masked values, hashes, prefixes, lengths, and pool order are never returned. Studio does not read arbitrary `.env` files, shell history, Codex auth files, keychains, browser storage, or provider-specific credential stores. Environment-based diagnostics describe only the environment inherited by the Studio server process and may differ from another running OpenClaude process.

## Background Sessions

The local server exposes read-only monitoring of OpenClaude's detached background sessions (started with `openclaude --bg`).

Read scope is limited to:

```text
<resolved OpenClaude config root>/bg-sessions/sessions/*.json
<resolved OpenClaude config root>/bg-sessions/logs/<id>.out.log
<resolved OpenClaude config root>/bg-sessions/logs/<id>.err.log
```

Studio derives log paths from validated session ids and the trusted logs root. It does not trust `stdoutLogPath` or `stderrLogPath` values embedded in metadata as read authorization.
When a log file exceeds the byte read cap, Studio returns the retained tail window only; `totalLines`, `start`, and per-entry `lineNumber` values are relative to that retained byte window because the server does not read discarded bytes to count their lines.

Endpoints:

- `GET /api/background-sessions` — lists safe session summaries with status counters.
- `GET /api/background-sessions/:sessionId/logs?stream=stdout|stderr&start=...&count=...&tail=true` — returns a bounded, redacted window of stdout or stderr.

Studio reports `recordedStatus` from the metadata file. It does not probe processes or claim a session is live; `processPresence` is always `unknown` in this version. Studio never manages, kills, or spawns processes — there are no write or control endpoints.

## Troubleshooting

See [Troubleshooting](troubleshooting.md) for connection failures, custom ports, token mode, missing projects, and safe bug-reporting guidance.
