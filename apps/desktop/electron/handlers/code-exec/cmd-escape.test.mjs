/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Run from apps/desktop: node --test electron/handlers/code-exec/cmd-escape.test.mjs
 * (Node 22.18+ loads the .ts module directly.) cmd.exe and the program's
 * argument parser are simulated, so this runs on any OS.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cmdCommandLine, escapeCmdArgument } from './cmd-escape.ts'

const META = '()[]%!^"`<>&|;, *?'

// One cmd.exe parse: ^x becomes x. An unescaped metacharacter would be acted on, so it fails the test.
function cmdPass(s) {
    let out = ''
    for (let i = 0; i < s.length; i++) {
        if (s[i] === '^') out += s[++i]
        else if (META.includes(s[i])) throw new Error(`unescaped ${s[i]} in ${s}`)
        else out += s[i]
    }
    return out
}

// How the program reads one argument (CommandLineToArgvW rules).
function parseArg(s) {
    let out = ''
    let quoted = false
    for (let i = 0; i < s.length;) {
        let slashes = 0
        while (s[i] === '\\') { slashes++; i++ }
        if (s[i] === '"') {
            out += '\\'.repeat(Math.floor(slashes / 2))
            if (slashes % 2) out += '"'
            else quoted = !quoted
            i++
        } else {
            out += '\\'.repeat(slashes)
            if (i === s.length) break
            if (!quoted && /\s/.test(s[i])) throw new Error(`argument split at ${i} in ${s}`)
            out += s[i++]
        }
    }
    assert.equal(quoted, false, `unterminated quote in ${s}`)
    return out
}

const CASES = [
    '', 'plain', 'a b', '  ', 'a&calc.ts', 'a|b', 'x>y<z', '100%PATH%', '!x!', '^', '^^', '(a)', '`;,*?[]',
    'a"b', '"', '""', 'a"&calc&"b', 'a\\"b', 'a\\\\"b', 'a\\\\\\"b', 'C:\\dir\\', 'C:\\dir\\\\', 'C:\\a b\\x.ts',
    '\\\\server\\share', 'tab\there', 'ümlaut ✓'
]

test('an argument reaches the program unchanged after one cmd.exe parse', () => {
    for (const arg of CASES) assert.equal(parseArg(cmdPass(escapeCmdArgument(arg))), arg, JSON.stringify(arg))
})

test('a double-escaped argument survives the second parse an npm shim does', () => {
    for (const arg of CASES) assert.equal(parseArg(cmdPass(cmdPass(escapeCmdArgument(arg, true)))), arg, JSON.stringify(arg))
})

test('metacharacters, quotes, spaces and backslashes are escaped as expected', () => {
    assert.equal(escapeCmdArgument(''), '^"^"')
    assert.equal(escapeCmdArgument('a&calc.ts'), '^"a^&calc.ts^"')
    assert.equal(escapeCmdArgument('a b'), '^"a^ b^"')
    assert.equal(escapeCmdArgument('%PATH%!x!'), '^"^%PATH^%^!x^!^"')
    assert.equal(escapeCmdArgument('a\\"b'), '^"a\\\\\\^"b^"')
    assert.equal(escapeCmdArgument('a\\\\"b'), '^"a\\\\\\\\\\^"b^"')
    assert.equal(escapeCmdArgument('C:\\dir\\'), '^"C:\\dir\\\\^"')
    assert.equal(escapeCmdArgument('C:\\dir\\\\'), '^"C:\\dir\\\\\\\\^"')
    assert.equal(escapeCmdArgument('a\\b'), '^"a\\b^"')
    assert.equal(escapeCmdArgument('a&b', true), '^^^"a^^^&b^^^"')
})

test('the command line quotes the program and double-escapes only node_modules/.bin shims', () => {
    const npx = cmdCommandLine('C:\\Program Files\\nodejs\\npx.cmd', ['--yes', 'tsx', 'C:\\w\\a&calc.ts'])
    assert.equal(npx, '"C:\\Program Files\\nodejs\\npx.cmd" ^"--yes^" ^"tsx^" ^"C:\\w\\a^&calc.ts^"')

    const shim = cmdCommandLine('C:\\w\\node_modules\\.bin\\tsx.cmd', ['a&b'])
    assert.equal(shim, '"C:\\w\\node_modules\\.bin\\tsx.cmd" ^^^"a^^^&b^^^"')
    assert.equal(cmdCommandLine('C:/w/node_modules/.bin/tsx.CMD', ['x']), '"C:/w/node_modules/.bin/tsx.CMD" ^^^"x^^^"')
    assert.equal(cmdCommandLine('C:\\w\\node_modules\\pkg\\run.cmd', ['x']), '"C:\\w\\node_modules\\pkg\\run.cmd" ^"x^"')

    assert.equal(cmdCommandLine('npm.cmd', []), '"npm.cmd"')
    // Apart from the spaces between arguments, nothing after the quoted program is left for cmd.exe to act on.
    for (const line of [npx, shim]) line.replace(/^"[^"]*" /, '').split(/(?<=") (?=\^)/).forEach(cmdPass)
})
