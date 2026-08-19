/** Shared ownership of one Blaxel sandbox for DSH provider adapters. */
import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import { Service } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { SandboxInstance } from '@blaxel/core';
/**
 * Creates one Blaxel sandbox and exposes it to filesystem and subprocess
 * adapters through `ctx.blaxel`. Credentials remain in the Blaxel SDK config
 * (CLI login or BL_* environment variables) and are never copied into the VM.
 */
export class BlaxelRuntime extends Service {
    static Config = z.object({
        name: z.string(),
        cwd: z.string().default('/workspace'),
        image: z.string().default('blaxel/node:latest'),
        memory: z.number().default(4096),
        region: z.string(),
        ttl: z.string(),
        expires: z.date(),
        ports: z.any(),
        envs: z.any(),
        volumes: z.any(),
        lifecycle: z.any(),
        network: z.any(),
        snapshotEnabled: z.boolean(),
        labels: z.any(),
        extraArgs: z.any(),
        externalId: z.string(),
    });
    cwd;
    runtimeRoot;
    name;
    config;
    ready;
    disposed = false;
    constructor(ctx, config) {
        super(ctx, 'blaxel');
        const resolved = config;
        this.config = { ...resolved, cwd: resolved.cwd };
        this.cwd = this.config.cwd;
        if (!posix.isAbsolute(this.cwd))
            throw new Error(`dsh-blaxel: cwd must be absolute: ${this.cwd}`);
        this.runtimeRoot = posix.join(this.cwd, '.dsh-blaxel');
        this.name = this.config.name ?? `dsh-${randomUUID().replaceAll('-', '').slice(0, 16)}`;
        this.ready = this.open();
        void this.ready.catch(() => { });
        ctx.effect(() => async () => {
            this.disposed = true;
            const sandbox = await this.ready.catch(() => undefined);
            if (sandbox !== undefined)
                await sandbox.delete().catch(() => undefined);
        }, 'blaxel sandbox teardown');
    }
    async getSandbox() {
        if (this.disposed)
            throw new Error('dsh-blaxel: service is disposing');
        const sandbox = await this.ready;
        if (this.disposed)
            throw new Error('dsh-blaxel: service is disposing');
        return sandbox;
    }
    async open() {
        const { name: _name, cwd: _cwd, ...options } = this.config;
        const sandbox = await SandboxInstance.create({ ...options, name: this.name });
        try {
            await sandbox.fs.mkdir(this.cwd);
            await sandbox.fs.mkdir(this.runtimeRoot);
            await sandbox.process.exec({
                name: 'dsh-blaxel-protect-runtime',
                command: `chmod 700 -- ${shellQuote(this.runtimeRoot)}`,
                workingDir: this.cwd,
                waitForCompletion: true,
            });
            return sandbox;
        }
        catch (error) {
            await sandbox.delete().catch(() => undefined);
            throw error;
        }
    }
}
export function shellQuote(value) {
    return `'${value.replaceAll("'", "'\"'\"'")}'`;
}
export default BlaxelRuntime;
