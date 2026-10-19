/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * What goes into a user's message besides their words: files they mentioned
 * with @ (inlined so the agent doesn't need to read them first) and which
 * file is open in the editor. The chat shows only what the user typed.
 */
import { useEditorStatusStore } from '../../stores/editorStatusStore'
import { useWorkspaceFolderStore } from '../../stores/workspaceFolderStore'
import { relativePath } from './tools/paths'
import type { PromptEnvironment } from './systemPrompt'

const MENTION = /@\[([^\]]+)\]\(local:\/\/([^)]+)\)/g
const MAX_ATTACHMENT_CHARS = 100_000
const MAX_ATTACHMENTS = 8

export interface ComposedMessage {
    content: string
    display: string
    /** Files whose full content is now in the conversation. */
    attached: string[]
}

export async function composeMessage(text: string, folder: string | null, spaceId: string): Promise<ComposedMessage> {
    const fs = window.electronAPI?.fs
    const parts: string[] = [text]
    const attached: string[] = []
    const seen = new Set<string>()

    for (const match of text.matchAll(MENTION)) {
        const path = match[2]
        if (seen.has(path) || seen.size >= MAX_ATTACHMENTS || !fs) continue
        seen.add(path)
        const read = await fs.readFile(path).catch(() => null)
        const rel = relativePath(folder, path)
        if (!read?.success) {
            parts.push(`(The user mentioned ${rel}, but it could not be read.)`)
            continue
        }
        const content = String(read.content ?? '')
        if (content.length > MAX_ATTACHMENT_CHARS) {
            parts.push(`(The user mentioned ${rel}; it is large, so read the parts you need with read_file.)`)
            continue
        }
        attached.push(path)
        parts.push(`<attached_file path="${rel}">\n${content}\n</attached_file>`)
    }

    const activeFile = useWorkspaceFolderStore.getState().getRecord(spaceId).activeFile
    if (activeFile) {
        const { line, selectionLength } = useEditorStatusStore.getState()
        parts.push(`<editor_context>The user has ${relativePath(folder, activeFile)} open in the editor (cursor on line ${line}${selectionLength ? `, ${selectionLength} characters selected` : ''}). It may or may not be relevant.</editor_context>`)
    }

    return { content: parts.join('\n\n'), display: text, attached }
}

export async function promptEnvironment(folder: string | null): Promise<PromptEnvironment> {
    const electron = window.electronAPI
    let shell: string | undefined
    let isGitRepo = false
    try { shell = (await electron?.terminal?.getDefaultShell?.())?.shell } catch { /* unknown */ }
    if (folder) {
        try { isGitRepo = !!(await electron?.fs?.stat(`${folder}/.git`))?.success } catch { /* not a repo */ }
    }
    return {
        workspace: folder,
        platform: electron?.platform ?? 'unknown',
        shell: shell ? shell.split(/[\\/]/).pop() : undefined,
        isGitRepo,
        date: new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
    }
}
