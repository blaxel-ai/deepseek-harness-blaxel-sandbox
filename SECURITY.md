# Security

Report a suspected vulnerability through Blaxel's private security process. Do not open a public issue with tokens, private source, account details, or an active exploit. Use the private vulnerability-reporting link in this repository's Security tab when available; otherwise contact the Blaxel security owner through the current internal process.

## Scope

Security-sensitive areas include workspace snapshot filtering, secret-file exclusion, path containment inside `/workspace`, the conflict-checked return of sandbox changes to the local worktree, Blaxel credential handling in DSH Settings, remote process and terminal execution, and sandbox deletion.

Cloud session handoff forwards the selected model API key to the dedicated cloud DSH host so it can continue independently. Blaxel account credentials stay local. Workspace snapshots exclude Git-ignored paths and common credential files. These controls reduce risk but do not replace user review of what a session moves to Blaxel.

## Cloud trust boundary

The dedicated Blaxel VM is the isolation boundary. The cloud agent runs with full access inside that VM and without per-tool approval. Treat its selected model, repository, commands, and installed tools as trusted with the cloud session and selected model credential. The plugin does not isolate the host's credentials, session files, or loopback services from code executing in the same VM. Native DSH scrubs sensitive variables from ordinary child environments to prevent accidental inheritance; this is not protection from deliberate same-VM access.

Browser access from outside the VM goes through the private Blaxel preview edge, which validates preview tokens and supplies identity headers. The host trusts those edge headers; they are not a separate authentication boundary against code already running inside the VM. Do not expose the host port through a public preview or unauthenticated proxy. Local permissions are captured before handoff and restored when cloud history returns to the originating computer.

Cloud bootstrap installs the pinned runtime with lifecycle scripts disabled and with npm configuration outside the transferred repository. This protects bootstrap from repository npm configuration, but does not make subsequently executed project commands untrusted-code safe.

## Releases

Releases are published from a maintainer's machine with npm two-factor authentication. No long-lived publish token is stored in this repository or its CI.
