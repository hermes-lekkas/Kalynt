/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Requests the mobile app can only perform from the desktop: proxied GitHub
 * API calls (so the phone never holds the token) and agent command
 * forwarding.
 */
// Use require to avoid ESM/types issues (matching signalingServer.ts pattern)
// eslint-disable-next-line @typescript-eslint/no-var-requires
const https = require('https')

export interface AgentCommand {
    agentId: string
    command: string
    params: Record<string, any>
}

// GitHub token (set by user in settings); kept in the main process only.
let githubToken: string | null = null

export function setGitHubToken(token: string): void {
    githubToken = token
}

export function isGitHubConfigured(): boolean {
    return githubToken !== null
}

/**
 * Execute agent command (placeholder - connects to actual agent system)
 */
export async function executeAgentCommand(command: AgentCommand): Promise<any> {
    // TODO: Connect to actual agent manager in main process
    // This is a placeholder that will be replaced with IPC call
    return new Promise((resolve) => {
        // Simulate command execution
        setTimeout(() => {
            resolve({
                success: true,
                message: `Command "${command.command}" executed on agent "${command.agentId}"`,
                timestamp: Date.now()
            })
        }, 1000)
    })
}

/**
 * Proxy GitHub API request
 */
export async function proxyGitHubRequest(
    endpoint: string,
    method: string = 'GET',
    body?: any
): Promise<any> {
    if (!githubToken) {
        throw new Error('GitHub token not configured')
    }

    // Use native https to avoid dependency issues
    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'api.github.com',
            path: endpoint,
            method: method,
            headers: {
                'Authorization': `token ${githubToken}`,
                'User-Agent': 'Kalynt-Mobile-Bridge/1.0',
                'Accept': 'application/vnd.github.v3+json',
                'Content-Type': 'application/json'
            }
        }

        const req = https.request(options, (res: any) => {
            let data = ''
            res.on('data', (chunk: any) => data += chunk)
            res.on('end', () => {
                try {
                    const json = JSON.parse(data)
                    if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                        resolve(json)
                    } else {
                        reject({ status: res.statusCode, message: json.message || 'GitHub API error' })
                    }
                } catch {
                    resolve(data)
                }
            })
        })

        req.on('error', (err: Error) => {
            reject({ status: 500, message: err.message })
        })

        if (body) {
            req.write(JSON.stringify(body))
        }
        req.end()
    })
}
