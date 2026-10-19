/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * The local model engine (node-llama-cpp). One model and context at a time;
 * generations take turns on the context's single sequence. Unloading aborts
 * running generations and frees the native memory with dispose().
 *
 * Context sizes are chosen against the memory the machine actually has
 * free: the model and context footprints are estimated from the GGUF file
 * and the context is shrunk until both fit under the budget.
 */
import path from 'path'
import fs from 'fs'
import { pathToFileURL } from 'url'
import type { Llama, LlamaModel, LlamaContext, Token } from 'node-llama-cpp'
import { readMemorySnapshot } from '../../services/memoryGuard'
import { memoryGuard } from '../../services/memoryGuard'

type Engine = typeof import('node-llama-cpp')

export interface LoadOptions {
    modelId: string
    modelPath: string
    contextLength: number
    gpuLayers?: number
    useMemoryMapping?: boolean
    flashAttention?: boolean
    batchSize?: number
    threads?: number
    /** Shrink the context to fit the memory the machine has free (default true). */
    autoContextCap?: boolean
    /** Megabytes to keep free for the system when sizing (default 512). */
    reservedMB?: number
}

export interface LoadResult {
    /** Context size actually allocated (may be smaller than requested). */
    contextSize: number
    /** Estimated total CPU memory the model + context will occupy, in MB. */
    estimatedRamMB: number
    /** True when the context had to be reduced to fit in memory. */
    contextCapped: boolean
}

export interface GenerateOptions {
    prompt: string
    maxTokens?: number
    temperature?: number
    topP?: number
    stopSequences?: string[]
    jsonSchema?: object
}

let engine: Engine | null = null
let llama: Llama | null = null
let model: LlamaModel | null = null
let context: LlamaContext | null = null
let loadedModelId: string | null = null
let generating = false
let draft: { id: string; model: LlamaModel; context: LlamaContext } | null = null

const active = new Map<string, AbortController>()
/** Recent warnings and errors from llama.cpp; its own messages explain failed loads. */
const engineLog: string[] = []

function rememberLog(level: string, message: string) {
    if (level === 'error' || level === 'fatal' || level === 'warn') {
        engineLog.push(message.trim())
        if (engineLog.length > 20) engineLog.shift()
    }
    if (level !== 'debug' && level !== 'log' && level !== 'info') console.log(`[node-llama-cpp] ${message.trim()}`)
}

/** Explains a failed load using what llama.cpp logged, when it said something specific. */
function explainLoadFailure(error: unknown): Error {
    const recent = engineLog.join('\n')
    if (/REMOVED/.test(recent)) return new Error('This model uses a quantization format the AI engine no longer supports. Download another version of it, such as Q4_K_M.')
    if (/unknown model architecture/i.test(recent)) return new Error('The AI engine does not support this model\'s architecture yet.')
    const reason = /error loading model: (.+)/.exec(recent)?.[1]
    return reason && /Failed to load model/i.test(String((error as Error)?.message)) ? new Error(`Couldn't load the model: ${reason}`) : error as Error
}

let turn: Promise<unknown> = Promise.resolve()

/** Runs `fn` after everything queued before it; generations and loads never overlap. */
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = turn.then(fn, fn)
    turn = run.catch(() => undefined)
    return run
}

async function importEngine(): Promise<Engine> {
    if (engine) return engine
    // Packaged builds ship node-llama-cpp outside the asar archive.
    const packaged = !process.defaultApp && process.resourcesPath
        ? path.join(process.resourcesPath, 'node_modules', 'node-llama-cpp')
        : null
    if (packaged && !fs.existsSync(packaged)) throw new Error('AI engine files are missing. Please reinstall the application.')
    engine = await import(packaged ? pathToFileURL(path.join(packaged, 'dist', 'index.js')).href : 'node-llama-cpp') as Engine
    return engine
}

export const currentModelId = () => loadedModelId
export const isGenerating = () => generating
export const draftModelId = () => draft?.id ?? null

async function disposeDraft() {
    const old = draft
    draft = null
    await old?.context.dispose().catch(() => undefined)
    await old?.model.dispose().catch(() => undefined)
}

async function disposeModel() {
    await disposeDraft()
    const [oldContext, oldModel] = [context, model]
    context = null
    model = null
    loadedModelId = null
    await oldContext?.dispose().catch(() => undefined)
    await oldModel?.dispose().catch(() => undefined)
}

/** Aborts running generations, then frees the model, its context and any draft model. */
export async function unloadModel(): Promise<void> {
    for (const controller of active.values()) controller.abort()
    await exclusive(disposeModel)
}

/**
 * Picks the largest context size whose estimated footprint fits the memory
 * budget. The context cost grows linearly with its size, so two estimates
 * pin the line and the budget is solved directly.
 */
function fitContextToBudget(
    estimate: (contextSize: number) => { cpuRam: number },
    budgetBytes: number,
    maxContext: number
): { contextSize: number; capped: boolean } {
    const minEstimate = estimate(512).cpuRam
    const maxEstimate = estimate(maxContext).cpuRam
    if (maxEstimate <= budgetBytes) return { contextSize: maxContext, capped: false }

    const perToken = maxContext > 512 ? (maxEstimate - minEstimate) / (maxContext - 512) : 0
    if (perToken <= 0) return { contextSize: 512, capped: true }

    const fit = Math.floor((budgetBytes - minEstimate) / perToken) + 512
    // Verify the linear model against the real estimator, then settle.
    const verified = estimate(Math.max(512, fit)).cpuRam <= budgetBytes ? fit : Math.floor(fit * budgetBytes / estimate(Math.max(512, fit)).cpuRam)
    return { contextSize: Math.max(512, Math.min(maxContext, verified)), capped: true }
}

export function loadModel(options: LoadOptions): Promise<LoadResult> {
    for (const controller of active.values()) controller.abort()
    return exclusive(async () => {
        await disposeModel()
        engineLog.length = 0
        const { getLlama } = await importEngine()
        if (!llama) {
            const { LlamaLogLevel } = await importEngine()
            llama = await getLlama({ logLevel: LlamaLogLevel.warn, logger: rememberLog })
            const vram = await llama.getVramState().catch(() => null)
            console.log(`[LLM] Backend: ${llama.gpu || 'cpu'}${vram ? `, VRAM free ${(vram.free / 2 ** 30).toFixed(1)} of ${(vram.total / 2 ** 30).toFixed(1)} GiB` : ''}`)
        }
        const gpuLayers = options.gpuLayers ?? 0
        model = await llama.loadModel({ modelPath: options.modelPath, gpuLayers, useMmap: options.useMemoryMapping ?? true })

        const tiny = /1\.5b|\b1b|0\.5b/i.test(options.modelId)
        const small = tiny || /\b3b|\b4b/i.test(options.modelId)
        const wanted = Math.min(options.contextLength || 8192, tiny ? 8192 : small ? 16384 : Infinity)
        const max = Math.max(512, Math.min(wanted, model.trainContextSize || wanted))
        const insights = model.fileInsights
        const flashAttention = options.flashAttention ?? true
        const useFlash = flashAttention && insights.flashAttentionSupported

        const modelReq = insights.estimateModelResourceRequirements({ gpuLayers, useMmap: options.useMemoryMapping ?? true })
        let contextSize = max
        let capped = false
        if (options.autoContextCap !== false) {
            const reserved = Math.max(0, options.reservedMB ?? 512) * 1024 * 1024
            const budget = Math.max(64 * 1024 * 1024, readMemorySnapshot().available - reserved)
            const totalFor = (ctx: number) => modelReq.cpuRam + insights.estimateContextResourceRequirements({
                contextSize: ctx, modelGpuLayers: gpuLayers, batchSize: options.batchSize || (tiny ? 64 : small ? 128 : 256), flashAttention: useFlash
            }).cpuRam
            if (totalFor(512) > budget) {
                await disposeModel()
                const needMB = Math.round(totalFor(512) / 1048576)
                const freeMB = Math.round(readMemorySnapshot().available / 1048576)
                throw new Error(`Not enough memory for this model: it needs at least ${needMB} MB even with the smallest context, and only ${freeMB} MB is free. Close other apps or pick a smaller model.`)
            }
            const fit = fitContextToBudget(ctx => ({ cpuRam: insights.estimateContextResourceRequirements({
                contextSize: ctx, modelGpuLayers: gpuLayers, batchSize: options.batchSize || (tiny ? 64 : small ? 128 : 256), flashAttention: useFlash
            }).cpuRam }), budget - modelReq.cpuRam, max)
            contextSize = fit.contextSize
            capped = fit.capped
            if (capped) console.warn(`[LLM] Context capped to ${contextSize} tokens (from ${max}) to fit ${(budget / 1048576).toFixed(0)} MB of free memory`)
        }

        const base = {
            contextSize: { min: 512, max: contextSize },
            failedCreationRemedy: { retries: 3, autoContextSizeShrink: 0.75 },
            batchSize: options.batchSize || (tiny ? 64 : small ? 128 : 256),
            ...(options.threads && options.threads > 0 ? { threads: options.threads } : {})
        }
        try {
            context = await model.createContext({ ...base, flashAttention: useFlash })
        } catch (err) {
            if (!useFlash) throw err
            // Some backends can't do flash attention; try once without it.
            context = await model.createContext(base)
        }
        loadedModelId = options.modelId

        const totalRam = modelReq.cpuRam + insights.estimateContextResourceRequirements({
            contextSize, modelGpuLayers: gpuLayers, batchSize: base.batchSize, flashAttention: useFlash
        }).cpuRam
        console.log(`[LLM] Loaded ${options.modelId}: context ${context.contextSize} tokens, ~${Math.round(totalRam / 1048576)} MB estimated`)
        memoryGuard.touch()
        return { contextSize: context.contextSize, estimatedRamMB: Math.round(totalRam / 1048576), contextCapped: capped && contextSize < max }
    }).catch(async err => {
        await disposeModel()
        throw explainLoadFailure(err)
    })
}

export function loadDraftModel(id: string, modelPath: string): Promise<void> {
    return exclusive(async () => {
        if (!llama || !model) throw new Error('Load a model first')
        await disposeDraft()
        const draftModel = await llama.loadModel({ modelPath, gpuLayers: 0, useMmap: true })
        try {
            const draftContext = await draftModel.createContext({ contextSize: { min: 256, max: 2048 }, failedCreationRemedy: { retries: 2, autoContextSizeShrink: 0.5 } })
            draft = { id, model: draftModel, context: draftContext }
        } catch (err) {
            await draftModel.dispose().catch(() => undefined)
            throw err
        }
    })
}

export const unloadDraftModel = () => exclusive(disposeDraft)

export function cancelGeneration(requestId: string): boolean {
    const controller = active.get(requestId)
    controller?.abort()
    return !!controller
}

/** Length of the longest end of `text` that could be the start of a stop sequence. */
function pendingStopLength(text: string, stops: string[]): number {
    let longest = 0
    for (const stop of stops) {
        for (let n = Math.min(stop.length - 1, text.length); n > longest; n--) {
            if (text.endsWith(stop.slice(0, n))) { longest = n; break }
        }
    }
    return longest
}

/**
 * Generates text for a prompt that already carries the model's chat template.
 * `onText` receives clean increments: no half characters and no partial stop sequence.
 */
export function generate(requestId: string, options: GenerateOptions, onText?: (text: string) => void): Promise<{ text: string; aborted: boolean }> {
    const controller = new AbortController()
    active.set(requestId, controller)
    memoryGuard.touch()
    return exclusive(async () => {
        if (!model || !context || !engine) throw new Error('No model loaded')
        if (controller.signal.aborted) return { text: '', aborted: true }
        const current = model
        const stops = (options.stopSequences ?? []).filter(Boolean)
        const maxTokens = options.maxTokens && options.maxTokens > 0 ? options.maxTokens : 2048

        const predictor = draft ? new engine.DraftSequenceTokenPredictor(draft.context.getSequence()) : undefined
        const sequence = context.getSequence(predictor ? { tokenPredictor: predictor } : undefined)
        let grammarEvaluationState: InstanceType<Engine['LlamaGrammarEvaluationState']> | undefined
        if (options.jsonSchema) {
            const grammar = new engine.LlamaJsonSchemaGrammar(llama!, options.jsonSchema as any)
            grammarEvaluationState = new engine.LlamaGrammarEvaluationState({ model: current, grammar })
        }

        const generated: Token[] = []
        let committed = ''      // text of generated[0..checkpoint)
        let checkpoint = 0
        let text = ''
        let emitted = 0
        let aborted = false
        generating = true
        try {
            // `true`: the template's control tokens (e.g. <|im_start|>) are real tokens, not text.
            const input = current.tokenize(options.prompt, true)
            // evaluate() takes no abort signal; leaving the loop stops generation.
            for await (const token of sequence.evaluate(input, { temperature: options.temperature, topP: options.topP, grammarEvaluationState })) {
                if (controller.signal.aborted) { aborted = true; break }
                generated.push(token)
                const piece = current.detokenize(generated.slice(checkpoint), false, generated.slice(Math.max(0, checkpoint - 4), checkpoint))
                text = committed + piece
                // A trailing U+FFFD is half of a multi-byte character; wait for the rest.
                const complete = !text.endsWith('�')
                if (complete) { committed = text; checkpoint = generated.length }

                const stopAt = stops.reduce((at, s) => { const i = text.indexOf(s); return i !== -1 && (at === -1 || i < at) ? i : at }, -1)
                if (stopAt !== -1) { text = text.slice(0, stopAt); break }
                if (complete) {
                    const safeEnd = text.length - pendingStopLength(text, stops)
                    if (safeEnd > emitted) { onText?.(text.slice(emitted, safeEnd)); emitted = safeEnd }
                }
                if (generated.length >= maxTokens) break
            }
        } catch (err) {
            if (!controller.signal.aborted) throw err
            aborted = true
        } finally {
            sequence.dispose()
            generating = false
            memoryGuard.touch()
            active.delete(requestId)
        }
        text = text.replace(/�+$/, '')
        if (!aborted && text.length > emitted) onText?.(text.slice(emitted))
        return { text, aborted: aborted || controller.signal.aborted }
    }).finally(() => active.delete(requestId))
}
