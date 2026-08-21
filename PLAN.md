# Blaxel Sandbox for DeepSeek Harness

## Goal

Ship one Blaxel-owned, out-of-tree DeepSeek Harness bundle that moves filesystem, Bash, terminal, and LSP execution into one disposable Blaxel sandbox without changing DeepSeek Harness.

## Delivery shape

Develop `@blaxel/dsh-sandbox` in the standalone `blaxel-ai/deepseek-harness-blaxel-sandbox` repository, then publish the package only after explicit approval. The package has these Loader entry points:

- `@blaxel/dsh-sandbox/runtime` owns one sandbox, the remote cwd, private adapter state, readiness, and deletion.
- `@blaxel/dsh-sandbox/filesystem` implements `ctx.fs` against that sandbox.
- `@blaxel/dsh-sandbox/subprocess` implements `ctx.subprocess` against the same sandbox, including PTY sessions.
- The package root is an installable `dsh.bundle` with `cordis.patch.yml`.

The bundle can install into Web, TUI, and headless profiles, but installation never changes the default execution world. Local providers stay active unless a separate process starts with `DSH_BLAXEL_ACTIVE=1`.

Web exposes **Open in Blaxel** beside the chat input. It is enabled only for sessions inside a Git worktree. Clicking it snapshots tracked and unignored files, excludes common credential files, restores the repository under `/workspace`, and opens an isolated DSH window. The local session remains open and never switches execution providers in place.

The Blaxel process disables host filesystem and subprocess providers, mounts the three Blaxel entries, and advertises `danger-full-access` only inside the remote microVM boundary. Absolute source-worktree paths are mapped to their `/workspace` equivalents at the provider boundary.

## Current state

- DeepSeek Harness currently directs external integrations to standalone `dsh-plugin` repositories and does not accept external pull requests.
- Current upstream is `0.1.0-rc.8`. Its E2B family proves the runtime + filesystem + subprocess seam, while `@tensorlakeai/dsh-sandbox` proves the current one-package bundle and profile-install path.
- Package consolidation is complete: one private `@blaxel/dsh-sandbox` package exposes default-only `/runtime`, `/filesystem`, and `/subprocess` Loader entries, ships `cordis.patch.yml`, and targets DSH `0.1.0-rc.8` plus `@blaxel/core@0.3.12`.
- The Web and subprocess implementations are separated into focused lifecycle, HTTP, protocol, process, terminal, and transport modules.
- Keyless lint, typecheck, 10 tests, build, publint, package contents, default-only packed imports, clean headless-profile installation, and `dsh --dump-config` pass.
- The Web flow has been manually verified end to end: a Git worktree opened in a separate sandbox window, copied files were present under `/workspace`, common credential files were absent, Bash reported `/workspace`, host `DSH_*` and `BL_API_KEY` values were absent, the original session still ran locally, and teardown deleted the sandbox.
- The provider implementation remains prototype code, not a release baseline. It does not yet satisfy every published subprocess, filesystem, terminal, or teardown contract. The formal opt-in live test remains separate from the manual Web proof.

## Required design

### Runtime owner

- Default to `blaxel/node:latest`, `/workspace`, 4096 MB, and a bounded disposable lifetime.
- Keep Blaxel credentials in the host SDK configuration. Never copy `BL_API_KEY`, `BL_WORKSPACE`, DSH variables, or credential-shaped host variables into the sandbox.
- Create the cwd and a real, non-symlink `.dsh-blaxel` directory with mode `0700` before adapters activate.
- Install and validate one small Node bridge used for byte-exact process transport and bounded file reads.
- Reject new work once disposal begins, await setup, delete the sandbox, accept only a typed not-found result as already quiescent, and surface other cleanup failures.

### Filesystem provider

- Canonicalize POSIX target identity through the remote sandbox so symlink aliases cannot bypass containment checks.
- Implement typed metadata, stable listings, UTF-8 and binary detection, streaming text, and `readBytes` without transferring more than the requested bound.
- Serialize mutations per canonical target.
- Publish writes through a private sibling staging directory. Preserve mode, make guarded creates atomically no-replace, restore CRLF style for edits, and never report a committed write as failed because post-commit cleanup failed.
- Map not-found, permission, cancellation, non-regular, stale-version, and generic transport failures to the existing `FsError` vocabulary.

### Subprocess provider

- Extend `SubprocessRuntime`; return a handle immediately while remote startup publishes the real process-group id.
- Run exact argv and a rebuilt, scrubbed environment. Do not expose the host ambient environment or interpolate user values into shell syntax.
- Use a sandbox-side Node bridge because Blaxel's ordinary process API has no stdin method and its log API is line-oriented. Transport stdin as ordered base64 frames through private state, and transport stdout/stderr as base64 frames so arbitrary bytes survive.
- Implement pipe, inherit, bounded collect, bounded spill, independent output offsets, stream backpressure, batch stdin, repeated pipe writes, and real stdin close.
- Terminate the complete remote process group with `SIGTERM`, wait `graceMs`, escalate to `SIGKILL`, and make `waitForExit()` prove tree quiescence. Retain failed cleanup for disposal retry.

### Terminal provider

- Use Blaxel's `/terminal/ws` protocol with a random `sessionId`, exact cwd, and initial dimensions.
- Suppress bootstrap-shell prompt and echo bytes behind a random output boundary, then launch exact argv under a rebuilt environment.
- Publish the terminal session leader, inspect and signal the foreground group, and report output and exit facts through the DSH interface.
- Track in-flight allocation and every live terminal. Disposal must abort setup, join writes and signals, terminate every process sharing the terminal session id, close the WebSocket, and prove quiescence.

## Product surfaces

- The runtime, filesystem, subprocess, PTY, Bash, LSP, security, and cleanup behavior is shared across Web, TUI, and headless.
- Web owns the current launch UX: a composer action validates the Git worktree and opens a separate process; Settings reports the active repository and owns reopen and stop controls. Terminal, previews, and richer logs remain future work.
- TUI uses shared human commands and lifecycle status; headless uses deterministic configuration and concise stderr output.
- Documentation remains required for profile installation, `bl login`, security, lifecycle, and troubleshooting because a plugin cannot configure a profile before it is installed.
- The plugin cannot add a top-level `dsh` launcher command, alter unloaded profiles, or safely swap global filesystem and subprocess providers during a running session.

## Verification gates

1. Unit coverage for runtime lifecycle, config validation, error mapping, quoting/framing, environment scrub, bounded output, and cleanup failure propagation.
2. Filesystem contract coverage for symlinks, canonical identity, large reads, malformed UTF-8, binary files, stable listings, guarded writes, races, edits, cancellation, and cleanup.
3. Subprocess contract coverage for exact argv/env, multi-write stdin, raw byte output, collect/spill bounds, background descendants, aborts, TERM-to-KILL escalation, transport loss, and disposal aggregation.
4. Terminal coverage for bootstrap suppression, exact argv/env, foreground signals, background descendants, transport failure, allocation races, and service disposal.
5. A real Loader/profile composition test that exercises the shipped `cordis.patch.yml`, not hand-mounted services.
6. An opt-in live Blaxel test that runs filesystem, Bash, multi-message stdin, PTY, and LSP in one sandbox, then verifies deletion.
7. `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `publint`, `pnpm pack`, a clean-profile install, and `dsh --dump-config` against DSH `0.1.0-rc.8` on Node 22 and 24.
8. Public-repository hygiene scan for credentials, private URLs, local paths, generated residue, and machine-specific data.

## Work sequence

1. Harden the runtime owner and filesystem provider to the E2B/Tensorlake contract level.
2. Replace the prototype FIFO/log implementation with the sandbox-side process bridge and complete process-tree lifecycle tests.
3. Complete the terminal WebSocket lifecycle and terminal-session quiescence tests.
4. Add equivalent explicit launch and lifecycle commands for TUI and headless.
5. Run the formal opt-in live composition, package/install smoke, documentation review, and release-readiness audit.
6. Only after additional explicit approval: publish npm, update external trackers, and announce the integration.

## Completion

The integration is complete only when a clean DSH profile installs one Blaxel bundle, one real session uses file tools, Bash, PTY, and LSP inside the same Blaxel sandbox, every owned process and terminal is quiescent at shutdown, the sandbox is deleted, all package gates pass, and the public npm/repository state is verified.
