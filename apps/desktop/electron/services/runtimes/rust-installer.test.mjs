/* SPDX-License-Identifier: AGPL-3.0-only */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kalynt-rust-installer-test-'))
after(() => fs.rm(root, { recursive: true, force: true }))

let bundleCounter = 0
async function loadTs(relPath) {
    const entry = fileURLToPath(new URL(relPath, import.meta.url))
    const outFile = path.join(root, `bundle-${++bundleCounter}.cjs`)
    await build({
        entryPoints: [entry],
        bundle: true,
        outfile: outFile,
        platform: 'node',
        format: 'cjs',
        external: ['electron']
    })
    return require(outFile)
}

test('QA-20: rustup installer basename is preserved as rustup-init on POSIX and rustup-init.exe on Windows', async () => {
    const { rustupInstallerFilename, prepareRustupExecutablePath, runRustup } = await loadTs('./installer.ts')

    assert.equal(rustupInstallerFilename('linux'), 'rustup-init')
    assert.equal(rustupInstallerFilename('darwin'), 'rustup-init')
    assert.equal(rustupInstallerFilename('win32'), 'rustup-init.exe')

    // POSIX rename/copy from rust.download -> rustup-init
    const dlDirPosix = path.join(root, 'dl-posix')
    await fs.mkdir(dlDirPosix, { recursive: true })
    const rawDownloadPosix = path.join(dlDirPosix, 'rust.download')
    await fs.writeFile(rawDownloadPosix, '#!/bin/sh\necho ok\n')
    const preparedPosix = prepareRustupExecutablePath(rawDownloadPosix, 'linux')
    assert.equal(path.basename(preparedPosix.executablePath), 'rustup-init')
    assert.equal(preparedPosix.createdCopy, true)
    assert.equal(fsSync.existsSync(preparedPosix.executablePath), true)
    // Calling again on already-correct basename does not copy
    const alreadyPosix = prepareRustupExecutablePath(preparedPosix.executablePath, 'linux')
    assert.equal(alreadyPosix.createdCopy, false)

    // Windows rename/copy from rust.download -> rustup-init.exe
    const dlDirWin = path.join(root, 'dl-win')
    await fs.mkdir(dlDirWin, { recursive: true })
    const rawDownloadWin = path.join(dlDirWin, 'rust.download')
    await fs.writeFile(rawDownloadWin, 'MZ')
    const preparedWin = prepareRustupExecutablePath(rawDownloadWin, 'win32')
    assert.equal(path.basename(preparedWin.executablePath), 'rustup-init.exe')
    assert.equal(preparedWin.createdCopy, true)
    assert.equal(fsSync.existsSync(preparedWin.executablePath), true)
    const alreadyWin = prepareRustupExecutablePath(preparedWin.executablePath, 'win32')
    assert.equal(alreadyWin.createdCopy, false)

    // End-to-end execution check on POSIX: fake rustup-init fails with "unknown proxy name" if argv[0] != rustup-init
    if (process.platform !== 'win32') {
        const fakeRustupDir = path.join(root, 'e2e-dl')
        const installDir = path.join(root, 'e2e-install')
        await fs.mkdir(fakeRustupDir, { recursive: true })
        await fs.mkdir(installDir, { recursive: true })
        const misnamedInstaller = path.join(fakeRustupDir, 'rust.download')
        await fs.writeFile(misnamedInstaller, [
            '#!/bin/sh',
            'BASE=$(basename "$0")',
            'if [ "$BASE" != "rustup-init" ]; then',
            '  echo "error: unknown proxy name: \'$BASE\'" >&2',
            '  exit 1',
            'fi',
            'mkdir -p "$CARGO_HOME/bin" "$RUSTUP_HOME"',
            'printf "#!/bin/sh\\necho \\"cargo 1.85.0\\"\\n" > "$CARGO_HOME/bin/cargo"',
            'printf "#!/bin/sh\\necho \\"rustc 1.85.0 (4d91de4e4 2025-02-17)\\"\\n" > "$CARGO_HOME/bin/rustc"',
            'chmod +x "$CARGO_HOME/bin/cargo" "$CARGO_HOME/bin/rustc"',
            'exit 0'
        ].join('\n'), { mode: 0o755 })

        const env = await runRustup(misnamedInstaller, installDir)
        assert.equal(env.CARGO_HOME, path.join(installDir, 'cargo'))
        assert.equal(env.RUSTUP_HOME, path.join(installDir, 'rustup'))
        assert.equal(fsSync.existsSync(path.join(installDir, 'cargo', 'bin', 'rustc')), true)
        // Temporary copy must be cleaned up after runRustup
        assert.equal(fsSync.existsSync(path.join(fakeRustupDir, 'rustup-init')), false)

        // Verify RuntimeManager.installRuntime records the real managed rustc version
        const { RuntimeManager } = await loadTs('../runtime-manager.ts')
        const runtimesRoot = path.join(root, 'managed-runtimes')
        const mgr = new RuntimeManager(runtimesRoot)
        const dlPath = path.join(mgr.getDownloadsDir(), 'rust.download')
        await fs.mkdir(mgr.getDownloadsDir(), { recursive: true })
        await fs.copyFile(misnamedInstaller, dlPath)

        const res = await mgr.installRuntime('rust', 'rust.download')
        assert.equal(res.success, true, `installRuntime failed: ${res.error}`)
        const check = await mgr.checkInstallation('rust')
        assert.equal(check.isInstalled, true)
        assert.equal(check.managedByKalynt, true)
        assert.equal(check.version, '1.85.0')

        const removed = await mgr.uninstallRuntime('rust')
        assert.equal(removed.success, true)
    }
})
