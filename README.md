# Blaxel Sandbox for DeepSeek Harness

Version 0.1.3 moves a DeepSeek Harness Web conversation and its current Git worktree to an independent DSH host in a private Blaxel sandbox. Once the cloud page is ready, model requests and tools continue there with the originating computer offline. Earlier tools-only versions require the original host to stay running.

Use [GUIDE.md](GUIDE.md) for setup and recovery, and [the cloud handoff contract](docs/cloud-session-handoff.md) for implementation status and tested boundaries.

## Move, continue, review, return

1. Select **Move to Blaxel** in an existing Git-backed conversation. A running task checkpoints after its current tool finishes.
2. The plugin restores the project, native conversation history, referenced images, and supported child-session history in a private cloud host, then opens the same conversation there.
3. Continue in the cloud page. **Copy private link** provides access from another device; opening from the original computer renews an expired link automatically.
4. On the original computer with DSH running, select **Move back to local**. Review changed files and the exact patch, then apply the transfer.
5. The conversation and checked changes return together. The laptop's original permission policy is restored before it resumes. Move to Blaxel again to include newer local work.

The local copy remains read-only while the cloud owns execution. Compatible local file edits survive the return; conflicts retain both copies and save a recovery patch. Reopening connects to the existing sandbox without uploading a new local snapshot.

## Session architecture

```text
Local DSH -> private Blaxel DSH host -> reviewed files and conversation back locally
```

Blaxel credentials remain on the original computer. The selected model's portable API key is supplied to the dedicated cloud process so its agent can run independently. Local-only model endpoints and OAuth grants cannot be handed off by this implementation.

## Compatibility

DeepSeek Harness is in developer preview and its plugin contracts change between release candidates. Each plugin release pins one DSH version and is verified against it with the full check, a clean-profile install, and a DSH Web boot.

| Plugin | DSH host | Node.js |
| -- | -- | -- |
| `0.1.3` | `0.1.2-rc.1` | 22.19+, 24+ |
| `0.1.2`, `0.1.1` | `0.1.2-rc.1` | 22, 24 |
| `0.1.0` | `0.1.1-rc.2` | 22, 24 |

When DSH publishes a new version, the plugin is re-verified against it and, when a Host contract moved, a new plugin release pins the new version. Older hosts keep the last plugin release that pinned them.

## Profile installation

Install the current plugin into the DSH Web profile with the native helpers it requires:

```sh
npx --yes --package @blaxel/dsh-sandbox@latest dsh-blaxel plugin --profile web add \
  --allow-build=@deepseek-ai/dsh-subprocess-local \
  --allow-build=koffi \
  --allow-build=node-pty \
  --allow-build=@google/genai \
  --allow-build=protobufjs \
  @blaxel/dsh-sandbox@latest
npx --yes --package @blaxel/dsh-sandbox@latest dsh-blaxel web
```

## Development installation

```sh
git clone https://github.com/blaxel-ai/deepseek-harness-blaxel-sandbox.git
cd deepseek-harness-blaxel-sandbox
pnpm install
pnpm build
dsh plugin --profile web link "$PWD"
node dist/cli.js web
```

`dsh-blaxel` prepares an isolated, pinned DSH 0.1.2-rc.1 runtime on first launch and reuses it afterward. It includes the native history-import extension needed to preserve original timestamps. It uses your existing DSH profile; it does not modify your global DSH installation. Node.js, npm and Git must be available. Keep the same `DSH_HOME` if you use a custom profile.

Sign in from **Settings > Blaxel**, or authenticate on the host with `bl login YOUR-WORKSPACE`.

`pnpm check` runs lint, types, unit tests, build, and publint. `pnpm e2e` additionally boots the pinned `dsh-blaxel` runtime with the selected profile and runs the Playwright browser smoke suite (`pnpm exec playwright install chromium` once).

## Workspace launch

The launch action is available when the session directory is inside a Git worktree. It:

1. Lists tracked files and unignored untracked files.
2. Excludes common credential and private-key paths.
3. Creates a bounded archive without `.git` or `.dsh-blaxel` state.
4. Restores the worktree under `/workspace` in a Blaxel sandbox.
5. Restores the same native session ID in a dedicated cloud DSH process.
6. Opens its authenticated private preview after the cloud host is ready.

The launch panel reports real file counts and the active phase. A failed launch stays in the current session with its error instead of creating an empty page.

Before any sandbox is created, the plugin verifies that the session's selected model route is active and that its resolved credential is configured. If a writable credential is missing, the composer shows a secure provider-specific setup card. Saving the key writes it to the DSH host credential store, verifies the model again, and continues the original sandbox action. The selected portable model API key is forwarded to the cloud process; it is never returned to the browser. Blaxel credentials remain local.

## Configuration

| Variable | Default | Purpose |
|---|---:|---|
| `DSH_BLAXEL_IMAGE` | `blaxel/ts-app:latest` | Sandbox image |
| `DSH_BLAXEL_MEMORY` | `4096` | Sandbox memory in MB |
| `DSH_BLAXEL_REGION` | automatic | Sandbox region |
| `DSH_BLAXEL_TTL` | 24h for cloud sessions | Maximum lifetime from sandbox creation |

CI may provide `BL_WORKSPACE` and `BL_API_KEY`. Blaxel credentials remain local; only the selected portable model key enters the cloud host.

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
DSH_BLAXEL_LIVE=1 pnpm vitest run tests/live.test.ts tests/live-roundtrip.test.ts
```

Do not run the live test without authorization to use the target Blaxel workspace.

## Runnable example

[Invoice Desk](examples/invoice-desk) is the dependency-free application used in the cloud walkthrough. Run its ten tests locally, then use the same project for a reviewed round trip.

## Security and lifecycle

- Blaxel authentication remains host-side.
- Local sessions retain DSH's local sandbox policy.
- Sandbox sessions route to the remote filesystem and subprocess providers. A failed remote operation never falls back to the host.
- Git-ignored files and common credential files such as `.env`, `.npmrc`, private keys, and credential JSON are omitted from workspace snapshots.
- A running task checkpoints at a safe tool boundary before continuing on the cloud host.
- Moving is an explicit round trip, not continuous synchronization. `Return to local` conflict-checks sandbox changes against the original worktree, applies them only when safe, stops that sandbox, and keeps the same DSH session local. The session can later move into a fresh sandbox again.
- Each runtime is deleted only when stopped. Restarting DSH reconnects the same native session to its existing sandbox.
- Reconnecting keeps existing sandbox files and does not upload newer local edits. To bring local work into that session, move back to local, merge any conflicts, then move to Blaxel again. See the [file-change scenarios](GUIDE.md#move-changes-back-to-local).
- Telemetry is limited to attribution: Blaxel API and sandbox requests carry the Blaxel SDK `User-Agent` with `deepseek-harness-blaxel-sandbox/<version>` appended. Nothing is collected from DSH, the conversation, or the workspace.
