/* SPDX-License-Identifier: AGPL-3.0-only
 * Run: node --test apps/desktop/src/services/workspaceScanService.test.mjs
 * Regression tests for QA-28 (Workspace Review scope & limits) and QA-29 (cancellation & outcome states).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const { outputFiles } = await build({
    entryPoints: [fileURLToPath(new URL('./workspaceScanService.ts', import.meta.url))],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    plugins: [{
        name: 'mock-renderer-services',
        setup(b) {
            b.onResolve({ filter: /^\.\/(aiService|offlineLLMService)$/ }, args => ({
                path: args.path,
                namespace: 'mock'
            }))
            b.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({
                contents: 'export const aiService = {}; export const offlineLLMService = { isGenerating: () => false, cancelGeneration: async () => {} };',
                loader: 'js'
            }))
        }
    }]
})
const { WorkspaceScanService, getScanLimits } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`)

/** Creates an in-memory directory tree for deterministic workspace scan testing. */
function makeTree(filesByRelPath) {
    const dirs = new Map()
    const contents = new Map()

    const ensureDir = (dir) => {
        if (!dirs.has(dir)) dirs.set(dir, new Map())
        return dirs.get(dir)
    }
    ensureDir('/ws')

    for (const [rel, content] of Object.entries(filesByRelPath)) {
        const parts = rel.split('/')
        let curr = '/ws'
        for (let i = 0; i < parts.length - 1; i++) {
            const next = `${curr}/${parts[i]}`
            ensureDir(curr).set(parts[i], { name: parts[i], isDirectory: true })
            ensureDir(next)
            curr = next
        }
        const name = parts[parts.length - 1]
        const full = `${curr}/${name}`
        ensureDir(curr).set(name, { name, isDirectory: false, size: content.length })
        contents.set(full, content)
    }

    return {
        readDir: async (p) => {
            const map = dirs.get(p)
            return map ? { success: true, items: Array.from(map.values()) } : { success: false }
        },
        readFile: async (p) => {
            return contents.has(p)
                ? { success: true, content: contents.get(p) }
                : { success: false, error: 'ENOENT' }
        }
    }
}

const makeLines = (n, prefix = 'const x = ') => Array.from({ length: n }, (_, i) => `${prefix}${i + 1};`).join('\n')

test('QA-28: 27 files in sampled mode analyzes 25 and reports 2 omitted (file_cap), while full mode visits all 27', async () => {
    const service = WorkspaceScanService.getInstance()
    const files = {}
    for (let i = 1; i <= 27; i++) {
        files[`src/file${String(i).padStart(2, '0')}.js`] = makeLines(8)
    }
    const tree = makeTree(files)
    const requested = []
    const deps = {
        ...tree,
        chat: async (messages) => {
            requested.push(messages[1].content)
            return { content: JSON.stringify({ issues: [] }) }
        }
    }

    // Sampled mode: caps at 25, reports 27 discovered / 25 analyzed / 2 omitted, outcome = partial
    const sampled = await service.scanWorkspace('/ws', {
        aiMode: 'cloud',
        provider: 'openai',
        scope: 'sampled',
        onProgress() {},
        deps
    })
    assert.equal(requested.length, 25)
    assert.equal(sampled.outcome, 'partial')
    assert.equal(sampled.stats.discoveredFiles, 27)
    assert.equal(sampled.stats.analyzedFiles, 25)
    assert.equal(sampled.stats.omittedFiles, 2)
    assert.equal(sampled.stats.omittedByReason.file_cap, 2)

    // Full mode: visits all 27 files, 0 omitted, outcome = completed
    requested.length = 0
    const full = await service.scanWorkspace('/ws', {
        aiMode: 'cloud',
        provider: 'openai',
        scope: 'full',
        onProgress() {},
        deps
    })
    assert.equal(requested.length, 27)
    assert.equal(full.outcome, 'completed')
    assert.equal(full.stats.discoveredFiles, 27)
    assert.equal(full.stats.analyzedFiles, 27)
    assert.equal(full.stats.omittedFiles, 0)
})

test('QA-28: short file (<5 lines), deep file (depth 6), and long file (>500 lines) behave explicitly in sampled vs full modes', async () => {
    const service = WorkspaceScanService.getInstance()
    const tree = makeTree({
        'short.js': 'const a = 1;\nconst b = 2;',
        'd1/d2/d3/d4/d5/d6/deep.js': makeLines(10),
        'long.js': makeLines(650)
    })
    const seenPrompts = []
    const deps = {
        ...tree,
        chat: async (messages) => {
            seenPrompts.push(messages[1].content)
            if (messages[1].content.includes('long.js')) {
                return {
                    content: JSON.stringify({
                        issues: [{ type: 'bug', severity: 'high', line: 10, description: 'Long file issue', suggestion: 'Fix it' }]
                    })
                }
            }
            return { content: JSON.stringify({ issues: [] }) }
        }
    }

    // Sampled mode: omits short.js (short_file) and deep.js (depth_limit), clips long.js at 500 lines
    const sampled = await service.scanWorkspace('/ws', {
        aiMode: 'cloud',
        provider: 'openai',
        scope: 'sampled',
        onProgress() {},
        deps
    })
    assert.equal(sampled.outcome, 'partial')
    assert.equal(sampled.stats.discoveredFiles, 3)
    assert.equal(sampled.stats.analyzedFiles, 1)
    assert.equal(sampled.stats.omittedFiles, 2)
    assert.equal(sampled.stats.omittedByReason.short_file, 1)
    assert.equal(sampled.stats.omittedByReason.depth_limit, 1)
    assert.equal(sampled.stats.clippedFiles, 1)
    assert.equal(sampled.issues.length, 1)
    assert.deepEqual(sampled.issues[0].reviewedRange, { startLine: 1, endLine: 500, totalLines: 650, truncated: true })

    // Full mode: reviews short.js, deep.js, AND both chunks (1-500 and 501-650) of long.js
    seenPrompts.length = 0
    const full = await service.scanWorkspace('/ws', {
        aiMode: 'cloud',
        provider: 'openai',
        scope: 'full',
        onProgress() {},
        deps
    })
    assert.equal(full.outcome, 'completed')
    assert.equal(full.stats.discoveredFiles, 3)
    assert.equal(full.stats.analyzedFiles, 3)
    assert.equal(full.stats.omittedFiles, 0)
    assert.equal(full.stats.clippedFiles, 0)
    // 1 request for short.js + 1 for deep.js + 2 chunks for long.js = 4 requests
    assert.equal(seenPrompts.length, 4)
    assert.ok(seenPrompts.some(p => p.includes('showing lines 501-650')))
    assert.equal(full.issues.length, 2)
    assert.deepEqual(full.issues[0].reviewedRange, { startLine: 1, endLine: 500, totalLines: 650, truncated: false })
    assert.deepEqual(full.issues[1].reviewedRange, { startLine: 501, endLine: 650, totalLines: 650, truncated: false })
})

test('QA-29: cancellation before first result reports canceled with 0 analyzed files (never completed)', async () => {
    const service = WorkspaceScanService.getInstance()
    const tree = makeTree({ 'a.js': makeLines(10), 'b.js': makeLines(10) })
    const statuses = []
    let releaseFirst
    const deps = {
        ...tree,
        chat: async (_messages, _provider, opts) => new Promise((resolve) => {
            opts.signal?.addEventListener('abort', () => resolve({ content: '', error: 'Stopped.' }), { once: true })
            releaseFirst = () => resolve({ content: '{"issues":[]}' })
        })
    }

    const scanPromise = service.scanWorkspace('/ws', {
        aiMode: 'cloud',
        provider: 'openai',
        scope: 'sampled',
        onProgress: p => statuses.push(p.status),
        deps
    })

    await new Promise(r => setTimeout(r, 20))
    await service.stopScan()
    if (releaseFirst) releaseFirst()
    const result = await scanPromise

    assert.equal(result.outcome, 'canceled')
    assert.equal(result.stats.analyzedFiles, 0)
    assert.equal(result.stats.omittedByReason.canceled, 2)
    assert.equal(statuses.at(-1), 'canceled')
    assert.match(result.message || '', /before any files were analyzed/i)
})

test('QA-29: cancellation after several results preserves findings already returned', async () => {
    const service = WorkspaceScanService.getInstance()
    const tree = makeTree({
        'a.js': makeLines(10),
        'b.js': makeLines(10),
        'c.js': makeLines(10),
        'd.js': makeLines(10)
    })
    let calls = 0
    const deps = {
        ...tree,
        chat: async (_messages, _provider, opts) => {
            calls++
            if (calls <= 2) {
                return {
                    content: JSON.stringify({
                        issues: [{ type: 'security', severity: 'critical', line: 2, description: `Finding ${calls}`, suggestion: 'Fix' }]
                    })
                }
            }
            return new Promise((resolve) => {
                opts.signal?.addEventListener('abort', () => resolve({ content: '', error: 'Stopped.' }), { once: true })
            })
        }
    }

    const scanPromise = service.scanWorkspace('/ws', {
        aiMode: 'cloud',
        provider: 'openai',
        scope: 'sampled',
        onProgress: p => {
            if (p.status === 'analyzing' && p.current === 3) {
                setTimeout(() => void service.stopScan(), 5)
            }
        },
        deps
    })
    const result = await scanPromise

    assert.equal(result.outcome, 'canceled')
    assert.equal(result.stats.analyzedFiles, 2)
    assert.equal(result.issues.length, 2)
    assert.equal(result.stats.omittedByReason.canceled, 2)
})

test('QA-29: cancellation during indexing returns canceled with 0 analyzed files', async () => {
    const service = WorkspaceScanService.getInstance()
    const deps = {
        readDir: async () => {
            await new Promise(r => setTimeout(r, 30))
            return { success: true, items: [{ name: 'a.js', isDirectory: false, size: 100 }] }
        },
        readFile: async () => ({ success: true, content: makeLines(10) }),
        chat: async () => ({ content: '{"issues":[]}' })
    }

    const scanPromise = service.scanWorkspace('/ws', {
        aiMode: 'cloud',
        provider: 'openai',
        scope: 'sampled',
        onProgress() {},
        deps
    })
    setTimeout(() => void service.stopScan(), 5)
    const result = await scanPromise

    assert.equal(result.outcome, 'canceled')
    assert.equal(result.stats.analyzedFiles, 0)
})

test('QA-29: empty workspace completed review and all-error failed review are distinct outcomes', async () => {
    const service = WorkspaceScanService.getInstance()
    const emptyTree = makeTree({})
    const emptyRes = await service.scanWorkspace('/ws', {
        aiMode: 'cloud',
        provider: 'openai',
        scope: 'full',
        onProgress() {},
        deps: { ...emptyTree, chat: async () => ({ content: '{"issues":[]}' }) }
    })
    assert.equal(emptyRes.outcome, 'completed')
    assert.equal(emptyRes.stats.discoveredFiles, 0)
    assert.equal(emptyRes.stats.analyzedFiles, 0)
    assert.match(emptyRes.message || '', /No supported code files/i)

    const errTree = makeTree({ 'a.js': makeLines(10), 'b.js': makeLines(10) })
    const failedRes = await service.scanWorkspace('/ws', {
        aiMode: 'cloud',
        provider: 'openai',
        scope: 'full',
        onProgress() {},
        deps: { ...errTree, chat: async () => ({ content: '', error: '401 unauthorized' }) }
    })
    assert.equal(failedRes.outcome, 'failed')
    assert.equal(failedRes.stats.analyzedFiles, 0)
    assert.equal(failedRes.errors.length, 2)

    // Verify disclosed limit helpers
    assert.equal(getScanLimits('sampled', 'cloud').maxFiles, 25)
    assert.equal(getScanLimits('sampled', 'offline').maxLinesPerFile, 80)
    assert.equal(getScanLimits('full', 'cloud').maxFiles, null)
})
