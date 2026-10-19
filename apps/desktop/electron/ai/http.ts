/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * HTTP helpers shared by the provider adapters: JSON requests with readable
 * errors, and a server-sent-events reader that copes with lines split across
 * network chunks.
 */

export class ProviderError extends Error {
    constructor(message: string, readonly status?: number, readonly retryable = false) {
        super(message)
        this.name = 'ProviderError'
    }
}

/** Pulls the most useful message out of an error body from any provider. */
export function errorMessage(body: unknown, status: number): string {
    const b = body as Record<string, any> | null
    const candidates = [
        b?.error?.message,
        typeof b?.error === 'string' ? b.error : undefined,
        b?.message,
        Array.isArray(b) ? b[0]?.error?.message : undefined,
        b?.detail
    ]
    const message = candidates.find(m => typeof m === 'string' && m.trim())
    return message ? String(message) : `The provider returned HTTP ${status}.`
}

const RETRYABLE = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529])

/** POSTs JSON and throws a ProviderError with the provider's own message on failure. */
export async function postJson(url: string, body: unknown, headers: Record<string, string>, signal: AbortSignal): Promise<Response> {
    let response: Response
    try {
        response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...headers },
            body: JSON.stringify(body),
            signal
        })
    } catch (error) {
        if (signal.aborted) throw error
        throw new ProviderError(`Couldn't reach the provider: ${error instanceof Error ? error.message : String(error)}`, undefined, true)
    }
    if (!response.ok) {
        const text = await response.text().catch(() => '')
        let parsed: unknown = null
        try { parsed = JSON.parse(text) } catch { parsed = text ? { message: text.slice(0, 400) } : null }
        throw new ProviderError(errorMessage(parsed, response.status), response.status, RETRYABLE.has(response.status))
    }
    return response
}

export async function getJson(url: string, headers: Record<string, string>, signal?: AbortSignal): Promise<any> {
    const response = await fetch(url, { headers, signal })
    const text = await response.text()
    let parsed: unknown = null
    try { parsed = JSON.parse(text) } catch { /* not JSON */ }
    if (!response.ok) throw new ProviderError(errorMessage(parsed, response.status), response.status)
    return parsed
}

export interface SseMessage {
    event?: string
    data: string
}

/**
 * Reads a server-sent-events body. Network chunks can end mid-line or
 * mid-character, so the unfinished tail is carried into the next chunk.
 */
export async function readSse(response: Response, onMessage: (message: SseMessage) => void): Promise<void> {
    if (!response.body) throw new ProviderError('The provider sent an empty response.')
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let event: string | undefined
    let data: string[] = []

    const dispatch = () => {
        if (data.length) onMessage({ event, data: data.join('\n') })
        event = undefined
        data = []
    }

    for (;;) {
        const { done, value } = await reader.read()
        buffer += done ? decoder.decode() : decoder.decode(value, { stream: true })
        const lines = buffer.split(/\r?\n/)
        buffer = done ? '' : lines.pop() ?? ''
        for (const line of lines) {
            if (line === '') dispatch()
            else if (line.startsWith('data:')) data.push(line.slice(line.startsWith('data: ') ? 6 : 5))
            else if (line.startsWith('event:')) event = line.slice(6).trim()
            // Comments (":") and other fields are ignored.
        }
        if (done) {
            dispatch()
            return
        }
    }
}

/** Parses tool-call arguments, keeping the raw text when the model sent invalid JSON. */
export function parseArguments(raw: string | undefined): { args: Record<string, unknown>; error?: string } {
    const text = (raw ?? '').trim()
    if (!text) return { args: {} }
    try {
        const parsed = JSON.parse(text)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return { args: parsed as Record<string, unknown> }
        return { args: {}, error: 'Tool arguments must be a JSON object.' }
    } catch {
        return { args: {}, error: `Tool arguments were not valid JSON: ${text.slice(0, 200)}` }
    }
}
