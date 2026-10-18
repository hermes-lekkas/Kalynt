/**
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * IPC for local models. The engine (loading, generation, disposal) is in
 * ./llm/engine.ts; CoreML models on macOS go through the native helper.
 * The AIME MemoryGuard (services/memoryGuard.ts) frees the model when the
 * system runs low on memory or the model sits idle; the renderer hears
 * about it through `llm:unloaded`.
 */
import path from 'path'
import fs from 'fs'
import type { BrowserWindow as BrowserWindowType } from 'electron'
import { nativeHelperService } from '../services/native-helper-service'
import { memoryGuard } from '../services/memoryGuard'
import { validatePath } from '../utils/pathValidator'
import * as engine from './llm/engine'

interface AimeLoadConfig {
    gpuLayers?: number
    useMemoryMapping?: boolean
    flashAttention?: boolean
    batchSize?: number
    threads?: number
    autoContextCap?: boolean
    reservedMB?: number
    emergencyUnload?: boolean
    idleUnloadMinutes?: number
}

interface LoadModelOptions {
    modelId: string
    path: string
    contextLength: number
    expectedSizeBytes?: number
    aimeConfig?: AimeLoadConfig
}

let nativeModelId: string | null = null
let broadcast: ((channel: string, data?: unknown) => void) | null = null

/** Turns engine errors into something a person can act on. */
function friendlyError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error)
    if (/Cannot find module|AI engine files are missing/.test(message)) return 'The AI engine is not installed correctly. Please reinstall Kalynt.'
    if (/AVX|instruction/i.test(message)) return 'This CPU lacks instructions the AI engine needs (AVX2). Try a different machine or model.'
    if (/InsufficientMemory|out of memory|OOM|allocat|OutOfDeviceMemory|too large for the available resources|Not enough memory/i.test(message)) {
        return 'Not enough memory for this model. Close other apps, choose a smaller model or lower the context size.'
    }
    if (/gguf|magic|invalid model/i.test(message)) return 'The model file is damaged. Delete it and download it again.'
    if (/assert|NaN/.test(message)) return 'The model produced invalid numbers. Its weights or quantization may be broken; try another model.'
    return message
}

function checkModelFile(file: string, expectedSizeBytes?: number): string | null {
    if (!fs.existsSync(file)) return `Model file not found: ${path.basename(file)}`
    const size = fs.statSync(file).size
    if (size < 1024 * 1024) return 'The model file is too small to be valid. Download it again.'
    if (expectedSizeBytes && size < expectedSizeBytes * 0.9) {
        const mb = (n: number) => (n / 1024 / 1024).toFixed(0)
        return `The model file is incomplete (${mb(size)} of about ${mb(expectedSizeBytes)} MB). Delete it and download it again.`
    }
    return null
}

/** Hooks the MemoryGuard to the engine and tells the renderer when it acted. */
function armMemoryGuard(aime: AimeLoadConfig | undefined): void {
    memoryGuard.configure(
        {
            isModelActive: () => nativeModelId === null && engine.currentModelId() !== null,
            isGenerating: engine.isGenerating,
            unload: async reason => {
                await engine.unloadModel()
                broadcast?.('llm:unloaded', { reason })
                // Give the rest of the app the same memory-pressure signal the
                // performance system uses, so indexing and other background
                // work pauses too.
                if (reason === 'low-memory') broadcast?.('performance:suspend-background-tasks')
            }
        },
        {
            reservedMB: aime?.emergencyUnload === false ? 0 : aime?.reservedMB,
            idleUnloadMinutes: aime?.idleUnloadMinutes
        }
    )
    memoryGuard.start()
}

export function registerLLMInferenceHandlers(
    ipcMain: Electron.IpcMain,
    getModelsDir: () => string,
    getMainWindow: () => BrowserWindowType | null
) {
    broadcast = (channel, data) => {
        const win = getMainWindow()
        if (win && !win.isDestroyed()) win.webContents.send(channel, data ?? {})
    }

    ipcMain.handle('load-model', async (_event, options: LoadModelOptions) => {
        try {
            const modelPath = validatePath(getModelsDir(), path.basename(options.path))

            if (/\.mlmodelc?$/.test(modelPath) && process.platform === 'darwin' && nativeHelperService.isAvailable()) {
                const result = await nativeHelperService.request('llm-load', { path: modelPath })
                if (result.success) {
                    await engine.unloadModel()
                    memoryGuard.stop()
                    nativeModelId = options.modelId
                    return { success: true, native: true }
                }
            }

            const problem = checkModelFile(modelPath, options.expectedSizeBytes)
            if (problem) return { success: false, error: problem }

            nativeModelId = null
            armMemoryGuard(options.aimeConfig)
            const info = await engine.loadModel({
                modelId: options.modelId,
                modelPath,
                contextLength: options.contextLength,
                gpuLayers: options.aimeConfig?.gpuLayers,
                useMemoryMapping: options.aimeConfig?.useMemoryMapping,
                flashAttention: options.aimeConfig?.flashAttention,
                autoContextCap: options.aimeConfig?.autoContextCap,
                reservedMB: options.aimeConfig?.reservedMB,
                batchSize: options.aimeConfig?.batchSize,
                threads: options.aimeConfig?.threads
            })
            broadcast?.('llm:loaded', { modelId: options.modelId, ...info })
            return { success: true, ...info }
        } catch (error) {
            console.error('[LLM] Load failed:', error)
            return { success: false, error: friendlyError(error) }
        }
    })

    ipcMain.handle('unload-model', async () => {
        nativeModelId = null
        memoryGuard.stop()
        await engine.unloadModel()
        return { success: true }
    })

    ipcMain.handle('load-draft-model', async (_event, options: { modelId: string; path: string }) => {
        try {
            const modelPath = validatePath(getModelsDir(), path.basename(options.path))
            const problem = checkModelFile(modelPath)
            if (problem) return { success: false, error: problem }
            await engine.loadDraftModel(options.modelId, modelPath)
            return { success: true }
        } catch (error) {
            return { success: false, error: `Couldn't load the draft model: ${friendlyError(error)}` }
        }
    })

    ipcMain.handle('unload-draft-model', async () => {
        await engine.unloadDraftModel()
        return { success: true }
    })

    ipcMain.handle('get-draft-model-status', async () => ({
        success: true,
        loaded: engine.draftModelId() !== null,
        modelId: engine.draftModelId()
    }))

    ipcMain.handle('get-model-status', async () => ({
        success: true,
        loaded: engine.currentModelId() !== null,
        modelId: engine.currentModelId(),
        generating: engine.isGenerating()
    }))

    const nativeGenerate = async (prompt: string, maxTokens?: number) => {
        const result = await nativeHelperService.request('llm-predict', { prompt, maxTokens })
        return String(result.text ?? '')
    }

    ipcMain.handle('generate-completion', async (_event, options: engine.GenerateOptions & { requestId?: string }) => {
        try {
            if (nativeModelId && nativeHelperService.isAvailable()) {
                return { success: true, text: await nativeGenerate(options.prompt, options.maxTokens) }
            }
            const { text } = await engine.generate(options.requestId ?? `once-${Date.now()}-${Math.random()}`, options)
            return { success: true, text: text.trim() }
        } catch (error) {
            return { success: false, error: friendlyError(error) }
        }
    })

    // Streams tokens to the sender; always ends with one generate-completion-complete.
    ipcMain.on('generate-completion-stream', async (event, options: engine.GenerateOptions & { requestId: string }) => {
        const { requestId } = options
        const send = (channel: string, data: unknown) => {
            if (!event.sender.isDestroyed()) event.sender.send(channel, data)
        }
        try {
            if (nativeModelId && nativeHelperService.isAvailable()) {
                send('generate-completion-token', { requestId, token: await nativeGenerate(options.prompt, options.maxTokens) })
                send('generate-completion-complete', { requestId })
                return
            }
            const { aborted } = await engine.generate(requestId, options, token => send('generate-completion-token', { requestId, token }))
            send('generate-completion-complete', aborted ? { requestId, error: 'Aborted by user' } : { requestId })
        } catch (error) {
            console.error('[LLM] Generation failed:', error)
            send('generate-completion-complete', { requestId, error: friendlyError(error) })
        }
    })

    ipcMain.handle('cancel-generation', async (_event, requestId: string) => {
        return engine.cancelGeneration(requestId) ? { success: true } : { success: false, error: 'Generation not found' }
    })
}

/** Frees the loaded model; called when the app quits. */
export const unloadLocalModel = () => {
    memoryGuard.stop()
    return engine.unloadModel()
}
