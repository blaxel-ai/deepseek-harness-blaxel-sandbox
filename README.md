# Blaxel Sandbox for DeepSeek Harness

`@blaxel/dsh-sandbox` is a first-class Blaxel sandbox execution plugin for DeepSeek Harness (DSH). It moves filesystem, Bash, terminal, and LSP operations into one short-lived Blaxel microVM while the DSH interface, model requests, session state, and Blaxel credentials remain on the host.

> This package is under development and has not been published. The current implementation is a prototype being raised to the DeepSeek Harness capability contracts.

## How it composes

The package is one installable DSH bundle with three internal providers:

- `@blaxel/dsh-sandbox/runtime` owns sandbox creation, readiness, private adapter state, and deletion.
- `@blaxel/dsh-sandbox/filesystem` provides remote `ctx.fs`.
- `@blaxel/dsh-sandbox/subprocess` provides remote `ctx.subprocess`, including PTY sessions.

Local execution remains unchanged after installation. In Web, **Open in Blaxel** appears beside the session chat input when the session directory is inside a Git worktree. It snapshots tracked files plus unignored untracked files, omits common credential files, restores the repository under `/workspace`, and opens a separate DSH window where all execution capabilities share the same remote filesystem and process world.

## Development installation

The package is not published yet. Build the source checkout and link it into a DSH Web profile:

```sh
git clone https://github.com/blaxel-ai/deepseek-harness-blaxel-sandbox.git
cd deepseek-harness-blaxel-sandbox
pnpm install
pnpm build
dsh plugin --profile web link "$PWD"
```

Launch Web normally, open a session rooted anywhere inside a Git repository, then use **Open in Blaxel** beside the chat input:

```sh
dsh web
```

The original local session stays open. The Blaxel window uses isolated session storage and maps the selected directory to the equivalent path under `/workspace`. Directories outside a Git worktree are rejected. TUI and headless launch controls remain planned work.

## Authentication

Authenticate on the host with the Blaxel CLI:

```sh
bl login YOUR-WORKSPACE
```

CI may provide `BL_WORKSPACE` and `BL_API_KEY`. The plugin does not copy Blaxel credentials, `DSH_*` variables, or credential-shaped host environment variables into sandbox processes.

## Configuration

The initial bundle supports host environment overrides:

| Variable | Default | Purpose |
|---|---:|---|
| `DSH_BLAXEL_CWD` | `/workspace` | Remote working directory |
| `DSH_BLAXEL_WORKSPACE_ROOT` | `/workspace` | Restored Git worktree root |
| `DSH_BLAXEL_IMAGE` | `blaxel/node:latest` | Sandbox image |
| `DSH_BLAXEL_MEMORY` | `4096` | Sandbox memory in MB |

The Blaxel settings page reports the active sandbox and provides reopen and stop controls.

## Development

Requirements: Node.js 22.19+ or 24+, pnpm 10, and no Blaxel credentials for keyless checks.

```sh
pnpm install
pnpm check
pnpm pack
```

The live test is opt-in and creates a real Blaxel sandbox:

```sh
DSH_BLAXEL_LIVE=1 pnpm vitest run tests/live.test.ts
```

Do not run the live test without authorization to use the target Blaxel workspace.

## Security and lifecycle

- Blaxel authentication remains host-side.
- DSH receives `danger-full-access` only inside the disposable remote microVM boundary.
- Host filesystem, subprocess, and host sandbox wrappers are disabled only in the separate Blaxel process.
- Git-ignored files and common credential files such as `.env`, `.npmrc`, private keys, and credential JSON files are omitted from workspace snapshots.
- The runtime deletes its owned sandbox during DSH teardown and surfaces cleanup failures.
- No local fallback occurs when sandbox setup or transport fails.

See [`PLAN.md`](./PLAN.md) for the implementation and verification gates.
