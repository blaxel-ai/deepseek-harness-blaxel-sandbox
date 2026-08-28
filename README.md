# Blaxel Sandbox for DeepSeek Harness

`@blaxel/dsh-sandbox` adds Blaxel-backed sessions to DeepSeek Harness (DSH). The DSH interface, model requests, session state, and Blaxel credentials stay on the host. Filesystem, Bash, terminal, and LSP operations for a sandbox session run in one short-lived Blaxel microVM.

> This package is under development and has not been published.

## Launch film

[Watch the 1080p DeepSeek Harness × Blaxel launch film](docs/assets/deepseek-harness-blaxel-launch-1080p.mp4).

## Session architecture

Local and sandbox sessions use the same DSH host, native session store, and sidebar:

```text
DSH Web
  +-- local session     -> local filesystem and subprocess providers
  +-- cloud session     -> Blaxel filesystem and subprocess providers
```

The active native session ID selects the execution backend. The plugin never starts another DSH Web process, opens another tab, or navigates away from the current page.

Sandbox sessions use an indented container marker so they are distinguishable in the normal sidebar. An empty session offers **Open in Sandbox**. A session with history offers **Move to Sandbox**, which atomically binds that same native session ID to Blaxel. Its conversation, automatic title, sidebar row, and current-page selection stay unchanged.

## Profile installation

After the package is published, install it into the DSH Web profile with the native helpers it requires:

```sh
dsh plugin --profile web add \
  --allow-build=@deepseek-ai/dsh-subprocess-local \
  --allow-build=koffi \
  --allow-build=node-pty \
  @blaxel/dsh-sandbox
dsh web
```

## Development installation

```sh
git clone https://github.com/blaxel-ai/deepseek-harness-blaxel-sandbox.git
cd deepseek-harness-blaxel-sandbox
pnpm install
pnpm build
dsh plugin --profile web link "$PWD"
dsh web
```

Sign in from **Settings > Blaxel**, or authenticate on the host with `bl login YOUR-WORKSPACE`.

## Workspace launch

The launch action is available when the session directory is inside a Git worktree. It:

1. Lists tracked files and unignored untracked files.
2. Excludes common credential and private-key paths.
3. Creates a bounded archive without `.git` or `.dsh-blaxel` state.
4. Restores the worktree under `/workspace` in a Blaxel sandbox.
5. Binds the current native session ID to the remote providers.
6. Keeps that session selected in the existing interface.

The launch panel reports real file counts and the active phase. A failed launch stays in the current session with its error instead of creating an empty page.

Before any sandbox is created, the plugin verifies that the session's selected model route is active and that its resolved credential is configured. If a writable credential is missing, the composer shows a secure provider-specific setup card. Saving the key writes it to the DSH host credential store, verifies the model again, and continues the original sandbox action. Model credentials are never returned to the browser or copied into the sandbox.

## Configuration

| Variable | Default | Purpose |
|---|---:|---|
| `DSH_BLAXEL_IMAGE` | `blaxel/ts-app:latest` | Sandbox image |
| `DSH_BLAXEL_MEMORY` | `4096` | Sandbox memory in MB |
| `DSH_BLAXEL_REGION` | automatic | Sandbox region |
| `DSH_BLAXEL_TTL` | platform default | Maximum lifetime from sandbox creation |

CI may provide `BL_WORKSPACE` and `BL_API_KEY`. Blaxel credentials and credential-shaped host environment variables are not copied into sandbox processes.

## Blaxel Settings

The Blaxel settings section provides browser OAuth with workspace selection, existing CLI profile switching, and sandbox defaults verified against the active account's memory and TTL quotas, workspace regions, and available Hub images. Official Blaxel skills and OAuth-connected resource MCP status stay at the top. API-key login remains available as an advanced fallback.

It also lists every running sandbox session with its session ID, runtime name, remote workspace, uptime, state, and owned tool-process count. Stopping one sandbox removes its remote runtime binding without closing or replacing the DSH page.

## Development

Keyless verification:

```sh
pnpm check
pnpm pack
```

The opt-in live test creates a real sandbox:

```sh
DSH_BLAXEL_LIVE=1 pnpm vitest run tests/live.test.ts
```

Do not run the live test without authorization to use the target Blaxel workspace.

## Security and lifecycle

- Blaxel authentication remains host-side.
- Local sessions retain DSH's local sandbox policy.
- Sandbox sessions route to the remote filesystem and subprocess providers. A failed remote operation never falls back to the host.
- Git-ignored files and common credential files such as `.env`, `.npmrc`, private keys, and credential JSON are omitted from workspace snapshots.
- A running turn cannot be moved into a sandbox session.
- Moving is one-way for now. Snapshot provenance retains the original local root so a future explicit reverse-sync flow can be added without changing session identity.
- Each runtime is deleted only when stopped. Restarting DSH reconnects the same native session to its existing sandbox.
