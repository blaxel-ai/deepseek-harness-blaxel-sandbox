# Changelog

## 0.1.0 - 2026-09-02

First public release of `@blaxel/dsh-sandbox`, the Blaxel sandbox plugin for DeepSeek Harness (DSH) Web.

- **Open on Blaxel** creates a sandbox-backed native DSH session for the current Git worktree. **Move to Blaxel** rebinds a session with history in place, keeping its conversation, title, and sidebar row.
- Filesystem, Bash, and terminal tools for a sandbox session run inside one short-lived Blaxel microVM under `/workspace`. The DSH interface, model requests, credentials, and session state stay on the host.
- **Return to local** conflict-checks sandbox changes against the original worktree, applies them only when safe, stops the sandbox, and continues the same session locally.
- Settings > Blaxel handles sign-in, sandbox defaults, and running sandbox sessions. Restarting DSH reconnects sessions to their existing sandboxes.
- Workspace snapshots exclude Git-ignored paths and common credential files. A failed remote operation never falls back to the host.
- Verified on DSH `0.1.1-rc.2` with Node 22 and 24.
