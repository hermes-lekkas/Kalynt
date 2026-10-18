/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Removes chat-template tokens and raw tool-call JSON that some models leak
 * into their replies, so people only see readable text.
 */
export function cleanModelOutput(text: string): string {
    if (!text) return ''
    return text
        .replace(/<\|im_(start|end)\|>?/g, '')
        .replace(/<\|(end_of_text|start_of_role|end_of_role)\|>/g, '')
        .replace(/<\/?s>/g, '')
        .replace(/\[\/?INST\]/g, '')
        .replace(/<tool>[\s\S]*?<\/tool>/gi, '')
        .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '')
        .replace(/<function=\w+>[\s\S]*?<\/function>/gi, '')
        .replace(/\{"name"\s*:\s*"(readFile|listDirectory|writeFile|runCommand|executeCode|createFile|delete)"[\s\S]*?\}/g, '')
        .replace(/\{"tool"\s*:\s*"[^"]+"\s*,\s*"params"\s*:\s*\{[^}]*\}\s*\}/g, '')
        .replace(/\n?(user|assistant|system)\s*$/gi, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
}

/** Splits a `<thinking>` block from the visible answer. */
export function splitThinking(text: string): { thinking: string | null; answer: string } {
    const match = text.match(/<thinking>([\s\S]*?)<\/thinking>/i)
    return {
        thinking: match ? match[1].trim() : null,
        answer: text.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '').trim()
    }
}
