/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * AIME MemoryGuard: watches system memory while a local model is loaded and
 * frees it before the machine starts swapping, plus unloads models that have
 * been idle long enough. The renderer is told through LLM events.
 */
import fs from 'fs'
import os from 'os'

export interface MemorySnapshot {
    /** Bytes the system can hand out before it starts swapping. */
    available: number
    total: number
}

/** Prefer MemAvailable (includes reclaimable cache); fall back to freemem. */
export function readMemorySnapshot(): MemorySnapshot {
    if (process.platform === 'linux') {
        try {
            const info = fs.readFileSync('/proc/meminfo', 'utf8')
            const available = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(info)
            const total = /^MemTotal:\s+(\d+)\s+kB$/m.exec(info)
            if (available && total) {
                return { available: Number(available[1]) * 1024, total: Number(total[1]) * 1024 }
            }
        } catch { /* fall through */ }
    }
    return { available: os.freemem(), total: os.totalmem() }
}

export type UnloadReason = 'low-memory' | 'idle'

export interface MemoryGuardHooks {
    /** True while a model occupies memory. */
    isModelActive: () => boolean
    /** True while a generation is running; idle unload never interrupts one. */
    isGenerating: () => boolean
    /** Frees the model (aborting any generation when the system is out of memory). */
    unload: (reason: UnloadReason) => void | Promise<void>
}

const CHECK_INTERVAL_MS = 5000
/** After an emergency unload, wait before considering another. */
const LOW_MEMORY_COOLDOWN_MS = 60_000

class MemoryGuard {
    private hooks: MemoryGuardHooks | null = null
    private timer: NodeJS.Timeout | null = null
    /** Bytes to keep free for the OS and other apps; 0 disables the emergency unload. */
    private reservedBytes = 512 * 1024 * 1024
    /** Unload after this many idle minutes; 0 disables. */
    private idleMinutes = 0
    private lastActivity = Date.now()
    private lastEmergencyUnload = 0
    private lastSnapshot: MemorySnapshot | null = null

    configure(hooks: MemoryGuardHooks, options: { reservedMB?: number; idleUnloadMinutes?: number } = {}): void {
        this.hooks = hooks
        if (options.reservedMB !== undefined) this.reservedBytes = Math.max(0, options.reservedMB) * 1024 * 1024
        if (options.idleUnloadMinutes !== undefined) this.idleMinutes = Math.max(0, options.idleUnloadMinutes)
        this.lastActivity = Date.now()
    }

    start(): void {
        if (this.timer) return
        this.timer = setInterval(() => this.check(), CHECK_INTERVAL_MS)
        // Never keep the process alive just for the guard.
        this.timer.unref?.()
    }

    stop(): void {
        if (this.timer) clearInterval(this.timer)
        this.timer = null
    }

    /** Marks now as the last time the model did something. */
    touch(): void {
        this.lastActivity = Date.now()
    }

    /** Latest reading, for display. */
    snapshot(): MemorySnapshot {
        if (!this.lastSnapshot) this.lastSnapshot = readMemorySnapshot()
        return this.lastSnapshot
    }

    private check(): void {
        const snap = readMemorySnapshot()
        this.lastSnapshot = snap
        if (!this.hooks || !this.hooks.isModelActive()) return

        if (this.reservedBytes > 0 && snap.available < this.reservedBytes) {
            const now = Date.now()
            if (now - this.lastEmergencyUnload < LOW_MEMORY_COOLDOWN_MS) return
            this.lastEmergencyUnload = now
            console.warn(`[MemoryGuard] Only ${(snap.available / 1048576).toFixed(0)} MB free; unloading the model to avoid swapping`)
            void this.hooks.unload('low-memory')
            return
        }

        if (this.idleMinutes > 0 && !this.hooks.isGenerating()) {
            const idleMs = Date.now() - this.lastActivity
            if (idleMs > this.idleMinutes * 60_000) {
                console.warn(`[MemoryGuard] Model idle for ${Math.round(idleMs / 60_000)} min; unloading`)
                void this.hooks.unload('idle')
            }
        }
    }
}

export const memoryGuard = new MemoryGuard()
