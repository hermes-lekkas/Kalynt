/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Build tasks and the debugger.
 */
import { ipcRenderer, type IpcRendererEvent } from 'electron'
import { subscribe } from './subscribe'

export const toolsApi = {

    // ==========================================
    // Build/Task APIs (Enhanced)
    // ==========================================
    build: {
        getTasks: (workspacePath: string) => ipcRenderer.invoke('build:getTasks', workspacePath),
        executeTask: (task: any, workspacePath: string) => ipcRenderer.invoke('build:executeTask', task, workspacePath),
        killTask: (taskId: string) => ipcRenderer.invoke('build:killTask', taskId),
        onOutput: (callback: (data: any) => void) => {
            const subscription = (_event: IpcRendererEvent, data: any) => callback(data)
            ipcRenderer.on('build:output', subscription)
            return () => {
                ipcRenderer.removeListener('build:output', subscription)
            }
        },
        onEnd: (callback: (data: any) => void) => {
            const subscription = (_event: IpcRendererEvent, data: any) => callback(data)
            ipcRenderer.on('build:end', subscription)
            return () => {
                ipcRenderer.removeListener('build:end', subscription)
            }
        },
        onProblems: (callback: (data: any) => void) => {
            const subscription = (_event: IpcRendererEvent, data: any) => callback(data)
            ipcRenderer.on('build:problems', subscription)
            return () => {
                ipcRenderer.removeListener('build:problems', subscription)
            }
        },
        removeListeners: () => {
            ipcRenderer.removeAllListeners('build:output')
            ipcRenderer.removeAllListeners('build:end')
            ipcRenderer.removeAllListeners('build:problems')
        }
    },

    // ==========================================
    // Debug APIs (Enhanced)
    // ==========================================
    debug: {
        getConfigurations: (workspacePath: string) => ipcRenderer.invoke('debug:getConfigurations', workspacePath),
        start: (configuration: any, workspacePath: string, activeFile?: string, breakpoints?: { file: string; lines: number[] }[]) => ipcRenderer.invoke('debug:start', configuration, workspacePath, activeFile, breakpoints),
        stop: (sessionId: string) => ipcRenderer.invoke('debug:stop', sessionId),
        setBreakpoints: (sessionId: string, file: string, breakpoints: any) => ipcRenderer.invoke('debug:setBreakpoints', sessionId, file, breakpoints),
        continue: (sessionId: string, threadId?: number) => ipcRenderer.invoke('debug:continue', sessionId, threadId),
        stepOver: (sessionId: string, threadId?: number) => ipcRenderer.invoke('debug:stepOver', sessionId, threadId),
        stepInto: (sessionId: string, threadId?: number) => ipcRenderer.invoke('debug:stepInto', sessionId, threadId),
        stepOut: (sessionId: string, threadId?: number) => ipcRenderer.invoke('debug:stepOut', sessionId, threadId),
        pause: (sessionId: string, threadId?: number) => ipcRenderer.invoke('debug:pause', sessionId, threadId),
        getCallStack: (sessionId: string, threadId?: number) => ipcRenderer.invoke('debug:getCallStack', sessionId, threadId),
        getVariables: (sessionId: string, variablesReference: number) => ipcRenderer.invoke('debug:getVariables', sessionId, variablesReference),
        evaluate: (sessionId: string, expression: string, frameId?: number) => ipcRenderer.invoke('debug:evaluate', sessionId, expression, frameId),
        addWatch: (sessionId: string, expression: string) => ipcRenderer.invoke('debug:addWatch', sessionId, expression),
        removeWatch: (sessionId: string, watchId: string) => ipcRenderer.invoke('debug:removeWatch', sessionId, watchId),
        getWatches: (sessionId: string) => ipcRenderer.invoke('debug:getWatches', sessionId),
        updateWatches: (sessionId: string, frameId?: number) => ipcRenderer.invoke('debug:updateWatches', sessionId, frameId),
        clearWatches: (sessionId: string) => ipcRenderer.invoke('debug:clearWatches', sessionId),
        onStarted: (callback: (data: any) => void) => {
            const subscription = (_event: IpcRendererEvent, data: any) => callback(data)
            ipcRenderer.on('debug:started', subscription)
            return () => {
                ipcRenderer.removeListener('debug:started', subscription)
            }
        },
        onStopped: (callback: (data: any) => void) => {
            const subscription = (_event: IpcRendererEvent, data: any) => callback(data)
            ipcRenderer.on('debug:stopped', subscription)
            return () => {
                ipcRenderer.removeListener('debug:stopped', subscription)
            }
        },
        onContinued: (callback: (data: any) => void) => {
            const subscription = (_event: IpcRendererEvent, data: any) => callback(data)
            ipcRenderer.on('debug:continued', subscription)
            return () => {
                ipcRenderer.removeListener('debug:continued', subscription)
            }
        },
        onTerminated: (callback: (data: any) => void) => {
            const subscription = (_event: IpcRendererEvent, data: any) => callback(data)
            ipcRenderer.on('debug:terminated', subscription)
            return () => {
                ipcRenderer.removeListener('debug:terminated', subscription)
            }
        },
        onOutput: (callback: (data: any) => void) => {
            const subscription = (_event: IpcRendererEvent, data: any) => callback(data)
            ipcRenderer.on('debug:output', subscription)
            return () => {
                ipcRenderer.removeListener('debug:output', subscription)
            }
        },
        onBreakpoint: (callback: (data: any) => void) => {
            const subscription = (_event: IpcRendererEvent, data: any) => callback(data)
            ipcRenderer.on('debug:breakpoint', subscription)
            return () => {
                ipcRenderer.removeListener('debug:breakpoint', subscription)
            }
        },
        onEvent: (callback: (event: any) => void) => {
            const subscription = (_event: IpcRendererEvent, event: any) => callback(event)
            ipcRenderer.on('debug:event', subscription)
            return () => {
                ipcRenderer.removeListener('debug:event', subscription)
            }
        },
        onResponse: (callback: (response: any) => void) => {
            const subscription = (_event: IpcRendererEvent, response: any) => callback(response)
            ipcRenderer.on('debug:response', subscription)
            return () => {
                ipcRenderer.removeListener('debug:response', subscription)
            }
        },
        onError: (callback: (data: any) => void) => {
            const subscription = (_event: IpcRendererEvent, data: any) => callback(data)
            ipcRenderer.on('debug:error', subscription)
            return () => {
                ipcRenderer.removeListener('debug:error', subscription)
            }
        },
        onAdapterMissing: (callback: (data: { type: string, requiredBinary: string, installInstructions: string }) => void) => {
            const subscription = (_event: IpcRendererEvent, data: any) => callback(data)
            ipcRenderer.on('debug:adapter-missing', subscription)
            return () => {
                ipcRenderer.removeListener('debug:adapter-missing', subscription)
            }
        },
        removeListeners: () => {
            ipcRenderer.removeAllListeners('debug:started')
            ipcRenderer.removeAllListeners('debug:stopped')
            ipcRenderer.removeAllListeners('debug:continued')
            ipcRenderer.removeAllListeners('debug:terminated')
            ipcRenderer.removeAllListeners('debug:output')
            ipcRenderer.removeAllListeners('debug:breakpoint')
            ipcRenderer.removeAllListeners('debug:event')
            ipcRenderer.removeAllListeners('debug:response')
            ipcRenderer.removeAllListeners('debug:error')
            ipcRenderer.removeAllListeners('debug:adapter-missing')
        }
    }
}
