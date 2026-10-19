/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Web search and page reading for the agent (current docs, error messages,
 * package versions). Requests run in the main process.
 */
import { fail, type AgentTool } from './types'

const agentApi = () => {
    const agent = window.electronAPI?.agent
    if (!agent) throw new Error('Web access needs the desktop app.')
    return agent
}

const str = (v: unknown) => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v))

/** Hosts on this machine or the local network: fetching them asks the user first. */
export function isPrivateUrl(raw: unknown): boolean {
    try {
        const host = new URL(str(raw)).hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
        if (host.includes(':')) return host === '::' || host === '::1' || /^(f[cd]|fe[89ab]|::ffff:)/.test(host)
        return host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.lan')
            || /^(0|10|127)\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)
            || /^169\.254\./.test(host) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host) || !host.includes('.')
    } catch {
        return false
    }
}

export const webSearchTool: AgentTool = {
    name: 'web_search',
    kind: 'web',
    description: 'Search the web. Use it for up-to-date information: library documentation, API changes, error messages, release notes. Returns titles, URLs and snippets; read a page with web_fetch.',
    parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Search query.' } },
        required: ['query']
    },
    title: args => `Search the web for ${str(args.query)}`,
    async execute(args) {
        const query = str(args.query).trim()
        if (!query) return fail('query is empty.')
        const result = await agentApi().webSearch({ query, count: 8 })
        if (!result.ok) return fail(result.error ?? 'Search failed.')
        const results = result.results ?? []
        const text = results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join('\n\n')
        return {
            content: results.length ? text : 'No results.',
            display: { type: 'web-results', query, results }
        }
    }
}

export const webFetchTool: AgentTool = {
    name: 'web_fetch',
    kind: 'web',
    description: 'Read a web page or other URL as text (HTML is converted to Markdown-like text; JSON is pretty-printed). Use it after web_search, or for URLs the user mentions.',
    parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: 'http or https URL.' } },
        required: ['url']
    },
    title: args => `Read ${str(args.url)}`,
    async execute(args) {
        // Local addresses were approved before this ran (see approvals.ts); anything else must stay public.
        const result = await agentApi().webFetch({ url: str(args.url), maxChars: 40_000, allowPrivate: isPrivateUrl(args.url) })
        if (!result.ok) return fail(result.error ?? 'Could not read the page.')
        const content = result.content ?? ''
        const header = `${result.title ? `# ${result.title}\n` : ''}Source: ${result.url}\n\n`
        return {
            content: header + (content || '(empty page)') + (result.truncated ? '\n\n(Page truncated.)' : ''),
            display: { type: 'web-page', url: result.url ?? str(args.url), title: result.title ?? '', chars: content.length, truncated: !!result.truncated }
        }
    }
}
