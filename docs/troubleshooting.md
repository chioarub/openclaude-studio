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
