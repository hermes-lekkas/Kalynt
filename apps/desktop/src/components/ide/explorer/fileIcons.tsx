/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Syntax-keyed file glyphs with subtle, restrained hues calibrated for both
 * dark and light Kalynt surfaces.
 */
import {
    Braces, Database, File, FileCode2, FileImage, FileJson, FileLock2, FileText,
    FileType2, Folder, FolderOpen, Package, Settings2, SquareTerminal, type LucideIcon
} from 'lucide-react'

const BY_EXTENSION: Record<string, LucideIcon> = {
    json: FileJson, jsonc: FileJson,
    md: FileText, mdx: FileText, txt: FileText, rst: FileText,
    png: FileImage, jpg: FileImage, jpeg: FileImage, gif: FileImage, svg: FileImage, webp: FileImage, ico: FileImage, bmp: FileImage,
    sql: Database, db: Database, sqlite: Database,
    sh: SquareTerminal, bash: SquareTerminal, zsh: SquareTerminal, ps1: SquareTerminal, bat: SquareTerminal,
    yaml: Settings2, yml: Settings2, toml: Settings2, ini: Settings2, env: Settings2, conf: Settings2,
    lock: FileLock2, pem: FileLock2, key: FileLock2,
    ttf: FileType2, otf: FileType2, woff: FileType2, woff2: FileType2,
    css: Braces, scss: Braces, less: Braces,
    zip: Package, tar: Package, gz: Package, tgz: Package, rar: Package, '7z': Package
}

const CODE = new Set([
    'ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs', 'py', 'rs', 'go', 'java', 'kt', 'c', 'h', 'cpp', 'hpp', 'cc',
    'cs', 'fs', 'rb', 'php', 'swift', 'dart', 'lua', 'r', 'pl', 'html', 'vue', 'svelte', 'xml', 'scala',
    'ex', 'exs', 'clj', 'jl', 'zig', 'nim', 'hs', 'ml', 'erl', 'groovy', 'graphql', 'gql'
])

const TONE_BY_EXTENSION: Record<string, string> = {
    ts: 'ts', mts: 'ts', cts: 'ts',
    tsx: 'tsx', jsx: 'tsx',
    js: 'js', mjs: 'js', cjs: 'js',
    css: 'css', scss: 'css', less: 'css',
    html: 'html', htm: 'html', vue: 'html', svelte: 'html', xml: 'html', svg: 'html',
    json: 'json', jsonc: 'json', yaml: 'json', yml: 'json', toml: 'json',
    md: 'md', mdx: 'md',
    py: 'py',
    rs: 'rust',
    go: 'go',
    sh: 'shell', bash: 'shell', zsh: 'shell', ps1: 'shell',
    png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', ico: 'image', bmp: 'image',
    sql: 'data', db: 'data', sqlite: 'data', graphql: 'data', gql: 'data'
}

export function fileIconTone(name: string): string | null {
    const lower = name.toLowerCase()
    if (lower === 'package.json' || lower === 'cargo.toml' || lower === 'go.mod') return 'json'
    if (lower.startsWith('.env') || lower === 'dockerfile' || lower === 'makefile') return 'config'
    const ext = lower.includes('.') ? lower.split('.').pop()! : ''
    return TONE_BY_EXTENSION[ext] ?? null
}

export function fileIcon(name: string): LucideIcon {
    const lower = name.toLowerCase()
    if (lower === 'package.json' || lower === 'cargo.toml' || lower === 'go.mod') return Package
    if (lower.startsWith('.env')) return Settings2
    if (lower === 'dockerfile' || lower === 'makefile') return Settings2
    const ext = lower.includes('.') ? lower.split('.').pop()! : ''
    if (BY_EXTENSION[ext]) return BY_EXTENSION[ext]
    if (CODE.has(ext)) return FileCode2
    return File
}

export function FileGlyph({ name, size = 15, className }: { name: string; size?: number; className?: string }) {
    const Icon = fileIcon(name)
    const tone = fileIconTone(name)
    const classes = [className, tone && `file-icon--${tone}`].filter(Boolean).join(' ')
    return <Icon size={size} className={classes} strokeWidth={1.6} aria-hidden />
}

export function FolderGlyph({ open, size = 15, className }: { open?: boolean; size?: number; className?: string }) {
    const Icon = open ? FolderOpen : Folder
    const classes = [className, 'file-icon--folder'].filter(Boolean).join(' ')
    return <Icon size={size} className={classes} strokeWidth={1.6} aria-hidden />
}
