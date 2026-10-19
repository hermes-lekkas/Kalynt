# Contributing to Kalynt

Thank you for your interest in contributing to Kalynt! We welcome contributions from the community to help make this the best privacy-first IDE.

## Repository Structure

Kalynt is a monorepo managed by npm workspaces.

```text
kalynt/
├── apps/
│   ├── desktop/              # The Electron application
│   │   ├── electron/         # Main process: IPC handlers, services, terminal, extensions, preload
│   │   ├── src/              # Renderer: React components, stores, services, styles
│   │   └── scripts/          # Build hooks (electron-builder afterPack)
│   └── mobile/               # Android companion app (built separately)
├── packages/
│   ├── crdt/                 # Shared CRDT logic (Yjs wrappers)
│   ├── networking/           # P2P networking layer
│   ├── shared/               # Common types and utilities
│   └── native-macos/         # Swift native helper (FSEvents, CoreML, memory)
└── ...
```

[ARCHITECTURE.md](./ARCHITECTURE.md) explains how the pieces fit together.

## Getting Started

1.  **Prerequisites**:
    *   Node.js >= 22.0.0
    *   Python 3.10+ (for native module builds)
    *   C++ build tools
    *   Swift 5.9+ (for the macOS native helper, optional)

2.  **Setup**:
    ```bash
    git clone https://github.com/trisle-app/Kalynt.git
    cd Kalynt
    npm install
    ```

3.  **Run the app in development**:
    ```bash
    npm run electron:dev
    ```
    This starts the Vite dev server and launches Electron. `npm run dev:web` runs the interface alone in a browser, with the desktop APIs stubbed out.

4.  **Check your changes** before opening a pull request:
    ```bash
    cd apps/desktop
    npx tsc --noEmit -p tsconfig.json        # renderer
    npx tsc --noEmit -p tsconfig.node.json   # main process
    npx vite build                           # production build
    ```

## Conventions

*   **Keep files under 500 lines.** Split by responsibility (see `components/ide/` or `electron/handlers/debug/` for examples).
*   **UI** uses the primitives in `src/components/ui` and the CSS variables in `src/styles/tokens.css`; don't hard-code colours. Every view must work in both the light and dark themes.
*   **Write interface text in plain language**, in sentence case, and say what happens ("Stage file", not "Submit").
*   **Main process:** never spawn a shell. Pass commands as argument lists, and send every path that comes from the renderer through `validatePath` (`electron/utils/pathValidator.ts`). The one exception is the agent's `run_command` (`electron/agent/exec.ts`), which runs behind the approval rules in `src/services/agent/approvals.ts`.
*   **Cloud providers and model IDs** live only in `src/types/aiProviders.ts`. Each protocol has one adapter in `electron/ai/`; a provider with an OpenAI-compatible API usually needs only a catalog entry and its parameters in `openaiChat.ts`.
*   **Agent tools** live in `src/services/agent/tools/`, one file per area. A tool that changes something needs a `kind` that the approval rules understand, and should snapshot files with `ctx.checkpoint` before writing.

## What You Can Contribute To

We accept pull requests for:

*   **UI/UX**: components, styling and themes (`apps/desktop/src/components`)
*   **Language support**: new languages for Run, Build and Debug (`electron/handlers/code-exec`, `electron/handlers/debug`)
*   **Networking**: P2P reliability (`packages/networking`, `src/services/p2pService.ts`)
*   **Performance**: memory and startup time (`electron/services/Performance_Acceleration`)
*   **Security**: path handling, CSP, process isolation
*   **Tests**: Kalynt has no unit-test suite yet, and tests are very welcome
*   **Native (macOS)**: the Swift helper (`packages/native-macos`)
*   **Documentation**: guides and tutorials

## Submission Guidelines

1.  **Fork the repository**.
2.  **Create a feature branch**: `git checkout -b feature/my-new-feature`
3.  **Commit your changes**: `git commit -am 'Add some feature'`
4.  **Push to the branch**: `git push origin feature/my-new-feature`
5.  **Submit a Pull Request**.

## Code of Conduct

*   Be respectful and inclusive.
*   Focus on constructive feedback.
*   Zero tolerance for harassment or discrimination.

## License

By contributing, you agree that your contributions will be licensed under the **AGPL-3.0-only** license.

---
© 2026 Hermes Lekkas (hermeslekkasdev@gmail.com). All rights reserved.
