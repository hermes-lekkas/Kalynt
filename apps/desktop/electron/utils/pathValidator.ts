/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import path from 'node:path'
import fs from 'node:fs'

const isInside = (base: string, target: string) => {
    const relative = path.relative(base, target)
    return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))
}

/** Resolve the nearest existing ancestor before appending missing segments. */
function realLocation(target: string): string {
    let ancestor = target
    const missing: string[] = []
    for (;;) {
        try { fs.lstatSync(ancestor); break }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
            const parent = path.dirname(ancestor)
            if (parent === ancestor) throw error
            missing.unshift(path.basename(ancestor))
            ancestor = parent
        }
    }
    // lstat also detects a dangling symlink: realpath must fail rather than
    // accepting it as a missing ordinary directory.
    return path.resolve(fs.realpathSync(ancestor), ...missing)
}

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

    let realTarget: string, realBase: string
    try {
        realTarget = realLocation(resolvedTarget)
        realBase = realLocation(resolvedBase)
    } catch (error) {
        throw new Error('Path validation failed: ' + (error as Error).message)
    }
    if (!isInside(realBase, realTarget)) {
        throw new Error('Path traversal via symlink detected')
    }

    return resolvedTarget
}
