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
    for (const [path, content] of Object.entries(checkpoint.files)) {
        let result: { success?: boolean } | undefined
        if (content === null) {
            const stat = await fs.stat(path)
            result = stat?.success ? await fs.delete(path) : { success: true }
        } else {
            result = await fs.writeFile({ path, content })
        }
        if (!result?.success) failed.push(path)
    }
    checkpoint.undone = true
    return failed
}
