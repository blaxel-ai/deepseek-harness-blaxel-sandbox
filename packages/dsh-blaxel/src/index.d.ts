import { Context, Service } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { SandboxInstance } from '@blaxel/core';
import type { SandboxCreateConfiguration } from '@blaxel/core';
export type { SandboxCreateConfiguration, SandboxInstance } from '@blaxel/core';
export interface Config extends Omit<SandboxCreateConfiguration, 'name'> {
    /** Explicit sandbox name; otherwise a unique disposable name is generated. */
    name?: string;
    /** Remote working directory shared by all mounted DSH capabilities. */
    cwd?: string;
}
declare module '@deepseek-ai/cordis' {
    interface Context {
        blaxel: BlaxelRuntime;
    }
}
/**
 * Creates one Blaxel sandbox and exposes it to filesystem and subprocess
 * adapters through `ctx.blaxel`. Credentials remain in the Blaxel SDK config
 * (CLI login or BL_* environment variables) and are never copied into the VM.
 */
export declare class BlaxelRuntime extends Service {
    static Config: z<Config>;
    readonly cwd: string;
    readonly runtimeRoot: string;
    readonly name: string;
    private readonly config;
    private readonly ready;
    private disposed;
    constructor(ctx: Context, config: Config);
    getSandbox(): Promise<SandboxInstance>;
    private open;
}
export declare function shellQuote(value: string): string;
export default BlaxelRuntime;
