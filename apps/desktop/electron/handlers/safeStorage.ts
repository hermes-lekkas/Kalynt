/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { safeStorage } from 'electron'
import type { IpcMain } from 'electron'
import * as fs from 'node:fs'
import * as path from 'node:path'

// Store encrypted keys in a JSON file in userData
let keysFilePath: string = ''

interface EncryptedKeys {
    [key: string]: string // Base64 encoded encrypted values
}

function getKeysFilePath(userDataPath: string): string {
    if (!keysFilePath) {
        keysFilePath = path.join(userDataPath, 'secure-keys.json')
    }
    return keysFilePath
}

function loadKeys(userDataPath: string): EncryptedKeys {
    try {
        const filePath = getKeysFilePath(userDataPath)
        if (fs.existsSync(filePath)) {
            const data = fs.readFileSync(filePath, 'utf-8')
            // CRITICAL-002 FIX: Validate parsed data is an object before returning
            const parsed = JSON.parse(data)
            if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
                return parsed as EncryptedKeys
            }
            console.error('[SafeStorage] Invalid keys file format: not an object')
        }
    } catch (error) {
        console.error('[SafeStorage] Failed to load keys:', error)
    }
    return {}
}

// Written to a temporary file and renamed, so a crash mid-write can't
// corrupt every stored key. Readable by the owner only. Throws on failure.
function saveKeys(userDataPath: string, keys: EncryptedKeys): void {
    const filePath = getKeysFilePath(userDataPath)
    const tempPath = `${filePath}.${process.pid}.tmp`
    fs.writeFileSync(tempPath, JSON.stringify(keys, null, 2), { encoding: 'utf-8', mode: 0o600 })
    fs.renameSync(tempPath, filePath)
}

/** Decrypts one stored secret for use inside the main process, or null. */
export function readSecret(userDataPath: string, key: string): string | null {
    try {
        const encryptedBase64 = loadKeys(userDataPath)[key]
        if (!encryptedBase64 || !safeStorage.isEncryptionAvailable()) return null
        return safeStorage.decryptString(Buffer.from(encryptedBase64, 'base64'))
    } catch (error) {
        console.error(`[SafeStorage] Couldn't read ${key}:`, error)
        return null
    }
}

export function registerSafeStorageHandlers(
    ipcMain: IpcMain,
    getUserDataPath: () => string
) {
    // Check if safeStorage is available
    ipcMain.handle('safeStorage:isAvailable', () => {
        return safeStorage.isEncryptionAvailable()
    })

    // Store an encrypted value
    // SECURITY FIX: Refuse to store credentials when encryption is unavailable
    // Base64 encoding is NOT encryption and provides no security
    ipcMain.handle('safeStorage:set', async (_event, options: { key: string; value: string }) => {
        try {
            if (!options?.key || typeof options.value !== 'string') {
                return { success: false, error: 'A key and a text value are required' }
            }
            if (!safeStorage.isEncryptionAvailable()) {
                // SECURITY: Do not fall back to insecure storage
                console.error('[SafeStorage] Encryption not available - refusing to store credentials insecurely')
                return {
                    success: false,
                    error: 'Secure storage is not available on this system. Cannot store credentials securely.',
                    encrypted: false
                }
            }

            const encrypted = safeStorage.encryptString(options.value)
            const keys = loadKeys(getUserDataPath())
            keys[options.key] = encrypted.toString('base64')
            saveKeys(getUserDataPath(), keys)

            console.log(`[SafeStorage] Stored encrypted key: ${options.key}`)
            return { success: true, encrypted: true }
        } catch (error) {
            console.error('[SafeStorage] Set error:', error)
            return { success: false, error: String(error) }
        }
    })

    // Retrieve and decrypt a value
    // SECURITY FIX: Refuse to retrieve when encryption is unavailable
    ipcMain.handle('safeStorage:get', async (_event, key: string) => {
        try {
            const keys = loadKeys(getUserDataPath())
            const encryptedBase64 = keys[key]

            if (!encryptedBase64) {
                return { success: true, value: null }
            }

            if (!safeStorage.isEncryptionAvailable()) {
                // SECURITY: Do not attempt to decode potentially encrypted data
                // This prevents misuse of unencrypted fallback data
                console.error('[SafeStorage] Encryption not available - cannot retrieve credentials')
                return {
                    success: false,
                    value: null,
                    error: 'Secure storage is not available on this system. Cannot retrieve credentials.',
                    encrypted: false
                }
            }

            const encrypted = Buffer.from(encryptedBase64, 'base64')
            const decrypted = safeStorage.decryptString(encrypted)

            return { success: true, value: decrypted, encrypted: true }
        } catch (error) {
            console.error('[SafeStorage] Get error:', error)
            return { success: false, error: String(error) }
        }
    })

    // Delete a stored key
    ipcMain.handle('safeStorage:delete', async (_event, key: string) => {
        try {
            const keys = loadKeys(getUserDataPath())
            delete keys[key]
            saveKeys(getUserDataPath(), keys)

            console.log(`[SafeStorage] Deleted key: ${key}`)
            return { success: true }
        } catch (error) {
            console.error('[SafeStorage] Delete error:', error)
            return { success: false, error: String(error) }
        }
    })

    // Get all stored key names (not values)
    ipcMain.handle('safeStorage:listKeys', async () => {
        try {
            const keys = loadKeys(getUserDataPath())
            return { success: true, keys: Object.keys(keys) }
        } catch (error) {
            console.error('[SafeStorage] ListKeys error:', error)
            return { success: false, error: String(error) }
        }
    })
}
