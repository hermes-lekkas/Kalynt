/* SPDX-License-Identifier: AGPL-3.0-only
 * Run: node --test apps/desktop/electron/ai/localServer.test.mjs
 * Exercises the real discovery and streaming adapters against a local HTTP server.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const { outputFiles } = await build({
    stdin: { contents: "export * from './localServer'; export * from './openaiChat'; export * from './http';", resolveDir: fileURLToPath(new URL('.', import.meta.url)), loader: 'ts' },
    bundle: true, write: false, platform: 'node', format: 'esm'
})
const { normalizeLocalServerUrl, localServerInput, discoverLocalModels, streamChatCompletions, getJson } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`)

let baseUrl, server, lastRequest, redirected = 0
before(async () => {
    server = http.createServer(async (req, res) => {
        if (req.url === '/redirected') { redirected++; res.end('{}'); return }
        if (req.url.startsWith('/redirect/')) { res.writeHead(307, { Location: '/redirected' }); res.end(); return }
        if (req.url === '/empty/models') { res.setHeader('Content-Type', 'application/json'); res.end('{"data":[]}'); return }
        if (req.url === '/invalid/models') { res.end('<html>not an API</html>'); return }
        if (req.url === '/wrong/models') { res.end('{"models":[]}'); return }
        if (req.url === '/denied/models') { res.writeHead(401); res.end('{"error":{"message":"Token required"}}'); return }
        if (req.url === '/v1/models') {
            lastRequest = { headers: req.headers }
            res.end(JSON.stringify({ data: [{ id: 'qwen-coder' }, { id: 'qwen-coder' }, { id: 'embedding-model' }, { id: 123 }, {}] })); return
        }
        if (req.url === '/v1/chat/completions') {
            let raw = ''; for await (const chunk of req) raw += chunk
            lastRequest = { headers: req.headers, body: JSON.parse(raw) }
            res.writeHead(200, { 'Content-Type': 'text/event-stream' })
            if (lastRequest.body.model === 'slow') { res.write(': waiting\n\n'); return }
            const tool = lastRequest.body.messages.some(m => m.role === 'tool')
            const chunks = tool ? [
                { choices: [{ delta: { content: 'Checked ✓' }, finish_reason: null }] },
                { choices: [{ delta: {}, finish_reason: 'stop' }] }
            ] : [
                { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_file', arguments: '{"pa' } }] } }] },
                { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"README.MD"}' } }] }, finish_reason: 'tool_calls' }] }
            ]
            const bytes = Buffer.from(chunks.map(c => `data: ${JSON.stringify(c)}\r\n\r\n`).join('') + 'data: [DONE]\n\n')
            // Split JSON, SSE delimiters and UTF-8 characters across network writes.
            for (let index = 0; index < bytes.length; index += 7) {
                if (res.destroyed) break
                res.write(bytes.subarray(index, index + 7)); await new Promise(resolve => setImmediate(resolve))
            }
            res.end(); return
        }
        res.writeHead(404); res.end('{}')
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    baseUrl = `http://127.0.0.1:${server.address().port}`
})
after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })

test('accepts loopback presets and rejects remote addresses and embedded credentials', () => {
    assert.equal(normalizeLocalServerUrl('http://localhost:11434/'), 'http://localhost:11434/v1')
    assert.equal(normalizeLocalServerUrl('http://[::1]:1234/v1/'), 'http://[::1]:1234/v1')
    for (const value of ['https://example.com/v1', 'http://192.168.1.2/v1', 'http://localhost.evil.test/v1', 'file:///tmp/model', 'http://user:secret@127.0.0.1/v1', 'http://127.0.0.1/v1?token=secret', 'http://127.0.0.1/v1#test']) assert.throws(() => normalizeLocalServerUrl(value))
})
test('keeps tokens only for the same normalized endpoint', () => {
    const previous = { baseUrl: 'http://127.0.0.1:1234/v1', apiKey: 'private-token' }
    assert.equal(localServerInput({ baseUrl: previous.baseUrl + '/' }, previous).apiKey, 'private-token')
    assert.equal(localServerInput({ baseUrl: 'http://127.0.0.1:11434/v1' }, previous).apiKey, '')
    assert.equal(localServerInput({ baseUrl: previous.baseUrl, apiKey: '' }, previous).apiKey, '')
    assert.throws(() => localServerInput({ baseUrl: previous.baseUrl, contextWindow: 1000 }), /context window/)
})
test('discovers real model IDs, removes duplicates, and sends only the optional server token', async () => {
    const models = await discoverLocalModels({ baseUrl: baseUrl + '/v1', apiKey: 'server-token' })
    assert.deepEqual(models.map(m => m.id), ['qwen-coder'])
    assert.equal(lastRequest.headers.authorization, 'Bearer server-token')
    await discoverLocalModels({ baseUrl: baseUrl + '/v1' })
    assert.equal(lastRequest.headers.authorization, undefined)
})
test('empty, malformed and incompatible catalogues fail with actionable messages', async () => {
    await assert.rejects(discoverLocalModels({ baseUrl: baseUrl + '/empty' }), /has no models/)
    await assert.rejects(discoverLocalModels({ baseUrl: baseUrl + '/invalid' }), /unreadable response/)
    await assert.rejects(discoverLocalModels({ baseUrl: baseUrl + '/wrong' }), /OpenAI-compatible model list/)
    await assert.rejects(discoverLocalModels({ baseUrl: baseUrl + '/denied' }), e => e.status === 401 && e.message === 'Token required')
})
test('does not follow discovery or inference redirects with a server token', async () => {
    await assert.rejects(discoverLocalModels({ baseUrl: baseUrl + '/redirect', apiKey: 'secret' }))
    await assert.rejects(streamChatCompletions({ provider: 'local-server', model: 'coder', system: '', items: [] }, { baseUrl: baseUrl + '/redirect', apiKey: 'secret', signal: new AbortController().signal, emit() {} }))
    assert.equal(redirected, 0)
})
test('streams split tool calls and replays a tool result without cloud-specific fields', async () => {
    const request = { provider: 'local-server', model: 'qwen-coder', system: 'Read the project.', items: [{ role: 'user', content: 'Read the README.' }], tools: [{ name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } }] }
    const options = { baseUrl: baseUrl + '/v1', apiKey: '', signal: new AbortController().signal, emit() {} }
    const result = await streamChatCompletions(request, options)
    assert.equal(result.stopReason, 'tool_use')
    assert.deepEqual(result.assistant.toolCalls[0].arguments, { path: 'README.MD' })
    assert.equal(lastRequest.body.stream_options, undefined)
    assert.equal(lastRequest.body.reasoning_effort, undefined)
    const second = await streamChatCompletions({ ...request, items: [...request.items, result.assistant, { role: 'tool', callId: 'call_1', name: 'read_file', content: 'Kalynt readme.' }] }, options)
    assert.equal(second.assistant.text, 'Checked ✓')
    assert.equal(second.stopReason, 'end')
    assert.equal(lastRequest.body.messages.find(m => m.role === 'assistant').reasoning_content, undefined)
    assert.equal(lastRequest.headers.authorization, undefined)
})
test('bounds local output against input, tools, and the configured context', async () => {
    await streamChatCompletions({ provider: 'local-server', model: 'coder', system: 'Summarize.', items: [], maxTokens: 12000, contextWindow: 4096 }, { baseUrl: baseUrl + '/v1', apiKey: '', signal: new AbortController().signal, emit() {} })
    assert.ok(lastRequest.body.max_tokens < 4096)
    const old = lastRequest
    await assert.rejects(streamChatCompletions({ provider: 'local-server', model: 'coder', system: 'x'.repeat(30000), items: [], contextWindow: 4096 }, { baseUrl: baseUrl + '/v1', apiKey: '', signal: new AbortController().signal, emit() {} }), /too large for the local server context/)
    assert.equal(lastRequest, old, 'oversized input must fail before making a request')
})
test('cancels an in-flight streamed model request', async () => {
    const controller = new AbortController()
    const pending = streamChatCompletions({ provider: 'local-server', model: 'slow', system: '', items: [] }, { baseUrl: baseUrl + '/v1', apiKey: '', signal: controller.signal, emit() {} })
    setTimeout(() => controller.abort(), 40)
    await assert.rejects(pending)
})
test('keeps rate-limit status distinct from authentication failure', async () => {
    const original = globalThis.fetch
    globalThis.fetch = async () => new Response('{"error":{"message":"Rate limited"}}', { status: 429 })
    try { await assert.rejects(getJson('https://provider.example/models', {}), e => e.status === 429 && e.message === 'Rate limited') }
    finally { globalThis.fetch = original }
})
