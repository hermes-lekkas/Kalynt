/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
// Ghost Text / Inline Completion Standalone Function for Monaco Editor
// Provides Copilot-like AI code suggestions as you type
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Monaco = any

import { logger } from '../utils/logger'
import type { AIProvider } from '../services/aiService'
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

    try {
        const languages = [
            'typescript', 'javascript', 'typescriptreact', 'javascriptreact',
            'python', 'rust', 'go', 'cpp', 'c', 'html', 'css', 'json', 'yaml', 'plaintext'
        ]

        // BUG-062: Register for all supported languages individually to handle version differences
        const disposables = languages.map(lang =>
            monaco.languages.registerInlineCompletionsProvider(lang, {
                provideInlineCompletions: async (
                    model: { getValueInRange: (range: object) => string; getLineContent: (line: number) => string; getLanguageId: () => string; },
                    position: { lineNumber: number; column: number },
                    _context: any,
                    token: { isCancellationRequested: boolean }
                ) => {
                    // ... implementation moved to a shared function or kept here ...
                    // For brevity and to ensure correctness, I'll keep the implementation here for each

                    // Debounce: Wait 500ms to avoid flooding AI with requests on every keystroke
                    await new Promise(resolve => setTimeout(resolve, 500))
                    if (token.isCancellationRequested || (model as any).isDisposed()) {
                        return { items: [] }
                    }

                    const textBeforeCursor = model.getValueInRange({
                        startLineNumber: Math.max(1, position.lineNumber - 10),
                        startColumn: 1,
                        endLineNumber: position.lineNumber,
                        endColumn: position.column
                    })

                    const currentLine = model.getLineContent(position.lineNumber)
                    if (currentLine.trim().length < 5) {
                        return { items: [] }
                    }

                    try {
                        const response = await aiService.chat([
                            {
                                role: 'system' as const,
                                content: 'Complete the code. Return ONLY the completion, no markdown, no explanation, just the code continuation.'
                            },
                            {
                                role: 'user' as const,
                                content: `Complete this ${model.getLanguageId()} code:\n${textBeforeCursor}`
                            }
                        ], provider, { model: fastModel(provider), maxTokens: 256 })

                        const completion = response.content?.trim() || ''
                        if (!completion || completion.startsWith('```') || completion.length > 200) {
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
                    }
                },
                freeInlineCompletions: () => { }
            })
        )

        return {
            dispose: () => {
                disposables.forEach(d => d.dispose())
            }
        }
    } catch (error) {
        logger.ai.error('Failed to register ghost text provider', error)
        return null
    }
}
