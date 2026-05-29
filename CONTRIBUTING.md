# Contributing

Thanks for considering a contribution to OpenClaude Studio.

The project is early and deliberately scoped. The best contributions are small, well-tested improvements that keep the local data access model understandable.

## Development

```bash
npm install
npm run dev
```

Before opening a pull request, run:

```bash
npm test
npm run lint
npm run build
npm run smoke:package
npm run test:e2e
```

The project supports Node.js 22 or newer. CI and releases run on Node.js 22 to validate the supported baseline.

## Scope

The current MVP line is intentionally read-only. Changes that write OpenClaude settings, sessions, logs, provider profiles, or project files should wait until the write model has explicit design and security review.

Roadmap discussions are welcome. For larger features, open an issue first so the data access model, UI scope, and testing plan can be discussed before implementation.

## Pull Requests

- Keep changes focused and small.
- Include tests for behavior changes.
- Avoid committing generated output, local environment files, secrets, logs, or machine-specific paths.
- Keep API responses typed through `packages/shared`.
- Document user-visible changes in `README.md` when behavior, setup, or scope changes.
- Update docs in `docs/` when architecture, deployment, local server behavior, or privacy assumptions change.
- Keep the local server read-only unless the change has an explicit safety design.

## Code Style

Use the existing TypeScript, React, and Fastify patterns in the repository. Prefer small services with focused tests over broad cross-cutting changes.

## Releases

The local API package is published from GitHub Actions when a `v*` tag is pushed. The npm package should use trusted publishing for `.github/workflows/release.yml`; do not add long-lived npm tokens to repository secrets.

The same release workflow deploys the web app to Cloudflare Pages after validation and npm publishing succeed. Cloudflare Pages Git integration should keep automatic production deployments disabled and preview branch deployments set to `None`; production deploys are handled by the release workflow.

Release tags must match the server package version, for example `v0.0.4` for `apps/server/package.json` version `0.0.4`. If the exact npm package version was already published, the workflow skips npm publishing and still deploys the web app.

The release workflow needs these repository secrets:

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`

The Cloudflare API token should grant the account-level `Cloudflare Pages:Edit` permission.

## Security

Do not include real OpenClaude data, provider credentials, local session contents, debug logs, or screenshots containing private data in issues or pull requests.
