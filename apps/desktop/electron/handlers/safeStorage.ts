/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { safeStorage } from 'electron'
import type { IpcMain } from 'electron'
import crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

// Store encrypted keys in a JSON file in userData
let keysFilePath: string = ''

interface EncryptedKeys {
    [key: string]: string // Base64 encoded encrypted values
}

const DISALLOWED_KEY_NAMES = new Set(['__proto__', 'constructor', 'prototype'])
const MAIN_ONLY_SECRET_PREFIXES = ['apiKey_']
const MAIN_ONLY_SECRET_KEYS = new Set(['localServer_connection'])

function isValidKeyName(key: unknown): key is string {
    return typeof key === 'string' && key.length > 0 && !DISALLOWED_KEY_NAMES.has(key)
}

function isMainOnlySecret(key: string): boolean {
    return MAIN_ONLY_SECRET_KEYS.has(key) || MAIN_ONLY_SECRET_PREFIXES.some(prefix => key.startsWith(prefix))
}

function hasStoredKey(keys: EncryptedKeys, key: string): boolean {
    return Object.prototype.hasOwnProperty.call(keys, key) && typeof keys[key] === 'string' && keys[key].length > 0
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
                return Object.assign(Object.create(null), parsed) as EncryptedKeys
            }
            console.error('[SafeStorage] Invalid keys file format: not an object')
        }
    } catch (error) {
        console.error('[SafeStorage] Failed to load keys:', error)
    }
    return Object.create(null) as EncryptedKeys
}

// Written to a unique temporary file and renamed, so concurrent writes or a
// crash mid-write cannot corrupt stored keys. Readable by the owner only.
function saveKeys(userDataPath: string, keys: EncryptedKeys): void {
    const filePath = getKeysFilePath(userDataPath)
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`
    try {
        fs.writeFileSync(tempPath, JSON.stringify(keys, null, 2), { encoding: 'utf-8', mode: 0o600 })
        fs.renameSync(tempPath, filePath)
    } catch (error) {
        try { fs.unlinkSync(tempPath) } catch { /* ignore cleanup error */ }
        throw error
    }
}

/** Decrypts one stored secret for use inside the main process, or null. */
export function readSecret(userDataPath: string, key: string): string | null {
    try {
        if (!isValidKeyName(key)) return null
        const keys = loadKeys(userDataPath)
        const encryptedBase64 = hasStoredKey(keys, key) ? keys[key] : null
        if (!encryptedBase64 || !safeStorage.isEncryptionAvailable()) return null
        return safeStorage.decryptString(Buffer.from(encryptedBase64, 'base64'))
    } catch (error) {
        console.error(`[SafeStorage] Couldn't read ${key}:`, error)
        return null
    }
}

/** Main-process settings use the same encrypted, atomic storage as API keys. */
export function writeSecret(userDataPath: string, key: string, value: string): void {
    if (!isValidKeyName(key)) throw new Error('Invalid secret key name.')
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure storage is unavailable. Unlock your system keychain and try again.')
    const keys = loadKeys(userDataPath)
    keys[key] = safeStorage.encryptString(value).toString('base64')
    saveKeys(userDataPath, keys)
}

export function deleteSecret(userDataPath: string, key: string): void {
    if (!isValidKeyName(key)) return
    const keys = loadKeys(userDataPath)
    delete keys[key]
    saveKeys(userDataPath, keys)
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
            if (!isValidKeyName(options?.key) || typeof options.value !== 'string') {
                return { success: false, error: 'A valid key and a text value are required' }
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

    // Check whether a stored key exists without decrypting or exposing its value
    ipcMain.handle('safeStorage:hasKey', async (_event, key: string) => {
        try {
            if (!isValidKeyName(key)) {
                return { success: false, hasKey: false, error: 'A valid key name is required' }
            }
            const keys = loadKeys(getUserDataPath())
            return { success: true, hasKey: hasStoredKey(keys, key) }
        } catch (error) {
            console.error('[SafeStorage] HasKey error:', error)
            return { success: false, hasKey: false, error: String(error) }
        }
    })

    // Retrieve and decrypt a value
    // SECURITY FIX: Refuse to retrieve main-process-only secrets (cloud API keys
    // and local server connection) or when encryption is unavailable.
    ipcMain.handle('safeStorage:get', async (_event, key: string) => {
        try {
            if (!isValidKeyName(key)) {
                return { success: false, value: null, error: 'A valid key name is required' }
            }
            const keys = loadKeys(getUserDataPath())
            const exists = hasStoredKey(keys, key)

            if (isMainOnlySecret(key)) {
                console.warn(`[SafeStorage] Blocked renderer read of main-only secret: ${key}`)
                return {
                    success: false,
                    value: null,
                    hasKey: exists,
                    error: 'Access denied: this credential can only be read by the main process.'
                }
            }

            if (!exists) {
                return { success: true, value: null, hasKey: false }
            }

            if (!safeStorage.isEncryptionAvailable()) {
                // SECURITY: Do not attempt to decode potentially encrypted data
                // This prevents misuse of unencrypted fallback data
                console.error('[SafeStorage] Encryption not available - cannot retrieve credentials')
                return {
                    success: false,
                    value: null,
                    hasKey: true,
                    error: 'Secure storage is not available on this system. Cannot retrieve credentials.',
                    encrypted: false
                }
            }

            const encrypted = Buffer.from(keys[key], 'base64')
            const decrypted = safeStorage.decryptString(encrypted)

            return { success: true, value: decrypted, hasKey: true, encrypted: true }
        } catch (error) {
            console.error('[SafeStorage] Get error:', error)
            return { success: false, error: String(error) }
        }
    })

    // Delete a stored key
    ipcMain.handle('safeStorage:delete', async (_event, key: string) => {
        try {
            if (!isValidKeyName(key)) {
                return { success: false, error: 'A valid key name is required' }
            }
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
