/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
// main-process/shellIntegration.ts
import type { IPty } from 'node-pty'
import { EventEmitter } from 'node:events'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const MAX_OUTPUT_BUFFER = 64 * 1024
const MAX_PENDING_OSC_BUFFER = 16 * 1024
const OSC_633_PREFIX = '\x1b]633;'

export interface ShellIntegrationData {
    type: 'command_start' | 'command_end' | 'cwd_change' | 'prompt' | 'continuation'
    timestamp: number
    terminalId: string
    data?: any
}

export interface CommandRecord {
    id: string
    terminalId: string
    command: string
    cwd: string
    startTime: number
    endTime?: number
    exitCode?: number
    output?: string
    hasOutput: boolean
    decorations?: Array<{
        line: number
        column: number
        length: number
        type: 'error' | 'warning' | 'info' | 'success'
        message?: string
    }>
}

export interface SpawnIntegrationConfig {
    args: string[]
    env: Record<string, string>
}

export function sanitizeTerminalId(terminalId: string): string {
    const cleaned = String(terminalId || '')
        .replace(/[^a-zA-Z0-9_-]/g, '_')
        .slice(0, 48)
    return cleaned || 'term'
}

function shellKind(shell: string): 'bash' | 'zsh' | 'fish' | 'pwsh' | 'unknown' {
    const base = path.basename(shell || '').toLowerCase().replace(/\.(exe|cmd|bat)$/i, '')
    if (base === 'bash') return 'bash'
    if (base === 'zsh') return 'zsh'
    if (base === 'fish') return 'fish'
    if (base === 'pwsh' || base === 'powershell') return 'pwsh'
    return 'unknown'
}

function unescapeOscField(value: string): string {
    return value
        .replace(/\\x3b/gi, ';')
        .replace(/\\n/g, '\n')
        .replace(/\\\\/g, '\\')
}

export function buildShellIntegrationScript(shell: string): string {
    const kind = shellKind(shell)

    if (kind === 'bash') {
        return [
            '# Kalynt Bash Shell Integration (OSC 633)',
            '__kalynt_in_prompt=1',
            '__kalynt_in_command=0',
            '__kalynt_last_status=0',
            '__kalynt_escape() {',
            '  local s="$1"',
            '  s="${s//\\\\/\\\\\\\\}"',
            '  s="${s//$\'\\n\'/\\\\n}"',
            '  s="${s//;/\\\\x3b}"',
            '  printf \'%s\' "$s"',
            '}',
            '__kalynt_preexec() {',
            '  [[ -n "${__kalynt_in_prompt:-}" ]] && return',
            '  [[ "${BASH_COMMAND:-}" == "__kalynt_"* ]] && return',
            '  if [[ "$__kalynt_in_command" == "0" ]]; then',
            '    __kalynt_in_command=1',
            '    local __kalynt_cmd="$BASH_COMMAND"',
            '    printf \'\\033]633;A;%s\\007\' "$PWD"',
            '    printf \'\\033]633;B;%s\\007\' "$(__kalynt_escape "$__kalynt_cmd")"',
            '    printf \'\\033]633;C;%s\\007\' "$PWD"',
            '  fi',
            '}',
            '__kalynt_cmd_end() {',
            '  __kalynt_last_status=$?',
            '  __kalynt_in_prompt=1',
            '  if [[ "$__kalynt_in_command" == "1" ]]; then',
            '    __kalynt_in_command=0',
            '    printf \'\\033]633;E;%s\\007\' "$__kalynt_last_status"',
            '    printf \'\\033]633;D;%s\\007\' "$__kalynt_last_status"',
            '  fi',
            '  printf \'\\033]633;C;%s\\007\' "$PWD"',
            '  printf \'\\033]633;P\\007\'',
            '  return "$__kalynt_last_status"',
            '}',
            '__kalynt_prompt_end() {',
            '  __kalynt_in_prompt=""',
            '  return "$__kalynt_last_status"',
            '}',
            'if [[ "$(declare -p PROMPT_COMMAND 2>/dev/null)" == "declare -a"* ]]; then',
            '  PROMPT_COMMAND=(__kalynt_cmd_end "${PROMPT_COMMAND[@]}" __kalynt_prompt_end)',
            'elif [[ -z "${PROMPT_COMMAND:-}" ]]; then',
            '  PROMPT_COMMAND="__kalynt_cmd_end; __kalynt_prompt_end"',
            'elif [[ "$PROMPT_COMMAND" != *"__kalynt_cmd_end"* ]]; then',
            '  PROMPT_COMMAND="__kalynt_cmd_end; ${PROMPT_COMMAND}; __kalynt_prompt_end"',
            'fi',
            'trap \'__kalynt_preexec\' DEBUG',
            ''
        ].join('\n')
    }

    if (kind === 'zsh') {
        return [
            '# Kalynt Zsh Shell Integration (OSC 633)',
            '__kalynt_in_command=0',
            '__kalynt_preexec() {',
            '  __kalynt_in_command=1',
            '  local cmd="$1"',
            '  cmd="${cmd//\\\\/\\\\\\\\}"',
            '  cmd="${cmd//$\'\\n\'/\\\\n}"',
            '  cmd="${cmd//;/\\\\x3b}"',
            '  printf \'\\033]633;A;%s\\007\' "$PWD"',
            '  printf \'\\033]633;B;%s\\007\' "$cmd"',
            '  printf \'\\033]633;C;%s\\007\' "$PWD"',
            '}',
            '__kalynt_precmd() {',
            '  local exit_code=$?',
            '  if [[ "$__kalynt_in_command" == "1" ]]; then',
            '    __kalynt_in_command=0',
            '    printf \'\\033]633;E;%s\\007\' "$exit_code"',
            '    printf \'\\033]633;D;%s\\007\' "$exit_code"',
            '  fi',
            '  printf \'\\033]633;C;%s\\007\' "$PWD"',
            '  printf \'\\033]633;P\\007\'',
            '  return $exit_code',
            '}',
            'autoload -Uz add-zsh-hook',
            'add-zsh-hook preexec __kalynt_preexec',
            'add-zsh-hook precmd __kalynt_precmd',
            ''
        ].join('\n')
    }

    if (kind === 'fish') {
        return [
            '# Kalynt Fish Shell Integration (OSC 633)',
            'function __kalynt_preexec --on-event fish_preexec',
            '  set -l cmd (string replace -a "\\" "\\\\" -- "$argv[1]" | string replace -a ";" "\\x3b")',
            '  printf "\\033]633;A;%s\\007" "$PWD"',
            '  printf "\\033]633;B;%s\\007" "$cmd"',
            '  printf "\\033]633;C;%s\\007" "$PWD"',
            'end',
            'function __kalynt_postexec --on-event fish_postexec',
            '  set -l exit_code $status',
            '  printf "\\033]633;E;%s\\007" "$exit_code"',
            '  printf "\\033]633;D;%s\\007" "$exit_code"',
            '  printf "\\033]633;C;%s\\007" "$PWD"',
            '  printf "\\033]633;P\\007"',
            'end',
            ''
        ].join('\n')
    }

    if (kind === 'pwsh') {
        return [
            '# Kalynt PowerShell Shell Integration (OSC 633)',
            '$Global:__KalyntOrigPrompt = $function:prompt',
            'function global:prompt {',
            '  $exitCode = if ($?) { 0 } elseif ($null -ne $LASTEXITCODE) { $LASTEXITCODE } else { 1 }',
            '  $esc = [char]27; $bel = [char]7',
            '  [Console]::Write("${esc}]633;E;${exitCode}${bel}${esc}]633;D;${exitCode}${bel}${esc}]633;C;$($PWD.Path)${bel}${esc}]633;P${bel}")',
            '  if ($Global:__KalyntOrigPrompt) { & $Global:__KalyntOrigPrompt } else { "PS $($executionContext.SessionState.Path.CurrentLocation)$(\'>\' * ($nestedPromptLevel + 1)) " }',
            '}',
            ''
        ].join('\n')
    }

    return ''
}

function trailingPartialOscLength(text: string): number {
    const maxLen = Math.min(text.length, OSC_633_PREFIX.length - 1)
    for (let len = maxLen; len > 0; len--) {
        if (text.endsWith(OSC_633_PREFIX.slice(0, len))) {
            return len
        }
    }
    return 0
}

export class ShellIntegrationService extends EventEmitter {
    private readonly integrations = new Map<string, ShellIntegration>()
    private readonly commandHistory = new Map<string, CommandRecord[]>()
    private readonly spawnCleanups = new Map<string, () => void>()
    private readonly maxCommandHistory = 1000

    constructor() {
        super()
    }

    /**
     * Prepares clean launch arguments & environment for shell integration
     * (Bash `--rcfile`, Zsh `ZDOTDIR`) instead of writing unquoted commands
     * into the PTY after a timer.
     */
    prepareSpawn(
        terminalId: string,
        shell: string,
        baseEnv: Record<string, string>
    ): SpawnIntegrationConfig {
        this.cleanupSpawnArtifacts(terminalId)

        const kind = shellKind(shell)
        const script = buildShellIntegrationScript(shell)
        if (!script || (kind !== 'bash' && kind !== 'zsh')) {
            return { args: [], env: { ...baseEnv } }
        }

        const safeId = sanitizeTerminalId(terminalId)
        const nonce = crypto.randomBytes(6).toString('hex')
        const tempRoot = os.tmpdir()

        try {
            if (kind === 'bash') {
                const rcFile = path.join(tempRoot, `kalynt-bash-${safeId}-${nonce}.bashrc`)
                const rcContent = [
                    '# Kalynt Bash wrapper rcfile',
                    '[ -f /etc/bash.bashrc ] && . /etc/bash.bashrc',
                    '[ -f "$HOME/.bashrc" ] && . "$HOME/.bashrc"',
                    script
                ].join('\n')
                fs.writeFileSync(rcFile, rcContent, { mode: 0o600 })
                this.spawnCleanups.set(terminalId, () => {
                    try { fs.rmSync(rcFile, { force: true }) } catch { /* ignore */ }
                })
                return {
                    args: ['--rcfile', rcFile],
                    env: { ...baseEnv }
                }
            }

            if (kind === 'zsh') {
                const zdotDir = path.join(tempRoot, `kalynt-zsh-${safeId}-${nonce}`)
                fs.mkdirSync(zdotDir, { recursive: true, mode: 0o700 })

                const zshenvContent = [
                    '__kalynt_orig_zdotdir="${KALYNT_ZDOTDIR_ORIG:-$HOME}"',
                    'if [[ -f "$__kalynt_orig_zdotdir/.zshenv" ]]; then',
                    '  ZDOTDIR="$__kalynt_orig_zdotdir" source "$__kalynt_orig_zdotdir/.zshenv"',
                    'fi',
                    ''
                ].join('\n')

                const zprofileContent = [
                    '__kalynt_orig_zdotdir="${KALYNT_ZDOTDIR_ORIG:-$HOME}"',
                    'if [[ -f "$__kalynt_orig_zdotdir/.zprofile" ]]; then',
                    '  ZDOTDIR="$__kalynt_orig_zdotdir" source "$__kalynt_orig_zdotdir/.zprofile"',
                    'fi',
                    ''
                ].join('\n')

                const zshrcContent = [
                    '__kalynt_orig_zdotdir="${KALYNT_ZDOTDIR_ORIG:-$HOME}"',
                    'if [[ -n "${KALYNT_ZDOTDIR_ORIG:-}" ]]; then',
                    '  export ZDOTDIR="$KALYNT_ZDOTDIR_ORIG"',
                    'else',
                    '  unset ZDOTDIR',
                    'fi',
                    'unset KALYNT_ZDOTDIR_ORIG',
                    'if [[ -f "$__kalynt_orig_zdotdir/.zshrc" ]]; then',
                    '  source "$__kalynt_orig_zdotdir/.zshrc"',
                    'fi',
                    'unset __kalynt_orig_zdotdir',
                    script
                ].join('\n')

                fs.writeFileSync(path.join(zdotDir, '.zshenv'), zshenvContent, { mode: 0o600 })
                fs.writeFileSync(path.join(zdotDir, '.zprofile'), zprofileContent, { mode: 0o600 })
                fs.writeFileSync(path.join(zdotDir, '.zshrc'), zshrcContent, { mode: 0o600 })

                this.spawnCleanups.set(terminalId, () => {
                    try { fs.rmSync(zdotDir, { recursive: true, force: true }) } catch { /* ignore */ }
                })

                const nextEnv: Record<string, string> = {
                    ...baseEnv,
                    ZDOTDIR: zdotDir
                }
                if (baseEnv.ZDOTDIR) {
                    nextEnv.KALYNT_ZDOTDIR_ORIG = baseEnv.ZDOTDIR
                }
                return { args: [], env: nextEnv }
            }
        } catch (error) {
            console.error('[ShellIntegration] Failed to prepare shell integration files:', error)
        }

        return { args: [], env: { ...baseEnv } }
    }

    attachToTerminal(terminalId: string, ptyProcess: IPty | null, shell: string): void {
        // Replace any stale integration without leaking listeners or temp files
        const existing = this.integrations.get(terminalId)
        if (existing) {
            existing.removeAllListeners()
            this.integrations.delete(terminalId)
        }

        const integration = new ShellIntegration(terminalId, shell)
        this.integrations.set(terminalId, integration)

        integration.on('data', (data: ShellIntegrationData) => {
            this.handleIntegrationData(data)
        })

        integration.on('command', (command: CommandRecord) => {
            this.handleCommandRecord(command)
        })

        // Ensure closed terminals are removed from this.integrations automatically
        if (ptyProcess && typeof ptyProcess.onExit === 'function') {
            ptyProcess.onExit(() => {
                this.detachFromTerminal(terminalId)
            })
        }
    }

    detachFromTerminal(terminalId: string): void {
        const integration = this.integrations.get(terminalId)
        if (integration) {
            integration.removeAllListeners()
            this.integrations.delete(terminalId)
        }
        this.cleanupSpawnArtifacts(terminalId)
    }

    hasIntegration(terminalId: string): boolean {
        return this.integrations.has(terminalId)
    }

    private cleanupSpawnArtifacts(terminalId: string): void {
        const cleanup = this.spawnCleanups.get(terminalId)
        if (cleanup) {
            this.spawnCleanups.delete(terminalId)
            cleanup()
        }
    }

    private handleIntegrationData(data: ShellIntegrationData): void {
        this.emit('integration_data', data)
    }

    private handleCommandRecord(command: CommandRecord): void {
        const history = this.commandHistory.get(command.terminalId) || []
        history.push(command)

        if (history.length > this.maxCommandHistory) {
            history.splice(0, history.length - this.maxCommandHistory)
        }

        this.commandHistory.set(command.terminalId, history)

        this.emit('command_recorded', command)
        this.analyzeCommandForDecorations(command)
    }

    private analyzeCommandForDecorations(command: CommandRecord): void {
        if (!command.output) return

        const decorations: NonNullable<CommandRecord['decorations']> = []
        const errorPatterns = [
            /error:/gi,
            /failed/gi,
            /syntax error/gi,
            /not found/gi,
            /permission denied/gi
        ]

        const lines = command.output.split('\n')
        lines.forEach((line, lineIndex) => {
            errorPatterns.forEach(pattern => {
                pattern.lastIndex = 0
                let match: RegExpExecArray | null
                while ((match = pattern.exec(line)) !== null) {
                    decorations.push({
                        line: lineIndex,
                        column: match.index,
                        length: match[0].length,
                        type: 'error',
                        message: 'Error detected'
                    })
                    if (decorations.length >= 200) return
                }
            })
        })

        if (decorations.length > 0) {
            command.decorations = decorations
            this.emit('decorations_available', {
                terminalId: command.terminalId,
                commandId: command.id,
                decorations
            })
        }
    }

    processData(terminalId: string, data: string): void {
        const integration = this.integrations.get(terminalId)
        if (integration) {
            integration.processData(data)
        }
    }

    getCommandHistory(terminalId: string): CommandRecord[] {
        return this.commandHistory.get(terminalId) || []
    }

    getCurrentCommand(terminalId: string): CommandRecord | undefined {
        const integration = this.integrations.get(terminalId)
        const active = integration?.getActiveCommand()
        if (active) return active
        const history = this.commandHistory.get(terminalId)
        return history ? history[history.length - 1] : undefined
    }

    clearHistory(terminalId: string): void {
        this.commandHistory.delete(terminalId)
    }

    getShellIntegrationScript(shell: string): string {
        return buildShellIntegrationScript(shell)
    }

    dispose(): void {
        for (const terminalId of Array.from(this.integrations.keys())) {
            this.detachFromTerminal(terminalId)
        }
        for (const terminalId of Array.from(this.spawnCleanups.keys())) {
            this.cleanupSpawnArtifacts(terminalId)
        }
        this.integrations.clear()
        this.commandHistory.clear()
        this.removeAllListeners()
    }
}

class ShellIntegration extends EventEmitter {
    private buffer = ''
    private currentCommand?: CommandRecord
    private outputBuffer = ''
    private inCommand = false
    private lastCwd = process.cwd()

    constructor(
        private readonly terminalId: string,
        public readonly shell: string
    ) {
        super()
    }

    getActiveCommand(): CommandRecord | undefined {
        return this.currentCommand
    }

    processData(data: string): void {
        if (!data) return
        this.buffer += data

        while (this.buffer.length > 0) {
            const startIdx = this.buffer.indexOf(OSC_633_PREFIX)

            if (startIdx === -1) {
                // Keep any trailing partial prefix of "\x1b]633;" for the next chunk
                const keep = trailingPartialOscLength(this.buffer)
                const flushLen = this.buffer.length - keep
                if (flushLen > 0) {
                    this.flushPlainOutput(this.buffer.slice(0, flushLen))
                    this.buffer = keep > 0 ? this.buffer.slice(flushLen) : ''
                }
                break
            }

            // Flush plain output before the OSC sequence
            if (startIdx > 0) {
                this.flushPlainOutput(this.buffer.slice(0, startIdx))
                this.buffer = this.buffer.slice(startIdx)
            }

            // Find OSC terminator: BEL (\x07) or ST (\x1b\\)
            const bodyStart = OSC_633_PREFIX.length
            const belIdx = this.buffer.indexOf('\x07', bodyStart)
            const stIdx = this.buffer.indexOf('\x1b\\', bodyStart)

            let endIdx = -1
            let termLen = 0
            if (belIdx !== -1 && (stIdx === -1 || belIdx < stIdx)) {
                endIdx = belIdx
                termLen = 1
            } else if (stIdx !== -1) {
                endIdx = stIdx
                termLen = 2
            }

            if (endIdx === -1) {
                // Incomplete sequence — preserve buffer across chunks unless excessively large
                if (this.buffer.length > MAX_PENDING_OSC_BUFFER) {
                    this.flushPlainOutput(this.buffer)
                    this.buffer = ''
                }
                break
            }

            const sequence = this.buffer.slice(bodyStart, endIdx)
            this.buffer = this.buffer.slice(endIdx + termLen)
            this.handleSequence(sequence)
        }
    }

    private flushPlainOutput(text: string): void {
        if (!text) return
        if (this.inCommand && this.outputBuffer.length < MAX_OUTPUT_BUFFER) {
            const remaining = MAX_OUTPUT_BUFFER - this.outputBuffer.length
            this.outputBuffer += text.length <= remaining ? text : text.slice(0, remaining)
        }
        this.emit('raw_data', text)
    }

    private handleSequence(sequence: string): void {
        const [type, ...args] = sequence.split(';')

        switch (type) {
            case 'A': { // Command started
                this.inCommand = true
                this.outputBuffer = ''
                const cwd = args[0] || this.lastCwd
                if (args[0]) this.lastCwd = args[0]
                this.currentCommand = {
                    id: `cmd_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
                    terminalId: this.terminalId,
                    command: '',
                    cwd,
                    startTime: Date.now(),
                    hasOutput: false
                }
                this.emit('data', {
                    type: 'command_start',
                    timestamp: Date.now(),
                    terminalId: this.terminalId,
                    data: this.currentCommand
                })
                break
            }

            case 'B': { // Command line updated
                const rawCommand = unescapeOscField(args.join(';')).trim()
                if (this.currentCommand) {
                    this.currentCommand.command = rawCommand
                }
                break
            }

            case 'C': { // Current working directory
                const cwd = args.join(';')
                if (cwd) {
                    this.lastCwd = cwd
                    if (this.currentCommand) {
                        this.currentCommand.cwd = cwd
                    }
                }
                this.emit('data', {
                    type: 'cwd_change',
                    timestamp: Date.now(),
                    terminalId: this.terminalId,
                    data: { cwd: cwd || this.lastCwd }
                })
                break
            }

            case 'E': { // Exit code
                if (this.currentCommand && args[0] !== undefined && args[0] !== '') {
                    const parsed = Number.parseInt(args[0], 10)
                    if (!Number.isNaN(parsed)) {
                        this.currentCommand.exitCode = parsed
                    }
                }
                break
            }

            case 'D': { // Command finished (optional exit code in args[0])
                this.inCommand = false
                if (this.currentCommand) {
                    if (args[0] !== undefined && args[0] !== '') {
                        const parsed = Number.parseInt(args[0], 10)
                        if (!Number.isNaN(parsed)) {
                            this.currentCommand.exitCode = parsed
                        }
                    }
                    const finished = this.currentCommand
                    finished.endTime = Date.now()
                    finished.output = this.outputBuffer
                    finished.hasOutput = this.outputBuffer.length > 0

                    this.currentCommand = undefined
                    this.outputBuffer = ''

                    this.emit('command', finished)
                    this.emit('data', {
                        type: 'command_end',
                        timestamp: Date.now(),
                        terminalId: this.terminalId,
                        data: finished
                    })
                }
                break
            }

            case 'P': { // Prompt
                this.emit('data', {
                    type: 'prompt',
                    timestamp: Date.now(),
                    terminalId: this.terminalId
                })
                break
            }
        }
    }
}
