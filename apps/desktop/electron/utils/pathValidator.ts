/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import path from 'node:path'
import fs from 'node:fs'

const isInside = (base: string, target: string) => target === base || target.startsWith(base + path.sep)

/**
 * Resolves `target` against `base` and throws unless the result stays inside
 * `base`. Existing paths are also checked through their real path, so a
 * symlink inside the folder can't point outside it.
 */
export function validatePath(base: string, target: string): string {
    if (!base) throw new Error('No folder to resolve against')
    const resolvedBase = path.resolve(base)
    const resolvedTarget = path.resolve(resolvedBase, target)

    if (!isInside(resolvedBase, resolvedTarget)) {
        throw new Error('Path traversal detected')
    }

    if (fs.existsSync(resolvedTarget)) {
        let realTarget: string
        let realBase: string
        try {
            realTarget = fs.realpathSync(resolvedTarget)
            realBase = fs.realpathSync(resolvedBase)
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code === 'ENOENT') return resolvedTarget
            throw new Error('Path validation failed: ' + (e as Error).message)
        }
        if (!isInside(realBase, realTarget)) {
            throw new Error('Path traversal via symlink detected')
        }
    }

    return resolvedTarget
}
