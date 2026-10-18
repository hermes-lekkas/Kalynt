/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Agent Loop Service - Core ReAct (Reasoning + Acting) Engine
 *
 * Implements the agentic loop described in the Kalynt architecture:
 *   User Message → Plan → Act (Tool) → Observe → Reason → Loop
 *
 * This service is the brain of the IDE agent. It:
 * 1. Receives a user message
 * 2. Builds context (AIME RAG + workspace info + file context)
 * 3. Sends to LLM (cloud or offline)
 * 4. Parses response for tool calls
 * 5. Executes tools, feeds results back
 * 6. Loops until task is complete or max iterations reached
 * 7. Emits events for real-time UI updates
 */

import { logger } from '../utils/logger'
import { aiService, AIProvider, AIMessage } from './aiService'
import { offlineLLMService, ChatMessage as OfflineChatMessage } from './offlineLLMService'
import { executeTool, stopActiveTool, type ToolContext } from './ideAgentTools'
import { aimeService } from './aimeService'
import { shadowWorkspaceService } from './shadowWorkspaceService'
import { cycleDetectionService } from './cycleDetectionService'
import { toolCacheService } from './toolCacheService'
import { useModelStore } from '../stores/modelStore'
import { estimateTokens, truncateToTokens } from '../utils/tokenCounter'
import { detectModelTier } from '../instructions'
import { buildAgentLoopSystemPrompt } from '../instructions/agentLoopInstructions'
import {
    AgentStep,
    AgentPlan,
    AgentLoopConfig,
    AgentLoopState,
    AgentLoopEvent,
    DEFAULT_LOOP_CONFIG
} from '../types/agentTypes'

type EventListener = (event: AgentLoopEvent) => void

/** Maximum characters to include from a single tool result */
const MAX_TOOL_RESULT_CHARS = 4000

/**
 * Parse tool calls from LLM response.
 * Standardized on JSON format within ```tool code blocks.
 */
function parseToolCalls(response: string): Array<{ name: string; params: Record<string, unknown> }> {
    const calls: Array<{ name: string; params: Record<string, unknown> }> = []
    let match: RegExpExecArray | null

    // Strategy 1 (Standard): Markdown code block ```tool (JSON inside)
    const toolBlockPattern = /```tool\s*\n?({[\s\S]*?})\n?```/gi
    while ((match = toolBlockPattern.exec(response)) !== null) {
        try {
            const parsed = JSON.parse(match[1])
            if (parsed.name && parsed.params) {
                calls.push({ name: parsed.name, params: parsed.params })
            }
        } catch { /* skip invalid JSON */ }
    }
    if (calls.length > 0) return calls

    // Strategy 2 (Fallback): XML <tool_code> XML tags
    const toolCodePattern = /<tool_code>([\s\S]*?)<\/tool_code>/gi
    while ((match = toolCodePattern.exec(response)) !== null) {
        try {
            const content = match[1]
            const nameMatch = /<name>([\s\S]*?)<\/name>/i.exec(content)
            if (nameMatch) {
                const toolName = nameMatch[1].trim()
                const params: Record<string, unknown> = {}
                const paramRegex = /<(\w+)>([\s\S]*?)<\/\1>/gi
                let paramMatch: RegExpExecArray | null
                while ((paramMatch = paramRegex.exec(content)) !== null) {
                    const tagName = paramMatch[1].toLowerCase()
                    if (tagName !== 'name') {
                        const val = paramMatch[2].trim()
                        if (val === 'true') params[paramMatch[1]] = true
                        else if (val === 'false') params[paramMatch[1]] = false
                        else if (/^\d+$/.test(val)) params[paramMatch[1]] = Number.parseInt(val)
                        else params[paramMatch[1]] = val
                    }
                }
                calls.push({ name: toolName, params })
            }
        } catch { /* skip */ }
    }
    if (calls.length > 0) return calls

    // Strategy 3 (Aggressive Fallback): Find any JSON object that looks like a tool call
    const jsonStartPattern = /\{\s*"name"\s*:\s*"(\w+)"\s*,\s*"params"\s*:/g
    while ((match = jsonStartPattern.exec(response)) !== null) {
        const jsonCandidate = response.substring(match.index)
        // Try to find the matching closing brace
        let braceCount = 0
        for (let i = 0; i < jsonCandidate.length; i++) {
            if (jsonCandidate[i] === '{') braceCount++
            else if (jsonCandidate[i] === '}') {
                braceCount--
                if (braceCount === 0) {
                    try {
                        const parsed = JSON.parse(jsonCandidate.substring(0, i + 1))
                        if (parsed.name && parsed.params) {
                            calls.push({ name: parsed.name, params: parsed.params })
                            break
                        }
                    } catch { /* try next */ }
                }
            }
        }
    }

    return calls
}

/**
 * Extract clean text content from LLM response, removing tool calls and special tokens.
 */
function extractCleanContent(response: string): string {
    return response
        // Remove thinking tags and their content
        .replaceAll(/<think>[\s\S]*?<\/think>/gi, '')
        .replaceAll(/<thinking>[\s\S]*?<\/thinking>/gi, '')
        // Remove standardized tool code blocks
        .replaceAll(/```tool[\s\S]*?```/gi, '')
        // Remove other specific formats if they leak
        .replaceAll(/<tool_code>[\s\S]*?<\/tool_code>/gi, '')
        // Remove special tokens
        .replaceAll(/<\|im_end\|>/g, '')
        .replaceAll(/<\|im_start\|>/g, '')
        .replaceAll(/<\|end_of_text\|>/g, '')
        .replaceAll(/<\/s>/g, '')
        .replaceAll(/<s>/g, '')
        .replaceAll(/\[INST\]/g, '')
        .replaceAll(/\[\/INST\]/g, '')
        // Remove role markers
        .replaceAll(/\n?(user|assistant|system)\s*$/gi, '')
        // Clean whitespace
        .trim()
}

/**
 * Extract thinking content from response
 */
function extractThinking(response: string): string | null {
    const thinkMatch = /<think>([\s\S]*?)<\/think>/i.exec(response)
        ?? /<thinking>([\s\S]*?)<\/thinking>/i.exec(response)
    return thinkMatch ? thinkMatch[1].trim() : null
}

/**
 * Extract a plan from the LLM response if it generated one
 */
function extractPlan(response: string): AgentPlan | null {
    // Look for plan format: <plan>...</plan> or ```plan...```
    const planMatch = /<plan>([\s\S]*?)<\/plan>/i.exec(response)
        ?? /```plan\s*\n([\s\S]*?)\n```/i.exec(response)

    if (!planMatch) return null

    try {
        const parsed = JSON.parse(planMatch[1])
        if (parsed.title && Array.isArray(parsed.steps)) {
            return {
                id: crypto.randomUUID(),
                title: parsed.title,
                steps: parsed.steps.map((s: any) => ({
                    description: s.description || s,
                    name: s.tool || s.name,
                    status: 'pending' as const
                })),
                status: 'proposed',
                createdAt: Date.now()
            }
        }
    } catch {
        // Try parsing as numbered list
        const lines = planMatch[1].split('\n').filter((l: string) => l.trim())
        if (lines.length > 0) {
            return {
                id: crypto.randomUUID(),
                title: 'Execution Plan',
                steps: lines.map((line: string) => ({
                    description: line.replace(/^\d+[.)]\s*/, '').trim(),
                    status: 'pending' as const
                })),
                status: 'proposed',
                createdAt: Date.now()
            }
        }
    }
    return null
}

class AgentLoopService {
    private config: AgentLoopConfig = { ...DEFAULT_LOOP_CONFIG }
    private state: AgentLoopState | null = null
    private readonly listeners: Set<EventListener> = new Set()
    private abortController: AbortController | null = null
    private workspacePath: string = ''
    private useOfflineAI: boolean = false
    private cloudProvider: AIProvider = 'openai'
    
    // Cache for this run
    private cacheEnabled = true

    // --- Configuration ---

    setConfig(config: Partial<AgentLoopConfig>) {
        this.config = { ...this.config, ...config }
    }

    getConfig(): AgentLoopConfig {
        return { ...this.config }
    }

    setWorkspacePath(path: string) {
        this.workspacePath = path
    }

    setUseOfflineAI(offline: boolean) {
        this.useOfflineAI = offline
    }

    setCloudProvider(provider: AIProvider) {
        this.cloudProvider = provider
    }

    // --- Event System ---

    on(listener: EventListener): () => void {
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
    }

    private emit(event: AgentLoopEvent) {
        for (const listener of this.listeners) {
            try {
                listener(event)
            } catch (err) {
                logger.agent.error('Event listener error', err)
            }
        }
    }

    // --- State ---

    getState(): AgentLoopState | null {
        return this.state ? { ...this.state } : null
    }

    isRunning(): boolean {
        return this.state?.isRunning ?? false
    }

    // --- Core Loop ---

    /**
     * Run the agentic ReAct loop for a user message.
     *
     * @param userMessage - The user's message/instruction
     * @param chatHistory - Previous chat messages for context
     * @param options - Override config for this run
     * @returns The final assistant response text
     */
    async run(
        userMessage: string,
        chatHistory: Array<{ role: string; content: string }> = [],
        options?: Partial<AgentLoopConfig> & { systemPrompt?: string }
    ): Promise<string> {
        if (this.state?.isRunning) {
            throw new Error('Agent loop is already running')
        }

        const runConfig = { ...this.config, ...options }
        const runId = crypto.randomUUID()

        this.abortController = new AbortController()
        const signal = this.abortController.signal

        this.state = {
            runId,
            isRunning: true,
            userMessage,
            steps: [],
            plan: null,
            iteration: 0,
            streamingText: '',
            isGenerating: false,
            thinkingContent: '',
            isThinking: false,
            error: null,
            startedAt: Date.now(),
            modifiedFiles: []
        }

        this.emit({ type: 'started', runId, userMessage })
        
        // Initialize cycle detection
        cycleDetectionService.startRun(runId)
        
        // Clear tool cache for new run
        if (this.cacheEnabled) {
            toolCacheService.clear()
        }

        try {
            // 1. Gather context from AIME (RAG)
            let ragContext = ''
            if (runConfig.useRAG) {
                try {
                    ragContext = await aimeService.retrieveContext(userMessage)
                    if (ragContext === 'No relevant context found.') ragContext = ''
                } catch {
                    logger.agent.warn('AIME context retrieval failed, continuing without RAG')
                }
            }

            // 2. Build system prompt (or use override)
            const systemPrompt = options?.systemPrompt || this.buildSystemPrompt(ragContext, runConfig)

            // 3. Build conversation history
            const contextWindow = this.useOfflineAI
                ? offlineLLMService.getContextWindow()
                : aiService.getContextWindow(this.cloudProvider)

            const messages = this.buildMessages(systemPrompt, chatHistory, userMessage, contextWindow)

            // 4. Enter the ReAct loop
            let finalResponse = ''
            let conversationMessages = [...messages]
            const startTime = Date.now()

            for (let iteration = 0; iteration < runConfig.maxIterations; iteration++) {
                if (signal.aborted) {
                    this.emit({ type: 'aborted' })
                    break
                }

                // Check time budget
                if (Date.now() - startTime > runConfig.maxDurationMs) {
                    logger.agent.warn('Agent loop time budget exceeded')
                    this.addStep({
                        type: 'error',
                        content: 'Time budget exceeded. Stopping agent loop.'
                    })
                    break
                }

                this.state.iteration = iteration + 1
                this.emit({ type: 'iteration', iteration: iteration + 1, maxIterations: runConfig.maxIterations })

                // Trim conversation to fit context window before generating
                const currentContextWindow = this.useOfflineAI
                    ? offlineLLMService.getContextWindow()
                    : aiService.getContextWindow(this.cloudProvider)
                conversationMessages = this.trimToContextWindow(conversationMessages, currentContextWindow)

                // Generate LLM response
                this.state.isGenerating = true
                this.state.streamingText = ''

                let response: string
                try {
                    response = await this.generateResponse(conversationMessages, signal)
                } catch (err) {
                    if (signal.aborted) {
                        this.emit({ type: 'aborted' })
                        break
                    }
                    const errorMsg = err instanceof Error ? err.message : String(err)
                    this.addStep({ type: 'error', content: `Generation failed: ${errorMsg}` })
                    this.emit({ type: 'error', error: errorMsg })
                    break
                }

                this.state.isGenerating = false
                this.state.streamingText = ''

                // Extract thinking
                const thinking = extractThinking(response)
                if (thinking) {
                    this.addStep({ type: 'thinking', content: thinking })
                }

                // Check for plan
                const plan = extractPlan(response)
                if (plan && runConfig.planMode) {
                    this.state.plan = plan
                    this.emit({ type: 'plan-proposed', plan })
                    this.addStep({ type: 'plan', content: plan.steps.map(s => s.description).join('\n') })

                    // In plan mode, emit the plan and return it for user approval
                    // The UI should present approve/reject, then call run() again
                    finalResponse = `Plan proposed:\n${plan.steps.map((s, i) => `${i + 1}. ${s.description}`).join('\n')}`
                    break
                }

                // Parse tool calls
                const toolCalls = parseToolCalls(response)
                const cleanText = extractCleanContent(response)

                if (toolCalls.length === 0) {
                    // No tool calls - this is the final answer
                    finalResponse = cleanText
                    if (finalResponse) {
                        this.addStep({ type: 'answer', content: finalResponse })
                    }
                    break
                }

                // If we have tool calls AND text, show the text as thinking/explanation
                if (cleanText) {
                    this.addStep({ type: 'thinking', content: cleanText })
                } else {
                    this.addStep({ type: 'thinking', content: `Executing ${toolCalls.length} tool(s)...` })
                }

                // Execute tool calls sequentially, collecting all results
                const toolResults: string[] = []

                for (const toolCall of toolCalls) {
                    if (signal.aborted) break

                    this.addStep({
                        type: 'tool-call',
                        content: `Calling ${toolCall.name}`,
                        name: toolCall.name,
                        params: toolCall.params
                    })
                    this.emit({ type: 'tool-executing', toolName: toolCall.name, params: toolCall.params })

                    const context: ToolContext = { workspacePath: this.workspacePath }
                    const stepStart = Date.now()

                    try {
                        const result = await executeTool(toolCall.name, toolCall.params, context)
                        const duration = Date.now() - stepStart

                        // Track modified files
                        if (result.success && ['writeFile', 'replaceInFile', 'insertAtLine', 'fuzzyReplace', 'createFile'].includes(toolCall.name)) {
                            const filePath = (toolCall.params.path as string) || ''
                            if (filePath && !this.state.modifiedFiles.includes(filePath)) {
                                this.state.modifiedFiles.push(filePath)
                                this.emit({ type: 'file-modified', filePath })
                            }
                        }

                        let resultStr = result.success
                            ? (typeof result.data === 'string' ? result.data : JSON.stringify(result.data, null, 2))
                            : `Error: ${result.error}`

                        // Truncate very long tool results to prevent context overflow
                        if (resultStr.length > MAX_TOOL_RESULT_CHARS) {
                            resultStr = resultStr.slice(0, MAX_TOOL_RESULT_CHARS) + `\n...(truncated, ${resultStr.length - MAX_TOOL_RESULT_CHARS} more characters)...`
                        }

                        this.addStep({
                            type: 'tool-result',
                            content: resultStr,
                            name: toolCall.name,
                            data: result.data ?? result.error,
                            duration
                        })

                        this.emit({
                            type: 'tool-result',
                            toolName: toolCall.name,
                            result: result.data ?? result.error,
                            success: result.success
                        })

                        // Shadow Workspace: Auto-validate after file modifications
                        let validationFeedback = ''
                        if (result.success && ['writeFile', 'replaceInFile', 'insertAtLine', 'fuzzyReplace', 'createFile'].includes(toolCall.name)) {
                            const modifiedPath = (toolCall.params.path as string) || ''
                            if (modifiedPath && this.workspacePath) {
                                try {
                                    const validation = await shadowWorkspaceService.validateFile(modifiedPath, this.workspacePath)
                                    if (validation && !validation.success) {
                                        validationFeedback = '\n' + shadowWorkspaceService.formatErrorsForAgent(validation)
                                        this.addStep({
                                            type: 'error',
                                            content: `Build validation: ${validation.errors.filter(e => e.severity === 'error').length} error(s) detected`,
                                            name: 'shadowWorkspace',
                                            duration: validation.duration
                                        })
                                    }
                                } catch {
                                    // Validation is best-effort, don't block the loop
                                }
                            }
                        }

                        // Collect tool result for combined message
                        toolResults.push(
                            `Tool "${toolCall.name}" ${result.success ? 'succeeded' : 'failed'}.\nResult:\n${resultStr}${validationFeedback}`
                        )
                    } catch (err) {
                        const errorMsg = err instanceof Error ? err.message : String(err)
                        this.addStep({
                            type: 'error',
                            content: `Tool ${toolCall.name} error: ${errorMsg}`,
                            name: toolCall.name,
                            duration: Date.now() - stepStart
                        })
                        this.emit({ type: 'tool-result', toolName: toolCall.name, result: errorMsg, success: false })

                        toolResults.push(
                            `Tool "${toolCall.name}" threw an error: ${errorMsg}\nTry a different approach or tool.`
                        )
                    }
                }

                // Record state for cycle detection
                const toolNames = toolCalls.map(tc => tc.name)
                const fileOps = this.state.modifiedFiles.slice(-5) // Last 5 modified files
                const cycle = cycleDetectionService.recordState(toolNames, fileOps, response)
                
                if (cycle) {
                    this.addStep({
                        type: 'error',
                        content: `Cycle detected: ${cycle.type}. Suggested action: ${cycle.suggestedAction.type}`
                    })
                    this.emit({ type: 'error', error: `Cycle detected: ${cycle.type}` })
                    
                    // Add cycle break suggestion to tool results
                    toolResults.push(
                        `\n⚠️ CYCLE DETECTED: The agent appears to be stuck in a ${cycle.type} pattern. ` +
                        `Suggestion: ${JSON.stringify(cycle.suggestedAction)}. ` +
                        `Try a completely different approach or ask for clarification.`
                    )
                }

                // Append assistant response ONCE + combined tool results as a single user message
                // This prevents conversation corruption from duplicating the assistant response per tool
                if (toolResults.length > 0) {
                    const combinedResults = toolResults.join('\n\n---\n\n')
                    conversationMessages = [
                        ...conversationMessages,
                        this.makeAssistantMessage(response),
                        this.makeUserMessage(
                            `${combinedResults}\n\nContinue with the task. If more tools are needed, call them. If the task is complete, provide a final summary.`
                        )
                    ]
                }
            }

            // If we exhausted iterations without a final answer
            if (!finalResponse && this.state.steps.length > 0) {
                const lastStep = this.state.steps.at(-1)
                if (lastStep?.type === 'tool-result') {
                    finalResponse = `Completed ${this.state.iteration} steps. Modified files: ${this.state.modifiedFiles.join(', ') || 'none'}.`
                }
            }

            this.emit({ type: 'completed', finalMessage: finalResponse, steps: this.state.steps })
            return finalResponse

        } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err)
            this.state.error = errorMsg
            this.emit({ type: 'error', error: errorMsg })
            logger.agent.error('Agent loop failed', err)
            return `Error: ${errorMsg}`

        } finally {
            if (this.state) {
                this.state.isRunning = false
                this.state.isGenerating = false
            }
            this.abortController = null
            
            // End cycle detection and log results
            const cycles = cycleDetectionService.endRun()
            if (cycles.length > 0) {
                logger.agent.warn('Cycles detected during run', {
                    count: cycles.length,
                    types: cycles.map(c => c.type)
                })
            }
            
            // Log cache statistics
            if (this.cacheEnabled) {
                const cacheStats = toolCacheService.getStats()
                const hitRate = toolCacheService.getHitRate()
                logger.agent.debug('Tool cache statistics', {
                    hitRate: `${hitRate.toFixed(1)}%`,
                    hits: cacheStats.hits,
                    misses: cacheStats.misses
                })
            }
        }
    }

    /**
     * Get the conversation history from the last run.
     * Useful for continuation or background analysis.
     */
    getMissionHistory(): Array<{ role: string; content: string }> {
        return this.state?.steps.map(step => {
            if (step.type === 'thinking') return { role: 'assistant', content: `<think>\n${step.content}\n</think>` }
            if (step.type === 'tool-call') return { role: 'assistant', content: `{"name": "${step.name}", "params": ${JSON.stringify(step.params)}}` }
            if (step.type === 'tool-result') return { role: 'user', content: `Tool Result: ${JSON.stringify(step.data)}` }
            if (step.type === 'answer') return { role: 'assistant', content: step.content }
            return { role: 'user', content: step.content }
        }) || []
    }

    /**
     * Abort the currently running loop
     */
    async abort() {
        if (!this.state?.isRunning) return

        this.abortController?.abort()

        // Cancel active tool execution
        await stopActiveTool().catch((error) => {
            logger.agent.warn('Failed to stop active tool during abort', { error: String(error) })
        })

        // Cancel LLM generation
        if (this.useOfflineAI) {
            await offlineLLMService.cancelGeneration().catch((error) => {
                logger.agent.warn('Failed to cancel offline generation during abort', { error: String(error) })
            })
        } else {
            aiService.cancelStream()
        }

        if (this.state) {
            this.state.isRunning = false
            this.state.isGenerating = false
        }

        this.emit({ type: 'aborted' })
    }

    // --- Internal Methods ---

    /**
     * Trim conversation messages to fit within the context window.
     * Preserves the system prompt (first message) and the most recent messages.
     * Drops oldest non-system messages when token count exceeds the budget.
     */
    private trimToContextWindow(
        messages: Array<{ role: string; content: string }>,
        contextWindow: number
    ): Array<{ role: string; content: string }> {
        const responseBuffer = 4096
        const safetyBuffer = 1000
        const maxTokens = contextWindow - responseBuffer - safetyBuffer

        // Calculate total tokens
        let totalTokens = 0
        for (const msg of messages) {
            totalTokens += estimateTokens(msg.content)
        }

        // If within budget, return as-is
        if (totalTokens <= maxTokens) return messages

        // System prompt always stays (index 0)
        const systemMsg = messages[0]
        const rest = messages.slice(1)

        // Drop oldest non-system messages until within budget
        let trimmed = [...rest]
        let currentTokens = totalTokens

        while (currentTokens > maxTokens && trimmed.length > 2) {
            // Remove the oldest non-system message
            const removed = trimmed.shift()!
            currentTokens -= estimateTokens(removed.content)
        }

        // If still over budget, truncate the oldest remaining message
        if (currentTokens > maxTokens && trimmed.length > 0) {
            const oldest = trimmed[0]
            const excessTokens = currentTokens - maxTokens
            const keepTokens = estimateTokens(oldest.content) - excessTokens
            if (keepTokens > 100) {
                trimmed[0] = {
                    role: oldest.role,
                    content: '...(earlier context trimmed)...\n' + truncateToTokens(oldest.content, keepTokens)
                }
            }
        }

        return [systemMsg, ...trimmed]
    }

    private addStep(step: Omit<AgentStep, 'id' | 'timestamp'>) {
        const fullStep: AgentStep = {
            id: crypto.randomUUID(),
            timestamp: Date.now(),
            ...step
        }
        this.state?.steps.push(fullStep)
        this.emit({ type: 'step-added', step: fullStep })
    }

    private buildSystemPrompt(ragContext: string, config: AgentLoopConfig): string {
        const loadedModelId = this.useOfflineAI
            ? useModelStore.getState().loadedModelId
            : null

        const tier = detectModelTier(
            loadedModelId,
            this.cloudProvider,
            this.useOfflineAI
        )

        let prompt = buildAgentLoopSystemPrompt(tier, this.workspacePath, ragContext)

        // Add plan mode instructions
        if (config.planMode) {
            prompt += `

## PLAN MODE
Before executing any tools, first create a plan:
\`\`\`plan
{
  "title": "Brief description of the task",
  "steps": [
    {"description": "Step 1: What to do", "name": "toolName"},
    {"description": "Step 2: What to do next", "name": "toolName"}
  ]
}
\`\`\`
Then execute the plan step by step.`
        }

        return prompt
    }

    private buildMessages(
        systemPrompt: string,
        chatHistory: Array<{ role: string; content: string }>,
        userMessage: string,
        contextWindow: number
    ): Array<{ role: string; content: string }> {
        const responseBuffer = 4096
        const systemTokens = estimateTokens(systemPrompt)
        const userTokens = estimateTokens(userMessage)

        let availableTokens = contextWindow - responseBuffer - systemTokens - userTokens

        // Safety buffer
        availableTokens -= 1000

        if (availableTokens < 0) {
            // Context is extremely tight, just send system + truncated user message
            return [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: truncateToTokens(userMessage, contextWindow - systemTokens - 500) }
            ]
        }

        const selectedHistory: Array<{ role: string; content: string }> = []

        // Iterate backwards
        for (let i = chatHistory.length - 1; i >= 0; i--) {
            const msg = chatHistory[i]
            const msgTokens = estimateTokens(msg.content)

            if (availableTokens >= msgTokens) {
                selectedHistory.unshift({
                    role: msg.role === 'tool' ? 'assistant' : msg.role,
                    content: msg.content
                })
                availableTokens -= msgTokens
            } else if (availableTokens > 100) {
                // Partial fit (keep at least 100 tokens)
                selectedHistory.unshift({
                    role: msg.role === 'tool' ? 'assistant' : msg.role,
                    content: '...(older content truncated)...\n' + truncateToTokens(msg.content, availableTokens)
                })
                break
            } else {
                break
            }
        }

        return [
            { role: 'system', content: systemPrompt },
            ...selectedHistory,
            { role: 'user', content: userMessage }
        ]
    }

    private makeAssistantMessage(content: string): { role: string; content: string } {
        return { role: 'assistant', content }
    }

    private makeUserMessage(content: string): { role: string; content: string } {
        return { role: 'user', content }
    }

    private async generateResponse(
        messages: Array<{ role: string; content: string }>,
        signal: AbortSignal
    ): Promise<string> {
        const maxRetries = 3
        let lastError: Error | null = null

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                if (this.useOfflineAI) {
                    return await this.generateOffline(messages, signal)
                } else {
                    return await this.generateCloud(messages, signal)
                }
            } catch (err) {
                // Don't retry on abort
                if (signal.aborted) throw err

                lastError = err instanceof Error ? err : new Error(String(err))
                const msg = lastError.message.toLowerCase()

                // Only retry on transient errors (network, rate limit, server errors)
                const isRetryable = msg.includes('fetch') || msg.includes('network') ||
                    msg.includes('429') || msg.includes('rate limit') ||
                    msg.includes('500') || msg.includes('502') || msg.includes('503') ||
                    msg.includes('timeout') || msg.includes('timed out')

                if (!isRetryable || attempt >= maxRetries) throw lastError

                // Exponential backoff: 1s, 2s
                const delay = Math.pow(2, attempt - 1) * 1000
                logger.agent.warn(`Generation attempt ${attempt} failed, retrying in ${delay}ms: ${lastError.message}`)
                await new Promise(resolve => setTimeout(resolve, delay))
            }
        }

        throw lastError || new Error('Generation failed after retries')
    }

    private async generateOffline(
        messages: Array<{ role: string; content: string }>,
        signal: AbortSignal
    ): Promise<string> {
        const loadedModelId = useModelStore.getState().loadedModelId
        if (!loadedModelId) throw new Error('No offline model loaded')

        // For offline, keep conversation history within context limits but generous enough for reasoning
        const trimmedMessages: OfflineChatMessage[] = [
            messages[0] as OfflineChatMessage, // system prompt
            ...messages.slice(-10).map(m => ({
                role: m.role as 'system' | 'user' | 'assistant',
                content: m.content
            }))
        ]

        // Let the model respond naturally — tool calls are parsed from the
        // ```tool markdown format defined in the system prompt. Grammar-forcing
        // JSON breaks natural text responses (final answers, clarifications).
        const options: any = {
            temperature: 0.3,
            maxTokens: 4096
        }

        const response = await new Promise<string>((resolve, reject) => {
            const onAbort = () => {
                offlineLLMService.cancelGeneration()
                reject(new Error('Aborted'))
            }
            signal.addEventListener('abort', onAbort, { once: true })

            offlineLLMService.generateStream(
                trimmedMessages,
                (token) => {
                    if (this.state) {
                        this.state.streamingText += token
                        this.emit({ type: 'streaming', text: this.state.streamingText })
                    }
                },
                options
            ).then(resolve).catch(reject).finally(() => {
                signal.removeEventListener('abort', onAbort)
            })
        })

        return response
    }

    private async generateCloud(
        messages: Array<{ role: string; content: string }>,
        signal: AbortSignal
    ): Promise<string> {
        const aiMessages: AIMessage[] = messages.map(m => ({
            role: m.role as 'system' | 'user' | 'assistant',
            content: m.content
        }))

        // Determine best model for agent tasks
        const options: any = {
            temperature: 0.3,
            maxTokens: 8192
        }

        // Use user-selected model if available, otherwise fall back to reliable defaults
        if (this.config.model) {
            options.model = this.config.model
        } else if (this.cloudProvider === 'openai') {
            options.model = 'gpt-4o'
        } else if (this.cloudProvider === 'anthropic') {
            options.model = 'claude-sonnet-5-5'
            // Adaptive thinking at the model's default effort
            options.thinking = true
        } else if (this.cloudProvider === 'google') {
            options.model = 'gemini-2.5-pro'
        }

        const response = await new Promise<string>((resolve, reject) => {
            const onAbort = () => {
                aiService.cancelStream()
                reject(new Error('Aborted'))
            }
            signal.addEventListener('abort', onAbort, { once: true })

            aiService.chatStream(
                aiMessages,
                {
                    onToken: (token: string) => {
                        if (this.state) {
                            this.state.streamingText += token
                            this.emit({ type: 'streaming', text: this.state.streamingText })
                        }
                    },
                    onComplete: (fullResponse: string) => {
                        signal.removeEventListener('abort', onAbort)
                        resolve(fullResponse)
                    },
                    onError: (error: string) => {
                        signal.removeEventListener('abort', onAbort)
                        reject(new Error(error))
                    }
                },
                this.cloudProvider,
                options
            )
        })

        return response
    }
}

export const agentLoopService = new AgentLoopService()
