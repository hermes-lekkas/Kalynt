/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export type OffloadingStrategy = 'auto' | 'gpu-only' | 'cpu-only' | 'balanced' | 'custom'

export interface HardwareInfo {

    cpuCores: number
    cpuThreads: number
    cpuModel: string

    totalRAM: number
    availableRAM: number
    usedRAM: number

    hasGPU: boolean
    gpuName?: string
    totalVRAM?: number
    availableVRAM?: number

    totalDiskSpace: number
    availableDiskSpace: number
}

export interface AIMEConfig {
    /** Use the flash-attention kernel: a bit faster and a bit less memory. */
    flashAttention: boolean

    offloadingStrategy: OffloadingStrategy
    /** Layers on the GPU when the strategy is "custom". */
    gpuLayers: number

    /** Shrink the context to what fits in free memory when the model loads. */
    autoContextCap: boolean
    /** Upper bound on the context, in tokens. */
    maxContextTokens: number
    useMemoryMapping: boolean

    batchSize: number
    /** 0 lets the engine use every performance core. */
    threads: number

    /** Memory to keep free for the system; the MemoryGuard unloads the model below it. */
    reservedRAM: number
    /** Unload the model when free memory drops under `reservedRAM`. */
    emergencyUnload: boolean
    /** Unload the model after this many idle minutes; 0 keeps it loaded. */
    idleUnloadMinutes: number
}

export const DEFAULT_AIME_CONFIG: AIMEConfig = {
    flashAttention: true,
    offloadingStrategy: 'auto',
    gpuLayers: 0,
    autoContextCap: true,
    maxContextTokens: 8192,
    useMemoryMapping: true,
    batchSize: 512,
    threads: 0,
    reservedRAM: 512,
    emergencyUnload: true,
    idleUnloadMinutes: 0
}

export interface AIMEPreset {
    name: string
    description: string
    config: AIMEConfig
}

export const AIME_PRESETS: AIMEPreset[] = [
    {
        name: 'Maximum Quality',
        description: 'No caps: the full model context and no automatic unloading. For systems with 16GB+ RAM.',
        config: {
            flashAttention: true,
            offloadingStrategy: 'gpu-only',
            gpuLayers: 999,
            autoContextCap: false,
            maxContextTokens: 32768,
            useMemoryMapping: false,
            batchSize: 512,
            threads: 0,
            reservedRAM: 2048,
            emergencyUnload: false,
            idleUnloadMinutes: 0
        }
    },
    {
        name: 'Balanced',
        description: 'Good balance of quality and efficiency. For systems with 8-12GB RAM.',
        config: {
            flashAttention: true,
            offloadingStrategy: 'balanced',
            gpuLayers: 16,
            autoContextCap: true,
            maxContextTokens: 8192,
            useMemoryMapping: true,
            batchSize: 512,
            threads: 0,
            reservedRAM: 1024,
            emergencyUnload: true,
            idleUnloadMinutes: 15
        }
    },
    {
        name: 'Maximum Efficiency',
        description: 'Lowest RAM usage, good for limited systems. For 4-6GB RAM.',
        config: {
            flashAttention: true,
            offloadingStrategy: 'cpu-only',
            gpuLayers: 0,
            autoContextCap: true,
            maxContextTokens: 4096,
            useMemoryMapping: true,
            batchSize: 256,
            threads: 0,
            reservedRAM: 768,
            emergencyUnload: true,
            idleUnloadMinutes: 5
        }
    },
    {
        name: 'Small Model Speed',
        description: 'Optimized for fast responses with small models (<7B). Prioritizes speed over context.',
        config: {
            flashAttention: true,
            offloadingStrategy: 'cpu-only',
            gpuLayers: 0,
            autoContextCap: true,
            maxContextTokens: 2048,
            useMemoryMapping: true,
            batchSize: 128,
            threads: 0,
            reservedRAM: 512,
            emergencyUnload: true,
            idleUnloadMinutes: 10
        }
    },
    {
        name: 'GPU Accelerated',
        description: 'Maximum speed with GPU acceleration. Requires CUDA/Metal compatible GPU.',
        config: {
            flashAttention: true,
            offloadingStrategy: 'gpu-only',
            gpuLayers: 999,
            autoContextCap: true,
            maxContextTokens: 8192,
            useMemoryMapping: false,
            batchSize: 512,
            threads: 0,
            reservedRAM: 1024,
            emergencyUnload: true,
            idleUnloadMinutes: 15
        }
    }
]

/**
 * Estimates the RAM a model needs, in MB: the weights plus the KV cache the
 * context will allocate (about 12 KB per token per GB of model file, measured
 * on Qwen-class GQA models) plus compute buffers.
 */
export function calculateAIMERAMUsage(
    modelSizeMB: number,
    contextTokens: number,
    flashAttention: boolean
): number {
    const weights = modelSizeMB
    const kvPerTokenMB = modelSizeMB / 80_000
    const kvCache = contextTokens * kvPerTokenMB * (flashAttention ? 0.9 : 1)
    const compute = modelSizeMB * 0.08
    return Math.ceil(weights + kvCache + compute)
}

export function recommendAIMESettings(hardware: HardwareInfo): AIMEConfig {
    const availRAM = hardware.availableRAM
    const hasGPU = hardware.hasGPU

    if (availRAM < 6144) {
        return {
            flashAttention: true,
            offloadingStrategy: 'cpu-only',
            gpuLayers: 0,
            autoContextCap: true,
            maxContextTokens: 2048,
            useMemoryMapping: true,
            batchSize: 256,
            threads: 0,
            reservedRAM: 512,
            emergencyUnload: true,
            idleUnloadMinutes: 5
        }
    }

    if (availRAM < 12288) {
        return {
            flashAttention: true,
            offloadingStrategy: hasGPU ? 'balanced' : 'cpu-only',
            gpuLayers: hasGPU ? 16 : 0,
            autoContextCap: true,
            maxContextTokens: 8192,
            useMemoryMapping: true,
            batchSize: 512,
            threads: 0,
            reservedRAM: 1024,
            emergencyUnload: true,
            idleUnloadMinutes: 15
        }
    }

    return {
        flashAttention: true,
        offloadingStrategy: hasGPU ? 'auto' : 'cpu-only',
        gpuLayers: hasGPU ? 32 : 0,
        autoContextCap: true,
        maxContextTokens: 16384,
        useMemoryMapping: true,
        batchSize: 512,
        threads: 0,
        reservedRAM: 2048,
        emergencyUnload: true,
        idleUnloadMinutes: 0
    }
}

/**
 * Model size categories for AIME optimization
 */
export type ModelSizeCategory = 'tiny' | 'small' | 'medium' | 'large'

/**
 * Detect model size category from model ID
 */
export function detectModelSizeCategory(modelId: string): ModelSizeCategory {
    const lower = modelId.toLowerCase()

    // Tiny: <3B parameters
    if (/1\.5b|1b|0\.5b|500m|tiny/.test(lower)) return 'tiny'

    // Small: 3B-7B parameters
    if (/3b|4b|7b/.test(lower)) return 'small'

    // Medium: 8B-24B parameters
    if (/8b|13b|14b|24b/.test(lower)) return 'medium'

    // Large: 32B+
    return 'large'
}
