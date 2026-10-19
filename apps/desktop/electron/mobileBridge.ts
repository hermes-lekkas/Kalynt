/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
/**
 * Mobile Bridge Server
 *
 * Handles WebSocket connections from the Android companion app.
 * Provides endpoints for pairing, command execution, and GitHub proxy.
 * Runs alongside the y-webrtc signaling server on a different port.
 */

// Use require to avoid ESM/types issues (matching signalingServer.ts pattern)
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { WebSocketServer } = require('ws')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const http = require('http')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const https = require('https')

import {
    handlePairingRequest,
    generatePairingQR,
    hasValidToken,
    clearPairingState
} from './mobilePairing'
import type { DeviceInfo } from './mobilePairing'
import {
    executeAgentCommand,
    proxyGitHubRequest,
    setGitHubToken,
    isGitHubConfigured
} from './mobileGithubProxy'
import type { AgentCommand } from './mobileGithubProxy'

export { generatePairingQR }

// Mobile message types (must match Android)
interface MobileMessage {
    type: string
    requestId?: string
    [key: string]: any
}

interface MobileClient {
    id: string
    socket: any
    deviceInfo: DeviceInfo
    pairedAt: number
    lastPing: number
}

// WebSocket ready states
const WS_READY_STATE_OPEN = 1

const clientSessions = new Map<string, MobileClient>()

// Configuration
const PING_TIMEOUT = 30000
const MAX_MESSAGE_SIZE = 1024 * 1024 // 1MB

export interface MobileBridgeHandle {
    port: number
    pairingPort: number
    url: string
    close: () => void
    setGitHubToken: (token: string) => void
    sendNotification: (deviceId: string, notification: any) => boolean
    getConnectedDevices: () => DeviceInfo[]
}

/**
 * Send message to mobile client
 */
function send(socket: any, message: any) {
    if (socket.readyState === WS_READY_STATE_OPEN) {
        socket.send(JSON.stringify(message))
    }
}

/**
 * Send error to mobile client
 */
function sendError(socket: any, message: string, code: string) {
    send(socket, {
        type: 'error',
        code,
        message
    })
}

/**
 * Start the mobile bridge server
 */
export function startMobileBridge(port: number = 8443): Promise<MobileBridgeHandle> {
    return new Promise((resolve, reject) => {
        // HTTP server for pairing endpoint
        const pairingServer = http.createServer(handlePairingRequest)
        const pairingPort = port + 1

        // WebSocket server for mobile connections
        const wss = new WebSocketServer({ noServer: true })
        const server = https.createServer(getTlsOptions())

        // Handle WebSocket connections
        wss.on('connection', (socket: any, req: any) => {
            const clientId = require('crypto').randomBytes(16).toString('base64url')
            console.log(`[MobileBridge] New connection: ${clientId}`)

            let authenticated = false
            let pongReceived = true

            // Set up ping interval
            const pingInterval = setInterval(() => {
                if (!pongReceived) {
                    console.log(`[MobileBridge] Client ${clientId} timed out`)
                    socket.terminate()
                    clearInterval(pingInterval)
                    return
                }
                pongReceived = false
                if (socket.readyState === WS_READY_STATE_OPEN) {
                    socket.ping()
                }
            }, PING_TIMEOUT)

            socket.on('pong', () => {
                pongReceived = true
            })

            socket.on('message', (data: any) => {
                try {
                    // Size limit check
                    if (data.length > MAX_MESSAGE_SIZE) {
                        sendError(socket, 'Message too large', 'MESSAGE_TOO_LARGE')
                        return
                    }

                    const message: MobileMessage = JSON.parse(data.toString())

                    // Authentication required for most messages
                    if (!authenticated && message.type !== 'authenticate') {
                        sendError(socket, 'Authentication required', 'AUTH_REQUIRED')
                        return
                    }

                    handleMobileMessage(socket, message, clientId, () => {
                        authenticated = true
                    })

                } catch (err) {
                    console.error('[MobileBridge] Invalid message:', err)
                    sendError(socket, 'Invalid message format', 'INVALID_MESSAGE')
                }
            })

            socket.on('close', () => {
                clearInterval(pingInterval)
                clientSessions.delete(clientId)
                console.log(`[MobileBridge] Client disconnected: ${clientId}`)
            })

            socket.on('error', (err: Error) => {
                console.error(`[MobileBridge] Socket error for ${clientId}:`, err)
            })
        })

        // Handle upgrade to WebSocket
        server.on('upgrade', (request: any, socket: any, head: any) => {
            const pathname = new URL(request.url || '', `https://localhost:${port}`).pathname

            if (pathname === '/mobile') {
                wss.handleUpgrade(request, socket, head, (ws: any) => {
                    wss.emit('connection', ws, request)
                })
            } else {
                socket.destroy()
            }
        })

        // Start pairing HTTP server
        pairingServer.listen(pairingPort, '0.0.0.0', () => {
            console.log(`[MobileBridge] Pairing endpoint on http://0.0.0.0:${pairingPort}`)
        })

        // Start WebSocket server
        server.listen(port, '0.0.0.0', () => {
            console.log(`[MobileBridge] WebSocket server on wss://0.0.0.0:${port}`)

            resolve({
                port,
                pairingPort,
                url: `wss://localhost:${port}`,
                close: () => {
                    pairingServer.close()
                    server.close()
                    wss.close()
                    clientSessions.clear()
                    clearPairingState()
                },
                setGitHubToken: (token: string) => {
                    setGitHubToken(token)
                },
                sendNotification: (deviceId: string, notification: any): boolean => {
                    for (const [, client] of clientSessions) {
                        if (client.deviceInfo.deviceId === deviceId) {
                            if (client.socket.readyState === WS_READY_STATE_OPEN) {
                                client.socket.send(JSON.stringify({
                                    type: 'push_notification',
                                    ...notification
                                }))
                                return true
                            }
                        }
                    }
                    return false
                },
                getConnectedDevices: (): DeviceInfo[] => {
                    return Array.from(clientSessions.values()).map(c => c.deviceInfo)
                }
            })
        })

        server.on('error', (err: any) => {
            if (err.code === 'EADDRINUSE') {
                console.warn(`[MobileBridge] Port ${port} in use, trying ${port + 10}`)
                startMobileBridge(port + 10).then(resolve).catch(reject)
            } else {
                reject(err)
            }
        })
    })
}

/**
 * Handle messages from mobile clients
 */
async function handleMobileMessage(
    socket: any,
    message: MobileMessage,
    clientId: string,
    onAuthenticated: () => void
) {
    switch (message.type) {
        case 'authenticate': {
            const { token } = message
            if (!token || !hasValidToken(token)) {
                sendError(socket, 'Invalid token', 'AUTH_FAILED')
                return
            }

            // Send desktop info
            send(socket, {
                type: 'desktop_info',
                ip: getLocalIp(),
                port: 8443,
                version: require('electron').app.getVersion(),
                deviceName: require('os').hostname()
            })

            break
        }

        case 'device_info': {
            const { deviceInfo } = message
            if (!deviceInfo || !deviceInfo.deviceId) {
                sendError(socket, 'Invalid device info', 'INVALID_DEVICE')
                return
            }

            // Store client session
            clientSessions.set(clientId, {
                id: clientId,
                socket,
                deviceInfo,
                pairedAt: Date.now(),
                lastPing: Date.now()
            })

            onAuthenticated()

            send(socket, {
                type: 'authenticated',
                message: 'Connected to Kalynt Desktop'
            })

            console.log(`[MobileBridge] Device authenticated: ${deviceInfo.deviceName}`)
            break
        }

        case 'execute_command': {
            const { requestId, agentId, command, params } = message

            try {
                // Forward to agent manager (will be implemented in main process)
                const result = await executeAgentCommand({ agentId, command, params } as AgentCommand)

                send(socket, {
                    type: 'command_response',
                    requestId,
                    status: 'completed',
                    result
                })
            } catch (err: any) {
                send(socket, {
                    type: 'command_response',
                    requestId,
                    status: 'failed',
                    error: err.message
                })
            }
            break
        }

        case 'github_request': {
            const { requestId, endpoint, method, body } = message

            if (!isGitHubConfigured()) {
                sendError(socket, 'GitHub not authenticated', 'GITHUB_NOT_AUTH')
                return
            }

            try {
                const result = await proxyGitHubRequest(endpoint, method, body)
                send(socket, {
                    type: 'github_response',
                    requestId,
                    statusCode: 200,
                    body: result
                })
            } catch (err: any) {
                send(socket, {
                    type: 'github_response',
                    requestId,
                    statusCode: err.status || 500,
                    error: err.message
                })
            }
            break
        }

        case 'ping': {
            send(socket, { type: 'pong', timestamp: Date.now() })
            break
        }

        default: {
            sendError(socket, `Unknown message type: ${message.type}`, 'UNKNOWN_TYPE')
        }
    }
}

/**
 * TLS options for the bridge server. There is no certificate yet, so phones
 * can't connect over TLS until pairing ships (see the changelog's known
 * issues). Client certificates are never requested, so nothing here turns
 * off certificate checks.
 */
function getTlsOptions(): import("https").ServerOptions {
    return {}
}

/**
 * Get local IP address
 */
export function getLocalIp(): string {
    const interfaces = require('os').networkInterfaces()
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address
            }
        }
    }
    return 'localhost'
}
