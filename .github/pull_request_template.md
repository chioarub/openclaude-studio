## Summary

Describe what changed and why.

## Validation

- [ ] `npm test`
- [ ] `npm run lint`
- [ ] `npm run build`
- [ ] `npm run smoke:package`
- [ ] `npm run test:e2e`

## Checklist

- [ ] The change is focused and does not include unrelated refactors.
- [ ] User-visible behavior changes are documented in `README.md` or `docs/`.
- [ ] API response changes are typed through `packages/shared`.
- [ ] Local data access remains read-only, or the safety model is explicitly described.
- [ ] No local OpenClaude data, credentials, debug logs, generated output, or machine-specific paths are committed.
