# Cloud session handoff

The cloud handoff candidate is implemented and unreleased. The published tools-only package requires the original host to keep running. This document separates the verified candidate from the public release.

## User workflow

1. Start DSH Web through the package's `dsh-blaxel` launcher and open a Git worktree.
2. Select Move to Blaxel. The plugin snapshots current files and transfers the native session, referenced images, completed child history, and unsent text/image draft.
3. Wait for the private cloud page. Its model requests and tools run independently of the original computer.
4. Use Copy private link for another browser. Reopen from the original computer to renew expired access.
5. Select Move back to local, review changed paths and the patch, then apply. The plugin restores conversation history and local permissions and deletes the sandbox only after durable local success.
6. Continue locally or move again to include newer local files in a fresh sandbox.

See [GUIDE.md](../GUIDE.md) for installation, authentication, conflict recovery, and limits.

## Execution and data ownership

A dedicated pinned DSH host runs inside the private sandbox. The selected native pi-ai or DeepSeek model API key enters that process; Blaxel credentials stay local. Server-side admission prevents the held local session from dispatching competing work. Remote failures never fall back to local tools.

The VM is the security boundary: the cloud agent has full access inside it, without per-tool approval. Its model and tools must be trusted with the session and selected model key. Private preview authentication protects external browser access; it does not isolate credentials or local services from commands inside that same VM. See [SECURITY.md](../SECURITY.md) for the complete trust boundary.

A running root task checkpoints at a safe tool boundary. Local child agents must be idle before outbound handoff. During return, cloud children finish before the checkpoint because a one-shot child cannot resume after a cold restart.

History import preserves original native event timestamps through an isolated pinned runtime extension. The package launcher installs that runtime in its own cache and leaves the global DSH installation unchanged. Imported children are published to the native session list. A successful cloud return reopens the saved local conversation automatically, recreating native image-preview handles and selecting the correct root even when return started in another session.

## Recovery transaction

The cloud host resumes an interrupted initial root or child import by validating the saved prefix and appending its missing events. Complete transfer size, including unsent drafts, is checked before provisioning. Drafts edited during handoff prevent automatic navigation so those edits remain available.

The cloud host writes its freeze request, held state, and final checkpoint durably. Repeated freeze requests and cloud-host restarts return the same completed checkpoint. An interrupted release keeps admission closed until a durable release intent can finish removing the checkpoint and restoring execution.

Return checks the reviewed patch hash again, rejects conflicting local history or files, imports images and the conversation tail, then records a completion receipt before deleting the sandbox. Partial child imports are validated as prefixes on retry. A cleanup failure reuses the receipt rather than importing history twice. Before local file application, a failed return releases cloud execution when reachable; after application, it preserves the checkpoint for recovery.

## Verified on September 9, 2026

- Independent continuation: while the original host was suspended, the cloud generated a fresh UUID, read it, used a separate tool call to write the same value, then edited invoice code and ran tests before the original host resumed.
- Real Chrome handoffs: local to cloud, reviewed return, and another handoff containing earlier cloud work plus newer local edits. The original user's pending draft was preserved.
- Invoice Desk acceptance: CSV export implementation, ten passing project tests, and an independent HTTP check of status, content type, filename, header, three rows, and the Export CSV control.
- Image and child return: 12,424 root events, 1,133 events in a pre-existing child, and 1,574 events in a cloud-created child matched after decoding native storage, including timestamps. The referenced JPEG hash and unsent text/image draft matched exactly.
- Repeated acceptance: 15,329 root events and three child histories matched on the next return, with the image bytes and pending draft intact. The new child appeared in the native list without manual refresh.
- Recovery: identical repeated checkpoint after a cloud-host restart, safe conflict handling, failed-checkpoint retry, failed-release fencing, partial-child-import retry, local-host restart, and durable receipt recovery after cleanup interruption.
- Authentication at the external private preview edge: anonymous and forged requests returned 401, an expired preview token returned 401, valid login and clean-root access returned 200, cross-origin requests returned 403, and renewed access returned 200. Preview tokens were absent from the final address bar. These checks do not establish authentication against code already running inside the VM.
- Validation: 195 keyless tests passed. All three opt-in live sandbox tests passed separately. Fresh package installs booted the native Web plugin on Node 22.22.3, 24.20.0, and 26.3.0. Lint, types, build, and package checks passed; publint reports two known warnings for the native client companion manifests.

The private acceptance artifacts and screenshot manifest are maintained with the DeepSeek blog project. They contain no published credential links. Publication must use the exact final package and its checks, rather than treating earlier public CI as cloud-handoff proof.

## Supported boundaries

- Git-backed workspaces; explicit transfer at handoff and return, without continuous two-way synchronization
- Portable native pi-ai and DeepSeek API-key models; no local OAuth grants or laptop-only endpoints
- Native referenced images, saved composer drafts, and supported child-session history
- No migration of custom external skills, local MCP authorization, or host-only services
- Default cloud lifetime of 24 hours; private links expire independently and do not extend sandbox lifetime
- At most 100,000 snapshot entries, 512 MiB source data, 256 MiB compressed archive, 1 MiB return patch, and 64 MiB combined conversation transfer
- Drafts bounded to 1 MiB text, 20 images, and 12 MiB encoded payload
- At most 32 descendant sessions and 16 MiB combined child history
- Submodules and nested repositories opened as their own workspace

## Release gates

The implementation, documentation changes, screenshots, unpublished Strapi article, and social copy are prepared for review. Source review, final-SHA CI, merge, npm publication, docs deployment, and content publication are separate release actions. Fresh-package browser CI covers Node 22 and 24; the scheduled live suite also boots and authenticates the native private cloud host, freezes its transcript and draft, and returns its files. Independent model continuation has separate live browser evidence above. Do not advertise cloud continuation for the existing tools-only release.
