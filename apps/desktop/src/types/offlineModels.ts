/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
// Offline LLM Model Types and Configurations
// New Apache 2.0 Licensed Models for IDE Development (2026)

import { TierType } from '../stores/appStore'

/**
 * Offline model quality rating
 */
export type ModelQuality = 1 | 2 | 3 | 4 | 5

/**
 * Download status for a model
 */
export type DownloadStatus = 'not_downloaded' | 'downloading' | 'paused' | 'downloaded' | 'error'

/**
 * Model capability levels
 * - chat: Can only chat and answer questions (smallest models)
 * - read: Can chat + read files (small models)
 * - write: Can chat + read + write files (medium models)
 * - full: All capabilities including code execution (large models)
 */
export type ModelCapabilityLevel = 'chat' | 'read' | 'write' | 'full'

/**
 * Detailed model capabilities
 */
export interface ModelCapabilities {
    level: ModelCapabilityLevel
    canReadFiles: boolean
    canWriteFiles: boolean
    canExecuteCode: boolean
    canRunCommands: boolean
    maxContextForSpeed: number  // Recommended context for fast responses
    supportsToolCalling: boolean
}

/**
 * Configuration for an offline LLM model
 */
export interface OfflineModel {
    id: string
    name: string
    description: string
    size: string              // Human readable, e.g., "2.1 GB"
    sizeBytes: number         // Actual size in bytes
    ramRequired: string       // Human readable, e.g., "4 GB"
    ramRequiredMB: number     // RAM in MB
    quality: ModelQuality     // 1-5 star rating
    downloadUrl: string       // Hugging Face URL
    filename: string          // Local filename
    minTier: TierType         // Minimum tier required
    tierIndex: number         // 1-5, for tier counting
    contextLength: number     // Max context in tokens
    promptTemplate: string    // Chat prompt format
    role?: string             // Role in IDE (e.g., "The Flagship Agent")
    capabilities: ModelCapabilities  // What the model can do
}

/**
 * State of a downloaded model
 */
export interface DownloadedModel {
    id: string
    path: string              // Full path to file
    downloadedAt: number      // Timestamp
    sizeBytes: number         // Verified size
    verified: boolean         // Hash verified
}

/**
 * Download progress state
 */
export interface DownloadProgress {
    modelId: string
    status: DownloadStatus
    bytesDownloaded: number
    totalBytes: number
    speed: number             // bytes/second
    eta: number               // seconds remaining
    error?: string
}

// ============================================
// Prompt Templates for New Model Families
// ============================================

// Qwen2.5-Coder uses ChatML format
const QWEN_TEMPLATE = '<|im_start|>system\n{system}<|im_end|>\n<|im_start|>user\n{user}<|im_end|>\n<|im_start|>assistant\n'

// Devstral uses Mistral instruction format
const DEVSTRAL_TEMPLATE = '<s>[INST] {system}\n\n{user} [/INST]'

/**
 * Available offline models - Top 5 Coding Agent Models (2026)
 * Ordered by tier/complexity: smallest to largest
 *
 * Model Lineup:
 * 1. Qwen2.5-Coder 1.5B Q8 - Fast autocomplete (1.7GB, 4GB RAM)
 * 2. Qwen2.5-Coder 7B Q4_K_M - Balanced performance (4.68GB, 8GB RAM)
 * 3. Qwen3-4B-Thinking-2507 Q5_K_XL - Extended reasoning (2.9GB, 6GB RAM) [NEW]
 * 4. Qwen2.5-Coder 7B Q8 - High quality agent (7.7GB, 12GB RAM)
 * 5. Devstral Small 2 24B - Repo architect (14.3GB, 20GB RAM)
 * 6. Qwen2.5-Coder 14B - Flagship model (9GB, 16GB RAM)
 */
export const OFFLINE_MODELS: OfflineModel[] = [
    // 0. The Nano Assistant - Qwen2.5-Coder-0.5B (Ultra-Fast Draft)
    {
        id: 'qwen2.5-coder-0.5b',
        name: 'Qwen2.5-Coder 0.5B',
        description: 'Ultra-lightweight model for speculative decoding. Installs irrelevant of VRAM. Best used as a "Draft Model" to accelerate larger models.',
        size: '0.7 GB',
        sizeBytes: 700_000_000,
        ramRequired: '1.5 GB',
        ramRequiredMB: 1536,
        quality: 2,
        downloadUrl: 'https://huggingface.co/Qwen/Qwen2.5-Coder-0.5B-Instruct-GGUF/resolve/main/qwen2.5-coder-0.5b-instruct-q8_0.gguf',
        filename: 'qwen2.5-coder-0.5b-instruct-q8_0.gguf',
        minTier: 'starter',
        tierIndex: 0,
        contextLength: 32768,
        promptTemplate: QWEN_TEMPLATE,
        role: 'The Draft Specialist',
        capabilities: {
            level: 'read',
            canReadFiles: true,
            canWriteFiles: false,
            canExecuteCode: false,
            canRunCommands: false,
            maxContextForSpeed: 1024,
            supportsToolCalling: false
        }
    },
    // 1. The Autocomplete - Qwen2.5-Coder-1.5B (Ghost-Text Engine)
    {
        id: 'qwen2.5-coder-1.5b',
        name: 'Qwen2.5-Coder 1.5B',
        description: 'Fast chat assistant for code discussions. Can read files and answer questions. Note: Cannot edit files or execute code - use larger models for those tasks.',
        size: '1.6 GB',
        sizeBytes: 1_600_000_000,
        ramRequired: '4 GB',
        ramRequiredMB: 4096,
        quality: 3,
        downloadUrl: 'https://huggingface.co/ggml-org/Qwen2.5-Coder-1.5B-Instruct-Q8_0-GGUF/resolve/main/qwen2.5-coder-1.5b-instruct-q8_0.gguf',
        filename: 'qwen2.5-coder-1.5b-instruct-q8_0.gguf',
        minTier: 'starter',
        tierIndex: 1,
        contextLength: 32768,
        promptTemplate: QWEN_TEMPLATE,
        role: 'The Chat Assistant',
        capabilities: {
            level: 'read',
            canReadFiles: true,
            canWriteFiles: false,
            canExecuteCode: false,
            canRunCommands: false,
            maxContextForSpeed: 2048,
            supportsToolCalling: false  // Limited tool calling ability
        }
    },
    // 2. The Balanced Model - Qwen2.5-Coder-7B Q4_K_M (RAM-Efficient)
    {
        id: 'qwen2.5-coder-7b-q4',
        name: 'Qwen2.5-Coder 7B Q4_K_M',
        description: 'RAM-efficient coding assistant. Can read files and provide suggestions. Good for code discussions and analysis. Uses 40% less RAM than Q8 version.',
        size: '4.68 GB',
        sizeBytes: 4_680_000_000,
        ramRequired: '8 GB',
        ramRequiredMB: 8192,
        quality: 4,
        downloadUrl: 'https://huggingface.co/Qwen/Qwen2.5-Coder-7B-Instruct-GGUF/resolve/main/qwen2.5-coder-7b-instruct-q4_k_m.gguf',
        filename: 'qwen2.5-coder-7b-instruct-q4_k_m.gguf',
        minTier: 'starter',
        tierIndex: 2,
        contextLength: 128000,
        promptTemplate: QWEN_TEMPLATE,
        role: 'The Balanced Model',
        capabilities: {
            level: 'read',
            canReadFiles: true,
            canWriteFiles: false,
            canExecuteCode: false,
            canRunCommands: false,
            maxContextForSpeed: 4096,
            supportsToolCalling: true
        }
    },
    // 3. The Reasoning Model - Qwen3-4B-Thinking-2507 (Extended Reasoning Specialist)
    {
        id: 'qwen3-4b-thinking',
        name: 'Qwen3-4B-Thinking-2507 Q5_K_XL',
        description: 'Reasoning specialist for complex problem-solving. Uses step-by-step thinking for code analysis. Can read files and provide detailed explanations. Best for understanding complex code.',
        size: '2.9 GB',
        sizeBytes: 2_900_000_000,
        ramRequired: '6 GB',
        ramRequiredMB: 6144,
        quality: 4,
        downloadUrl: 'https://huggingface.co/unsloth/Qwen3-4B-Thinking-2507-GGUF/resolve/main/Qwen3-4B-Thinking-2507-UD-Q5_K_XL.gguf',
        filename: 'Qwen3-4B-Thinking-2507-UD-Q5_K_XL.gguf',
        minTier: 'starter',
        tierIndex: 3,
        contextLength: 262144,  // 256K native context with YaRN extension
        promptTemplate: QWEN_TEMPLATE,
        role: 'The Reasoning Model',
        capabilities: {
            level: 'read',
            canReadFiles: true,
            canWriteFiles: false,
            canExecuteCode: false,
            canRunCommands: false,
            maxContextForSpeed: 4096,
            supportsToolCalling: true
        }
    },
    // 4. The Agent - Qwen2.5-Coder-7B Q8 (Tool-Calling Specialist)
    {
        id: 'qwen2.5-coder-7b',
        name: 'Qwen2.5-Coder 7B Q8',
        description: 'Full-featured coding agent. Can read, write, and edit files. Strong tool-calling abilities for agentic coding. Higher quality Q8 quantization. (SWE-bench: 47%)',
        size: '8.1 GB',
        sizeBytes: 8_100_000_000,
        ramRequired: '12 GB',
        ramRequiredMB: 12288,
        quality: 5,
        downloadUrl: 'https://huggingface.co/Qwen/Qwen2.5-Coder-7B-Instruct-GGUF/resolve/main/qwen2.5-coder-7b-instruct-q8_0.gguf',
        filename: 'qwen2.5-coder-7b-instruct-q8_0.gguf',
        minTier: 'starter',
        tierIndex: 4,
        contextLength: 128000,
        promptTemplate: QWEN_TEMPLATE,
        role: 'The Agent',
        capabilities: {
            level: 'full',
            canReadFiles: true,
            canWriteFiles: true,
            canExecuteCode: true,
            canRunCommands: true,
            maxContextForSpeed: 8192,
            supportsToolCalling: true
        }
    },
    // 5. The Repo Architect - Devstral Small 2 24B (Agentic Coding Specialist)
    {
        id: 'devstral-small-2-24b',
        name: 'Devstral Small 2 24B',
        description: 'Professional coding agent from Mistral AI. Full IDE capabilities with 128K context. Optimized for software engineering. (SWE-bench: 68%)',
        size: '14.3 GB',
        sizeBytes: 14_330_000_000,
        ramRequired: '20 GB',
        ramRequiredMB: 20480,
        quality: 4,
        downloadUrl: 'https://huggingface.co/bartowski/mistralai_Devstral-Small-2-24B-Instruct-2512-GGUF/resolve/main/mistralai_Devstral-Small-2-24B-Instruct-2512-Q4_K_M.gguf',
        filename: 'devstral-small-2-24b-instruct.Q4_K_M.gguf',
        minTier: 'starter',
        tierIndex: 5,
        contextLength: 131072,  // 128K practical limit (model supports 256K)
        promptTemplate: DEVSTRAL_TEMPLATE,
        role: 'The Repo Architect',
        capabilities: {
            level: 'full',
            canReadFiles: true,
            canWriteFiles: true,
            canExecuteCode: true,
            canRunCommands: true,
            maxContextForSpeed: 16384,
            supportsToolCalling: true
        }
    },
    // 6. The Flagship Agent - Qwen2.5-Coder-14B (The Brain)
    {
        id: 'qwen2.5-coder-14b',
        name: 'Qwen2.5-Coder-14B',
        description: 'Flagship coding agent. Full IDE control with 128K context for indexing entire projects. Best for complex coding tasks. (SWE-bench: 47%)',
        size: '9.0 GB',
        sizeBytes: 9_000_000_000,
        ramRequired: '16 GB',
        ramRequiredMB: 16384,
        quality: 5,
        downloadUrl: 'https://huggingface.co/lmstudio-community/Qwen2.5-Coder-14B-Instruct-GGUF/resolve/main/Qwen2.5-Coder-14B-Instruct-Q4_K_M.gguf',
        filename: 'Qwen2.5-Coder-14B-Instruct-Q4_K_M.gguf',
        minTier: 'starter',
        tierIndex: 6,
        contextLength: 128000,
        promptTemplate: QWEN_TEMPLATE,
        role: 'The Flagship Agent',
        capabilities: {
            level: 'full',
            canReadFiles: true,
            canWriteFiles: true,
            canExecuteCode: true,
            canRunCommands: true,
            maxContextForSpeed: 16384,
            supportsToolCalling: true
        }
    },
    // 7. The Architect - Qwen2-72B-Instruct (72B Parameter Beast)
    {
        id: 'qwen2-72b-instruct',
        name: 'Qwen2 72B Instruct',
        description: 'Massive 72B parameter model with exceptional coding capabilities. 128K context window for entire codebase understanding. Full agent capabilities including advanced tool calling. Requires 64GB+ RAM.',
        size: '47.4 GB',
        sizeBytes: 47_400_000_000,
        ramRequired: '64 GB',
        ramRequiredMB: 65536,
        quality: 5,
        downloadUrl: 'https://huggingface.co/Qwen/Qwen2-72B-Instruct-GGUF/resolve/main/qwen2-72b-instruct-q4_k_m.gguf',
        filename: 'qwen2-72b-instruct-q4_k_m.gguf',
        minTier: 'starter',
        tierIndex: 7,
        contextLength: 131072,
        promptTemplate: QWEN_TEMPLATE,
        role: 'The Architect',
        capabilities: {
            level: 'full',
            canReadFiles: true,
            canWriteFiles: true,
            canExecuteCode: true,
            canRunCommands: true,
            maxContextForSpeed: 32768,
            supportsToolCalling: true
        }
    }
]

/**
 * Get model by ID
 */
export function getModelById(id: string): OfflineModel | undefined {
    return OFFLINE_MODELS.find(m => m.id === id)
}

/**
 * Get model capabilities by ID
 */
export function getModelCapabilities(id: string): ModelCapabilities | undefined {
    const model = getModelById(id)
    return model?.capabilities
}

/**
 * Check if a model can perform a specific action
 */
export function canModelPerformAction(
    modelId: string,
    action: 'read' | 'write' | 'execute' | 'command'
): boolean {
    const caps = getModelCapabilities(modelId)
    if (!caps) return false

    switch (action) {
        case 'read': return caps.canReadFiles
        case 'write': return caps.canWriteFiles
        case 'execute': return caps.canExecuteCode
        case 'command': return caps.canRunCommands
        default: return false
    }
}

/**
 * Check if a model is considered "small" (read-only capabilities)
 */
export function isReadOnlyModel(modelId: string): boolean {
    const caps = getModelCapabilities(modelId)
    if (!caps) return true  // Default to restricted if unknown
    return caps.level === 'chat' || caps.level === 'read'
}

/**
 * Get models available for a tier
 * BETA v1: All models are free and available to all tiers
 */
export function getModelsForTier(_tier: TierType): OfflineModel[] {
    // Beta v1: Return all models for all tiers (tier parameter unused)
    return OFFLINE_MODELS
}

/**
 * Check if a model is available for a tier
 */
export function isModelAvailableForTier(modelId: string, tier: TierType): boolean {
    const model = getModelById(modelId)
    if (!model) return false

    const availableModels = getModelsForTier(tier)
    return availableModels.some(m => m.id === modelId)
}

/**
 * Format bytes to human readable string
 */
export function formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B'
    const k = 1024
    const sizes = ['B', 'KB', 'MB', 'GB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return Number.parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i]
}

/**
 * Format ETA to human readable string
 */
export function formatETA(seconds: number): string {
    if (seconds < 60) return `${Math.round(seconds)}s`
    if (seconds < 3600) return `${Math.round(seconds / 60)}m`
    return `${Math.round(seconds / 3600)}h ${Math.round((seconds % 3600) / 60)}m`
}
