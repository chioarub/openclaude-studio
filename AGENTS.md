# AGENTS.md

This file is the operating guide for AI coding agents contributing to OpenClaude Studio. Follow it when investigating issues, editing code, writing tests, updating docs, or preparing pull requests.

OpenClaude Studio is a read-only, local-data dashboard for OpenClaude. Treat the repository as privacy-sensitive infrastructure, not as a generic React app.

## Core contract

OpenClaude Studio has three important boundaries:

1. The browser never reads local OpenClaude files directly.
2. The local server reads OpenClaude data from disk and exposes typed JSON over HTTP.
3. The current MVP line is read-only.

Do not weaken these boundaries.

The local API may read OpenClaude config, project/session data, plans, tasks, file-history metadata, and debug logs, but it must not mutate OpenClaude settings, sessions, logs, provider profiles, project files, tasks, plans, or file-history data.

## Repository map

* `apps/server`: Fastify local API, CLI entry point, npm package published as `openclaude-studio`.
* `apps/web`: Vite + React + Tailwind CSS dashboard.
* `packages/shared`: shared TypeScript API response contracts.
* `tests/e2e`: Playwright end-to-end tests.
* `docs`: architecture, local server, troubleshooting, deployment, privacy, and release notes.
* `.github/workflows`: CI, release, npm publishing, and deployment automation.

## Read first

Before making changes, read the files relevant to the task:

* For non-trivial work, start with `README.md`, `CONTRIBUTING.md`, and this file.
* For architecture or data-flow changes, read `docs/architecture.md`.
* For local server, host, origin, token, or filesystem changes, read `docs/local-server.md`, `docs/privacy-and-redaction.md`, and `SECURITY.md`.
* For release, npm, deployment, CI, or review automation changes, read `docs/deployment.md`, `.github/workflows/ci.yml`, `.github/workflows/release.yml`, and `.coderabbit.yaml`.
* For code changes, read nearby source files and nearby tests before editing.

Prefer existing patterns over new abstractions.

## Branch and pull request rules

* Work on a branch. Do not push directly to `main`.
* Keep commits focused, reviewable, and suitable for a public repository.
* Do not rewrite shared branch history unless the maintainer explicitly asks for it.
* Do not commit generated outputs such as `dist`, coverage, Playwright reports, test results, packed `.tgz` files, temporary logs, or local environment files.
* Do not include private process notes, local-only paths, real OpenClaude data, credentials, tokens, debug logs, screenshots with private data, or personal data.
* Let required CI and review automation finish before marking a PR ready to merge.
* Treat unresolved maintainer or CodeRabbit findings as blocking unless they are explicitly deferred with a reason.

## Stop and ask before doing these

Do not proceed without explicit maintainer direction if a task requires any of the following:

* Adding write-capable behavior.
* Editing OpenClaude config, sessions, logs, provider profiles, project files, tasks, plans, or file-history data.
* Expanding the local file read scope beyond the documented OpenClaude data locations.
* Exposing the local server beyond loopback by default.
* Weakening CORS, private-network handling, token checks, path validation, symlink protection, bounded file reads, or redaction.
* Introducing authentication, persistence, database storage, background daemons, telemetry, analytics, cloud sync, or remote execution.
* Replacing npm, Vite, React, Tailwind, Fastify, Vitest, or Playwright.
* Adding a large dependency or UI component framework.
* Reworking release, publishing, deployment, CI, branch protection, repository permissions, or review automation flows.
* Performing broad refactors unrelated to the requested change.

If the safe path is unclear, stop and explain the risk instead of guessing.

## Development commands

Use Node.js 22 or newer and npm. Do not switch package managers.

Install dependencies:

```bash
npm install
```

Run both the server and web app locally:

```bash
npm run dev
```

Common validation commands:

```bash
npm run lint
npm test
npm run build
npm run smoke:package
npm run test:e2e
```

Focused workspace commands:

```bash
npm run lint -w @openclaude-studio/shared
npm run build -w @openclaude-studio/shared

npm run lint -w openclaude-studio
npm run test -w openclaude-studio
npm run build -w openclaude-studio

npm run lint -w @openclaude-studio/web
npm run test -w @openclaude-studio/web
npm run build -w @openclaude-studio/web
```

For package changes, also run:

```bash
npm pack --dry-run -w openclaude-studio
npm run smoke:package
```

Local CodeRabbit CLI review, when installed and authenticated, can be used for pre-PR feedback:

```bash
cr auth status
cr review --agent --type uncommitted --base main --config .coderabbit.yaml
cr review --agent --type committed --base main --config .coderabbit.yaml
```

If the installed binary is named `coderabbit`, use:

```bash
coderabbit review --agent --type uncommitted --base main --config .coderabbit.yaml
```

Treat local CLI review as pre-PR feedback. Pull request review has repository and PR collaboration context that local review does not.

## Validation expectations

Run the smallest useful checks while iterating, then run the broader checks needed for the final change.

| Change type                                            | Expected checks                                                                                                |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| Docs only                                              | No runtime checks required unless commands, setup, release, deployment, or security guidance changed.          |
| Shared API types                                       | `npm run build -w @openclaude-studio/shared`; also validate server/web if consumers changed.                   |
| Server behavior                                        | `npm run test -w openclaude-studio`, `npm run lint -w openclaude-studio`, and relevant root checks.            |
| Web behavior                                           | `npm run test -w @openclaude-studio/web`, `npm run lint -w @openclaude-studio/web`, and relevant build checks. |
| API contract changes                                   | Shared build, server tests, web tests, and docs if behavior changed.                                           |
| Local data, logs, redaction, paths, origins, or tokens | Server tests plus explicit security/privacy review notes in the PR.                                            |
| Packaging, CLI, release, or workflows                  | `npm run build`, `npm pack --dry-run -w openclaude-studio`, `npm run smoke:package`, and workflow/docs review. |
| User-visible integrated behavior                       | Relevant unit tests plus `npm run test:e2e` where practical.                                                   |

If a check cannot be run, say exactly which check was skipped and why.

## Safety and privacy rules

* Never commit real OpenClaude data.
* Never commit provider credentials, API keys, auth headers, bearer tokens, local debug logs, session contents, screenshots with private data, or machine-specific paths.
* Use synthetic fixtures in tests.
* Redact likely secrets before returning local data to the browser.
* Treat redaction as defense in depth, not as permission to expose more data.
* Prefer summaries, booleans, counts, and diagnostics over raw sensitive values.
* Do not log secrets or raw local file contents.
* Be careful with diagnostics: useful is good; dumping private local content is not.
* Keep local server defaults conservative.

## Server rules

When changing `apps/server`:

* Keep endpoints read-only.
* Keep the server bound to `127.0.0.1` by default.
* Preserve the official hosted origin and loopback-origin behavior unless the task explicitly changes it.
* Keep private-network handling intentional and tested.
* Keep file reads bounded and scoped.
* Avoid following symlinks for sensitive local reads.
* Reject unsafe filenames and path traversal attempts.
* Do not expose arbitrary file paths or arbitrary file reads.
* Redact provider secrets, URL credentials, bearer tokens, common API key formats, and secret-like fields.
* Prefer explicit typed diagnostics for missing, malformed, or unavailable local data.
* Add or update tests for path safety, redaction, diagnostics, API compatibility, and error handling.

Use Fastify and the existing service structure. Prefer small focused helpers over large cross-cutting rewrites.

## Web rules

When changing `apps/web`:

* Keep the UI read-only.
* Treat API responses as untrusted and potentially partial.
* Handle loading, empty, degraded, and error states.
* Keep the app usable when the local server is stopped or unreachable.
* Preserve light and dark theme behavior.
* Preserve responsive behavior.
* Preserve accessibility basics: semantic controls, labels, keyboard usability, visible focus, and readable contrast.
* Do not add a heavy UI framework unless explicitly requested.
* Avoid assuming a newly added server field is always present; hosted web deployments may talk to older local servers.
* Add or update tests for changed rendering, routing, state, API normalization, or user interactions.

## Shared contract rules

When changing `packages/shared`:

* Treat exported types as public contracts between server and web.
* Prefer additive fields over renaming or removing fields.
* If a response shape changes, update shared types, server implementation, web consumption, tests, and docs together.
* Keep contract names clear and domain-specific.
* Do not place server-only or web-only implementation details in shared types.

## Testing rules

* Add tests for behavior changes.
* Keep tests close to the code they validate.
* Prefer synthetic fixtures over copied real OpenClaude data.
* Cover success, failure, degraded, and edge cases when touching local data access.
* Test backward compatibility when web code consumes new or optional API fields.
* Test redaction behavior near any redaction change.
* Test path traversal, symlink, unsafe filename, and bounded-read behavior near filesystem changes.
* Do not update snapshots, fixtures, or expected output casually; explain why the change is correct.

## Dependency and package rules

* Use npm and keep `package-lock.json` authoritative.
* Do not add dependencies for small utilities that can be implemented simply.
* Do not add runtime dependencies without a clear user-facing or maintenance benefit.
* Keep package metadata, workspace names, versions, changelog, and release workflow behavior consistent.
* Do not commit generated outputs unless explicitly required.

## Documentation rules

Update docs when behavior, setup, scope, architecture, deployment, release, privacy, security, local server behavior, or public API behavior changes.

Public docs must not contain:

* Private implementation notes.
* Local absolute paths from a contributor machine.
* Real tokens, secrets, logs, sessions, screenshots, or personal data.
* Commands that only work in one contributor’s environment.
* Stale version numbers or release instructions.

Prefer direct, user-facing documentation over internal commentary.

## CI, release, and deployment rules

* Keep GitHub Actions permissions least-privilege.
* Keep release jobs idempotent.
* Do not add long-lived npm tokens.
* Preserve npm trusted publishing unless explicitly directed otherwise.
* Keep Cloudflare deployment behavior aligned with `docs/deployment.md`.
* Do not change release tag semantics without updating docs and validation.
* If release behavior changes, verify package versioning, `package-lock.json`, changelog, npm publishing, and web deployment still agree.

## Code style

* Use TypeScript idiomatically.
* Prefer explicit types at API boundaries.
* Keep modules focused.
* Prefer simple functions with clear names.
* Avoid clever abstractions unless they remove real duplication.
* Do not perform unrelated formatting churn.
* Do not rewrite working code just to match personal style.
* Follow the local style of the file being edited.
* Keep public names stable unless the task explicitly requires a rename.

## Agent workflow

For non-trivial work:

1. Understand the requested change.
2. Inspect the relevant files and tests.
3. Identify the safety, API, and compatibility impact.
4. Make the smallest coherent change.
5. Add or update tests.
6. Run focused checks.
7. Run broader checks when the change warrants them.
8. Summarize the result clearly.

Do not hide uncertainty. If something is risky, stale, or unverified, say so.

## Pull request handoff

Every PR or final agent response should include:

* What changed.
* Why it changed.
* Tests and checks run, with exact commands.
* Checks not run, with reasons.
* Security/privacy notes for any change touching local data, logs, provider config, filesystem access, origins, tokens, package publishing, or deployment.
* Any follow-up work intentionally left out.

Keep PRs small, focused, and reviewable. Address actionable CodeRabbit or maintainer findings in code, or explain clearly why a finding is intentionally deferred.
