# Deployment

OpenClaude Studio has two deployable pieces:

- The `openclaude-studio` npm package, which runs the local read-only API.
- The static web app in `apps/web`, which can be served from Cloudflare Pages or another static host.

The hosted web app still requires users to run the local API on their own machine.

## Release Flow

Releases are handled by `.github/workflows/release.yml` when a `v*` tag is pushed.

The workflow:

1. Installs dependencies with Node.js 22.
2. Verifies the tag matches `apps/server/package.json`.
3. Runs lint, unit tests, build, package inspection, packed-package smoke test, and e2e tests.
4. Publishes `openclaude-studio` to npm if that exact version is not already published.
5. Deploys `apps/web/dist` to Cloudflare Pages.

Release tags must match the npm package version. For example, `v0.0.4` must match `apps/server/package.json` version `0.0.4`.

## Required Repository Secrets

The release workflow needs:

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`

The Cloudflare API token should grant account-level `Cloudflare Pages:Edit` permission for the target account.

The npm package should use trusted publishing through GitHub Actions. Do not add long-lived npm tokens to repository secrets.

## Cloudflare Pages Settings

Production deployment should be owned by the release workflow, not automatic branch pushes. Recommended Cloudflare Pages settings:

- Production branch deployments: disabled or controlled by the release workflow
- Preview branch deployments: disabled unless intentionally enabled for PR review
- Build command in Cloudflare Git integration: not required when deployment is handled by Wrangler
- Output directory in Cloudflare Git integration: not required when deployment is handled by Wrangler

The release workflow deploys with:

```text
pages deploy apps/web/dist --project-name=openclaude-studio --branch=main --commit-hash=<sha>
```

## Local Production Check

Before release, run:

```bash
npm test
npm run lint
npm run build
npm run smoke:package
npm run test:e2e
```

`npm run smoke:package` creates the npm tarball, installs it into a temporary project, verifies the CLI version, verifies key help output, and removes the tarball afterward.
