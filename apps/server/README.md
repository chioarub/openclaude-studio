# OpenClaude Studio Local API

This package runs the read-only local API used by OpenClaude Studio.

The hosted frontend cannot read OpenClaude files directly from a browser. Run this server on the same machine as OpenClaude, then open the OpenClaude Studio frontend in your browser:

```text
https://openclaude-studio.pages.dev/
```

## Usage

```bash
npx openclaude-studio
```

Keep the command running while you use the hosted frontend. Stop it with `Ctrl+C` when you are done.

The server binds to `127.0.0.1:43110` by default and reads:

- `~/.openclaude.json`
- `~/.openclaude/projects/`
- `~/.openclaude/debug/`

## Hosted Frontend Origins

The official hosted frontend at `https://openclaude-studio.pages.dev` is allowed by default.

When using a custom hosted frontend, allow its exact origin:

```bash
npx openclaude-studio --allowed-origin https://studio.example.com
```

You can also use an environment variable:

```bash
OPENCLAUDE_STUDIO_ALLOWED_ORIGINS=https://studio.example.com npx openclaude-studio
```

## Options

```text
--host <host>                 Host to bind. Defaults to 127.0.0.1.
--port <port>                 Port to listen on. Defaults to 43110.
--allowed-origin <origin>     Additional hosted frontend origin to allow. Repeat or comma-separate values.
--version, -v                 Print version.
--help, -h                    Print help.
```

## Safety

The local API is read-only. It does not write OpenClaude settings, sessions, logs, provider profiles, project files, tasks, or plans.

Keep the server bound to a loopback address unless you provide your own trusted access control.
