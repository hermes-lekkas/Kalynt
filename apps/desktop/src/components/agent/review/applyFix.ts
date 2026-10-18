/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Asks the model for a fix to one review finding and opens the result in the
 * editor as unsaved changes, so nothing is written until the user saves.
 */
import type { ScanIssue } from '../../../services/workspaceScanService'
import { aiService, type AIProvider } from '../../../services/aiService'
import { offlineLLMService } from '../../../services/offlineLLMService'

const FIX_TIMEOUT_MS = 60_000

export async function proposeFix(issue: ScanIssue, mode: 'cloud' | 'offline', provider: AIProvider, cloudModel?: string): Promise<void> {
    const file = await window.electronAPI?.fs?.readFile(issue.path)
    if (!file?.success || typeof file.content !== 'string') throw new Error('The file could not be read.')

    const lines = file.content.split('\n')
    let start = 0
    let end = Math.min(lines.length, 80)
    if (issue.line && issue.line > 0) {
        start = Math.max(0, issue.line - 30)
        end = Math.min(lines.length, issue.line + 30)
    }
    const section = lines.slice(start, end).join('\n')
    const prompt = `Fix this issue in the code.\n\nIssue: ${issue.description}\nFix: ${issue.suggestion}\n\nCode (lines ${start + 1}-${end}):\n\`\`\`\n${section}\n\`\`\`\n\nReturn ONLY the fixed code for these lines. No explanation, no markdown fences.`
    const system = 'You are a code fixer. Output ONLY the fixed code. No explanation, no markdown.'

    let fixed: string
    if (mode === 'offline') {
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
            fixed = await Promise.race([
                offlineLLMService.generate([{ role: 'system', content: system }, { role: 'user', content: prompt }], { temperature: 0.1, maxTokens: 1024 }),
                new Promise<string>((_, reject) => {
                    timer = setTimeout(() => {
                        offlineLLMService.cancelGeneration().catch(() => undefined)
                        reject(new Error('The local model took too long to propose a fix.'))
                    }, FIX_TIMEOUT_MS)
                })
            ])
        } finally {
            if (timer) clearTimeout(timer)
        }
    } else {
        const response = await aiService.chat([{ role: 'system', content: system }, { role: 'user', content: prompt }], provider, { temperature: 0.1, maxTokens: 2048, model: cloudModel })
        if (response.error) throw new Error(response.error)
        fixed = response.content
    }

    fixed = fixed.replace(/^```[\w]*\n?/, '').replace(/\n?```\s*$/, '').trim()
    if (fixed.length < 5) throw new Error('The model returned an empty fix.')

    const next = [...lines]
    next.splice(start, end - start, ...fixed.split('\n'))
    window.dispatchEvent(new CustomEvent('kalynt-apply-fix', { detail: { path: issue.path, content: next.join('\n'), line: issue.line } }))
}
