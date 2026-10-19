/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Copies a workspace folder elsewhere, leaving out dependencies and git data.
 */
import path from 'node:path'
import fs from 'node:fs'

const SKIP = new Set(['node_modules', '.git'])

export async function copyFolder(src: string, dest: string): Promise<number> {
    let copied = 0
    const walk = async (from: string, to: string): Promise<void> => {
        await new Promise(resolve => setImmediate(resolve))
        await fs.promises.mkdir(to, { recursive: true })
        const entries = await fs.promises.readdir(from, { withFileTypes: true })
        for (const entry of entries) {
            if (SKIP.has(entry.name)) continue
            const source = path.join(from, entry.name)
            const target = path.join(to, entry.name)
            if (entry.isSymbolicLink()) {
                // Keep links as links; following them could copy far outside the folder.
                try {
                    await fs.promises.symlink(await fs.promises.readlink(source), target)
                } catch (err) {
                    console.warn('[Backup] Skipped link', source, err)
                }
            } else if (entry.isDirectory()) {
                await walk(source, target)
            } else if (entry.isFile()) {
                await fs.promises.copyFile(source, target)
                copied++
            }
            // Sockets, FIFOs and devices are skipped: reading them could block forever.
        }
    }
    await walk(src, dest)
    return copied
}
