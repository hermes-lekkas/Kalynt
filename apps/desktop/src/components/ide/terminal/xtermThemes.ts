/*
 * SPDX-License-Identifier: AGPL-3.0-only
 * Terminal palettes matched to the editor themes.
 */
import type { ITheme } from '@xterm/xterm'

export const TERMINAL_DARK: ITheme = {
    background: '#15141a',
    foreground: '#e4e2eb',
    cursor: '#a48dff',
    cursorAccent: '#15141a',
    selectionBackground: 'rgba(139, 108, 255, 0.35)',
    black: '#2b2a33',
    red: '#f0616d',
    green: '#4cc38a',
    yellow: '#e9b44c',
    blue: '#6fa8f5',
    magenta: '#b69cff',
    cyan: '#5fc7d4',
    white: '#b0adbd',
    brightBlack: '#5e5b6b',
    brightRed: '#ff8a94',
    brightGreen: '#79dbab',
    brightYellow: '#f5cd7a',
    brightBlue: '#9cc4fa',
    brightMagenta: '#cdbbff',
    brightCyan: '#8fdbe4',
    brightWhite: '#f6f5fa'
}

export const TERMINAL_LIGHT: ITheme = {
    background: '#ffffff',
    foreground: '#1c1b23',
    cursor: '#5b3dd9',
    cursorAccent: '#ffffff',
    selectionBackground: 'rgba(106, 75, 232, 0.22)',
    black: '#1c1b23',
    red: '#c9303e',
    green: '#1f8f5c',
    yellow: '#a86a00',
    blue: '#2563c9',
    magenta: '#5b3dd9',
    cyan: '#0f7f8c',
    white: '#a3a0b3',
    brightBlack: '#6b6880',
    brightRed: '#e0485a',
    brightGreen: '#27a86d',
    brightYellow: '#c27c00',
    brightBlue: '#3b7be0',
    brightMagenta: '#7a5cf0',
    brightCyan: '#1597a6',
    brightWhite: '#4a4759'
}

export const TERMINAL_FONT = "'JetBrains Mono Variable', 'JetBrains Mono', ui-monospace, Menlo, Consolas, monospace"
