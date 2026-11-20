/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
// main-process/terminalManager.ts
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import crypto from 'node:crypto'
import { validatePath } from '../utils/pathValidator'

const SAFE_SESSION_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/
const MAX_IMPORT_BYTES = 5 * 1024 * 1024 // 5 MB

export function isValidSessionId(sessionId: string): boolean {
    if (typeof sessionId !== 'string' || !sessionId) return false
    if (sessionId.includes('..') || sessionId.includes('/') || sessionId.includes('\\') || sessionId.includes('\0')) {
        return false
    }
    return SAFE_SESSION_ID.test(sessionId)
}

export interface TerminalSession {
    id: string
    title: string
    shell: string
    cwd: string
    env: { [key: string]: string }
    cols: number
    rows: number
    status: 'running' | 'stopped' | 'paused'
    processType: 'shell' | 'task' | 'debug'
    metadata: any
    createdAt: number
    lastActive: number
    history: string[]
    commandHistory: Array<{
        command: string
        timestamp: number
        exitCode?: number
    }>
}

export interface SessionGroup {
    id: string
    name: string
    sessionIds: string[]
    layout?: 'horizontal' | 'vertical' | 'grid'
    createdAt: number
}

export class TerminalSessionManager extends EventEmitter {
    private sessions = new Map<string, TerminalSession>()
    private groups = new Map<string, SessionGroup>()
    private sessionStoragePath: string

    constructor(storagePath?: string) {
        super()
        // Use app.getPath('userData') when no explicit path is provided
        this.sessionStoragePath = storagePath || path.join(app.getPath('userData'), 'terminal-sessions')

        // Ensure storage directory exists
        if (!fs.existsSync(this.sessionStoragePath)) {
            try {
                fs.mkdirSync(this.sessionStoragePath, { recursive: true })
            } catch (err) {
                console.error('[SessionManager] Failed to create sessions dir:', err)
            }
        }

        // Load saved sessions
        this.loadSessions()
    }

    /** Resolves `<sessionStoragePath>/<sessionId>.json` safely, rejecting path traversal. */
    private resolveSessionFile(sessionId: string): string | null {
        if (!isValidSessionId(sessionId)) {
            console.warn(`[SessionManager] Rejected invalid sessionId: ${String(sessionId).slice(0, 64)}`)
            return null
        }
        try {
            return validatePath(this.sessionStoragePath, `${sessionId}.json`)
        } catch (error) {
            console.warn('[SessionManager] Blocked unsafe session file path:', error)
            return null
        }
    }

    /**
     * Validates an export/import JSON path against allowed base directories
     * (the active workspace directory and the session storage directory).
     */
    private resolveTransferPath(targetPath: string, workspacePath?: string | null): string | null {
        if (typeof targetPath !== 'string' || !targetPath.trim() || targetPath.includes('\0')) {
            return null
        }
        if (!targetPath.toLowerCase().endsWith('.json')) {
            return null
        }

        const allowedBases = [workspacePath, this.sessionStoragePath].filter(
            (base): base is string => typeof base === 'string' && base.trim().length > 0
        )

        for (const base of allowedBases) {
            try {
                return validatePath(base, targetPath)
            } catch {
                // Try next allowed base directory
            }
        }
        return null
    }

    createSession(options: {
        id?: string
        title?: string
        shell: string
        cwd: string
        env?: { [key: string]: string }
        cols?: number
        rows?: number
        processType?: 'shell' | 'task' | 'debug'
        metadata?: any
    }): TerminalSession {
        const sessionId =
            options.id ||
            `session_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`

        if (!isValidSessionId(sessionId)) {
            throw new Error(`Invalid session id: ${sessionId}`)
        }

        const now = Date.now()

        const session: TerminalSession = {
            id: sessionId,
            title: options.title || `Terminal ${sessionId}`,
            shell: options.shell,
            cwd: options.cwd,
            env: options.env || {},
            cols: options.cols || 80,
            rows: options.rows || 24,
            status: 'running',
            processType: options.processType || 'shell',
            metadata: options.metadata || {},
            createdAt: now,
            lastActive: now,
            history: [],
            commandHistory: []
        }

        this.sessions.set(sessionId, session)
        this.emit('session_created', session)

        // Auto-save session
        this.saveSession(sessionId)

        return session
    }

    getSession(sessionId: string): TerminalSession | undefined {
        if (!isValidSessionId(sessionId)) return undefined
        return this.sessions.get(sessionId)
    }

    updateSession(sessionId: string, updates: Partial<TerminalSession>): boolean {
        if (!isValidSessionId(sessionId)) return false
        const session = this.sessions.get(sessionId)
        if (!session) return false

        // Prevent mutating session id via updates
        const { id: _ignoredId, ...safeUpdates } = updates
        Object.assign(session, safeUpdates)
        session.lastActive = Date.now()

        this.emit('session_updated', { sessionId, updates: safeUpdates })
        this.saveSession(sessionId)

        return true
    }

    addToSessionHistory(sessionId: string, data: string): boolean {
        const session = this.getSession(sessionId)
        if (!session) return false

        session.history.push(data)
        session.lastActive = Date.now()

        if (session.history.length > 10000) {
            session.history = session.history.slice(-10000)
        }

        return true
    }

    addToCommandHistory(sessionId: string, command: string, exitCode?: number): boolean {
        const session = this.getSession(sessionId)
        if (!session) return false

        session.commandHistory.push({
            command,
            timestamp: Date.now(),
            exitCode
        })

        if (session.commandHistory.length > 1000) {
            session.commandHistory = session.commandHistory.slice(-1000)
        }

        this.saveSession(sessionId)
        return true
    }

    pauseSession(sessionId: string): boolean {
        return this.updateSession(sessionId, { status: 'paused' })
    }

    resumeSession(sessionId: string): boolean {
        return this.updateSession(sessionId, { status: 'running' })
    }

    stopSession(sessionId: string): boolean {
        return this.updateSession(sessionId, { status: 'stopped' })
    }

    deleteSession(sessionId: string): boolean {
        const sessionFile = this.resolveSessionFile(sessionId)
        if (!sessionFile) return false

        const session = this.sessions.get(sessionId)
        if (!session) return false

        this.sessions.delete(sessionId)
        this.emit('session_deleted', sessionId)

        if (fs.existsSync(sessionFile)) {
            fs.unlinkSync(sessionFile)
        }

        return true
    }

    getAllSessions(): TerminalSession[] {
        return Array.from(this.sessions.values())
    }

    getActiveSessions(): TerminalSession[] {
        return this.getAllSessions().filter(s => s.status === 'running')
    }

    createGroup(name: string, sessionIds: string[], layout?: 'horizontal' | 'vertical' | 'grid'): SessionGroup {
        const groupId = `group_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`

        const group: SessionGroup = {
            id: groupId,
            name,
            sessionIds,
            layout,
            createdAt: Date.now()
        }

        this.groups.set(groupId, group)
        this.emit('group_created', group)

        return group
    }

    addToGroup(groupId: string, sessionId: string): boolean {
        const group = this.groups.get(groupId)
        if (!group) return false

        if (!group.sessionIds.includes(sessionId)) {
            group.sessionIds.push(sessionId)
            this.emit('group_updated', { groupId, sessionId, action: 'added' })
            return true
        }

        return false
    }

    removeFromGroup(groupId: string, sessionId: string): boolean {
        const group = this.groups.get(groupId)
        if (!group) return false

        const index = group.sessionIds.indexOf(sessionId)
        if (index !== -1) {
            group.sessionIds.splice(index, 1)
            this.emit('group_updated', { groupId, sessionId, action: 'removed' })
            return true
        }

        return false
    }

    getGroup(groupId: string): SessionGroup | undefined {
        return this.groups.get(groupId)
    }

    getAllGroups(): SessionGroup[] {
        return Array.from(this.groups.values())
    }

    deleteGroup(groupId: string): boolean {
        const group = this.groups.get(groupId)
        if (!group) return false

        this.groups.delete(groupId)
        this.emit('group_deleted', groupId)

        return true
    }

    saveSession(sessionId: string): boolean {
        const sessionFile = this.resolveSessionFile(sessionId)
        if (!sessionFile) return false

        const session = this.sessions.get(sessionId)
        if (!session) return false

        try {
            const sessionData = {
                ...session,
                // Don't save full history to disk to avoid large files
                history: [],
                commandHistory: session.commandHistory.slice(-100)
            }

            fs.writeFileSync(sessionFile, JSON.stringify(sessionData, null, 2))
            return true
        } catch (error) {
            console.error(`[SessionManager] Error saving session ${sessionId}:`, error)
            return false
        }
    }

    loadSession(sessionId: string): TerminalSession | null {
        const sessionFile = this.resolveSessionFile(sessionId)
        if (!sessionFile) return null

        try {
            if (!fs.existsSync(sessionFile)) return null

            const sessionData = JSON.parse(fs.readFileSync(sessionFile, 'utf8'))
            if (!sessionData || typeof sessionData !== 'object') return null

            const session: TerminalSession = {
                ...sessionData,
                id: sessionId,
                status: 'stopped', // Sessions are stopped when loaded from disk
                history: [],
                commandHistory: Array.isArray(sessionData.commandHistory) ? sessionData.commandHistory : [],
                lastActive: Date.now()
            }

            this.sessions.set(sessionId, session)
            return session
        } catch (error) {
            console.error(`[SessionManager] Error loading session ${sessionId}:`, error)
            return null
        }
    }

    private loadSessions(): void {
        try {
            if (!fs.existsSync(this.sessionStoragePath)) return
            const files = fs.readdirSync(this.sessionStoragePath)

            for (const file of files) {
                if (file.endsWith('.json')) {
                    const sessionId = path.basename(file, '.json')
                    if (isValidSessionId(sessionId)) {
                        this.loadSession(sessionId)
                    }
                }
            }
        } catch (error) {
            console.error('[SessionManager] Error loading sessions:', error)
        }
    }

    exportSession(sessionId: string, exportPath: string, workspacePath?: string | null): boolean {
        if (!isValidSessionId(sessionId)) return false
        const session = this.sessions.get(sessionId)
        if (!session) return false

        const validatedPath = this.resolveTransferPath(exportPath, workspacePath)
        if (!validatedPath) {
            console.warn('[SessionManager] Blocked unsafe export path:', exportPath)
            return false
        }

        try {
            const exportData = {
                session,
                exportDate: new Date().toISOString(),
                version: '1.0.0',
                app: 'Kalynt Terminal'
            }

            fs.mkdirSync(path.dirname(validatedPath), { recursive: true })
            fs.writeFileSync(validatedPath, JSON.stringify(exportData, null, 2))
            return true
        } catch (error) {
            console.error(`[SessionManager] Error exporting session ${sessionId}:`, error)
            return false
        }
    }

    importSession(importPath: string, workspacePath?: string | null): string | null {
        const validatedPath = this.resolveTransferPath(importPath, workspacePath)
        if (!validatedPath) {
            console.warn('[SessionManager] Blocked unsafe import path:', importPath)
            return null
        }

        try {
            if (!fs.existsSync(validatedPath)) return null

            const stat = fs.statSync(validatedPath)
            if (!stat.isFile() || stat.size > MAX_IMPORT_BYTES) {
                throw new Error('Invalid session file size')
            }

            const importData = JSON.parse(fs.readFileSync(validatedPath, 'utf8'))

            if (!importData || importData.app !== 'Kalynt Terminal' || !importData.session || typeof importData.session !== 'object') {
                throw new Error('Invalid session file format')
            }

            const raw = importData.session as Partial<TerminalSession>
            const safeSuffix = String(raw.id || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 32)
            const newSessionId = `imported_${Date.now()}_${crypto.randomBytes(4).toString('hex')}${safeSuffix ? `_${safeSuffix}` : ''}`

            const session: TerminalSession = {
                id: newSessionId,
                title: typeof raw.title === 'string' ? raw.title : `Imported ${newSessionId}`,
                shell: typeof raw.shell === 'string' ? raw.shell : '',
                cwd: typeof raw.cwd === 'string' ? raw.cwd : '',
                env: raw.env && typeof raw.env === 'object' && !Array.isArray(raw.env) ? raw.env : {},
                cols: typeof raw.cols === 'number' && raw.cols > 0 ? raw.cols : 80,
                rows: typeof raw.rows === 'number' && raw.rows > 0 ? raw.rows : 24,
                status: 'stopped',
                processType: raw.processType === 'task' || raw.processType === 'debug' ? raw.processType : 'shell',
                metadata: raw.metadata && typeof raw.metadata === 'object' ? raw.metadata : {},
                createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : Date.now(),
                lastActive: Date.now(),
                history: [],
                commandHistory: Array.isArray(raw.commandHistory) ? raw.commandHistory.slice(-100) : []
            }

            this.sessions.set(newSessionId, session)
            this.saveSession(newSessionId)

            return newSessionId
        } catch (error) {
            console.error('[SessionManager] Error importing session:', error)
            return null
        }
    }

    clearOldSessions(maxAgeHours: number = 24): number {
        const cutoff = Date.now() - (maxAgeHours * 60 * 60 * 1000)
        let count = 0

        for (const [sessionId, session] of this.sessions) {
            if (session.lastActive < cutoff && session.status === 'stopped') {
                this.deleteSession(sessionId)
                count++
            }
        }

        return count
    }

    getSessionStats() {
        const sessions = this.getAllSessions()

        return {
            total: sessions.length,
            running: sessions.filter(s => s.status === 'running').length,
            stopped: sessions.filter(s => s.status === 'stopped').length,
            paused: sessions.filter(s => s.status === 'paused').length,
            byShell: sessions.reduce((acc, session) => {
                acc[session.shell] = (acc[session.shell] || 0) + 1
                return acc
            }, {} as Record<string, number>),
            byType: sessions.reduce((acc, session) => {
                acc[session.processType] = (acc[session.processType] || 0) + 1
                return acc
            }, {} as Record<string, number>)
        }
    }

    dispose(): void {
        for (const sessionId of this.sessions.keys()) {
            this.saveSession(sessionId)
        }

        this.sessions.clear()
        this.groups.clear()
        this.removeAllListeners()
    }
}
