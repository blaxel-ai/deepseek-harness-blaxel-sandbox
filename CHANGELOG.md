# Changelog

## 0.1.3 - 2026-09-09

### Independent cloud session handoff

- Move an existing conversation and Git worktree into a full private Blaxel DSH host, including automatic continuation after a running tool finishes.
- Automatically authenticate and renew private previews, retain native origin checks, and bridge strict local cookies on the return navigation.
- Copy a private link for another device, review the real file diff before return, restore the conversation and original local permissions, and preserve both copies on conflict.
- Preserve referenced images, unsent text and image drafts, and completed child conversations in both directions, including native event timestamps.
- Recover interrupted checkpoints, partial child imports, host restarts, and cleanup retries through durable checkpoints and receipts. Refresh imported children in the native session list without a browser reload.
- Validate combined history, images, and draft size before provisioning; resume interrupted first imports without losing root or child history, and preserve draft edits made during handoff.
- Verify fresh packed installations on Node 22 and 24 in browser CI, and exercise a native private cloud host in the scheduled live suite.
- Keep return diffs and cloud controls readable in light and dark themes.
- Keep execution ownership enforced at the native API gateway and selected-model credentials separate from local Blaxel credentials.
- Live browser testing proved independent model/tool steps with the original DSH host suspended, conflict recovery, and repeated handoff.

### Dependency security

- Pin the published `@blaxel/core@0.3.20-preview.290` SDK, which replaces the vulnerable TOML parser with `smol-toml`. The exact preview is pinned until the fix reaches a stable SDK release.
- Update `js-yaml` and Vitest to patched versions and verify audits in a fresh consumer profile as well as this repository.

### Compatibility and round-trip improvements

- Keep sandbox authentication attached to the session workspace when another terminal changes the global Blaxel CLI context; restore that workspace before recovering persisted bindings, and follow the CLI context again after the last sandbox closes.
- Patch profile-local native history imports for both custom-profile argument forms and simultaneous launches.
- Preserve settings action errors during background refresh and use the bound environment for browser reauthentication.

- **Implicit model authentication is checked before sandbox launch.** Empty pi-ai provider profiles now use the provider's own API-key, OAuth, and ambient credential checks. Missing OpenAI keys open the existing inline setup form instead of allowing a sandbox launch followed by `Provider is not configured: openai`. The check does not refresh OAuth or send model requests; credentials remain on the host.
- **The composer action works again on DSH 0.1.2.** DSH 0.1.2 hands session-scoped slot entries `sessionId` and `useSession` instead of a `session` object; the Blaxel entries now read that contract, so **Move to Blaxel** / **Open on Blaxel** render instead of crashing the slot.
- **Connection state lives in the composer.** Every sandboxed session shows a chip next to the send button: **On Blaxel** while connected, **Connecting…** while a sandbox starts, and a clickable **Reconnect Blaxel** when the sandbox is unavailable. Local sessions keep the one-click **Move to Blaxel** action, so a session can be sandboxed or reconnected without opening Settings.
- **Provider names are presented properly.** Model setup cards say "Connect OpenAI" and "OpenAI API key" even when the DSH profile only knows the lowercase provider id (`openai`, `deepseek`, `anthropic`, `google`, `xai`, `mistral`, `groq`, `openrouter`).
- **A sandbox lost mid-session no longer takes DSH down.** A tool call against a sandbox that was deleted or expired while DSH was running used to surface the platform's raw 404 payload and, on the next process teardown, crash the DSH host with `fatal load failure`. The tool now fails with one sentence, "The sandbox no longer exists.", the session flips to unavailable immediately, and the chip, banner, and Settings offer **Reconnect** or **Continue locally**. Verified live by deleting the sandbox out-of-band during a running turn.
- **Sandbox liveness is probed.** Status refreshes check each connected sandbox with the platform at most every 30 seconds, so a sandbox that disappears while idle is reported as unavailable without waiting for the next tool call.
- **User-visible messages are unified.** Failed HTTP requests read as plain sentences instead of internal error codes, sandbox states use the same words in the composer, banner, and Settings, and blocked-tool messages point at Reconnect or Continue locally.
- **Browser smoke suite.** `pnpm e2e` boots the pinned `dsh-blaxel` runtime and drives a real Chromium session through Playwright: every Blaxel slot mounts without a slot error, the composer shows the Move action or a state chip that agrees with the banner, and Settings exposes the Blaxel section.
- **Reconnect asks before replacing a lost sandbox.** When the bound sandbox no longer exists, Reconnect now explains that changes made only inside it cannot be recovered and asks for consent before creating a fresh sandbox from the local worktree. A new **Continue locally** action drops an unavailable sandbox so the session is never stuck with blocked tools.
- **Conflict recovery preserves each session's patch.** When Return to local fails the conflict check, the sandbox patch is saved under a unique path in the repository's private Git directory (`.git/dsh-blaxel/`). The error names the file so its changes can be reviewed and merged locally while the sandbox keeps running.
- **Baseline survives an agent-created repository.** Recovery no longer fails when the agent ran `git init` inside `/workspace`; the divergence baseline pairs through its own Git directory and leaves the agent's `.git` alone.
- **Expired CLI refresh no longer blocks a working session.** When `bl token` cannot refresh but the stored access token still works, sandbox operations continue instead of demanding a new sign-in.
- Sandbox state is visible everywhere: the chat banner and sidebar marker show creating, ready, and unavailable states, and an unavailable sandbox blocks local tools explicitly rather than silently falling back to the host.
- Round-trip edge cases are covered by tests: local edits to untouched files, non-overlapping edits to the same file, local commits after the snapshot, same-file conflicts, deletions on either side, binary files, executable bits, non-ASCII paths, a deleted worktree, a deleted or standby sandbox, a failed replacement, and moves attempted while tools or turns are still running.
- Sandbox loss is confirmed through the sandbox API before offering destructive recovery; missing processes and command errors no longer mark a healthy sandbox as deleted.
- Host path aliases map to the sandbox worktree, and submodules or nested repositories are reported before launch instead of silently omitted.
- The return preview includes changes committed by the agent. Reconnect and return messages explain which copy is used and how newer local edits are preserved.
- Stopped commands clean up their process group, including background children; commands with a missing working directory fail before execution. Zero-byte output buffers stay bounded, and opening a sandbox refuses a turn that started during provisioning.

## 0.1.2 - 2026-09-03

- Every Blaxel request made by the plugin now appends the product token `deepseek-harness-blaxel-sandbox/<version>` to the Blaxel SDK `User-Agent`, so Blaxel can attribute sandbox traffic to this integration. No new headers, identifiers, or data are sent, and nothing is collected from DSH or the workspace.

## 0.1.1 - 2026-09-03

Compatibility release for DeepSeek Harness `0.1.2-rc.1`.

- DSH 0.1.2 removed the Host API Proxy service the Web entry depended on, so the plugin failed to activate with `waiting for service: apiProxy`. The Web entry now calls the owning Host services directly: the session, workspace, settings, and credentials controllers, the LLM provider registry, and the default-model service.
- Requires DSH `0.1.2-rc.1` or newer; `0.1.1-rc.2` hosts stay on plugin `0.1.0`.
- Verified on DSH `0.1.2-rc.1`: full check, clean install of the packed tarball into a fresh Web profile, and DSH Web booting with every Blaxel entry active.

## 0.1.0 - 2026-09-02

First public release of `@blaxel/dsh-sandbox`, the Blaxel sandbox plugin for DeepSeek Harness (DSH) Web.

- **Open on Blaxel** creates a sandbox-backed native DSH session for the current Git worktree. **Move to Blaxel** rebinds a session with history in place, keeping its conversation, title, and sidebar row.
- Filesystem, Bash, and terminal tools for a sandbox session run inside one short-lived Blaxel microVM under `/workspace`. The DSH interface, model requests, credentials, and session state stay on the host.
- **Return to local** conflict-checks sandbox changes against the original worktree, applies them only when safe, stops the sandbox, and continues the same session locally.
- Settings > Blaxel handles sign-in, sandbox defaults, and running sandbox sessions. Restarting DSH reconnects sessions to their existing sandboxes.
- Workspace snapshots exclude Git-ignored paths and common credential files. A failed remote operation never falls back to the host.
- Verified on DSH `0.1.1-rc.2` with Node 22 and 24.
