# Changelog

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
