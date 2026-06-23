# Privacy and Redaction

OpenClaude Studio reads local OpenClaude data and displays it in the browser. Treat that data as private by default.

## Local Data Read by the Server

The local API may read:

- `~/.openclaude.json`
- `~/.openclaude/projects/`
- `~/.openclaude/plans/`
- `~/.openclaude/tasks/`
- `~/.openclaude/file-history/`
- `~/.openclaude/debug/`

The app is read-only in the current MVP line. It should not write OpenClaude config, sessions, logs, provider profiles, project files, tasks, plans, or file-history data.

Project discovery may use bounded transcript metadata from `~/.openclaude/projects/` to find projects missing from `~/.openclaude.json`. This can expose historical project paths in the browser, including paths that no longer exist on disk.

## Redaction Scope

The server redacts likely secrets before returning data to the browser. Current redaction covers:

- Known provider secret fields
- Provider profile credentials and custom header values
- URL usernames and passwords
- Common URL query secret names
- Bearer tokens
- Common API key formats in logs and messages

Session Change Review can display code or configuration text from current project files and OpenClaude file-history backups. Those reads are bounded, symlink-safe, and redacted before diff generation, but redaction remains best effort. Review screenshots, copied diffs, and recordings before sharing them.

Background session stdout and stderr logs can contain prompts, model output, file paths, and credentials. Studio redacts these with the same patterns used for debug logs (API keys, bearer tokens, URL credentials, environment-style assignments) before returning them to the browser, but redaction is best effort. Background logs are derived from validated session ids and a trusted logs root; Studio never trusts the log paths embedded in background metadata as read authorization. Treat every background log line as potentially sensitive.

When `OPENCLAUDE_CONFIG_DIR` and `CLAUDE_CONFIG_DIR` are both set and disagree, Studio emits a warning diagnostic through `/api/projects`. That specific message intentionally contains only the variable names and the resolution outcome — it never includes the configured path values, the home directory, or any local file contents. Other diagnostics in the same response (e.g. "File does not exist") may include paths by established convention; the conflict warning is deliberately more conservative because the conflict itself is the sensitive signal.

Redaction is defense in depth, not a guarantee. New providers, unusual token formats, or arbitrary user content may still contain sensitive data.

## Contributor Rules

- Do not commit real OpenClaude data.
- Do not commit debug logs, screenshots, recordings, or fixtures containing private data.
- Prefer synthetic fixtures in tests.
- Keep redaction tests close to any redaction behavior changes.
- Review screenshots manually before sharing them in public issues or pull requests.

## Local Server Exposure

The local API binds to `127.0.0.1` by default. Do not expose it to public networks.

If you change `OPENCLAUDE_STUDIO_HOST`, make sure the network is trusted and the access-control model is explicit. Hosted browser origins only control which browser origins can call the local API; they do not turn the local API into a safe public service.

## Reporting Security Issues

Use GitHub private vulnerability reporting when available. If that is not available, open a minimal public issue that does not include exploit details, secrets, local file contents, or private user data.
