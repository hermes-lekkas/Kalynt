/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
// Ghost Text / Inline Completion Standalone Function for Monaco Editor
// Provides Copilot-like AI code suggestions as you type
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Monaco = any

import { logger } from '../utils/logger'
import { pickProvider, type AIProvider } from '../services/aiService'
import { useAppStore } from '../stores/appStore'
import { fastModel } from '../types/aiProviders'

// Import aiService dynamically to avoid path issues
const getAiService = async () => {
    try {
        const module = await import('../services/aiService')
        return module.aiService
    } catch (error) {
        logger.ai.warn('Failed to load AI service for ghost text', error)
        return null
    }
}

const GHOST_TEXT_LANGUAGES = [
    'typescript', 'javascript', 'typescriptreact', 'javascriptreact',
    'python', 'rust', 'go', 'cpp', 'c', 'csharp', 'java', 'kotlin', 'scala', 'swift',
    'ruby', 'php', 'dart', 'lua', 'r', 'perl', 'elixir', 'clojure', 'fsharp', 'haskell', 'zig',
    'html', 'css', 'scss', 'less', 'xml', 'svg', 'vue', 'svelte',
    'json', 'jsonc', 'yaml', 'toml', 'ini', 'dockerfile', 'makefile', 'graphql', 'prisma',
    'sql', 'shell', 'bash', 'powershell', 'bat', 'markdown', 'plaintext'
]

const MAX_PREFIX_LINES = 50
const MAX_SUFFIX_LINES = 25
const MAX_PREFIX_CHARS = 4000
const MAX_SUFFIX_CHARS = 2000
const DEBOUNCE_MS = 400

interface CancellationTokenLike {
    isCancellationRequested: boolean
    onCancellationRequested?: (listener: () => void) => { dispose: () => void }
}

interface TextModelLike {
    getValueInRange: (range: object) => string
    getLineContent: (line: number) => string
    getLineCount?: () => number
    getLineMaxColumn?: (line: number) => number
    getLanguageId: () => string
    isDisposed?: () => boolean
}

function stripMarkdownFences(text: string): string {
    const cleaned = text.replace(/^\s*```[\w+-]*\r?\n/, '').replace(/\r?\n?```\s*$/, '')
    return cleaned.replace(/(?:\r?\n)+$/, '')
}

// Standalone function to register ghost text with Monaco instance
export async function registerGhostTextProvider(
    monaco: Monaco,
    aiEnabled: boolean = true,
    provider: AIProvider = 'anthropic'
) {
    if (!aiEnabled) return null

    const aiService = await getAiService()
    if (!aiService) {
        logger.ai.warn('AI service not available for ghost text')
        return null
    }

    let inFlight: AbortController | null = null

    try {
        const completionProvider = {
            provideInlineCompletions: async (
                model: TextModelLike,
                position: { lineNumber: number; column: number },
                _context: any,
                token: CancellationTokenLike
            ) => {
                // Cancel debounce immediately when Monaco cancels the request.
                const cancelledDuringDebounce = await new Promise<boolean>(resolve => {
                    if (token.isCancellationRequested) {
                        resolve(true)
                        return
                    }
                    let sub: { dispose: () => void } | undefined
                    const timer = setTimeout(() => {
                        sub?.dispose()
                        resolve(false)
                    }, DEBOUNCE_MS)
                    sub = token.onCancellationRequested?.(() => {
                        clearTimeout(timer)
                        sub?.dispose()
                        resolve(true)
                    })
                })

                if (cancelledDuringDebounce || token.isCancellationRequested || model.isDisposed?.()) {
                    return { items: [] }
                }

                const prefixRaw = model.getValueInRange({
                    startLineNumber: Math.max(1, position.lineNumber - MAX_PREFIX_LINES),
                    startColumn: 1,
                    endLineNumber: position.lineNumber,
                    endColumn: position.column
                })
                const totalLines = model.getLineCount?.() ?? position.lineNumber
                const suffixEndLine = Math.min(totalLines, position.lineNumber + MAX_SUFFIX_LINES)
                const suffixEndColumn = model.getLineMaxColumn?.(suffixEndLine) ?? 1000
                const suffixRaw = model.getValueInRange({
                    startLineNumber: position.lineNumber,
                    startColumn: position.column,
                    endLineNumber: suffixEndLine,
                    endColumn: suffixEndColumn
                })

                if (!prefixRaw.trim() && !suffixRaw.trim()) {
                    return { items: [] }
                }

                const prefix = prefixRaw.length > MAX_PREFIX_CHARS ? prefixRaw.slice(-MAX_PREFIX_CHARS) : prefixRaw
                const suffix = suffixRaw.length > MAX_SUFFIX_CHARS ? suffixRaw.slice(0, MAX_SUFFIX_CHARS) : suffixRaw

                // Abort any superseded in-flight ghost text request.
                inFlight?.abort()
                const controller = new AbortController()
                inFlight = controller
                const cancelSub = token.onCancellationRequested?.(() => controller.abort())

                try {
                    // A queued completion must not use a provider selected before
                    // the user switched to local inference or removed a key.
                    if (pickProvider(useAppStore.getState().apiKeys) !== provider) return { items: [] }
                    const response = await aiService.chat([
                        {
                            role: 'system' as const,
                            content: 'You are an inline code completion engine (fill-in-the-middle). Return ONLY the exact code to insert at <CURSOR> between <PREFIX> and <SUFFIX>. Do not repeat <PREFIX> or <SUFFIX>, do not wrap in markdown fences, and do not explain.'
                        },
                        {
                            role: 'user' as const,
                            content: `Language: ${model.getLanguageId()}\n<PREFIX>\n${prefix}<CURSOR><SUFFIX>\n${suffix}\n</SUFFIX>`
                        }
                    ], provider, {
                        model: fastModel(provider),
                        maxTokens: 256,
                        signal: controller.signal,
                        preserveWhitespace: true
                    })

                    if (
                        token.isCancellationRequested
                        || controller.signal.aborted
                        || model.isDisposed?.()
                        || pickProvider(useAppStore.getState().apiKeys) !== provider
                    ) {
                        return { items: [] }
                    }

                    const completion = stripMarkdownFences(response.content || '')
                    if (!completion.trim()) {
                        return { items: [] }
                    }

                    return {
                        items: [{
                            insertText: completion,
                            range: {
                                startLineNumber: position.lineNumber,
                                startColumn: position.column,
                                endLineNumber: position.lineNumber,
                                endColumn: position.column
                            }
                        }]
                    }
                } catch (error) {
                    logger.ai.debug('Failed to generate inline completion', error)
                    return { items: [] }
                } finally {
                    cancelSub?.dispose()
                    if (inFlight === controller) inFlight = null
                }
            },
            disposeInlineCompletions: () => { },
            freeInlineCompletions: () => { }
        }

        const disposables = GHOST_TEXT_LANGUAGES.map(lang =>
            monaco.languages.registerInlineCompletionsProvider(lang, completionProvider)
        )

        return {
            dispose: () => {
                inFlight?.abort()
                inFlight = null
                disposables.forEach(d => d.dispose())
            }
        }
    } catch (error) {
        logger.ai.error('Failed to register ghost text provider', error)
        return null
    }
}
