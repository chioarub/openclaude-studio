# Changelog

All notable changes to OpenClaude Studio are documented here.

This project uses semantic versioning for the published `openclaude-studio` npm package.

## 0.0.6

- Fixed the hosted UI crash when connected to an older local server that does not return usage chart data yet.

## 0.0.5

- Added a project usage overview chart with cost and token views.
- Improved cost handling so projects without recorded spend fall back to token usage.
- Improved system logs with project-scoped log selection, sticky table headers, virtualized window loading, and log-message copy actions.
- Hardened CI into separate lint, unit test, build/package, and e2e jobs.
- Added a packed-package smoke test for the npm CLI.
- Added documentation for architecture, local server behavior, deployment, and privacy/redaction.
- Added a pull request checklist for contributors.

## 0.0.4

- Added the local server version to the UI.
- Improved hosted-app onboarding when the local API is not running.
- Added copy affordances for the local server command.
- Fixed CLI version output.

## 0.0.3

- Added release deployment through Cloudflare Pages.
- Reduced automatic dependency update noise.
- Improved CI and release automation.

## 0.0.2

- Published the local API package to npm.
- Added the hosted web app deployment path.
- Documented setup, release, and contributor workflows.

## 0.0.1

- Added the initial read-only OpenClaude Studio dashboard.
- Added the local API server and CLI package.
- Added project selection, overview cards, sessions, providers, diagnostics, logs, and light/dark themes.
