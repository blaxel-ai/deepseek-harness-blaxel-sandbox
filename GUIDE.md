# Guide: Blaxel Sandbox for DeepSeek Harness

Use [README.md](README.md) for the shortest installation path. This guide explains account setup, sandbox sessions, local round trips, recovery, security, and troubleshooting.

## How it works

This branch implements cloud session handoff. The published tools-only plugin still requires the original DSH host to run; do not advertise laptop-offline continuation for that release.

| Component | Location | Responsibility |
| --- | --- | --- |
| Original DSH host | Your computer | Local work, Blaxel credentials, snapshots, ownership and safe return |
| Cloud DSH host | Private Blaxel sandbox | Conversation, model requests, selected model API key, tools and project files |
| Browser | Your computer or another device | Authenticated access to the current execution owner |

The same session identity and history move between hosts. Once the cloud page is ready, the laptop can go offline. Reopen from the original computer to renew private access, or use **Copy private link** for another device. Private links grant access until their expiry; sandbox lifetime is independent and defaults to 24 hours.

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
  --allow-build=@google/genai \
  --allow-build=protobufjs \
  @blaxel/dsh-sandbox
npx --package @blaxel/dsh-sandbox dsh-blaxel web
```

To use the repository before publication:

```bash
git clone https://github.com/blaxel-ai/deepseek-harness-blaxel-sandbox.git
cd deepseek-harness-blaxel-sandbox
pnpm install
pnpm build
dsh plugin --profile web link "$PWD"
node dist/cli.js web
```

Use the package's `dsh-blaxel` launcher for cloud handoff. It caches a pinned DSH runtime with a small native history-import extension; the first launch downloads dependencies. Your profile and globally installed DSH remain separate from this runtime. Preserve `DSH_HOME` when using a custom profile.

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

Memory is shown directly. Expand **Advanced settings** to change the sandbox image, region, or maximum lifetime. The tested default remains TypeScript App; Base Image is a separate image choice.

| Setting | Default | Behavior |
| --- | --- | --- |
| Sandbox image | `blaxel/ts-app:latest` | Debian and glibc image prepared for common TypeScript workloads |
| Memory | `4096` MB | Filtered by the workspace memory limit |
| Region | Automatic | Filtered by workspace availability |
| Maximum lifetime | 24h for cloud sessions | Filtered by the workspace TTL limit |

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
- An active task checkpoints after its current tool finishes and continues in the cloud

Before creating a sandbox, the plugin requires a portable API-key model using the native pi-ai or DeepSeek provider. Local OAuth grants and laptop-only endpoints are rejected before ownership changes. Only the selected model key is sent to the cloud host; Blaxel credentials stay local. Configuration checks do not prove provider quota or key validity.

The cloud agent has full access inside its dedicated VM and runs without per-tool approval. Trust its model, project commands, and tools with the session and selected model key. Private preview authentication controls external browser access; it does not separate the host from code inside the VM. Returning to local restores the permissions captured before handoff. See [SECURITY.md](./SECURITY.md).

The launch action:

1. Resolves the current Git worktree and subdirectory.
2. Includes tracked files and unignored untracked files.
3. Excludes `.git`, `.dsh-blaxel`, Git-ignored paths, common credential files, and private keys.
4. Creates a bounded archive and restores it under `/workspace`.
5. Creates an immutable baseline for later change comparison.
6. Restores native session history and referenced assets in a full DSH host inside the private sandbox.
7. Opens the private cloud session automatically, including browser authentication.

The cloud page opens the same conversation and title. The original local view is held read-only until return.

## Identify a sandbox session

Sandbox sessions have an indented container marker in the normal sidebar. The active chat also has a subtle edge glow and a Running on Blaxel strip above the composer. Next to the send button, a chip states the connection: **On Blaxel** while connected, **Connecting…** while the sandbox starts, and **Reconnect Blaxel** when the sandbox is unavailable. Selecting that chip reconnects in place; a local session shows **Move to Blaxel** in the same spot.

Select the console link to inspect the sandbox, or **Open cloud session** to continue its conversation.

## Move changes back to local

On the original computer with DSH running, select **Move back to local** in the cloud banner or local Settings > Blaxel. The return landing handles the browser’s strict local authentication cookie automatically.

The plugin:

1. Shows the real changed paths and patch for review, then checkpoints the cloud agent before applying.
2. Compares `/workspace` with the immutable launch baseline.
3. Waits for active child agents to finish before completing the checkpoint.
4. Generates a bounded binary Git patch.
5. Checks the patch against the original local worktree before changing any file.
6. Applies the patch only when every target is safe and conflict-free.
7. Imports root and child conversation history with its event timestamps, restores the unsent text and image draft, and restores original laptop permissions.
8. Deletes the sandbox only after files and history are durable locally.

If local files conflict with the sandbox patch, nothing is applied and the sandbox remains available. Automatic transfer also fails closed for a truncated patch or unsafe symbolic-link target.

The saved local conversation reopens automatically after a cloud return, restoring its browser image previews. After the move completes, continue locally or select Move to Blaxel again. A later move creates a fresh sandbox from the current local worktree while preserving the same DSH session.

Files are copied when a sandbox starts and transferred back when you select Move back to local. There is no automatic two-way synchronization.

| Where newer edits exist | What happens |
| --- | --- |
| Sandbox only | Reopening the same session or reconnecting resumes those sandbox files. Move back to local applies the changes before stopping the sandbox. |
| Local only | The running sandbox keeps its earlier snapshot. Move back to local keeps your local edits; moving to Blaxel again copies the updated local files. |
| Both, with compatible edits | Move back to local applies the sandbox patch while preserving compatible local edits. |
| Both, with conflicting edits | Neither copy is overwritten. The sandbox stays available and a uniquely named recovery patch is saved in the repository's private Git directory. Review the patch and resolve the conflict before retrying. |
| A different session in the same repository | Open on Blaxel creates a separate sandbox from current local files. Changes in other sandboxes are not included. |

Reconnecting never uploads newer local files over the existing sandbox. The plugin does not choose a winner based on file timestamps. Sandbox-created Git commits contribute file changes to the return patch; their commit history is not imported into the local repository.

An exact already-applied patch is safe to retry. A manual merge that combines both versions may still fail the check. Retry **Move back to local** after merging. Discard permanently loses any unreturned cloud conversation and files, even when you have manually copied some file changes. There is no graphical conflict resolver yet.

## Discard a sandbox

Select Discard only when its remote changes are no longer needed. The confirmation explains that untransferred changes will be lost.

Discarding removes the remote runtime binding for that session. It does not close DSH, delete the conversation, affect another sandbox, or navigate to another page.

## Recover an interrupted return

The cloud checkpoint is durable across cloud-host restarts. If return fails before local files are applied, the plugin releases the cloud session when it can. If files or history have already been imported, it retains the checkpoint for a safe retry. Reopen the original profile and retry Move back to local; a durable completion receipt lets a cleanup retry finish without importing the same history twice.

Cloud children finish before return because one-shot child work cannot be resumed after a cold restart. A local-to-cloud move requires local child agents to be idle. Browser-only text and image drafts are saved with the session before a handoff.

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
| Return to local reports a conflict | The original local files changed since the sandbox baseline | Nothing was applied and the sandbox keeps running. Review the recovery patch under `.git/dsh-blaxel/` and resolve the conflict before retrying. After a manual merge, verify all wanted changes locally before using Discard sandbox. |
| Return to local rejects the patch | The patch exceeded the 1 MiB transfer limit, was truncated, or targeted an unsafe path | Keep the sandbox running and preserve or reduce the remote change before retrying |
| A remote tool fails | The sandbox command, filesystem, or connection failed | Read the tool error or reconnect the sandbox; the plugin never falls back to host execution |

## Limits

- Workspace snapshots support at most 100,000 listed files
- Source files in one snapshot are limited to 512 MiB before compression
- The compressed snapshot is limited to 256 MiB
- Automatic sandbox-to-local patches are limited to 1 MiB
- Conversation, referenced images, and pending draft transfers are limited to 64 MiB
- One sandbox launch can be prepared at a time
- Continuous bidirectional file synchronization is not provided
- At most 32 descendant sessions and 16 MiB combined child history
- Submodules and nested repositories must be opened as their own workspace; a parent snapshot reports them instead of silently omitting their content

## Security model

- Blaxel credentials stay on the original computer; only the selected model API key enters the private cloud process
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
DSH_BLAXEL_LIVE=1 pnpm vitest run tests/live.test.ts tests/live-roundtrip.test.ts
```

Run it only with authorization to use the selected workspace. The [Calibrator round-trip report](docs/calibrator-roundtrip-dogfood.md) records the full local, sandbox, recovery, and move-back journey.

## Resources

- [Repository quickstart](README.md)
- [Machine-readable integration guide](llms.txt)
- [Blaxel documentation](https://docs.blaxel.ai)
- [DeepSeek Harness repository](https://github.com/deepseek-ai/DeepSeek-Harness)
