/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import * as os from 'node:os'
import { nativeHelperService } from '../native-helper-service'
import { PerformanceMode } from './MemoryAccelerator'

/**
 * Engine tuning that follows the app-wide performance mode. The renderer folds
 * these into the AIME configuration whenever a model is loaded.
 */
export interface InferenceOptimization {
    flashAttention: boolean
    batchSize: number
    /** 0 lets the engine use every performance core. */
    threads: number
    /** Draft-model speculative decoding (still subject to family and RAM checks). */
    useSpeculativeDecoding: boolean
}

/**
 * ComputeAccelerator
 *
 * Optimizes CPU/GPU intensive tasks, specifically LLM inference
 * and heavy process management.
 */
export class ComputeAccelerator {
    private mode: PerformanceMode = PerformanceMode.BALANCED
    private isNativeSupported: boolean = false

    constructor() {
        this.isNativeSupported = nativeHelperService.isAvailable()
    }

    public setPerformanceMode(mode: PerformanceMode) {
        this.mode = mode
        this.applyProcessPriorities()
    }

    /**
     * Adjusts this process's OS priority to match the mode.
     * Windows priority classes are freely reversible. Unix niceness can only
     * be lowered — restoring it needs privileges — so on macOS/Linux only
     * attempts to *raise* priority are made (a failed raise leaves the current
     * priority); power saving there comes from threads/batch/draft tuning
     * instead. The macOS native helper propagates the hint to its children.
     */
    private applyProcessPriorities(): void {
        const p = os.constants.priority
        const target = this.mode === PerformanceMode.HIGH_PERFORMANCE
            ? p.PRIORITY_HIGH
            : this.mode === PerformanceMode.POWER_SAVER
                ? p.PRIORITY_LOW
                : p.PRIORITY_NORMAL
        try {
            const current = os.getPriority(process.pid)
            if (process.platform === 'win32' || target < current) {
                os.setPriority(process.pid, target)
            }
        } catch {
            // Raising priority needs privileges; keep the current priority.
        }
        if (this.isNativeSupported) {
            nativeHelperService
                .request('process:set-priority', { priority: target === p.PRIORITY_HIGH ? 'high' : 'normal' })
                .catch(() => undefined)
        }
    }

    /**
     * LLM inference tuning for the current performance mode.
     */
    public getInferenceOptimization(): InferenceOptimization {
        switch (this.mode) {
            case PerformanceMode.HIGH_PERFORMANCE:
                // Everything the hardware can give: full-core threads and a
                // large prompt-eval batch.
                return { flashAttention: true, batchSize: 512, threads: 0, useSpeculativeDecoding: true }
            case PerformanceMode.POWER_SAVER:
                // Half the cores, small batches and no draft model: less heat
                // and lower peak power on batteries.
                return { flashAttention: true, batchSize: 128, threads: Math.max(2, Math.floor(os.cpus().length / 2)), useSpeculativeDecoding: false }
            default:
                return { flashAttention: true, batchSize: 256, threads: 0, useSpeculativeDecoding: true }
        }
    }

    /**
     * Offloads heavy computation to the native helper if possible.
     */
    public async runNativeTask(taskName: string, params: any) {
        if (this.isNativeSupported) {
            return nativeHelperService.request(`compute:${taskName}`, params)
        }
        throw new Error('Native compute acceleration not available')
    }

    /**
     * Optimizes IPC communication by determining if updates should be throttled.
     */
    public shouldThrottleUpdate(lastUpdate: number, type: string): boolean {
        const now = Date.now()
        const elapsed = now - lastUpdate

        if (this.mode === PerformanceMode.POWER_SAVER) {
            return elapsed < 200 // Max 5 FPS for UI updates
        }

        if (type === 'terminal' || type === 'monitor') {
            return elapsed < 50 // 20 FPS
        }

        return false
    }
}
