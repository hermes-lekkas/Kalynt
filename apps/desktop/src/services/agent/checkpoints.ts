/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * File checkpoints: before the agent first changes a file in a run, its
 * content is recorded so the whole run can be undone.
 */
import type { RunCheckpoint } from './session'

const MAX_SNAPSHOT_BYTES = 2_000_000

export async function snapshot(checkpoint: RunCheckpoint, absolutePath: string): Promise<void> {
    if (absolutePath in checkpoint.files) return
    const fs = window.electronAPI?.fs
    if (!fs) return
    const stat = await fs.stat(absolutePath)
    if (!stat?.success) {
        checkpoint.files[absolutePath] = null
        return
    }
    if (stat.isDirectory || stat.size > MAX_SNAPSHOT_BYTES) return
    const read = await fs.readFile(absolutePath)
    if (read?.success) checkpoint.files[absolutePath] = String(read.content ?? '')
}

/** Puts every file the run touched back the way it was. Returns the paths it couldn't restore. */
export async function restore(checkpoint: RunCheckpoint): Promise<string[]> {
    const fs = window.electronAPI.fs
    const failed: string[] = []
    const restored: string[] = []
    for (const [path, content] of Object.entries(checkpoint.files)) {
        try {
            let result: { success?: boolean } | undefined
            if (content === null) {
                const stat = await fs.stat(path)
                // A failed stat can mean access denied, not only absence.
                result = stat?.success ? await fs.delete(path) : { success: /\bENOENT\b/.test(stat?.error ?? '') }
            } else {
                result = await fs.writeFile({ path, content })
            }
            if (!result?.success) failed.push(path)
            else restored.push(path)
        } catch {
            failed.push(path)
        }
    }
    checkpoint.undone = failed.length === 0
    // Retrying a partial undo must touch only failed files. The user may have
    // made fresh edits to files that were successfully restored already.
    if (failed.length) for (const path of restored) delete checkpoint.files[path]
    return failed
}
