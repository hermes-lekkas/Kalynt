/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Mobile device pairing: ECDH key exchange, the HTTP pairing endpoint the
 * phone posts to, and the QR payload that starts the flow. Tokens and
 * pending pairings live in memory only and are cleared on app restart.
 */
// Use require to avoid ESM/types issues (matching signalingServer.ts pattern)
// eslint-disable-next-line @typescript-eslint/no-var-requires
const http = require('http')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const crypto = require('crypto')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { dialog } = require('electron')

export interface DeviceInfo {
    deviceId: string
    deviceName: string
    osVersion: string
    appVersion: string
}

export interface PendingPairing {
    tempToken: string
    desktopPublicKey: string
    desktopPrivateKey: string
    timestamp: number
    ip: string
}

const PAIRING_TIMEOUT = 300000 // 5 minutes

// Token storage (in-memory, cleared on app restart)
const validTokens = new Set<string>()
const pendingPairings = new Map<string, PendingPairing>()

/** True when the token was issued by a completed pairing. */
export function hasValidToken(token: string): boolean {
    return validTokens.has(token)
}

/** Forgets every token and pending pairing; used when the bridge shuts down. */
export function clearPairingState(): void {
    validTokens.clear()
    pendingPairings.clear()
}

/**
 * Generate a secure random token
 */
function generateToken(length: number = 32): string {
    return crypto.randomBytes(length).toString('base64url')
}

/**
 * Generate ECDH key pair for pairing
 */
function generateKeyPair(): { publicKey: string; privateKey: string } {
    const ecdh = crypto.createECDH('secp256r1')
    ecdh.generateKeys()
    return {
        publicKey: ecdh.getPublicKey('base64'),
        privateKey: ecdh.getPrivateKey('base64')
    }
}

/**
 * Derive session key from ECDH
 */
function deriveSessionKey(privateKey: string, clientPublicKey: string): Buffer {
    const ecdh = crypto.createECDH('secp256r1')
    ecdh.setPrivateKey(Buffer.from(privateKey, 'base64'))
    return ecdh.computeSecret(clientPublicKey, 'base64')
}

/**
 * Generate QR code data for pairing
 */
export function generatePairingQR(ip: string): { qrData: string; cancel: () => void } {
    const tempToken = generateToken(16)
    const keyPair = generateKeyPair()

    const pairing: PendingPairing = {
        tempToken,
        desktopPublicKey: keyPair.publicKey,
        desktopPrivateKey: keyPair.privateKey,
        timestamp: Date.now(),
        ip
    }

    pendingPairings.set(tempToken, pairing)

    const qrData = JSON.stringify({
        desktopIp: ip,
        desktopPort: 8443,
        tempToken,
        desktopPublicKey: keyPair.publicKey,
        timestamp: Date.now()
    })

    return {
        qrData,
        cancel: () => {
            pendingPairings.delete(tempToken)
        }
    }
}

/**
 * Handle pairing HTTP requests
 */
export function handlePairingRequest(req: any, res: any) {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

    if (req.method === 'OPTIONS') {
        res.writeHead(200)
        res.end()
        return
    }

    if (req.method !== 'POST' || req.url !== '/pair') {
        res.writeHead(404)
        res.end(JSON.stringify({ error: 'Not found' }))
        return
    }

    let body = ''
    req.on('data', (chunk: any) => body += chunk)
    req.on('end', async () => {
        try {
            const request = JSON.parse(body)
            const { tempToken, devicePublicKey, deviceInfo } = request

            // Validate request
            if (!tempToken || !devicePublicKey || !deviceInfo) {
                res.writeHead(400)
                res.end(JSON.stringify({ error: 'Missing required fields' }))
                return
            }

            // Find pending pairing
            const pairing = pendingPairings.get(tempToken)
            if (!pairing) {
                res.writeHead(401)
                res.end(JSON.stringify({ error: 'Invalid or expired pairing token' }))
                return
            }

            // Check timeout
            if (Date.now() - pairing.timestamp > PAIRING_TIMEOUT) {
                pendingPairings.delete(tempToken)
                res.writeHead(401)
                res.end(JSON.stringify({ error: 'Pairing expired' }))
                return
            }

            // Show confirmation dialog to user
            const result = await dialog.showMessageBox({
                type: 'question',
                buttons: ['Approve', 'Reject'],
                defaultId: 0,
                title: 'Mobile Device Pairing',
                message: `Allow "${deviceInfo.deviceName}" to connect?`,
                detail: `Device: ${deviceInfo.deviceId}\nOS: ${deviceInfo.osVersion}\nApp: ${deviceInfo.appVersion}`
            })

            if (result.response !== 0) {
                pendingPairings.delete(tempToken)
                res.writeHead(403)
                res.end(JSON.stringify({ error: 'Pairing rejected by user' }))
                return
            }

            // Generate tokens
            const accessToken = generateToken()
            const refreshToken = generateToken()

            // Derive session key
            const sessionKey = deriveSessionKey(pairing.desktopPrivateKey, devicePublicKey)

            // Store tokens
            validTokens.add(accessToken)
            validTokens.add(refreshToken)

            // Clean up pairing
            pendingPairings.delete(tempToken)

            res.writeHead(200)
            res.end(JSON.stringify({
                success: true,
                accessToken,
                refreshToken,
                sessionKey: sessionKey.toString('base64')
            }))

        } catch (err) {
            console.error('[MobileBridge] Pairing error:', err)
            res.writeHead(500)
            res.end(JSON.stringify({ error: 'Internal server error' }))
        }
    })
}
