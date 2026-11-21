# Contributing to Kalynt

Thank you for contributing to Kalynt! This guide covers workspace setup, engineering conventions, verification commands, and how to submit pull requests.

---

## Repository Layout

Kalynt is an npm-workspaces monorepo:

```text
kalynt/
├── apps/desktop/              # Electron desktop application
│   ├── electron/              # Main process: IPC handlers, AI gateway, services, terminal/LSP/DAP, extensions, preload
│   ├── src/                   # Sandboxed React renderer: components, hooks, stores, services, styles
│   └── scripts/               # Build hooks (after-pack.cjs), test runner, Electron smoke harness
├── packages/
│   ├── crdt/                  # Shared Yjs CRDT helpers
│   ├── networking/            # P2P WebRTC helpers
│   ├── shared/                # Common types and utilities
│   └── native-macos/          # Swift native helper for macOS (FSEvents, CoreML, memory)
├── examples/test-extension/   # Reference VS Code extension fixture
└── website/                   # Static marketing & download site
```

Read [ARCHITECTURE.md](./ARCHITECTURE.md) for a walkthrough of the process model and service boundaries.

---

## Development Setup

### Prerequisites

- **Node.js `>= 22.12.0`** and **npm `>= 10`** (required by `@electron/rebuild` and CI)
- **Python 3.10+** and a **C++20 build toolchain** (for rebuilding `node-pty`)
- **Swift 5.9+** (optional, macOS native helper only)

### Install & Run

```bash
git clone https://github.com/hermes-lekkas/Kalynt.git
cd Kalynt
npm ci
npm run electron:dev
```

- `npm run electron:dev` starts Vite and launches the Electron desktop app.
- `npm run dev:web` runs the renderer alone in a browser with explicit desktop-only shims (`src/electronShim.ts`).
- `npm run rebuild:native --workspace=apps/desktop` explicitly rebuilds hoisted `node-pty` against Electron.

---

## Verification Checklist

Run these checks before opening a pull request:

```bash
npm test
npm run lint
npm run typecheck --workspace=apps/desktop
npm run typecheck:fixtures --workspace=apps/desktop
npm run build:vite --workspace=apps/desktop
```

Additional platform checks:

- **Linux production Electron smoke (uses disposable profile & keyring):**
  ```bash
  npm run rebuild:native --workspace=apps/desktop
  bash apps/desktop/scripts/smoke-linux-ci.sh
  ```
- **Local installer build (rebuilds `node-pty` and never publishes):**
  ```bash
  npm run build --workspace=apps/desktop
  ```
  On macOS, first run `swift build --package-path packages/native-macos -c release` to include the native helper.
- **Website changes:**
  ```bash
  npm run website:build
  ```

---

## Engineering Conventions

- **Keep modules focused and under ~500 lines.** Split by responsibility (see `apps/desktop/src/components/ide/` and `apps/desktop/electron/handlers/debug/`).
- **Design system & theming:** Build UI with primitives from `src/components/ui/` and semantic variables in `src/styles/tokens.css`. Never hard-code colors; ensure every view works in light, dark, and contributed VS Code color themes.
- **Plain-language copy:** Use sentence case and describe the exact action ("Stage file", "Lift ban", "Retry password"). Never display optimistic success states for canceled, partial, or unverified operations.
- **Main-process security:**
  - Validate every renderer-supplied filesystem path through `validatePath` (`electron/utils/pathValidator.ts`).
  - Spawn external commands with argument lists (`shell: false`). Only `tasks.json` `shell` tasks and approved agent `run_command` executions invoke a shell.
  - Keep API keys, tokens, and room passwords in `safeStorage` and never commit secrets (see [SECURITY_HYGIENE.md](./SECURITY_HYGIENE.md)).
- **AI providers & agent tools:** Curated cloud model catalogs live in `src/types/aiProviders.ts`; protocol adapters live in `electron/ai/`; agent tools live one per module under `src/services/agent/tools/` with `ctx.checkpoint` snapshots before writes.
- **Tests:** Add focused `*.test.mjs` regression tests next to your changes (automatically discovered by `npm test`). Use disposable directories in `os.tmpdir()` and loopback HTTP fixtures rather than real external services or user profiles.

---

## Areas to Contribute

- **Editor, Git & UX:** Monaco reliability, theming, accessibility, and workflow polish (`apps/desktop/src/components/`)
- **Languages, LSP & Debugging:** Additional runners, DAP adapters, and LSP integrations (`apps/desktop/electron/handlers/`, `electron/terminal/`)
- **Collaboration:** WebRTC reliability, TURN diagnostics, and CRDT sync (`packages/networking/`, `src/services/p2pService.ts`)
- **Local & Cloud AI:** Engine memory tuning, provider adapters, and agent tools (`electron/ai/`, `electron/handlers/llm/`, `src/services/agent/`)
- **Security & Testing:** Path validation, CSP, process isolation, and automated regression coverage
- **macOS Native Helper & Docs:** `packages/native-macos/`, guides, and examples

---

## Submitting a Pull Request

1. Fork the repository and create a feature branch: `git checkout -b feat/short-description`
2. Make focused commits with clear messages and passing tests.
3. Push your branch and open a Pull Request summarizing the problem, approach, and verification commands run.

---

## Publishing a release

1. Confirm the root and desktop package versions match the intended tag, and include upgrade notes in the changelog.
2. Wait for **Verify IDE** and **Build Installers** on the release source commit. Download the Windows, macOS, and Linux artifacts from that run.
3. Verify the installers and the generated `latest*.yml` SHA-512 hashes. Upload the installers, generated updater files, and a SHA-256 checksum manifest to a draft GitHub release targeting the same source commit.
4. Publish the draft once all platforms are present. Verify the public GitHub download links and the download section on GitHub Pages.

---

## Community Standards & License

- Follow our [Code of Conduct](./CODE_OF_CONDUCT.md) and [Security Policy](./SECURITY.md).
- By contributing, you agree that your contributions are licensed under **AGPL-3.0-only**.

Copyright © 2026 Hermes Lekkas (`hermeslekkasdev@gmail.com`).
