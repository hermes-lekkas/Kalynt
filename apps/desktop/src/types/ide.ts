/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import type { ReactNode } from 'react'

export type IDECommandCategory = 'file' | 'edit' | 'view' | 'terminal' | 'git' | 'ai' | 'workspace'

/** A command reachable from the command palette. */
export interface IDECommand {
    id: string
    title: string
    shortcut?: string
    category: IDECommandCategory
    action: () => void | Promise<void>
    /** Lucide icon name (string) or a rendered icon. */
    icon?: string | ReactNode
}

export interface FileItem {
    path: string
    name: string
    type: 'file' | 'directory'
}

export interface OpenFile {
    path: string
    name: string
    content: string
    language: string
    isDirty: boolean
}
