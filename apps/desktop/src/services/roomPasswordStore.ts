/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Workspace room passwords. localStorage keeps only the `encryptionEnabled`
 * flag under `space-settings-<spaceId>`; the password itself lives in the
 * OS-backed secure storage under `roomPassword_<spaceId>`.
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

const settingsKey = (spaceId: string) => `${SETTINGS_PREFIX}${spaceId}`
const secretKey = (spaceId: string) => `roomPassword_${spaceId}`
const secure = () => window.electronAPI?.safeStorage

function readSettings(spaceId: string): StoredSettings {
    try {
        const parsed = JSON.parse(localStorage.getItem(settingsKey(spaceId)) || '{}')
        return parsed && typeof parsed === 'object' ? parsed : {}
    } catch {
        return {}
    }
}

function writeFlag(spaceId: string, encryptionEnabled: boolean): void {
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

/** The workspace's room password, or null when encryption is off or none is stored. */
export async function getRoomPassword(spaceId: string): Promise<string | null> {
    await migrateLegacyRoomPasswords()
    const { encryptionEnabled, roomPassword } = readSettings(spaceId)
    if (!encryptionEnabled) return null
    // Only present when secure storage refused the migration.
    if (typeof roomPassword === 'string' && roomPassword) return roomPassword
    try {
        const r: SecureResult | undefined = await secure()?.get(secretKey(spaceId))
        return r?.success && typeof r.value === 'string' && r.value ? r.value : null
    } catch {
        return null
    }
}

export async function hasRoomPassword(spaceId: string): Promise<boolean> {
    return !!(await getRoomPassword(spaceId))
}

/** Saves the password to secure storage and turns encryption on. Throws if it can't be saved. */
export async function setRoomPassword(spaceId: string, password: string): Promise<void> {
    await migrateLegacyRoomPasswords()
    const r: SecureResult | undefined = await secure()?.set({ key: secretKey(spaceId), value: password })
    if (!r?.success) throw new Error(r?.error || 'The room password could not be saved to secure storage.')
    writeFlag(spaceId, true)
}

/** Turns encryption off and deletes the stored password. */
export async function clearRoomPassword(spaceId: string): Promise<void> {
    await migrateLegacyRoomPasswords()
    writeFlag(spaceId, false)
    const r: SecureResult | undefined = await secure()?.delete(secretKey(spaceId))
    if (r && !r.success) console.warn(`[RoomPassword] Couldn't delete the password for ${spaceId}:`, r.error)
}

/** Turns the encryption flag on without touching a stored password. */
export async function markEncryptionEnabled(spaceId: string): Promise<void> {
    await migrateLegacyRoomPasswords()
    writeFlag(spaceId, true)
}
