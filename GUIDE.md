# Guide: Blaxel Sandbox for DeepSeek Harness

Use [README.md](README.md) for the shortest installation path. This guide explains account setup, sandbox sessions, local round trips, recovery, security, and troubleshooting.

## How it works

The plugin keeps DeepSeek Harness (DSH) on your computer and changes where tools execute for one session.

| Component | Location | Responsibility |
| --- | --- | --- |
| DSH Web | Your computer | Interface, conversations, session titles, model requests, model credentials, and Blaxel authentication |
| Plugin host | Your computer | Workspace snapshots, session bindings, settings, recovery, and safe change transfer |
| Blaxel sandbox | Blaxel | Filesystem, Bash, and terminal operations under `/workspace` |

Local and sandbox sessions remain ordinary DSH sessions in the same sidebar. The active native session ID selects the local or Blaxel execution providers. The plugin does not start a second DSH process or open a separate DSH page.

## Requirements

- Node.js `22.19.0` or newer in the supported engine range
- DSH Web with plugin support
- A Blaxel account and workspace
- A local directory inside a Git worktree
- A configured credential for the model selected by the DSH session

## Install the plugin

After the package is published, install it into the DSH Web profile:

```bash
dsh plugin --profile web add \
  --allow-build=@deepseek-ai/dsh-subprocess-local \
  --allow-build=koffi \
  --allow-build=node-pty \
  @blaxel/dsh-sandbox
dsh web
```

To use the repository before publication:

```bash
git clone https://github.com/blaxel-ai/deepseek-harness-blaxel-sandbox.git
cd deepseek-harness-blaxel-sandbox
pnpm install
pnpm build
dsh plugin --profile web link "$PWD"
dsh web
```

Open DSH Settings and confirm that the Blaxel section appears.

## Connect Blaxel

Open Settings > Blaxel. Select Sign in to Blaxel for the normal setup:

1. Finish the Blaxel device authorization in the browser page.
2. Select the workspace DSH should use.
3. Select Verify connection.

The plugin stores the selected profile in the standard Blaxel CLI configuration. Existing `bl login` profiles appear in the workspace selector.

For CI or a managed host, start DSH with `BL_WORKSPACE` and `BL_API_KEY`. `BL_CLIENT_CREDENTIALS` and Blaxel-host identity are also recognized. Authentication supplied through the process environment cannot be changed in Settings. Restart DSH with different `BL_*` values instead.

While sandbox sessions exist, you can refresh credentials for their current workspace. Switching workspaces and signing out remain locked until those sandboxes are moved local or discarded.

## Enable agent capabilities

The top of Settings > Blaxel exposes two optional host-side capabilities:

- Blaxel skills installs or updates the official Blaxel CLI and SDK guidance for agents;
- Blaxel resource tools connect through secure browser authorization.

Both capabilities stay on the DSH host. The settings panel reports Up to date or Connected when each capability is ready.

## Choose sandbox defaults

Settings loads choices from the active Blaxel workspace. Only images, memory sizes, regions, and maximum lifetimes available to that account are selectable.

| Setting | Default | Behavior |
| --- | --- | --- |
| Sandbox image | `blaxel/ts-app:latest` | Debian and glibc image prepared for common TypeScript workloads |
| Memory | `4096` MB | Filtered by the workspace memory limit |
| Region | Automatic | Filtered by workspace availability |
| Maximum lifetime | Platform default | Filtered by the workspace TTL limit |

Saved defaults affect new sandboxes. Existing sessions keep their current resources.

The following host environment variables provide initial defaults when no saved settings exist:

| Variable | Purpose |
| --- | --- |
| `DSH_BLAXEL_IMAGE` | Sandbox image |
| `DSH_BLAXEL_MEMORY` | Memory in MB |
| `DSH_BLAXEL_REGION` | Region |
| `DSH_BLAXEL_TTL` | Maximum lifetime such as `4h` or `7d` |

## Start a sandbox session

Open a Git-backed workspace in DSH and create or select a session.

- An empty session shows Open on Blaxel
- A session with conversation history shows Move to Blaxel
- A running turn must finish before the session can move

Before creating a sandbox, the plugin verifies the selected model route and its host credential. If the credential is missing, complete the provider-specific setup card in the composer. The credential is written to the DSH host store and is not copied into the sandbox.

The launch action:

1. Resolves the current Git worktree and subdirectory.
2. Includes tracked files and unignored untracked files.
3. Excludes `.git`, `.dsh-blaxel`, Git-ignored paths, common credential files, and private keys.
4. Creates a bounded archive and restores it under `/workspace`.
5. Creates an immutable baseline for later change comparison.
6. Binds the existing DSH session ID to remote filesystem and subprocess providers.

The same conversation, automatic title, sidebar row, and selected page remain in place.

## Identify a sandbox session

Sandbox sessions have an indented container marker in the normal sidebar. The active chat also has a subtle edge glow and a Running on Blaxel strip above the composer. Next to the send button, a chip states the connection: **On Blaxel** while connected, **Connecting…** while the sandbox starts, and **Reconnect Blaxel** when the sandbox is unavailable. Selecting that chip reconnects in place; a local session shows **Move to Blaxel** in the same spot.

Select the strip to open the exact sandbox in Blaxel Console. The DSH session remains on the current page.

## Move changes back to local

Open Settings > Blaxel and find the running sandbox. Select Return to local.

The plugin:

1. Waits for the DSH turn and owned sandbox processes to finish.
2. Compares `/workspace` with the immutable launch baseline.
3. Shows the number of changed files and asks for confirmation.
4. Generates a bounded binary Git patch.
5. Checks the patch against the original local worktree before changing any file.
6. Applies the patch only when every target is safe and conflict-free.
7. Deletes that sandbox and returns the same DSH session to local tools.

If local files conflict with the sandbox patch, nothing is applied and the sandbox remains available. Automatic transfer also fails closed for a truncated patch or unsafe symbolic-link target.

After the move completes, continue locally or select Move to Blaxel again. A later move creates a fresh sandbox from the current local worktree while preserving the same DSH session.

This is a deliberate round trip, not continuous two-way synchronization. Local changes made after a sandbox starts are checked only when you move the sandbox changes back.

## Discard a sandbox

Select Discard only when its remote changes are no longer needed. The confirmation explains that untransferred changes will be lost.

Discarding removes the remote runtime binding for that session. It does not close DSH, delete the conversation, affect another sandbox, or navigate to another page.

## Recover after a restart

Session bindings persist on the host. Restarting DSH reconnects each native session to its existing Blaxel sandbox and immutable baseline.

If the Blaxel OAuth token expired:

1. Open Settings > Blaxel.
2. Select Reconnect account.
3. Complete browser authorization for the workspace already bound to the sandboxes.
4. Wait for each sandbox state to return to ready.

The reconnect flow can refresh only that bound workspace while sandboxes exist. This preserves workspace isolation.

## Troubleshooting

| Symptom | Cause | Action |
| --- | --- | --- |
| Blaxel settings are not visible | The package is not linked to the Web profile or DSH was not restarted | Reinstall or relink the plugin, then restart `dsh web` |
| Open on Blaxel is unavailable | The current directory is not inside a Git worktree | Open a Git-backed workspace in DSH |
| The move asks you to wait | The current turn or a sandbox tool process is still running | Wait for it to finish, then retry |
| Model setup appears before launch | The selected model route has no usable host credential | Save the requested provider credential in DSH and continue |
| Workspace choices cannot be verified | Authentication, workspace access, or provider discovery failed | Reconnect the account and select Verify connection |
| A recovered sandbox shows an authentication error | Its Blaxel OAuth token expired while DSH was stopped | Use Reconnect account for the same workspace |
| A tool fails with "The sandbox no longer exists." and the chip reads Reconnect Blaxel | The sandbox was deleted or expired while the session was connected | Choose Reconnect and confirm to start a fresh sandbox, or Continue locally to drop it. Idle sessions are probed every 30 seconds and flip to unavailable on their own |
| A sandbox shows as unavailable and Reconnect says it no longer exists | The sandbox was deleted or expired while DSH was away | Choose Reconnect and confirm to start a fresh sandbox from your current local files, or choose Continue locally to drop it. Changes that existed only in the lost sandbox cannot be recovered |
| Return to local reports a conflict | The original local files changed since the sandbox baseline | Nothing was applied and the sandbox keeps running. The sandbox patch is saved under `.git/dsh-blaxel/` in the repository; resolve or revert the local conflict and retry, or merge it with `git apply --3way <patch>` |
| Return to local rejects the patch | The patch exceeded the 1 MiB transfer limit, was truncated, or targeted an unsafe path | Keep the sandbox running and preserve or reduce the remote change before retrying |
| A remote tool fails | The sandbox command, filesystem, or connection failed | Read the tool error or reconnect the sandbox; the plugin never falls back to host execution |

## Limits

- Workspace snapshots support at most 100,000 listed files
- Source files in one snapshot are limited to 512 MiB before compression
- The compressed snapshot is limited to 256 MiB
- Automatic sandbox-to-local patches are limited to 1 MiB
- One sandbox launch can be prepared at a time
- Continuous bidirectional file synchronization is not provided

## Security model

- Blaxel and model credentials stay on the DSH host
- Credential-shaped host environment values are removed from sandbox tool processes
- Common credential paths, Git-ignored files, and private keys are excluded from snapshots
- Local sessions retain the DSH local sandbox policy
- Sandbox sessions route filesystem and subprocess operations only to Blaxel
- A failed remote operation never executes against the local host as a fallback
- Change transfer checks repository containment, conflicts, patch size, and symbolic-link targets before writing locally
- Blaxel resource-tool authorization state and its local proxy bearer token remain host-side

Review the snapshot file count and skipped-sensitive count shown during launch. Do not place required application secrets in the repository snapshot. Configure them through an explicit runtime-safe mechanism for the application you run inside the sandbox.

## Verify the repository

Run the complete keyless check:

```bash
pnpm check
pnpm pack
```

The live test creates a billable Blaxel sandbox and is opt-in:

```bash
DSH_BLAXEL_LIVE=1 pnpm vitest run tests/live.test.ts
```

Run it only with authorization to use the selected workspace. The [Calibrator round-trip report](docs/calibrator-roundtrip-dogfood.md) records the full local, sandbox, recovery, and move-back journey.

## Resources

- [Repository quickstart](README.md)
- [Machine-readable integration guide](llms.txt)
- [Blaxel documentation](https://docs.blaxel.ai)
- [DeepSeek Harness repository](https://github.com/deepseek-ai/DeepSeek-Harness)
