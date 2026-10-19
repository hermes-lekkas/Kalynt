/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * electron-builder afterPack hook.
 *
 * node-llama-cpp ships outside app.asar (extraResources) so its native
 * binaries can load. extraResources only copies the node-llama-cpp and
 * @node-llama-cpp folders, though, and npm hoists most of node-llama-cpp's
 * own dependencies to the repository's root node_modules. Without them the
 * packaged app fails to load the local AI engine ("Cannot find module
 * 'graceful-fs'"). This hook copies that dependency closure next to it.
 */
const fs = require('node:fs')
const path = require('node:path')

const ENGINE = 'node-llama-cpp'

/** Node's lookup: walk up from `fromDir` through each node_modules folder. */
function resolvePackageDir(name, fromDir) {
    for (let dir = fromDir; ; dir = path.dirname(dir)) {
        const candidate = path.join(dir, 'node_modules', name)
        if (fs.existsSync(path.join(candidate, 'package.json'))) return fs.realpathSync(candidate)
        if (path.dirname(dir) === dir) return null
    }
}

/** Every installed package node-llama-cpp needs at runtime, as real paths. */
function dependencyClosure(engineDir) {
    const seen = new Set([engineDir])
    const queue = [engineDir]
    while (queue.length) {
        const dir = queue.pop()
        const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
        const names = Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies })
        for (const name of names) {
            const found = resolvePackageDir(name, dir)
            // Optional platform packages for other OSes are simply not installed.
            if (!found || seen.has(found)) continue
            seen.add(found)
            queue.push(found)
        }
    }
    return seen
}

exports.default = async function afterPack(context) {
    const desktopDir = context.packager.info.appDir
    const engineDir = resolvePackageDir(ENGINE, desktopDir)
    if (!engineDir) throw new Error(`[after-pack] ${ENGINE} is not installed`)

    // Packages are copied to the same relative place they have under the
    // root node_modules, so nested copies (a/node_modules/b) keep resolving.
    const rootModules = path.dirname(engineDir)
    const target = path.join(context.packager.getResourcesDir(context.appOutDir), 'node_modules')

    let copied = 0
    for (const dir of dependencyClosure(engineDir)) {
        const relative = path.relative(rootModules, dir)
        // extraResources already copied these two (with the native binaries).
        if (relative === ENGINE || relative.startsWith(`${ENGINE}${path.sep}`) || relative.startsWith(`@node-llama-cpp${path.sep}`)) continue
        if (relative.startsWith('..')) throw new Error(`[after-pack] ${dir} is outside ${rootModules}`)
        const dest = path.join(target, relative)
        if (fs.existsSync(dest)) continue
        fs.cpSync(dir, dest, { recursive: true, dereference: true })
        copied++
    }
    console.log(`  • after-pack      copied ${copied} ${ENGINE} dependencies into resources/node_modules`)
}
