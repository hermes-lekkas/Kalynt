/* SPDX-License-Identifier: AGPL-3.0-only */
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const writes = new Map<string, Promise<unknown>>()
/** Serialize compare-and-write inside the app; readers see the old or new file. */
export function writeTextFile(file: string, content: string, encoding: BufferEncoding = 'utf8', expectedContent?: string | null): Promise<{ success: boolean; conflict?: boolean; error?: string; bom?: boolean }> {
    const previous = writes.get(file) ?? Promise.resolve()
    const operation = previous.catch(() => undefined).then(async () => {
        let temporary: string | undefined
        try {
            const stat = await fs.stat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error })
            if (stat && !stat.isFile()) return { success: false, error: 'This path is not a file' }
            if (stat) await fs.access(file, fs.constants.W_OK)
            const target = stat ? await fs.realpath(file) : file
            const before = stat ? await fs.readFile(target, 'utf8') : null
            // Monaco omits a UTF-8 BOM from its model value. Preserve an existing
            // BOM instead of changing the file format on the first edit.
            const text = (encoding === 'utf8' || encoding === 'utf-8') && before?.startsWith('\uFEFF') && !content.startsWith('\uFEFF') ? '\uFEFF' + content : content
            if (expectedContent !== undefined && before !== expectedContent) {
                if (before === text) return { success: true, bom: text.startsWith('\uFEFF') }
                return { success: false, conflict: true, error: 'The file changed on disk since it was opened or saved.' }
            }
            await fs.mkdir(path.dirname(target), { recursive: true })
            temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`)
            await fs.writeFile(temporary, text, { encoding, mode: stat ? stat.mode & 0o777 : 0o666, flag: 'wx' })
            if (stat) await fs.chmod(temporary, stat.mode & 0o777)
            await fs.rename(temporary, target)
            return { success: true, bom: text.startsWith('\uFEFF') }
        } catch (error) {
            return { success: false, error: error instanceof Error ? error.message : String(error) }
        } finally { if (temporary) await fs.rm(temporary, { force: true }).catch(() => undefined) }
    })
    writes.set(file, operation)
    void operation.finally(() => { if (writes.get(file) === operation) writes.delete(file) })
    return operation
}
