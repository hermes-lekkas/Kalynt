/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
/**
 * Built-in y-webrtc Signaling Server
 *
 * Inline TypeScript port of the y-webrtc signaling server with bounded payload,
 * connection, and topic limits plus verified EADDRINUSE detection.
 *
 * Listens on ws://localhost:4444 (127.0.0.1 only — localhost only for security).
 */

// Use require to avoid ESM/types issues with the ws package
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { WebSocketServer } = require('ws')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const http = require('http')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const os = require('os')

const PING_TIMEOUT = 30000
const WS_READY_STATE_CONNECTING = 0
const WS_READY_STATE_OPEN = 1

const HEALTH_RESPONSE_BODY = 'Kalynt Signaling Server OK'
const MAX_PAYLOAD_BYTES = 256 * 1024 // 256 KiB cap per signaling frame
const MAX_CONNECTIONS = 500
const MAX_TOPICS_PER_CLIENT = 100
const MAX_TOTAL_TOPICS = 2000
const MAX_TOPIC_NAME_LENGTH = 256
const EXISTING_SERVER_PROBE_TIMEOUT_MS = 1500

export interface SignalingServerHandle {
    port: number
    url: string
    lanUrl?: string // Exposed when binding to 0.0.0.0 for LAN access
    close: () => void
}

/**
 * Verify that an existing listener on `port` is actually a Kalynt signaling
 * server before reusing it on EADDRINUSE.
 */
function verifyExistingKalyntSignalingServer(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        let settled = false
        const finish = (ok: boolean) => {
            if (!settled) {
                settled = true
                resolve(ok)
            }
        }

        const req = http.get(
            {
                hostname: '127.0.0.1',
                port,
                path: '/',
                timeout: EXISTING_SERVER_PROBE_TIMEOUT_MS
            },
            (res: any) => {
                if (res.statusCode !== 200) {
                    res.resume()
                    finish(false)
                    return
                }
                let body = ''
                res.setEncoding('utf8')
                res.on('data', (chunk: string) => {
                    if (body.length < 128) body += chunk
                })
                res.on('end', () => {
                    finish(body.trim() === HEALTH_RESPONSE_BODY)
                })
            }
        )

        req.on('timeout', () => {
            req.destroy()
            finish(false)
        })
        req.on('error', () => finish(false))
    })
}

/**
 * Start the built-in y-webrtc signaling server on localhost.
 * Returns a promise that resolves with the server handle when ready.
 */
export function startSignalingServer(port: number = 4444): Promise<SignalingServerHandle> {
    return new Promise((resolve, reject) => {
        // Map from topic name to set of subscribed WebSocket clients
        const topics = new Map<string, Set<any>>()

        const send = (conn: any, message: object) => {
            if (
                conn.readyState !== WS_READY_STATE_CONNECTING &&
                conn.readyState !== WS_READY_STATE_OPEN
            ) {
                conn.close()
                return
            }
            try {
                conn.send(JSON.stringify(message))
            } catch {
                conn.close()
            }
        }

        const wss = new WebSocketServer({
            noServer: true,
            maxPayload: MAX_PAYLOAD_BYTES
        })
        const server = http.createServer((_req: any, res: any) => {
            res.writeHead(200, { 'Content-Type': 'text/plain' })
            res.end(HEALTH_RESPONSE_BODY)
        })

        wss.on('connection', (conn: any) => {
            const subscribedTopics = new Set<string>()
            let closed = false
            let pongReceived = true

            const pingInterval = setInterval(() => {
                if (!pongReceived) {
                    conn.close()
                    clearInterval(pingInterval)
                    return
                }
                pongReceived = false
                try {
                    conn.ping()
                } catch {
                    conn.close()
                }
            }, PING_TIMEOUT)

            conn.on('pong', () => {
                pongReceived = true
            })

            conn.on('close', () => {
                subscribedTopics.forEach((topicName: string) => {
                    const subs = topics.get(topicName)
                    if (subs) {
                        subs.delete(conn)
                        if (subs.size === 0) {
                            topics.delete(topicName)
                        }
                    }
                })
                subscribedTopics.clear()
                closed = true
                clearInterval(pingInterval)
            })

            conn.on('message', (rawMessage: any) => {
                let message: any
                try {
                    message = typeof rawMessage === 'string'
                        ? JSON.parse(rawMessage)
                        : JSON.parse(rawMessage.toString())
                } catch {
                    return
                }

                if (!message || typeof message.type !== 'string' || closed) return

                switch (message.type) {
                    case 'subscribe': {
                        const subscribeTopics: unknown[] = Array.isArray(message.topics) ? message.topics : []
                        subscribeTopics.forEach((topicName) => {
                            if (typeof topicName !== 'string' || !topicName || topicName.length > MAX_TOPIC_NAME_LENGTH) {
                                return
                            }
                            if (!subscribedTopics.has(topicName) && subscribedTopics.size >= MAX_TOPICS_PER_CLIENT) {
                                return
                            }
                            if (!topics.has(topicName)) {
                                if (topics.size >= MAX_TOTAL_TOPICS) return
                                topics.set(topicName, new Set())
                            }
                            topics.get(topicName)!.add(conn)
                            subscribedTopics.add(topicName)
                        })
                        break
                    }

                    case 'unsubscribe': {
                        const unsubscribeTopics: unknown[] = Array.isArray(message.topics) ? message.topics : []
                        unsubscribeTopics.forEach((topicName) => {
                            if (typeof topicName !== 'string') return
                            subscribedTopics.delete(topicName)
                            const subs = topics.get(topicName)
                            if (subs) {
                                subs.delete(conn)
                                if (subs.size === 0) {
                                    topics.delete(topicName)
                                }
                            }
                        })
                        break
                    }

                    case 'publish': {
                        if (
                            typeof message.topic === 'string' &&
                            message.topic.length > 0 &&
                            message.topic.length <= MAX_TOPIC_NAME_LENGTH &&
                            subscribedTopics.has(message.topic)
                        ) {
                            const receivers = topics.get(message.topic)
                            if (receivers) {
                                message.clients = receivers.size
                                receivers.forEach((receiver: any) => send(receiver, message))
                            }
                        }
                        break
                    }

                    case 'ping':
                        send(conn, { type: 'pong' })
                        break
                }
            })
        })

        server.on('upgrade', (request: any, socket: any, head: any) => {
            if (wss.clients.size >= MAX_CONNECTIONS) {
                socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n')
                socket.destroy()
                return
            }
            wss.handleUpgrade(request, socket, head, (ws: any) => {
                wss.emit('connection', ws, request)
            })
        })

        server.on('error', (err: any) => {
            if (err.code === 'EADDRINUSE') {
                verifyExistingKalyntSignalingServer(port).then((isKalyntServer) => {
                    if (isKalyntServer) {
                        console.warn(`[Signaling] Port ${port} already running a verified Kalynt signaling server — reusing it`)
                        resolve({
                            port,
                            url: `ws://localhost:${port}`,
                            close: () => { /* owned by existing Kalynt instance */ }
                        })
                    } else {
                        console.error(`[Signaling] Port ${port} is already in use by another process (not Kalynt signaling server)`)
                        reject(err)
                    }
                })
            } else {
                reject(err)
            }
        })

        // Default remains 127.0.0.1 for security (loopback only).
        // Set KALYNT_SIGNALING_BIND=0.0.0.0 to enable LAN accessibility.
        const bindHost = process.env.KALYNT_SIGNALING_BIND === '0.0.0.0' ? '0.0.0.0' : '127.0.0.1'
        const displayUrl = bindHost === '0.0.0.0'
            ? `ws://0.0.0.0:${port} (LAN accessible - ${os.hostname() || 'this-machine'})`
            : `ws://localhost:${port} (localhost only)`

        server.listen(port, bindHost, () => {
            const addr = server.address()
            const actualPort: number = (addr && typeof addr === 'object') ? addr.port : port
            console.log(`[Signaling] Built-in signaling server started on ${displayUrl}`)

            resolve({
                port: actualPort,
                url: `ws://localhost:${actualPort}`,
                lanUrl: bindHost === '0.0.0.0' ? `ws://${os.hostname()}:${actualPort}` : undefined,
                close: () => {
                    wss.clients.forEach((client: any) => {
                        try {
                            client.terminate()
                        } catch {
                            // Ignore errors during shutdown
                        }
                    })
                    wss.close()
                    server.close()
                    topics.clear()
                    console.log('[Signaling] Built-in signaling server stopped')
                }
            })
        })
    })
}
