# Calibrator local and sandbox roundtrip dogfood

Date: 2026-08-25

Note: this report predates the 0.1.0 label rename. `Open in Sandbox` is now **Open on Blaxel**, `Move to Sandbox` is **Move to Blaxel**, `Running in Blaxel` is **Running on Blaxel**, `Move to local` is **Return to local**, and `Discard sandbox` is **Discard**.

Status: Complete. The same native session moved local to sandbox, returned a nonzero patch to the original worktree, moved back to a fresh sandbox, survived host restarts, and passed the full Calibrator check on the new Debian/glibc default.

## Goal

Use DeepSeek Harness as a regular user to inspect a Calibrator feature locally, move the same session into a Blaxel sandbox, implement it there, recover the changes into the original local Git worktree, move the same session back into a sandbox, run checks, and verify the local app.

Feature: add a copyable Run ID to expanded Run details with temporary `Copied` feedback, an accessible label, and focused tests.

## Test identity

- Local repository: a clean Calibrator development worktree
- DSH URL: a local DSH Web instance
- DSH session: one ordinary native session retained throughout the journey
- First sandbox: initial implementation sandbox
- Nonzero move-back sandbox: replacement sandbox used to verify local recovery
- Metadata-clean sandbox: clean snapshot verification sandbox
- Final TypeScript App sandbox: final Debian/glibc verification sandbox
- Sandbox workspace: `/workspace`
- Blaxel workspace: `main`
- Files changed in the sandbox:
  - `components/run-view.tsx`
  - `lib/__tests__/run-view.test.ts`

An unrelated existing sandbox was visible during the test and intentionally left untouched.

## Journey

| Stage | User action | Evidence | Result |
| --- | --- | --- | --- |
| Local inspect | Started one ordinary Calibrator chat and asked the agent to inspect without editing | Reads used local repository paths and the agent proposed two focused file changes | Passed |
| Move to cloud | Clicked `Move to Sandbox` in the same composer | The same session and chat remained selected; later tools read and edited `/workspace` | Passed |
| Implement | Asked the agent to make the exact change, test it, and avoid commits | Two produced files were shown and sandbox edits targeted `/workspace` | Passed |
| Long command | Ran focused tests and the full repository check through Bash | Bash returned immediately with no output while child processes kept running | Failed, plugin fixed |
| Host disconnect | Deliberately restarted the DSH host | Both persisted bindings reappeared as failed because the CLI OAuth token had expired | Recovery path exposed an auth deadlock, plugin fixed |
| Reauthenticate | Opened Blaxel settings in signed-in Codex Chrome Use and clicked `Reconnect account` | Blaxel device confirmation used the existing signed-in browser session; workspace `Main` was preselected | Passed |
| Recover | Selected `Main` | Both persisted sandboxes returned to `ready`; tier, images, memory, regions, and lifetime choices became available again | Passed |
| Move local | Clicked `Move changes local` for the dogfood sandbox and accepted the confirmation | The UI reported `0 sandbox changes applied locally`, deleted the dogfood sandbox, and left the local worktree clean | Failed, plugin fixed and edits recovered |
| Move back | Clicked `Move to Sandbox` again in the same ordinary session | The same session stayed selected and created a replacement sandbox; no new page, session, or workspace group appeared | Passed |
| Recover again | Restarted the DSH host repeatedly while the replacement sandbox was active | The same sandbox reconnected each time and retained its original baseline plus later edits | Passed |
| Verify sandbox | Ran Git, dependency installation, the focused test, and the full check | Git and long-command waiting passed; the focused 7-test suite passed; full lint exposed macOS `._*` archive metadata | Partial, snapshot fixed |
| Recover nonzero patch | Moved the replacement sandbox back to the original worktree | Exactly two files and the six-line accessibility refinement were applied; the unrelated sandbox remained running | Passed |
| Clean snapshot | Moved the same ordinary session into a clean verification sandbox | Git was clean, `/workspace` was the root, and `find . -name '._*'` returned no files | Passed |
| Full sandbox check | Installed dependencies and ran the full suite in the clean sandbox | 261 passed, 3 native PTY tests crashed with exit 139 because `blaxel/node:latest` is musl and `node-pty` selected a glibc prebuild | Failed, default image fixed |
| Verify local app | Ran Calibrator, expanded Run details, and copied a real ID | The clipboard received the exact Run ID and the button announced `Run ID copied`; a restricted-clipboard fallback was added | Passed |
| Final sandbox run | Reconnected Blaxel, discarded only the clean dogfood sandbox, restarted DSH, and moved the same native session again | The final sandbox used `blaxel/ts-app:latest`; no new page, session, or workspace group appeared | Passed |
| Final recovery | Restarted DSH twice while the TypeScript App sandbox was active | The same sandbox reconnected; Read, Glob, and Bash all succeeded afterward | Passed |
| Final check | Installed dependencies inside the sandbox and ran focused plus full checks | Focused 7/7; full 286 passed, 1 skipped, 0 failed out of 287; production build passed; Git remained clean | Passed |
| Final divergence | Inspected the sandbox against its immutable baseline | 0 changed files, not truncated | Passed |

## Friction and papercuts

1. Sandbox readiness was not clearly announced in the chat after the first move. The strongest evidence was the `/workspace` tool path.
2. The sandbox marker disappeared when recovery failed. A failed persisted cloud binding is still a sandbox session and should retain its indented container marker.
3. The agent attempted one edit before reading the test file. The guard worked, but the red error row was noisy for a recoverable sequencing issue.
4. Sandbox Bash commands reported success before `npm` finished. This caused repeated probes, duplicate work, and uncertainty about test results.
5. Expired OAuth created a deadlock: settings required stopping sandboxes before changing auth, but sandbox recovery and stop both required valid auth.
6. The first browser automation connection used an isolated profile and showed login screens. Actual Codex Chrome Use reused the signed-in Chrome profile and completed device authorization without credentials. This was an operator harness mistake, not a plugin defect.
7. Settings exposed only `Stop` before this work. There was no safe way to inspect divergence and bring sandbox work back to the original local worktree.
8. Light mode rendered secondary controls as dark blocks with nearly black labels because the panel referenced theme variables DSH does not expose. Sandbox actions also wrapped into oversized blue and black buttons.
9. Recovery recreated the sandbox baseline after the feature had already been edited. That made the edited workspace and baseline identical, so divergence incorrectly reported zero and move-back discarded the sandbox without applying the feature.
10. GNU `setsid -w` fixed waiting locally but is unsupported by the BusyBox `setsid` in the Blaxel Node image. Even `pwd` failed before launch.
11. The first replacement sandbox had no native `.git` attachment, so ordinary `git status` failed despite the plugin owning a valid external baseline.
12. macOS bsdtar serialized extended attributes as 166 AppleDouble `._*` files. They were invisible locally but became ordinary files after Linux extraction and broke ESLint.
13. The old `blaxel/node:latest` default is musl. Calibrator's `node-pty` glibc prebuild loaded but immediately crashed with `SIGSEGV` instead of producing a useful install error.
14. DSH filesystem search passed its packaged macOS ripgrep path through the subprocess seam. Linux received the host-only absolute path, so Glob failed even though Bash remained healthy.
15. The first Run ID copy handler silently ignored clipboard rejection. A selection-based fallback and explicit failure state now keep the control honest in restricted browser contexts.
16. The TypeScript App image omits `ps`; readiness installed ripgrep but initially failed before binding. Runtime preparation now installs both ripgrep and procps.
17. Debian's default `sh` does not support `set -o pipefail`. Environment, filesystem, and divergence control commands now run explicitly under Bash instead of inheriting an image-dependent shell.

## Durable plugin changes

### One ordinary session

Cloud execution remains a property of the existing DSH session. The plugin stores one binding keyed by the native session ID. No cloud repository page, second tab, duplicate session, or extra workspace group is created.

### Safe one-way recovery

`Move changes local` now:

1. Requires the native session to be idle.
2. Reads a bounded Git divergence summary from the sandbox.
3. Generates a binary Git patch from the sandbox baseline.
4. Runs `git apply --check --binary --whitespace=nowarn` against the original local repository.
5. Applies only after the check succeeds.
6. Leaves the local worktree untouched on conflicts or truncated output.
7. Deletes only the recovered sandbox and removes only its session binding after a successful apply.

The divergence reader and patch applier are separate seams so a future local-to-sandbox synchronization direction can reuse the same conflict and provenance rules.

### Immutable recovery baseline

The sandbox Git baseline is now created exactly once, before a new binding becomes ready. Its original commit is pinned under an immutable plugin ref. Recovery only opens and validates that commit; it never runs `git init`, stages files, or creates a replacement commit. Missing or invalid baseline state fails closed instead of silently redefining the current edited workspace as clean.

The workspace's `.git` file points at the protected external Git directory. Regular `git status`, staging, and commits therefore work in `/workspace`, while move-back always compares the current tree to the pinned original ref.

### Clean cross-platform snapshots

Snapshot archiving now sets `COPYFILE_DISABLE=1`. macOS extended attributes are no longer materialized as AppleDouble source files when the archive is extracted in Linux.

### Native-dependency-safe runtime

New installations default to `blaxel/ts-app:latest`, a Debian/glibc image. A real `node-pty@1.2.0-beta.14` spawn returned `PTY_OK` there with exit 0. Runtime preparation installs ripgrep and procps through the image's native package manager, verifies the small DSH toolchain before exposing the session, maps DSH's packaged host ripgrep path during both resolution and spawn, and runs bounded control scripts explicitly under Bash.

### Visible sandbox identity

The active sandbox chat gets a subtle blue edge glow without changing local chats. A compact `Running in Blaxel` strip sits directly above the composer, names the exact sandbox, and links in one click to its signed-in Blaxel Console detail page.

The two Calibrator edits lost by the first move-back were reconstructed from the original session's immutable tool-diff records and applied to the local worktree before repeating the journey.

### Correct process lifecycle

Sandbox commands run in a new process session behind a small POSIX shell supervisor. The supervisor waits for the real command, forwards termination to its process group, and avoids GNU-only `setsid -w`, which is unavailable in Blaxel's BusyBox-based Node image. The Bash limit was raised from 60 seconds to 300 seconds for repository checks.

### Recoverable authentication

Running or failed bindings may refresh credentials only for their already-bound Blaxel workspace. Cross-workspace switches, sign-out, and API-key changes remain locked while any persisted binding exists. This breaks the expired-token deadlock without weakening tenant boundaries.

When a reconnect flow returns the workspace already pinned by a running sandbox, the plugin completes it automatically instead of asking the user to choose the same workspace again. Active sandbox deletion refreshes that bound credential before calling Blaxel.

### Destructive clarity

The old stop action is labeled `Stop and discard` and always confirms that unmerged sandbox changes will be lost. `Move changes local` is the primary action.

### Native settings theming

Cards, inputs, statuses, buttons, disabled states, hover states, warnings, and errors now use DSH's actual semantic theme tokens. Sandbox actions are compact `Move to local` and `Discard sandbox` controls below the session metadata. The panel no longer carries dark fallback fills into light mode.

## Verification

- Focused baseline and roundtrip suite: 14 tests passed across baseline creation, recovery, divergence, and local patch application.
- Baseline tests prove that creation initializes and commits once, recovery only resolves the original commit, and a missing baseline fails closed.
- Local patch tests cover success, conflict with no local mutation, and truncated patch rejection.
- Auth tests cover same-workspace refresh, cross-workspace rejection, and persisted failed bindings blocking workspace switches.
- `git diff --check`: passed.
- Full plugin `pnpm check`: passed, including lint, TypeScript, 78 tests, build, and package lint; one opt-in live test was skipped.
- Real first sandbox implementation: produced two intended Calibrator files.
- Real OAuth recovery through signed-in Codex Chrome Use: passed.
- Light and dark settings rendering through signed-in Codex Chrome Use: passed; the original System appearance preference was restored afterward.
- First real sandbox-to-local attempt: failed because recovery recreated the baseline; root cause fixed and the feature edits recovered from the immutable session log.
- Replacement sandbox creation in the same native session: passed.
- Repeated host restart recovery: passed without recreating the baseline or losing edits.
- Native sandbox Git: `git status` and `git rev-parse --show-toplevel` passed in `/workspace`.
- Portable process supervisor: dependency installation and the focused 7-test suite completed with their real exit status.
- Sandbox chat glow, identity strip, and exact Blaxel Console link: verified in signed-in Codex Chrome Use.
- Exact Blaxel Console detail page opened from the chat strip in one click: passed.
- Light-mode chat glow and full Blaxel settings panel: passed; the temporary browser emulation was cleared.
- Local Calibrator: focused 7-test suite and full 287-test check passed; exact Run ID clipboard and `Run ID copied` feedback passed in signed-in Codex Chrome Use.
- Final same-session TypeScript App sandbox: `blaxel/ts-app:latest`, Debian glibc 2.36, Node v24.19.0, `/usr/bin/rg`.
- Final recovered Read, Glob, and Bash probe: passed after the host restarted on the latest plugin build.
- Final sandbox focused suite: 7 passed, 0 failed, exit 0.
- Final sandbox full check: 286 passed, 1 skipped, 0 failed out of 287; production build passed; exit 0.
- Final sandbox Git status: clean; AppleDouble search returned none; divergence reported 0 changed files.

## Release bar

The tested roundtrip is ready. Before marketplace submission, perform the separate packaging gate from a fresh plugin install and reconcile the installed DSH host version with the declared DSH dependency.
