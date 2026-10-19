/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { isValidElement, type ReactNode } from 'react'
import {
    AlignLeft, ArrowDown, ArrowUp, Bot, Bug, ChevronRight, Code2, Columns2, Cpu, FilePlus, Files, FolderOpen, FolderX,
    GitBranch, GitCommit, Hammer, Hash, History, LayoutGrid, ListTodo, LogIn, Map as MapIcon, MessageSquare, MessageSquarePlus,
    MessagesSquare, PanelLeft, PanelRight, Pin, Play, Plus, Puzzle, RefreshCw, RotateCw, Save, Search, Settings,
    Share2, Sparkles, Square, SunMoon, TerminalSquare, UserPlus, Users, WrapText, X, type LucideIcon
} from 'lucide-react'

const ICONS: Record<string, LucideIcon> = {
    AlignLeft, ArrowDown, ArrowUp, Bot, Bug, Code2, Columns2, Cpu, FilePlus, Files, FolderOpen, FolderX, GitBranch,
    GitCommit, Hammer, Hash, History, LayoutGrid, ListTodo, LogIn, Map: MapIcon, MessageSquare, MessageSquarePlus,
    MessagesSquare, PanelLeft, PanelRight, Pin, Play, Plus, Puzzle, RefreshCw, RotateCw, Save, Search, Settings,
    Share2, Sparkles, Square, SunMoon, TerminalSquare, UserPlus, Users, WrapText, X,
    Folder: FolderOpen, Terminal: TerminalSquare, CheckCircle2: GitCommit, Lightbulb: Sparkles, Wrench: Sparkles,
    MoveVertical: Hash
}

/** Renders a command's icon given as a Lucide name or an element. */
export function CommandIcon({ icon }: { icon?: string | ReactNode }) {
    if (isValidElement(icon)) return icon
    const Icon = typeof icon === 'string' ? ICONS[icon] ?? ChevronRight : ChevronRight
    return <Icon size={15} strokeWidth={1.6} />
}
