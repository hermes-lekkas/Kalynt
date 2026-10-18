/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * The workspace's shared task list, synced to every collaborator, and the
 * AI step breakdown.
 */
import { useCallback } from 'react'
import { useYDoc, useYArray } from '../../hooks/useYjs'
import { useAppStore } from '../../stores/appStore'
import { useModelStore } from '../../stores/modelStore'
import { offlineLLMService, type ChatMessage as LLMMessage } from '../../services/offlineLLMService'
import { aiService, type AIProvider } from '../../services/aiService'

export type TaskStatus = 'todo' | 'in-progress' | 'done'
export type TaskPriority = 'low' | 'medium' | 'high'

export interface Subtask {
    id: string
    title: string
    completed: boolean
}

export interface Task {
    id: string
    title: string
    description?: string
    status: TaskStatus
    priority: TaskPriority
    tags: string[]
    createdAt: number
    dueDate?: number
    subtasks?: Subtask[]
    assignee?: string
}

export const COLUMNS: Array<{ id: TaskStatus; title: string }> = [
    { id: 'todo', title: 'To do' },
    { id: 'in-progress', title: 'In progress' },
    { id: 'done', title: 'Done' }
]

export function emptyTask(status: TaskStatus = 'todo'): Task {
    return { id: crypto.randomUUID(), title: '', status, priority: 'medium', tags: [], createdAt: Date.now(), subtasks: [] }
}

export function useTasks(spaceId: string) {
    const { doc, peerCount } = useYDoc(spaceId)
    const { items, push, update, remove } = useYArray<Task>(doc, 'tasks')
    const apiKeys = useAppStore(s => s.apiKeys)
    const loadedModelId = useModelStore(s => s.loadedModelId)
    const cloudProvider = (['anthropic', 'openai', 'google'] as AIProvider[]).find(p => !!apiKeys[p]) ?? null

    const save = useCallback((task: Task) => {
        const index = items.findIndex(t => t.id === task.id)
        if (index === -1) push(task)
        else update(index, task)
    }, [items, push, update])

    const move = useCallback((id: string, status: TaskStatus) => {
        const index = items.findIndex(t => t.id === id)
        if (index !== -1 && items[index].status !== status) update(index, { ...items[index], status })
    }, [items, update])

    const removeTask = useCallback((id: string) => {
        const index = items.findIndex(t => t.id === id)
        if (index !== -1) remove(index)
    }, [items, remove])

    /** Asks a model for 3–5 concrete steps. Prefers the local model when one is loaded. */
    const breakdown = useCallback(async (task: Task): Promise<Subtask[]> => {
        const prompt = `Break this task into 3 to 5 concrete, actionable steps: "${task.title}".${task.description ? `\nContext: ${task.description}` : ''}\nReply with ONLY a JSON array of strings, for example ["First step", "Second step"].`
        const messages: LLMMessage[] = [
            { role: 'system', content: 'You plan software tasks. Reply only with JSON.' },
            { role: 'user', content: prompt }
        ]
        let text = ''
        if (loadedModelId) {
            await offlineLLMService.generateStream(messages, token => { text += token })
        } else if (cloudProvider) {
            const response = await aiService.chat(messages, cloudProvider, { temperature: 0.2, maxTokens: 400 })
            if (response.error) throw new Error(response.error)
            text = response.content
        } else {
            throw new Error('Connect a model under Settings › Models and keys to break tasks into steps.')
        }
        const match = text.match(/\[[\s\S]*?\]/)
        if (!match) throw new Error('The model didn’t return a list of steps.')
        const steps = JSON.parse(match[0]) as unknown[]
        return steps.filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
            .map(title => ({ id: crypto.randomUUID(), title: title.trim(), completed: false }))
    }, [loadedModelId, cloudProvider])

    return { tasks: items, peerCount, save, move, remove: removeTask, breakdown, canBreakdown: !!(loadedModelId || cloudProvider) }
}
