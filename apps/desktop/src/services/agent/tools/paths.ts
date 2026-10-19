/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Path handling for agent tools. Models send paths relative to the workspace
 * (or absolute); the main process enforces that they stay inside it.
 */

const isWindows = () => window.electronAPI?.platform === 'win32'

export function isAbsolute(p: string): boolean {
    return p.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\\\')
}

function normalize(p: string): string {
    const sep = isWindows() ? '\\' : '/'
    const parts: string[] = []
    const absolutePrefix = /^[a-zA-Z]:[\\/]/.test(p) ? p.slice(0, 3) : p.startsWith('/') ? '/' : ''
    for (const part of p.slice(absolutePrefix.length).split(/[\\/]+/)) {
        if (!part || part === '.') continue
        if (part === '..') parts.pop()
        else parts.push(part)
    }
    return absolutePrefix + parts.join(sep)
}

/** Absolute path for a model-supplied path. */
export function resolvePath(workspace: string | null, p: unknown): string {
    const raw = String(p ?? '').trim().replace(/^["'`]|["'`]$/g, '')
    if (!raw || raw === '.') {
        if (!workspace) throw new Error('Open a folder first.')
        return workspace
    }
    if (isAbsolute(raw)) return normalize(raw)
    if (!workspace) throw new Error('Open a folder first, or give an absolute path.')
    return normalize(`${workspace}/${raw}`)
}

/** Workspace-relative path for display and for the model. */
export function relativePath(workspace: string | null, absolute: string): string {
    if (!workspace) return absolute
    const norm = (s: string) => s.replace(/\\/g, '/').replace(/\/+$/, '')
    const root = norm(workspace)
    const target = norm(absolute)
    if (target === root) return '.'
    return target.startsWith(`${root}/`) ? target.slice(root.length + 1) : absolute
}

export const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p
