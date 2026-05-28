# Security Policy

## Supported Versions

Security fixes target the latest `main` branch until the first tagged release is published.

## Reporting a Vulnerability

Please report vulnerabilities through GitHub private vulnerability reporting when available, or open a minimal issue that does not include exploit details or private data.

## Local Data Access

OpenClaude Studio reads local OpenClaude files through a localhost server. The server binds to `127.0.0.1` by default and allows loopback browser origins plus the official hosted frontend at `https://openclaude-studio.pages.dev`.

Additional hosted origins must be explicitly configured with `OPENCLAUDE_STUDIO_ALLOWED_ORIGINS`. You can set `OPENCLAUDE_STUDIO_TOKEN` for custom clients or deployments with their own access flow, but the bundled web UI does not prompt for this token.

Do not expose the local server to a public network. If you override `OPENCLAUDE_STUDIO_HOST`, make sure the network is trusted.

## Secrets

The app redacts known provider secret fields, URL credentials, bearer tokens, and common API key formats. Redaction is defense in depth, not a guarantee for every possible secret format.
