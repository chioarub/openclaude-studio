# Contributing

Thanks for considering a contribution.

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
npm run test:e2e
```

## Scope

The `0.0.1` line is intentionally read-only. Changes that write OpenClaude settings, sessions, logs, provider profiles, or project files should wait until the write model has explicit design and security review.

## Pull Requests

- Keep changes focused and small.
- Include tests for behavior changes.
- Avoid committing generated output, local environment files, secrets, logs, or machine-specific paths.
- Keep API responses typed through `packages/shared`.

## Code Style

Use the existing TypeScript, React, and Fastify patterns in the repository. Prefer small services with focused tests over broad cross-cutting changes.
