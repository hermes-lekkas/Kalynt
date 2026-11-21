/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Workspace room passwords. localStorage keeps only the `encryptionEnabled`
 * flag under `space-settings-<spaceId>`; persistent passwords live in the
 * OS-backed secure storage under `roomPassword_<spaceId>`, while deep-link
 * session passwords can be kept purely in memory via the volatile helpers.
 */

const SETTINGS_PREFIX = 'space-settings-'

interface SecureResult {
    success?: boolean
    value?: string | null
    error?: string
}

interface StoredSettings {
    encryptionEnabled?: boolean
    /** Older versions saved the password here in plain text; the migration moves it out. */
    roomPassword?: unknown
}

const normalizeId = (spaceId: string) => spaceId.trim().toLowerCase()
const settingsKey = (spaceId: string) => `${SETTINGS_PREFIX}${spaceId}`
const secretKey = (spaceId: string) => `roomPassword_${spaceId}`
const secure = () => (typeof window !== 'undefined' ? window.electronAPI?.safeStorage : undefined)

/** Volatile in-memory passwords (e.g. from kalynt:// deep links); never persisted to disk. */
const volatilePasswords = new Map<string, string>()

function hasLocalStorage(): boolean {
    return typeof localStorage !== 'undefined'
}

function readSettings(spaceId: string): StoredSettings {
    if (!hasLocalStorage()) return {}
    try {
        const parsed = JSON.parse(localStorage.getItem(settingsKey(spaceId)) || '{}')
        return parsed && typeof parsed === 'object' ? parsed : {}
    } catch {
        return {}
    }
}

function writeFlag(spaceId: string, encryptionEnabled: boolean): void {
    if (!hasLocalStorage()) return
    localStorage.setItem(settingsKey(spaceId), JSON.stringify({ encryptionEnabled }))
}

let migration: Promise<void> | null = null

/**
 * Moves room passwords that older versions saved in localStorage into secure
 * storage and strips them from localStorage. Runs once per app start; every
 * other function here waits for it. A password that secure storage refuses
 * stays where it is, so the workspace keeps working and the next start retries.
 */
export function migrateLegacyRoomPasswords(): Promise<void> {
    migration ??= (async () => {
        if (!hasLocalStorage()) return
        const keys = Object.keys(localStorage).filter(k => k.startsWith(SETTINGS_PREFIX))
        for (const key of keys) {
            const spaceId = key.slice(SETTINGS_PREFIX.length)
            const { encryptionEnabled, roomPassword } = readSettings(spaceId)
            if (roomPassword === undefined) continue
            if (typeof roomPassword === 'string' && roomPassword) {
                try {
                    const r: SecureResult | undefined = await secure()?.set({ key: secretKey(spaceId), value: roomPassword })
                    if (!r?.success) throw new Error(r?.error || 'secure storage unavailable')
                } catch (error) {
                    console.warn(`[RoomPassword] Couldn't move the password for ${spaceId} to secure storage:`, error)
                    continue
                }
            }
            writeFlag(spaceId, !!encryptionEnabled)
        }
    })().catch(error => console.error('[RoomPassword] Migration failed:', error))
    return migration
}

/**
 * Keeps a room password in memory for the current session only (never written
 * to localStorage or secure storage). Used for deep-link joins.
 */
export function setVolatileRoomPassword(spaceId: string, password: string): void {
    const key = normalizeId(spaceId)
    if (!key) return
    if (password) {
        volatilePasswords.set(key, password)
    } else {
        volatilePasswords.delete(key)
    }
}

/** Returns the in-memory volatile password for a workspace, or null if none. */
export function getVolatileRoomPassword(spaceId: string): string | null {
    const key = normalizeId(spaceId)
    return volatilePasswords.get(key) ?? volatilePasswords.get(spaceId) ?? null
}

/** Clears the in-memory volatile password for a workspace. */
export function clearVolatileRoomPassword(spaceId: string): void {
    volatilePasswords.delete(normalizeId(spaceId))
    volatilePasswords.delete(spaceId)
}

/** The workspace's room password, or null when encryption is off or none is stored. */
export async function getRoomPassword(spaceId: string): Promise<string | null> {
    const key = normalizeId(spaceId)
    const volatile = volatilePasswords.get(key) ?? volatilePasswords.get(spaceId)
    if (volatile) return volatile

    await migrateLegacyRoomPasswords()
    const normalizedSettings = readSettings(key)
    const legacySettings = key !== spaceId ? readSettings(spaceId) : {}
    const effectiveId = normalizedSettings.encryptionEnabled ? key : (legacySettings.encryptionEnabled ? spaceId : key)
    const { encryptionEnabled, roomPassword } = effectiveId === key ? normalizedSettings : legacySettings
    if (!encryptionEnabled) return null
    // Only present when secure storage refused the migration.
    if (typeof roomPassword === 'string' && roomPassword) return roomPassword
    try {
        const r: SecureResult | undefined = await secure()?.get(secretKey(effectiveId))
        if (r?.success && typeof r.value === 'string' && r.value) return r.value
        if (effectiveId !== spaceId) {
            const legacyRes: SecureResult | undefined = await secure()?.get(secretKey(spaceId))
            return legacyRes?.success && typeof legacyRes.value === 'string' && legacyRes.value ? legacyRes.value : null
        }
        return null
    } catch {
        return null
    }
}

export async function hasRoomPassword(spaceId: string): Promise<boolean> {
    return !!(await getRoomPassword(spaceId))
}

/** Saves the password to secure storage and turns encryption on. Throws if it can't be saved. */
export async function setRoomPassword(spaceId: string, password: string): Promise<void> {
    const key = normalizeId(spaceId)
    await migrateLegacyRoomPasswords()
    const r: SecureResult | undefined = await secure()?.set({ key: secretKey(key), value: password })
    if (!r?.success) throw new Error(r?.error || 'The room password could not be saved to secure storage.')
    volatilePasswords.delete(key)
    volatilePasswords.delete(spaceId)
    writeFlag(key, true)
}

/** Turns encryption off and deletes both volatile and stored passwords. */
export async function clearRoomPassword(spaceId: string): Promise<void> {
    const key = normalizeId(spaceId)
    volatilePasswords.delete(key)
    volatilePasswords.delete(spaceId)
    await migrateLegacyRoomPasswords()
    writeFlag(key, false)
    if (key !== spaceId) writeFlag(spaceId, false)
    const r: SecureResult | undefined = await secure()?.delete(secretKey(key))
    if (r && !r.success) console.warn(`[RoomPassword] Couldn't delete the password for ${key}:`, r.error)
    if (key !== spaceId) {
        await secure()?.delete(secretKey(spaceId)).catch(() => undefined)
    }
}

/** Turns the encryption flag on without touching a stored password. */
export async function markEncryptionEnabled(spaceId: string): Promise<void> {
    await migrateLegacyRoomPasswords()
    writeFlag(normalizeId(spaceId), true)
}
