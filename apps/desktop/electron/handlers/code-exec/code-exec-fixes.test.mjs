/* SPDX-License-Identifier: AGPL-3.0-only */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kalynt-code-exec-test-'))
after(() => fs.rm(root, { recursive: true, force: true }))

let bundleCounter = 0
async function loadTs(relPath) {
    const entry = fileURLToPath(new URL(relPath, import.meta.url))
    const outFile = path.join(root, `bundle-${++bundleCounter}.cjs`)
    await build({
        entryPoints: [entry],
        bundle: true,
        outfile: outFile,
        platform: 'node',
        format: 'cjs',
        plugins: [{
            name: 'mock-electron',
            setup(b) {
                b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'mock' }))
                b.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({
                    contents: `
                        export const app = { isPackaged: false, getAppPath: () => ${JSON.stringify(root)}, getPath: () => ${JSON.stringify(root)} };
                        export const shell = { openExternal: async () => {} };
                    `
                }))
            }
        }]
    })
    return require(outFile)
}

const VALID_NIM_MODULE = /^[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)*$/

test('QA-27: sanitizeNimModuleName and tempScriptFilename generate valid Nim module identifiers', async () => {
    const { sanitizeNimModuleName } = await loadTs('./languages.ts')
    const { tempScriptFilename } = await loadTs('../code-execution.ts')

    const samples = [
        'exec-1795221065814',
        'exec--foo__bar_',
        '123-456',
        '---___---',
        '',
        'my.unsaved file!@#',
        '__leading_and_trailing__'
    ]

    for (const sample of samples) {
        const stem = sanitizeNimModuleName(sample)
        assert.match(stem, VALID_NIM_MODULE, `Invalid Nim module name "${stem}" for input "${sample}"`)
        assert.ok(!stem.includes('-'), `Nim module name must not contain hyphens: ${stem}`)
        assert.ok(!stem.includes('__'), `Nim module name must not contain consecutive underscores: ${stem}`)
        assert.ok(!stem.endsWith('_'), `Nim module name must not end with underscore: ${stem}`)
    }

    assert.equal(tempScriptFilename('nim', 'exec-1795221065814'), 'kalynt_exec_1795221065814.nim')
})

test('QA-27: unsaved Nim temp file uses valid module name and cleans up on both success and compilation failure', async () => {
    if (process.platform === 'win32') return

    const { registerCodeExecutionHandlers } = await loadTs('../code-execution.ts')

    // Create a fake `nim` binary on PATH that enforces Nim's module identifier rule
    const fakeBinDir = path.join(root, 'fake-nim-bin')
    await fs.mkdir(fakeBinDir, { recursive: true })
    const fakeNim = path.join(fakeBinDir, 'nim')
    await fs.writeFile(fakeNim, [
        '#!/usr/bin/env node',
        'import fs from "node:fs";',
        'import path from "node:path";',
        'const args = process.argv.slice(2);',
        'const script = args[args.length - 1];',
        'const outArg = args.find(a => a.startsWith("--outdir:"));',
        'const outDir = outArg ? outArg.slice("--outdir:".length) : path.dirname(script);',
        'const stem = path.basename(script, ".nim");',
        'if (!/^[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)*$/.test(stem)) {',
        '  console.error("Error: invalid module name: " + stem);',
        '  process.exit(1);',
        '}',
        'const src = fs.readFileSync(script, "utf8");',
        'if (src.includes("COMPILE_FAIL")) {',
        '  console.error("Error: type mismatch");',
        '  process.exit(1);',
        '}',
        'fs.writeFileSync(path.join(outDir, stem), "fake-binary");',
        'console.log("NIM_OK:" + stem);'
    ].join('\n'), { mode: 0o755 })

    const prevPath = process.env.PATH
    process.env.PATH = `${fakeBinDir}${path.delimiter}${prevPath || ''}`

    const handlers = new Map()
    const fakeIpc = { handle: (ch, fn) => handlers.set(ch, fn) }
    const tempBase = path.join(root, 'temp-root')
    const fakeApp = { getPath: () => tempBase }
    registerCodeExecutionHandlers(fakeIpc, fakeApp, () => null, () => root)

    try {
        await handlers.get('code:clearBinaryCache')({})

        // 1. Success path with hyphenated exec ID
        const okRes = await handlers.get('code:execute')({}, {
            id: 'exec-1795221065814',
            language: 'nim',
            code: 'echo "hello"'
        })
        assert.equal(okRes.success, true, `Expected Nim run to succeed: ${okRes.error || okRes.stderr}`)
        assert.match(okRes.stdout, /NIM_OK:kalynt_exec_1795221065814/)

        const runDir = path.join(tempBase, 'kalynt-run')
        assert.equal(fsSync.existsSync(path.join(runDir, 'kalynt_exec_1795221065814.nim')), false, 'Temp .nim source must be deleted after success')
        assert.equal(fsSync.existsSync(path.join(runDir, 'kalynt_exec_1795221065814')), false, 'Compiled Nim artifact must be deleted after success')

        // 2. Compilation failure path must ALSO clean up temp .nim source
        const failRes = await handlers.get('code:execute')({}, {
            id: 'exec-fail-999',
            language: 'nim',
            code: 'COMPILE_FAIL'
        })
        assert.equal(failRes.exitCode, 1)
        assert.equal(fsSync.existsSync(path.join(runDir, 'kalynt_exec_fail_999.nim')), false, 'Temp .nim source must be deleted after compilation failure')
    } finally {
        process.env.PATH = prevPath
    }
})

test('QA-32: C# execution uses dotnet run --file on .NET 10+, supports .csproj, handles older SDK & .csx clearly, and preserves F#', async () => {
    const { planRun, parseDotnetMajorVersion } = await loadTs('./languages.ts')

    assert.equal(parseDotnetMajorVersion('10.0.115'), 10)
    assert.equal(parseDotnetMajorVersion('10.0.100-rc.2'), 10)
    assert.equal(parseDotnetMajorVersion('9.0.200'), 9)
    assert.equal(parseDotnetMajorVersion('8.0.404'), 8)
    assert.equal(parseDotnetMajorVersion('not-a-version'), null)

    const buildDir = path.join(root, 'cs-build')
    const standaloneCs = path.join(root, 'standalone', 'Hello.cs')
    const baseDeps = {
        findBinary: async (name) => (name === 'dotnet' ? '/usr/bin/dotnet' : null),
        findCsprojInDir: () => null
    }

    // 1. .NET 10+ SDK runs standalone .cs via `dotnet run --file <file>` for both `csharp` and `dotnet`
    const plan10Csharp = await planRun('csharp', standaloneCs, buildDir, null, 'r1', {
        ...baseDeps,
        detectDotnetVersion: async () => '10.0.115',
        hasDotnetScript: async () => false
    })
    assert.equal(plan10Csharp.run.command, '/usr/bin/dotnet')
    assert.deepEqual(plan10Csharp.run.args, ['run', '--file', standaloneCs])

    const plan10Dotnet = await planRun('dotnet', standaloneCs, buildDir, null, 'r2', {
        ...baseDeps,
        detectDotnetVersion: async () => '10.0.115',
        hasDotnetScript: async () => false
    })
    assert.deepEqual(plan10Dotnet.run.args, ['run', '--file', standaloneCs])

    // 2. Existing .csproj directory uses `dotnet run --project <csproj>` regardless of SDK version
    const projFile = path.join(root, 'proj', 'Program.cs')
    const csprojPath = path.join(root, 'proj', 'MyApp.csproj')
    const planProj = await planRun('csharp', projFile, buildDir, path.join(root, 'proj'), 'r3', {
        ...baseDeps,
        detectDotnetVersion: async () => '8.0.404',
        hasDotnetScript: async () => false,
        findCsprojInDir: () => csprojPath
    })
    assert.deepEqual(planProj.run.args, ['run', '--project', csprojPath])

    // 3. Older SDK (< 10) WITHOUT dotnet-script fails with a clear actionable error
    await assert.rejects(
        planRun('csharp', standaloneCs, buildDir, null, 'r4', {
            ...baseDeps,
            detectDotnetVersion: async () => '8.0.404',
            hasDotnetScript: async () => false
        }),
        (err) => {
            assert.match(err.message, /8\.0\.404/)
            assert.match(err.message, /\.NET 10\+/)
            assert.match(err.message, /dotnet tool install -g dotnet-script/)
            return true
        }
    )

    // 4. Older SDK (< 10) WITH dotnet-script uses `dotnet script <file>`
    const plan8WithScript = await planRun('csharp', standaloneCs, buildDir, null, 'r5', {
        ...baseDeps,
        detectDotnetVersion: async () => '8.0.404',
        hasDotnetScript: async () => true
    })
    assert.deepEqual(plan8WithScript.run.args, ['script', standaloneCs])

    // 5. .csx script without dotnet-script explains missing tool clearly; with dotnet-script runs `dotnet script`
    const csxFile = path.join(root, 'standalone', 'script.csx')
    await assert.rejects(
        planRun('csharp', csxFile, buildDir, null, 'r6', {
            ...baseDeps,
            detectDotnetVersion: async () => '10.0.115',
            hasDotnetScript: async () => false
        }),
        /dotnet tool install -g dotnet-script/
    )
    const planCsx = await planRun('csharp', csxFile, buildDir, null, 'r7', {
        ...baseDeps,
        detectDotnetVersion: async () => '10.0.115',
        hasDotnetScript: async () => true
    })
    assert.deepEqual(planCsx.run.args, ['script', csxFile])

    // 6. F# still uses `dotnet fsi <file>`
    const fsxFile = path.join(root, 'standalone', 'hello.fsx')
    const planFsharp = await planRun('fsharp', fsxFile, buildDir, null, 'r8', {
        ...baseDeps,
        detectDotnetVersion: async () => '10.0.115',
        hasDotnetScript: async () => false
    })
    assert.equal(planFsharp.run.command, '/usr/bin/dotnet')
    assert.deepEqual(planFsharp.run.args, ['fsi', fsxFile])

    // 7. runtimeCatalog.ts accurately describes .NET 10+ and dotnet-script requirements
    const { RUNTIME_CATALOG } = await loadTs('../../../src/components/extensions/runtimeCatalog.ts')
    const dotnetEntry = RUNTIME_CATALOG.find(r => r.id === 'dotnet')
    assert.ok(dotnetEntry)
    assert.match(dotnetEntry.description, /\.NET 10\+/)
    assert.match(dotnetEntry.description, /dotnet-script/)
})
