/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * The agent's tool set. Arguments are checked against each tool's schema
 * before it runs: streamed tool input can arrive incomplete, and models
 * occasionally send the wrong types.
 */
import type { ToolSpec } from '../../../types/aiProtocol'
import type { AgentTool, ToolContext, ToolOutcome } from './types'
import { findFilesTool, listDirectoryTool, readFileTool, searchCodeTool } from './fileTools'
import { deletePathTool, editFileTool, movePathTool, writeFileTool } from './editTools'
import { commandOutputTool, runCommandTool, stopCommandTool } from './execTools'
import { webFetchTool, webSearchTool } from './webTools'
import { diagnosticsTool, gitDiffTool, gitStatusTool, searchCodebaseTool, updatePlanTool } from './miscTools'
import { cleanError } from './types'

export const AGENT_TOOLS: AgentTool[] = [
    readFileTool,
    listDirectoryTool,
    findFilesTool,
    searchCodeTool,
    searchCodebaseTool,
    editFileTool,
    writeFileTool,
    movePathTool,
    deletePathTool,
    runCommandTool,
    commandOutputTool,
    stopCommandTool,
    diagnosticsTool,
    gitStatusTool,
    gitDiffTool,
    webSearchTool,
    webFetchTool,
    updatePlanTool
]

const byName = new Map(AGENT_TOOLS.map(t => [t.name, t]))

export const getTool = (name: string) => byName.get(name)

/** Tool definitions in the provider-neutral format, in a fixed order (keeps prompt caches warm). */
export function toolSpecs(tools: AgentTool[] = AGENT_TOOLS): ToolSpec[] {
    return tools.map(t => ({ name: t.name, description: t.description, parameters: t.parameters }))
}

const TYPE_CHECK: Record<string, (v: unknown) => boolean> = {
    string: v => typeof v === 'string',
    integer: v => typeof v === 'number' && Number.isInteger(v),
    number: v => typeof v === 'number' && Number.isFinite(v),
    boolean: v => typeof v === 'boolean',
    array: v => Array.isArray(v),
    object: v => !!v && typeof v === 'object' && !Array.isArray(v)
}

/** Returns a problem description, or null when the arguments fit the schema. */
export function validateArguments(tool: AgentTool, args: Record<string, unknown>): string | null {
    const properties = tool.parameters.properties as Record<string, { type?: string }>
    for (const name of tool.parameters.required ?? []) {
        if (args[name] === undefined || args[name] === null) return `Missing required argument "${name}".`
    }
    for (const [name, value] of Object.entries(args)) {
        const expected = properties[name]?.type
        if (!expected || value === undefined || value === null) continue
        // Be lenient with numbers sent as strings ("10"); the tools coerce them.
        if ((expected === 'integer' || expected === 'number') && typeof value === 'string' && value.trim() && !Number.isNaN(Number(value))) continue
        if ((expected === 'boolean') && (value === 'true' || value === 'false')) continue
        if (!TYPE_CHECK[expected]?.(value)) return `Argument "${name}" should be ${expected === 'integer' ? 'an integer' : `a ${expected}`}.`
    }
    return null
}

/** Coerces lenient values ("10", "true") to the schema's types. */
function coerce(tool: AgentTool, args: Record<string, unknown>): Record<string, unknown> {
    const properties = tool.parameters.properties as Record<string, { type?: string }>
    const out: Record<string, unknown> = { ...args }
    for (const [name, value] of Object.entries(args)) {
        const expected = properties[name]?.type
        if ((expected === 'integer' || expected === 'number') && typeof value === 'string') out[name] = Number(value)
        if (expected === 'boolean' && typeof value === 'string') out[name] = value === 'true'
    }
    return out
}

export async function runTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
    const tool = byName.get(name)
    if (!tool) return { content: `Unknown tool "${name}". Available tools: ${AGENT_TOOLS.map(t => t.name).join(', ')}.`, isError: true }
    const problem = validateArguments(tool, args)
    if (problem) return { content: `${problem} Check the ${name} parameters and try again.`, isError: true }
    try {
        return await tool.execute(coerce(tool, args), ctx)
    } catch (error) {
        return { content: `${name} failed: ${cleanError(error)}`, isError: true }
    }
}

export type { AgentTool, ToolContext, ToolOutcome, ToolDisplay, PlanItem, DiffLine, ToolKind } from './types'
