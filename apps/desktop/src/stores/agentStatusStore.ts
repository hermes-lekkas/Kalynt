/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * What the agent is doing right now, for surfaces outside the agent panel
 * (status bar, title bar).
 */
import { create } from 'zustand'

export type AgentActivity = 'idle' | 'thinking' | 'working' | 'waiting-approval' | 'scanning'

interface AgentStatusState {
    activity: AgentActivity
    /** Human-readable model name, e.g. "Claude 3.5 Sonnet" or "Qwen 2.5 7B (local)". */
    model: string | null
    step: { current: number; max: number } | null
    setActivity: (activity: AgentActivity) => void
    setModel: (model: string | null) => void
    setStep: (step: { current: number; max: number } | null) => void
}

export const useAgentStatusStore = create<AgentStatusState>(set => ({
    activity: 'idle',
    model: null,
    step: null,
    setActivity: activity => set({ activity }),
    setModel: model => set({ model }),
    setStep: step => set({ step })
}))
