/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Planning, semantic code search, diagnostics and read-only git.
 */
import { aimeService } from '../../aimeService'
import { checkFile } from '../diagnostics'
import { cleanError, fail, type AgentTool, type PlanItem, type PlanStatus } from './types'
import { relativePath, resolvePath } from './paths'
import { clip } from './execTools'

const STATUSES: PlanStatus[] = ['pending', 'in_progress', 'done']
const str = (v: unknown) => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v))

export const updatePlanTool: AgentTool = {
    name: 'update_plan',
    kind: 'plan',
    description: 'Keep a short checklist of the steps for the current task, shown to the user. Use it for tasks with three or more steps: write the plan first, then update it as you go, keeping exactly one step in_progress. Send the whole list each time.',
    parameters: {
        type: 'object',
        properties: {
            items: {
                type: 'array',
                description: 'All steps, in order.',
                items: {
                    type: 'object',
                    properties: {
                        text: { type: 'string', description: 'What the step does, in a few words.' },
                        status: { type: 'string', enum: STATUSES, description: 'pending, in_progress or done.' }
                    },
                    required: ['text', 'status']
                }
            }
        },
        required: ['items']
    },
    title: () => 'Update the plan',
    async execute(args, ctx) {
        if (!Array.isArray(args.items)) return fail('items must be a list of { text, status }.')
        const items: PlanItem[] = args.items
            .map(raw => raw as Record<string, unknown>)
            .filter(raw => raw && str(raw.text).trim())
            .map(raw => ({ text: str(raw.text).trim().slice(0, 200), status: STATUSES.includes(raw.status as PlanStatus) ? raw.status as PlanStatus : 'pending' }))
            .slice(0, 30)
        ctx.plan.set(items)
        const done = items.filter(i => i.status === 'done').length
        return { content: `Plan updated (${done}/${items.length} done).`, display: { type: 'plan', items } }
    }
}

export const searchCodebaseTool: AgentTool = {
    name: 'search_codebase',
    kind: 'search',
    description: 'Find code related to a concept or feature by meaning (for example "where are API keys stored"), using the project index. Good for getting oriented; use search_code for exact text.',
    parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'What you are looking for, in plain words.' } },
        required: ['query']
    },
    title: args => `Look up ${str(args.query)}`,
    async execute(args) {
        const stats = aimeService.getStats()
        if (!stats.filesIndexed) {
            return fail(stats.isIndexing ? 'The project index is still being built; use search_code or find_files for now.' : 'The project is not indexed; use search_code or find_files.')
        }
        const context = await aimeService.retrieveContext(str(args.query), 8)
        if (!context || context === 'No relevant context found.') return { content: 'Nothing relevant found in the index.' }
        return { content: clip(context, 20_000), display: { type: 'text', text: `Found related code in the project index.` } }
    }
}

export const diagnosticsTool: AgentTool = {
    name: 'get_diagnostics',
    kind: 'read',
    description: 'Check a file for errors with its language\'s checker: the TypeScript compiler (whole project), go vet, cargo check, or a syntax check for Python, JavaScript, JSON and shell scripts. Python, JavaScript, JSON and shell files are syntax-checked automatically after each edit.',
    parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'File to check.' } },
        required: ['path']
    },
    title: (args, ws) => `Check ${relativePath(ws, resolvePath(ws, args.path))}`,
    async execute(args, ctx) {
        if (!ctx.workspace) return fail('Open a folder first.')
        const path = resolvePath(ctx.workspace, args.path)
        try {
            const result = await checkFile(path, ctx.workspace)
            if (!result) return { content: 'No checker is available for this file type here; run the project\'s own build or tests instead.' }
            if (result.ok) return { content: `No errors found (${result.checker}).`, display: { type: 'text', text: `No errors found (${result.checker}).` } }
            return { content: `${result.checker} found problems:\n${result.output}`, isError: true, display: { type: 'text', text: result.output } }
        } catch (error) {
            return fail(cleanError(error))
        }
    }
}

export const gitStatusTool: AgentTool = {
    name: 'git_status',
    kind: 'read',
    description: 'Show the git status of the workspace: branch and changed, staged and untracked files.',
    parameters: { type: 'object', properties: {} },
    title: () => 'Check git status',
    async execute(_args, ctx) {
        if (!ctx.workspace) return fail('Open a folder first.')
        const result = await window.electronAPI.git.status(ctx.workspace)
        if (!result?.success) return fail(`${cleanError(result?.error ?? 'git status failed.')} (Use run_command for repositories in subfolders.)`)
        const s = result.status
        const lines = [
            `Branch: ${s.current ?? '(detached)'}${s.tracking ? ` tracking ${s.tracking}` : ''}${s.ahead ? `, ${s.ahead} ahead` : ''}${s.behind ? `, ${s.behind} behind` : ''}`,
            ...((s.files ?? []) as Array<{ path: string; index: string; working_dir: string }>).map(f => `${(f.index + f.working_dir).trim().padEnd(2)} ${f.path}`)
        ]
        return { content: lines.length > 1 ? lines.join('\n') : `${lines[0]}\nWorking tree clean.` }
    }
}

export const gitDiffTool: AgentTool = {
    name: 'git_diff',
    kind: 'read',
    description: 'Show uncommitted changes as a unified diff, for the whole workspace or one file.',
    parameters: {
        type: 'object',
        properties: {
            path: { type: 'string', description: 'Limit to this file.' },
            staged: { type: 'boolean', description: 'Show staged changes instead of unstaged ones.' }
        }
    },
    title: (args, ws) => args.path ? `Diff ${relativePath(ws, resolvePath(ws, args.path))}` : 'Diff the workspace',
    async execute(args, ctx) {
        if (!ctx.workspace) return fail('Open a folder first.')
        const file = args.path ? relativePath(ctx.workspace, resolvePath(ctx.workspace, args.path)) : undefined
        const result = await window.electronAPI.git.diff({ repoPath: ctx.workspace, file, staged: args.staged === true })
        if (!result?.success) return fail(cleanError(result?.error ?? 'git diff failed.'))
        return { content: clip(String(result.diff ?? ''), 30_000) || 'No changes.' }
    }
}
