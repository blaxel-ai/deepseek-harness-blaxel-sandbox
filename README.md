# DSH Blaxel providers

Out-of-tree DeepSeek Harness providers for a shared Blaxel sandbox. The packages follow DSH's documented capability seams: `dsh-blaxel` owns the sandbox lifecycle, `dsh-fs-blaxel` implements `ctx.fs`, and `dsh-subprocess-blaxel` implements `ctx.subprocess` including the native Blaxel terminal WebSocket.

The repository is intentionally independent of the DeepSeek Harness source tree. DSH's contribution guide asks external integrations to publish standalone packages and tag their repository `dsh-plugin`.

## Development

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

Authentication is read by `@blaxel/core` from the local Blaxel CLI configuration or `BL_WORKSPACE` and `BL_API_KEY`. The live test is opt-in:

```sh
DSH_BLAXEL_LIVE=1 pnpm vitest run tests/live.test.ts
```

## DSH composition

Load the lifecycle package before the two capability providers. Existing DSH consumers such as `dsh-bash-local`, `dsh-tool-fs`, `dsh-lsp-stdio`, and `dsh-terminal-bash` continue to use their provider-neutral seams:

```ts
import BlaxelRuntime from 'dsh-blaxel'
import BlaxelFileSystem from 'dsh-fs-blaxel'
import BlaxelSubprocessRuntime from 'dsh-subprocess-blaxel'

await ctx.plugin(BlaxelRuntime, { image: 'blaxel/node:latest', cwd: '/workspace', region: 'us-pdx-1' })
await ctx.plugin(BlaxelFileSystem)
await ctx.plugin(BlaxelSubprocessRuntime)
```

The subprocess provider uses `sandbox.process.exec` for ordinary commands and Blaxel's official `/terminal/ws` protocol for PTY sessions. Blaxel's SDK does not expose an stdin method for ordinary processes, so the adapter uses a private FIFO for DSH pipe and batch stdin. Filesystem target identity is normalized POSIX path identity; remote symlink canonicalization is intentionally deferred until Blaxel exposes a stable file-id primitive.
