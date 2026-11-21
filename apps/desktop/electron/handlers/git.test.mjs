/* SPDX-License-Identifier: AGPL-3.0-only */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)

const { outputFiles } = await build({
    entryPoints: [fileURLToPath(new URL('./git.ts', import.meta.url))],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    banner: {
        js: `import { createRequire as testCreateRequire } from 'node:module'; const require = testCreateRequire(${JSON.stringify(import.meta.url)});`
    },
    plugins: [{
        name: 'git-test-boundaries',
        setup(b) {
            b.onResolve({ filter: /^simple-git$/ }, args => ({
                path: args.kind === 'require-call'
                    ? require.resolve('simple-git')
                    : pathToFileURL(require.resolve('simple-git')).href,
                external: true
            }))
            b.onLoad({ filter: /safeStorage\.ts$/ }, () => ({
                contents: 'export const readSecret = () => null',
                loader: 'ts'
            }))
        }
    }]
})

const { registerGitHandlers } = await import(
    `data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`
)

const tempDirs = []
after(async () => {
    await Promise.all(tempDirs.map(dir => fs.rm(dir, { recursive: true, force: true })))
})

function runGit(cwd, args) {
    return execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
            ...process.env,
            GIT_AUTHOR_NAME: 'Kalynt QA',
            GIT_AUTHOR_EMAIL: 'qa@kalynt.local',
            GIT_COMMITTER_NAME: 'Kalynt QA',
            GIT_COMMITTER_EMAIL: 'qa@kalynt.local'
        }
    }).trim()
}

async function createMultiRemoteFixture() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kalynt-git-qa19-'))
    tempDirs.push(root)

    const originBare = path.join(root, 'origin.git')
    const secondBare = path.join(root, 'second.git')
    const seed = path.join(root, 'seed')
    const work = path.join(root, 'work')

    await fs.mkdir(originBare, { recursive: true })
    await fs.mkdir(secondBare, { recursive: true })
    await fs.mkdir(seed, { recursive: true })

    runGit(originBare, ['init', '--bare', '-b', 'main'])
    runGit(secondBare, ['init', '--bare', '-b', 'main'])

    // Create initial main branch and push to both bare remotes.
    runGit(seed, ['init', '-b', 'main'])
    await fs.writeFile(path.join(seed, 'README.md'), 'base\n')
    runGit(seed, ['add', 'README.md'])
    runGit(seed, ['commit', '-m', 'base commit'])
    runGit(seed, ['remote', 'add', 'origin', originBare])
    runGit(seed, ['remote', 'add', 'second', secondBare])
    runGit(seed, ['push', '-u', 'origin', 'main'])
    runGit(seed, ['push', 'second', 'main'])

    // Create origin/shared-name at commit A.
    runGit(seed, ['checkout', '-b', 'shared-name', 'main'])
    await fs.writeFile(path.join(seed, 'source.txt'), 'from origin\n')
    runGit(seed, ['add', 'source.txt'])
    runGit(seed, ['commit', '-m', 'origin shared-name commit'])
    const originSharedSha = runGit(seed, ['rev-parse', 'HEAD'])
    runGit(seed, ['push', 'origin', 'shared-name'])

    // Create second/shared-name at commit B (divergent commit from main).
    runGit(seed, ['checkout', '-B', 'shared-name', 'main'])
    await fs.writeFile(path.join(seed, 'source.txt'), 'from second\n')
    runGit(seed, ['add', 'source.txt'])
    runGit(seed, ['commit', '-m', 'second shared-name commit'])
    const secondSharedSha = runGit(seed, ['rev-parse', 'HEAD'])
    runGit(seed, ['push', 'second', 'shared-name'])

    // Clone origin into working copy, add second remote, and fetch both.
    runGit(root, ['clone', originBare, work])
    runGit(work, ['config', 'user.name', 'Kalynt QA'])
    runGit(work, ['config', 'user.email', 'qa@kalynt.local'])
    runGit(work, ['remote', 'add', 'second', secondBare])
    runGit(work, ['fetch', '--all'])

    // Wire real registerGitHandlers against a mock ipcMain.
    const handlers = new Map()
    const ipcMain = { handle: (channel, fn) => handlers.set(channel, fn) }
    registerGitHandlers(ipcMain, () => work, () => root)
    const invoke = (channel, arg) => handlers.get(channel)({}, arg)

    return { root, work, originBare, secondBare, originSharedSha, secondSharedSha, invoke }
}

test('QA-19: checking out same-named remote branches across two remotes never detaches HEAD and tracks exact remote', async () => {
    const { work, originBare, secondBare, originSharedSha, secondSharedSha, invoke } = await createMultiRemoteFixture()

    // 1. Select origin/shared-name when no local shared-name exists yet.
    const resOrigin = await invoke('git:checkout', { repoPath: work, branch: 'origin/shared-name', remoteRef: 'origin/shared-name' })
    assert.equal(resOrigin.success, true)
    assert.equal(resOrigin.branch, 'shared-name')
    assert.equal(resOrigin.tracking, 'origin/shared-name')
    assert.equal(resOrigin.created, true)

    assert.equal(runGit(work, ['branch', '--show-current']), 'shared-name')
    assert.equal(runGit(work, ['rev-parse', 'HEAD']), originSharedSha)
    assert.equal(runGit(work, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']), 'origin/shared-name')

    // 2. Select second/shared-name while local shared-name already exists tracking origin/shared-name.
    const resSecond = await invoke('git:checkout', { repoPath: work, branch: 'second/shared-name', remoteRef: 'second/shared-name' })
    assert.equal(resSecond.success, true)
    assert.equal(resSecond.branch, 'second-shared-name')
    assert.equal(resSecond.tracking, 'second/shared-name')
    assert.equal(resSecond.created, true)

    assert.equal(runGit(work, ['branch', '--show-current']), 'second-shared-name')
    assert.equal(runGit(work, ['rev-parse', 'HEAD']), secondSharedSha)
    assert.equal(runGit(work, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']), 'second/shared-name')

    // 3. Commit and push from renamed tracking branch `second-shared-name` pushes to `second`'s `shared-name`!
    await fs.writeFile(path.join(work, 'second-only.txt'), 'pushed from second-shared-name\n')
    assert.equal((await invoke('git:add', { repoPath: work, files: ['second-only.txt'] })).success, true)
    assert.equal((await invoke('git:commit', { repoPath: work, message: 'second branch update' })).success, true)
    const pushedSecondSha = runGit(work, ['rev-parse', 'HEAD'])
    const pushSecondRes = await invoke('git:push', work)
    assert.equal(pushSecondRes.success, true, pushSecondRes.error)
    assert.equal(runGit(secondBare, ['rev-parse', 'refs/heads/shared-name']), pushedSecondSha)
    assert.equal(runGit(originBare, ['rev-parse', 'refs/heads/shared-name']), originSharedSha)

    // 4. Selecting origin/shared-name again reuses existing local `shared-name` without duplicating or detaching.
    const resOriginAgain = await invoke('git:checkout', { repoPath: work, branch: 'origin/shared-name' })
    assert.equal(resOriginAgain.success, true)
    assert.equal(resOriginAgain.branch, 'shared-name')
    assert.equal(resOriginAgain.tracking, 'origin/shared-name')
    assert.equal(resOriginAgain.created, false)
    assert.equal(runGit(work, ['branch', '--show-current']), 'shared-name')
    assert.equal(runGit(work, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']), 'origin/shared-name')

    // Commit and push on origin's tracking branch pushes to origin's shared-name only.
    await fs.writeFile(path.join(work, 'origin-only.txt'), 'pushed from shared-name\n')
    assert.equal((await invoke('git:add', { repoPath: work, files: ['origin-only.txt'] })).success, true)
    assert.equal((await invoke('git:commit', { repoPath: work, message: 'origin branch update' })).success, true)
    const pushedOriginSha = runGit(work, ['rev-parse', 'HEAD'])
    const pushOriginRes = await invoke('git:push', work)
    assert.equal(pushOriginRes.success, true, pushOriginRes.error)
    assert.equal(runGit(originBare, ['rev-parse', 'refs/heads/shared-name']), pushedOriginSha)
    assert.equal(runGit(secondBare, ['rev-parse', 'refs/heads/shared-name']), pushedSecondSha)

    // 5. Selecting second/shared-name again reuses `second-shared-name` cleanly.
    const resSecondAgain = await invoke('git:checkout', { repoPath: work, branch: 'remotes/second/shared-name' })
    assert.equal(resSecondAgain.success, true)
    assert.equal(resSecondAgain.branch, 'second-shared-name')
    assert.equal(resSecondAgain.tracking, 'second/shared-name')
    assert.equal(resSecondAgain.created, false)
    assert.equal(runGit(work, ['branch', '--show-current']), 'second-shared-name')
})

test('QA-19: existing untracked local branch of same name is preserved when checking out remote branches', async () => {
    const { work, originSharedSha, secondSharedSha, invoke } = await createMultiRemoteFixture()

    // Create a local untracked `shared-name` branch at its own commit.
    runGit(work, ['checkout', '-b', 'shared-name'])
    await fs.writeFile(path.join(work, 'local.txt'), 'local only\n')
    runGit(work, ['add', 'local.txt'])
    runGit(work, ['commit', '-m', 'local shared-name commit'])
    const localSha = runGit(work, ['rev-parse', 'HEAD'])
    runGit(work, ['checkout', 'main'])

    // Selecting origin/shared-name must NOT detach HEAD and must NOT overwrite local shared-name.
    const resOrigin = await invoke('git:checkout', { repoPath: work, branch: 'origin/shared-name' })
    assert.equal(resOrigin.success, true)
    assert.equal(resOrigin.branch, 'origin-shared-name')
    assert.equal(resOrigin.tracking, 'origin/shared-name')
    assert.equal(runGit(work, ['branch', '--show-current']), 'origin-shared-name')
    assert.equal(runGit(work, ['rev-parse', 'HEAD']), originSharedSha)
    assert.equal(runGit(work, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']), 'origin/shared-name')

    // Local shared-name commit is completely intact.
    assert.equal(runGit(work, ['rev-parse', 'refs/heads/shared-name']), localSha)

    // Selecting second/shared-name creates second-shared-name tracking second/shared-name.
    const resSecond = await invoke('git:checkout', { repoPath: work, branch: 'second/shared-name' })
    assert.equal(resSecond.success, true)
    assert.equal(resSecond.branch, 'second-shared-name')
    assert.equal(resSecond.tracking, 'second/shared-name')
    assert.equal(runGit(work, ['branch', '--show-current']), 'second-shared-name')
    assert.equal(runGit(work, ['rev-parse', 'HEAD']), secondSharedSha)
    assert.equal(runGit(work, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']), 'second/shared-name')
})

test('QA-19: rejects unsafe or nonexistent branch refs cleanly', async () => {
    const { work, invoke } = await createMultiRemoteFixture()
    assert.equal((await invoke('git:checkout', { repoPath: work, branch: '--detach' })).success, false)
    assert.equal((await invoke('git:checkout', { repoPath: work, branch: 'bad ref' })).success, false)
    assert.equal((await invoke('git:checkout', { repoPath: work, branch: 'origin/missing', remoteRef: 'origin/missing' })).success, false)
})
