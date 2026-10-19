/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Building the cmd.exe command line that runs a .cmd/.bat file, escaped the
 * way cross-spawn does it (lib/util/escape.js).
 */

// cmd.exe metacharacters, escaped with ^. See http://www.robvanderwoude.com/escapechars.php
const META_CHARS = /([()\][%!^"`<>&|;, *?])/g

// npm cmd-shims pass %* on to node, so cmd.exe parses the arguments a second time.
const NPM_CMD_SHIM = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i

/**
 * Quotes an argument for the program (backslashes before a quote or before the
 * closing quote are doubled), then escapes every cmd.exe metacharacter with ^,
 * the quotes included, so cmd.exe passes it through as plain text.
 */
export function escapeCmdArgument(arg: string, doubleEscape = false): string {
    let quoted = ''
    let slashes = 0
    for (const ch of arg) {
        if (ch === '\\') {
            slashes++
            continue
        }
        quoted += ch === '"' ? '\\'.repeat(slashes * 2 + 1) + ch : '\\'.repeat(slashes) + ch
        slashes = 0
    }
    quoted = `"${quoted}${'\\'.repeat(slashes * 2)}"`
    const escaped = quoted.replace(META_CHARS, '^$1')
    return doubleEscape ? escaped.replace(META_CHARS, '^$1') : escaped
}

/**
 * The line cmd.exe runs for `command ...args`. The program path is quoted, not
 * caret-escaped: Windows paths can't contain quotes, and quoting keeps paths
 * with spaces (C:\Program Files\...) working.
 */
export function cmdCommandLine(command: string, args: string[]): string {
    const doubleEscape = NPM_CMD_SHIM.test(command)
    return [`"${command}"`, ...args.map(arg => escapeCmdArgument(arg, doubleEscape))].join(' ')
}
