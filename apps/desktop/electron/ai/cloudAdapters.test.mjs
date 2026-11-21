/* SPDX-License-Identifier: AGPL-3.0-only
 * Run: node --test apps/desktop/electron/ai/cloudAdapters.test.mjs
 * Loopback HTTP regression tests for QA-24 (live model catalog vs fallback)
 * and QA-25 (truncated provider streams across DeepSeek, Kimi, GLM, Gemini).
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const { outputFiles } = await build({
    stdin: {
        contents: [
            "export * from './models';",
            "export * from './openaiChat';",
            "export * from './gemini';",
            "export * from './http';"
        ].join('\n'),
        resolveDir: fileURLToPath(new URL('.', import.meta.url)),
        loader: 'ts'
    },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm'
})
const {
    mergeModels,
    fetchModelCatalog,
    streamChatCompletions,
    streamGemini,
    ProviderError,
    TruncatedStreamError
} = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`)

let baseUrl
let server
let transientAttempts = 0

before(async () => {
    server = http.createServer(async (req, res) => {
        const url = req.url || '/'

        // --- QA-24 model catalog fixtures ---
        if (url === '/catalog-empty/models') {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ data: [] }))
            return
        }
        if (url === '/catalog-filtered/models') {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({
                data: [
                    { id: 'gpt-4o-mini' },
                    { id: 'text-embedding-3-large' }
                ]
            }))
            return
        }
        if (url === '/catalog-retired/models') {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({
                data: [
                    { id: 'gpt-6-astra' },
                    { id: 'gpt-4o-mini' }
                ]
            }))
            return
        }
        if (url === '/catalog-401/models') {
            res.writeHead(401, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: { message: 'Incorrect API key provided.' } }))
            return
        }
        if (url === '/catalog-429/models') {
            res.writeHead(429, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: { message: 'Rate limit exceeded.' } }))
            return
        }
        if (url === '/catalog-404/models') {
            res.writeHead(404, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: { message: 'Not found.' } }))
            return
        }

        // --- QA-25 Chat Completions (DeepSeek, Kimi, GLM) fixtures ---
        if (url.endsWith('/chat/completions')) {
            let raw = ''
            for await (const chunk of req) raw += chunk
            const body = JSON.parse(raw)

            if (body.model === 'transient-503') {
                transientAttempts++
                if (transientAttempts === 1) {
                    res.writeHead(503, { 'Content-Type': 'application/json' })
                    res.end(JSON.stringify({ error: { message: 'Service temporarily overloaded.' } }))
                    return
                }
                res.writeHead(200, { 'Content-Type': 'text/event-stream' })
                res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Recovered ok' }, finish_reason: null }] })}\n\n`)
                res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`)
                res.write('data: [DONE]\n\n')
                res.end()
                return
            }

            res.writeHead(200, { 'Content-Type': 'text/event-stream' })

            if (body.model === 'clean-text') {
                res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Complete answer.' }, finish_reason: null }] })}\n\n`)
                res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`)
                res.write('data: [DONE]\n\n')
                res.end()
                return
            }

            if (body.model === 'truncated-text') {
                res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Partial answer before drop' }, finish_reason: null }] })}\n\n`)
                res.end()
                return
            }

            if (body.model === 'truncated-tool') {
                res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_trunc', function: { name: 'write_file', arguments: '{"path":"a.ts","con' } }] }, finish_reason: null }] })}\n\n`)
                res.end()
                return
            }

            if (body.model === 'done-with-malformed-tool') {
                res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_bad', function: { name: 'write_file', arguments: '{"path":"a.ts' } }] }, finish_reason: null }] })}\n\n`)
                res.write('data: [DONE]\n\n')
                res.end()
                return
            }

            if (body.model === 'empty-drop') {
                res.end()
                return
            }

            if (body.model === 'slow-cancel') {
                res.write(': keepalive\n\n')
                return
            }
        }

        // --- QA-25 Gemini streamGenerateContent fixtures ---
        if (url.includes(':streamGenerateContent')) {
            if (url.includes('transient-503')) {
                transientAttempts++
                if (transientAttempts === 1) {
                    res.writeHead(503, { 'Content-Type': 'application/json' })
                    res.end(JSON.stringify({ error: { message: 'Backend unavailable.' } }))
                    return
                }
                res.writeHead(200, { 'Content-Type': 'text/event-stream' })
                res.write(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Gemini recovered' }] }, finishReason: 'STOP' }] })}\n\n`)
                res.end()
                return
            }

            res.writeHead(200, { 'Content-Type': 'text/event-stream' })

            if (url.includes('clean-text')) {
                res.write(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Hello from Gemini' }] }, finishReason: 'FINISH_REASON_UNSPECIFIED' }] })}\n\n`)
                res.write(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: '!' }] }, finishReason: 'STOP' }] })}\n\n`)
                res.end()
                return
            }

            if (url.includes('truncated-text')) {
                res.write(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Gemini partial output' }] } }] })}\n\n`)
                res.end()
                return
            }

            if (url.includes('truncated-tool')) {
                res.write(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ functionCall: { id: 'gcall_1', name: 'read_file', args: { path: 'src/index.ts' } } }] } }] })}\n\n`)
                res.end()
                return
            }

            if (url.includes('empty-drop')) {
                res.end()
                return
            }

            if (url.includes('slow-cancel')) {
                res.write(': waiting\n\n')
                return
            }
        }

        res.writeHead(404)
        res.end('{}')
    })

    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    baseUrl = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
})

// ==========================================
// QA-24: Live model catalog vs fallback
// ==========================================

test('QA-24: empty 200 live catalog returns empty live result instead of curated fallback', async () => {
    const res = await fetchModelCatalog('openai', 'sk-test', `${baseUrl}/catalog-empty`)
    assert.equal(res.live, true)
    assert.equal(res.source, 'live')
    assert.equal(res.fallback, false)
    assert.deepEqual(res.models, [])
    assert.equal(res.rawCount, 0)
    assert.match(res.error || '', /no available models/i)
})

test('QA-24: filtered-only 200 live catalog never substitutes absent GPT-6 models', async () => {
    assert.deepEqual(mergeModels('openai', ['gpt-4o-mini', 'text-embedding-3-large']), [])

    const res = await fetchModelCatalog('openai', 'sk-test', `${baseUrl}/catalog-filtered`)
    assert.equal(res.live, true)
    assert.equal(res.source, 'live')
    assert.equal(res.fallback, false)
    assert.deepEqual(res.models, [])
    assert.equal(res.rawCount, 2)
    assert.match(res.error || '', /none are eligible chat models/i)
})

test('QA-24: retired saved model is omitted from refreshed live catalog', async () => {
    const res = await fetchModelCatalog('openai', 'sk-test', `${baseUrl}/catalog-retired`)
    assert.equal(res.live, true)
    assert.equal(res.source, 'live')
    assert.deepEqual(res.models.map(m => m.id), ['gpt-6-astra'])
    assert.equal(res.models[0].recommended, true)
    assert.equal(res.models.some(m => m.id === 'gpt-6.1-sol'), false)
})

test('QA-24: 401 auth failure returns non-live error state with status 401 and no fake models', async () => {
    const res = await fetchModelCatalog('openai', 'sk-bad', `${baseUrl}/catalog-401`)
    assert.equal(res.live, false)
    assert.equal(res.source, 'error')
    assert.equal(res.fallback, false)
    assert.equal(res.status, 401)
    assert.deepEqual(res.models, [])
    assert.match(res.error || '', /Incorrect API key/i)
    assert.match(res.error || '', /Settings/)
})

test('QA-24: 429 rate limit explicitly marks offline fallback models and preserves status 429', async () => {
    const res = await fetchModelCatalog('openai', 'sk-test', `${baseUrl}/catalog-429`)
    assert.equal(res.live, false)
    assert.equal(res.source, 'fallback')
    assert.equal(res.fallback, true)
    assert.equal(res.status, 429)
    assert.ok(res.models.length > 0)
    assert.match(res.error || '', /rate limit/i)
    assert.match(res.error || '', /offline fallback/i)
})

test('QA-24: 404 unsupported catalog endpoint explicitly marks offline fallback', async () => {
    const res = await fetchModelCatalog('openai', 'sk-test', `${baseUrl}/catalog-404`)
    assert.equal(res.live, false)
    assert.equal(res.source, 'fallback')
    assert.equal(res.fallback, true)
    assert.equal(res.status, 404)
    assert.ok(res.models.length > 0)
    assert.match(res.error || '', /offline fallback/i)
})

// ==========================================
// QA-25: Truncated provider streams
// ==========================================

for (const provider of ['deepseek', 'moonshot', 'zai']) {
    test(`QA-25 (${provider}): clean finish returns stopReason=end`, async () => {
        const events = []
        const result = await streamChatCompletions(
            { provider, model: 'clean-text', system: 'sys', items: [{ role: 'user', content: 'hi' }] },
            { apiKey: 'sk-test', baseUrl, signal: new AbortController().signal, emit: e => events.push(e) }
        )
        assert.equal(result.stopReason, 'end')
        assert.equal(result.assistant.text, 'Complete answer.')
        assert.equal(events.filter(e => e.type === 'text').length, 1)
    })

    test(`QA-25 (${provider}): truncation mid-text throws TruncatedStreamError with preserved partial text`, async () => {
        await assert.rejects(
            () => streamChatCompletions(
                { provider, model: 'truncated-text', system: 'sys', items: [{ role: 'user', content: 'hi' }] },
                { apiKey: 'sk-test', baseUrl, signal: new AbortController().signal, emit() {} }
            ),
            err => {
                assert.ok(err instanceof TruncatedStreamError)
                assert.equal(err.incomplete, true)
                assert.equal(err.stopReason, 'truncated')
                assert.equal(err.retryable, false)
                assert.equal(err.partial.assistant.text, 'Partial answer before drop')
                assert.match(err.message, /ended the response early/i)
                return true
            }
        )
    })
}

test('QA-25 (openaiChat): truncation mid-tool-arguments throws TruncatedStreamError and preserves partial call', async () => {
    await assert.rejects(
        () => streamChatCompletions(
            { provider: 'deepseek', model: 'truncated-tool', system: 'sys', items: [{ role: 'user', content: 'write' }] },
            { apiKey: 'sk-test', baseUrl, signal: new AbortController().signal, emit() {} }
        ),
        err => {
            assert.ok(err instanceof TruncatedStreamError)
            assert.equal(err.incomplete, true)
            assert.equal(err.stopReason, 'truncated')
            assert.equal(err.partial.assistant.toolCalls.length, 1)
            assert.equal(err.partial.assistant.toolCalls[0].name, 'write_file')
            assert.ok(err.partial.assistant.toolCalls[0].argumentsError)
            return true
        }
    )

    // Even if [DONE] arrives without finish_reason when JSON tool args were cut off
    await assert.rejects(
        () => streamChatCompletions(
            { provider: 'moonshot', model: 'done-with-malformed-tool', system: 'sys', items: [{ role: 'user', content: 'write' }] },
            { apiKey: 'sk-test', baseUrl, signal: new AbortController().signal, emit() {} }
        ),
        err => err instanceof TruncatedStreamError && err.stopReason === 'truncated'
    )
})

test('QA-25 (openaiChat): explicit cancellation rejects without TruncatedStreamError', async () => {
    const controller = new AbortController()
    const pending = streamChatCompletions(
        { provider: 'zai', model: 'slow-cancel', system: 'sys', items: [{ role: 'user', content: 'wait' }] },
        { apiKey: 'sk-test', baseUrl, signal: controller.signal, emit() {} }
    )
    setTimeout(() => controller.abort(), 30)
    await assert.rejects(pending, err => !(err instanceof TruncatedStreamError) && controller.signal.aborted)
})

test('QA-25 (openaiChat): transient failure before output is retryable and recovers', async () => {
    transientAttempts = 0
    await assert.rejects(
        () => streamChatCompletions(
            { provider: 'deepseek', model: 'transient-503', system: 'sys', items: [{ role: 'user', content: 'hi' }] },
            { apiKey: 'sk-test', baseUrl, signal: new AbortController().signal, emit() {} }
        ),
        err => err instanceof ProviderError && err.status === 503 && err.retryable === true
    )
    const recovered = await streamChatCompletions(
        { provider: 'deepseek', model: 'transient-503', system: 'sys', items: [{ role: 'user', content: 'hi' }] },
        { apiKey: 'sk-test', baseUrl, signal: new AbortController().signal, emit() {} }
    )
    assert.equal(recovered.stopReason, 'end')
    assert.equal(recovered.assistant.text, 'Recovered ok')

    // Empty stream drop before any output is also retryable
    await assert.rejects(
        () => streamChatCompletions(
            { provider: 'deepseek', model: 'empty-drop', system: 'sys', items: [{ role: 'user', content: 'hi' }] },
            { apiKey: 'sk-test', baseUrl, signal: new AbortController().signal, emit() {} }
        ),
        err => err instanceof TruncatedStreamError && err.retryable === true
    )
})

test('QA-25 (gemini): clean finish, mid-text truncation, mid-tool truncation, cancellation, and transient pre-output failure', async () => {
    // Clean finish (ignores FINISH_REASON_UNSPECIFIED until STOP)
    const clean = await streamGemini(
        { provider: 'google', model: 'clean-text', system: 'sys', items: [{ role: 'user', content: 'hi' }] },
        { apiKey: 'AIza-test', baseUrl, signal: new AbortController().signal, emit() {} }
    )
    assert.equal(clean.stopReason, 'end')
    assert.equal(clean.assistant.text, 'Hello from Gemini!')

    // Truncation mid-text
    await assert.rejects(
        () => streamGemini(
            { provider: 'google', model: 'truncated-text', system: 'sys', items: [{ role: 'user', content: 'hi' }] },
            { apiKey: 'AIza-test', baseUrl, signal: new AbortController().signal, emit() {} }
        ),
        err => {
            assert.ok(err instanceof TruncatedStreamError)
            assert.equal(err.incomplete, true)
            assert.equal(err.stopReason, 'truncated')
            assert.equal(err.retryable, false)
            assert.equal(err.partial.assistant.text, 'Gemini partial output')
            return true
        }
    )

    // Truncation mid-tool-call (no finishReason)
    await assert.rejects(
        () => streamGemini(
            { provider: 'google', model: 'truncated-tool', system: 'sys', items: [{ role: 'user', content: 'read' }] },
            { apiKey: 'AIza-test', baseUrl, signal: new AbortController().signal, emit() {} }
        ),
        err => {
            assert.ok(err instanceof TruncatedStreamError)
            assert.equal(err.incomplete, true)
            assert.equal(err.stopReason, 'truncated')
            assert.equal(err.partial.assistant.toolCalls.length, 1)
            assert.equal(err.partial.assistant.toolCalls[0].name, 'read_file')
            return true
        }
    )

    // Explicit cancellation
    const controller = new AbortController()
    const pending = streamGemini(
        { provider: 'google', model: 'slow-cancel', system: 'sys', items: [{ role: 'user', content: 'wait' }] },
        { apiKey: 'AIza-test', baseUrl, signal: controller.signal, emit() {} }
    )
    setTimeout(() => controller.abort(), 30)
    await assert.rejects(pending, err => !(err instanceof TruncatedStreamError) && controller.signal.aborted)

    // Transient 503 before output
    transientAttempts = 0
    await assert.rejects(
        () => streamGemini(
            { provider: 'google', model: 'transient-503', system: 'sys', items: [{ role: 'user', content: 'hi' }] },
            { apiKey: 'AIza-test', baseUrl, signal: new AbortController().signal, emit() {} }
        ),
        err => err instanceof ProviderError && err.status === 503 && err.retryable === true
    )
    const recovered = await streamGemini(
        { provider: 'google', model: 'transient-503', system: 'sys', items: [{ role: 'user', content: 'hi' }] },
        { apiKey: 'AIza-test', baseUrl, signal: new AbortController().signal, emit() {} }
    )
    assert.equal(recovered.stopReason, 'end')
    assert.equal(recovered.assistant.text, 'Gemini recovered')

    // Empty drop before output is retryable
    await assert.rejects(
        () => streamGemini(
            { provider: 'google', model: 'empty-drop', system: 'sys', items: [{ role: 'user', content: 'hi' }] },
            { apiKey: 'AIza-test', baseUrl, signal: new AbortController().signal, emit() {} }
        ),
        err => err instanceof TruncatedStreamError && err.retryable === true
    )
})
