# Changelog

All notable changes to OpenClaude Studio are documented here.

This project uses semantic versioning for the published `openclaude-studio` npm package.

## 0.3.0

- Added provider profile management with a read-only local API, web UI, validation diagnostics, safe templates, copyable commands, and secret redaction.
- Added Session Change Review with a read-only local API and web tab for bounded, redacted per-session diffs, backup diagnostics, and risk flags.
- Added project discovery from bounded transcript metadata so projects missing from the global OpenClaude config can still appear with diagnostics.
- Added light and dark documentation screenshots using synthetic fixture data.

## 0.2.1

- Added GitHub Release creation to the release workflow from the matching changelog section, with job-scoped token permissions and idempotent behavior when the npm version already exists.
- Pinned the GitHub Release job checkout action and added release workflow validation coverage for the pinned checkout and release safety checks.
- Aligned contributor, security, architecture, privacy, and README documentation with the current read-only scope for plans, tasks, and file-history data.

## 0.2.0

- Added the Plans & Tasks control tower with project plan files, task status groups, checklist progress, detail panes, and linked session context.
- Fixed project transcript data scoping so project summaries, plans, tasks, and session details avoid leaking similarly named or outside-project transcript data.
- Improved transcript discovery diagnostics for inaccessible, malformed, ambiguous, and outside-project session data.
- Refreshed launch-facing README, troubleshooting, package, and privacy documentation.
- Added a safe local API landing page at `/`.
- Improved CLI startup/help output with the hosted dashboard URL and next-step guidance.
- Added a visible local API URL control for custom local server ports.
- Added web metadata and tightened GitHub issue and pull request templates.
- Added synthetic screenshot assets for README launch previews.

## 0.1.0

- Added a session details inspector with conversation timeline, tool calls, changed files, token breakdowns, and related activity context.
- Improved the session details layout so long side-panel sections remain usable without creating nested modal scrolling problems.
- Added repository guidance for AI coding agents and tightened contributor pull request guidance for protected `main` branch workflows.
- Improved CodeRabbit review configuration with walkthrough-only PR summaries, public-repository hygiene checks, and non-blocking review automation.

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
