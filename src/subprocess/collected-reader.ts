import { Buffer } from 'node:buffer'
import type { SubprocessCollect, SubprocessOutputReader } from '@deepseek-ai/dsh-subprocess'
import type { BlaxelRuntime } from '../runtime-service.js'

export class CollectedReader implements SubprocessOutputReader {
  private total = 0
  private tail = Buffer.alloc(0)
  private full = Buffer.alloc(0)
  private finished = false
  private spillReady = false

  constructor(private readonly mode: SubprocessCollect, readonly spillPath?: string) {}

  push(chunk: string | Buffer): void {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    this.total += bytes.length
    this.tail = Buffer.concat([this.tail, bytes]).subarray(-this.mode.maxBytes)
    if (this.mode.spill !== undefined && this.full.length <= this.mode.spill.maxBytes) {
      this.full = Buffer.concat([this.full, bytes])
      if (this.full.length > this.mode.spill.maxBytes) this.full = Buffer.alloc(0)
    }
  }

  finish(): void { this.finished = true }

  async persist(sandbox: Awaited<ReturnType<BlaxelRuntime['getSandbox']>>): Promise<void> {
    if (this.spillPath === undefined || this.full.length === 0 || this.full.length !== this.total) return
    await sandbox.fs.writeBinary(this.spillPath, this.full)
    this.spillReady = true
  }

  readFrom(fromByte: number): { text: string; nextOffset: number; lossy: boolean; spillPath?: string } {
    const start = Math.max(0, Number.isFinite(fromByte) ? fromByte : 0)
    const tailStart = this.total - this.tail.length
    const lossy = start < tailStart
    const offset = lossy ? tailStart : start
    const local = this.tail.subarray(Math.max(0, offset - tailStart))
    return {
      text: local.toString('utf8'),
      nextOffset: this.total,
      lossy,
      ...(lossy && this.spillPath !== undefined && this.finished && this.spillReady ? { spillPath: this.spillPath } : {}),
    }
  }
}
