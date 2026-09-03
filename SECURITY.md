# Security

Report a suspected vulnerability through Blaxel's private security process. Do not open a public issue with tokens, private source, account details, or an active exploit. Use the private vulnerability-reporting link in this repository's Security tab when available; otherwise contact the Blaxel security owner through the current internal process.

## Scope

Security-sensitive areas include workspace snapshot filtering, secret-file exclusion, path containment inside `/workspace`, the conflict-checked return of sandbox changes to the local worktree, Blaxel credential handling in DSH Settings, remote process and terminal execution, and sandbox deletion.

The plugin never sends model credentials or Blaxel credentials into the sandbox. Workspace snapshots exclude Git-ignored paths and common credential files. These controls reduce risk but do not replace user review of what a session moves to Blaxel.

## Releases

Releases are published from a maintainer's machine with npm two-factor authentication. No long-lived publish token is stored in this repository or its CI.
