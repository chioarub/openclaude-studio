# Troubleshooting

Use this guide when the hosted dashboard cannot reach the local API or local OpenClaude data looks incomplete.

## Dashboard says "Start the local OpenClaude Studio server"

Start the local API and keep the terminal open:

```bash
npx openclaude-studio
```

Then refresh the dashboard at:

```text
https://openclaude-studio.pages.dev/
```

The hosted dashboard connects to `http://127.0.0.1:43110` by default.

## Node.js version errors

OpenClaude Studio requires Node.js 22 or newer. Check your version with:

```bash
node --version
```

Update Node.js before running `npx openclaude-studio` if the version is older than 22.

## No projects appear

OpenClaude must be installed and used at least once before Studio has local data to inspect.

Studio reads project information from `~/.openclaude.json` and bounded transcript metadata under `~/.openclaude/projects/`. If those files are missing, malformed, or point to project paths that no longer exist, the dashboard may show an empty or degraded project list with diagnostics.

## Studio shows the wrong projects

Studio resolves the OpenClaude config directory the same way OpenClaude does: `OPENCLAUDE_CONFIG_DIR` takes precedence over the legacy `CLAUDE_CONFIG_DIR`. If you launch OpenClaude with one and Studio with the other, Studio will inspect a different root.

If both variables are set to different values, Studio uses `OPENCLAUDE_CONFIG_DIR` and surfaces a warning in `/api/projects` diagnostics. Align the two values, or unset the one you do not want, so both tools read the same root.

Studio never migrates or copies OpenClaude data. It only reads from the selected root.

## Provider or credential status looks wrong

Studio reads saved provider profiles from the resolved OpenClaude configuration source and, when present, the startup launch profile at `<resolved OpenClaude config root>/.openclaude-profile.json`.

Credential status is value-free. Studio reports whether a credential appears configured, whether an OpenAI-compatible pool has a parsed non-empty count, and whether a documented placeholder was detected. It never shows credential values or validates them over the network.

Environment-based credential diagnostics describe only the environment inherited by the Studio server process. If OpenClaude was launched from another shell, service manager, or app with different variables, Studio may not see the same environment. Restart `npx openclaude-studio` from the same shell if you expect inherited environment variables to match.

Dynamic providers may show discovery capability without a copied model catalog. Studio does not call provider APIs, so configured models and recognition diagnostics are local inspection only.

## Port already in use

Start the local API on another loopback port:

```bash
npx openclaude-studio --port 43111
```

When the dashboard shows the disconnected banner, enter the matching API URL, for example:

```text
http://127.0.0.1:43111
```

Use **Reset API URL** in the banner to return to the default `http://127.0.0.1:43110`.

## Custom hosted frontend origin

The official hosted dashboard is allowed by default. For another hosted frontend, allow its exact origin:

```bash
npx openclaude-studio --allowed-origin https://studio.example.com
```

or:

```bash
OPENCLAUDE_STUDIO_ALLOWED_ORIGINS=https://studio.example.com npx openclaude-studio
```

## `OPENCLAUDE_STUDIO_TOKEN`

`OPENCLAUDE_STUDIO_TOKEN` enables API token checks for custom clients or custom deployments with their own access flow.

The bundled hosted UI does not prompt for tokens. If you enable token mode, the hosted dashboard will not be able to load protected endpoints.

## Logs and screenshots may contain private data

Redaction is best effort and defense in depth. It is not a guarantee that every secret, prompt, file path, or private detail is removed.

Review logs, screenshots, recordings, and diagnostics before sharing them in public issues or pull requests.

## Background Sessions show as empty

Background sessions are read from `<resolved OpenClaude config root>/bg-sessions/`. If no sessions appear:

- Start a background session with `openclaude --bg` (requires an OpenClaude version that supports detached background sessions).
- Confirm the resolved config root matches where OpenClaude writes background data. Studio reads the same root OpenClaude uses; see the `OPENCLAUDE_CONFIG_DIR` documentation.
- Older OpenClaude versions without background sessions show an empty, non-error state.
- If the Background Sessions page shows "requires a newer local server", update the `openclaude-studio` package.

## Session Replay tab is missing or shows no data

The Replay tab appears in session details. Sessions without a replay sidecar show an empty replay state.

- The tab stays visible and shows an unavailable state if the local server does not support replay (the endpoint returns 404). Update the `openclaude-studio` package to enable it.
- The tab shows "No replay data available" when no `<sessionId>.replay.json` file exists. Replay sidecars are produced by newer OpenClaude versions; sessions created by older versions will not have one.
- The tab says the replay schema version is not supported when the replay file was written by a newer OpenClaude than this server understands. Update `openclaude-studio` to read the newer format.
- The tab shows "malformed" when the replay file is corrupt, oversized, or fails validation. This is intentional — Studio does not attempt partial unsafe parses.

## Browser cannot connect to the localhost API

Check these items:

- The `npx openclaude-studio` terminal process is still running.
- The dashboard API URL matches the local server host and port.
- The local API is bound to `127.0.0.1` unless you have an explicit trusted access-control model.
- The browser is allowed to make localhost or private-network requests from the hosted dashboard.

## How to report a bug safely

Include:

- Operating system
- Node.js version
- Browser and version
- OpenClaude Studio version
- OpenClaude version, if known
- Hosted dashboard or local web dev server
- Local API URL and port, without secrets
- Short reproduction steps

Do not include real OpenClaude logs, prompts, provider credentials, local session contents, private file paths, or screenshots containing private data unless you have safely redacted them.
