# Security Policy

## Supported Versions

Security fixes target the latest tagged release and the current `main` branch.

## Reporting a Vulnerability

Please report vulnerabilities through GitHub private vulnerability reporting when available, or open a minimal issue that does not include exploit details or private data.

## Local Data Access

OpenClaude Studio reads local OpenClaude files through a localhost server. The server binds to `127.0.0.1` by default and allows loopback browser origins plus the official hosted frontend at `https://openclaude-studio.pages.dev`.

The current documented read scope includes `~/.openclaude.json`, `~/.openclaude/projects/`, `~/.openclaude/plans/`, `~/.openclaude/tasks/`, `~/.openclaude/file-history/`, `~/.openclaude/debug/`, `~/.openclaude/bg-sessions/` (session metadata and bounded stdout/stderr logs), and `<resolved OpenClaude config root>/.openclaude-profile.json` (bounded startup provider profile summary only). Background session log paths are always derived from validated session ids and a trusted logs root; Studio never trusts paths embedded in background metadata as read authorization.

Additional hosted origins must be explicitly configured with `OPENCLAUDE_STUDIO_ALLOWED_ORIGINS`. You can set `OPENCLAUDE_STUDIO_TOKEN` for custom clients or deployments with their own access flow, but the bundled web UI does not prompt for this token.

Do not expose the local server to a public network. If you override `OPENCLAUDE_STUDIO_HOST`, make sure the network is trusted.

## Secrets

The app redacts known provider secret fields, URL credentials, URL query secrets and secret-like fragments, bearer tokens, environment-style secret assignments, custom authorization header fields, and common API key formats. Provider credential diagnostics return booleans, counts, and source labels only; they do not return credential values, masked values, hashes, prefixes, lengths, or pool order. Redaction is defense in depth, not a guarantee for every possible secret format.
