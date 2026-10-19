# Security Policy

##  Security Philosophy

Kalynt is built on a "Trust No One" (Zero Trust) architecture. We assume that networks are compromised and that privacy is a fundamental right.

### Core Principles

1.  **Local-First:** Data should never leave the user's machine unless explicitly authorized.
2.  **End-to-End Encryption:** Peer-to-peer workspace data is encrypted with AES-256-GCM when the workspace has a room password.
3.  **Least Privilege:** The renderer has no Node.js access, extensions run in a separate process, and agent changes need approval unless you choose otherwise.
4.  **Transparency:** The core codebase is open-source (AGPL-3.0) for public audit.

---

##  Supported Versions

| Version | Supported |
|---|---|
| 2.0.x | Yes |
| 1.0.x (beta) | No. Please update to 2.0. |

---

##  Security Features

### 1. P2P Collaboration Encryption
*   **Protocol:** Yjs CRDT updates over WebRTC data channels.
*   **With a room password:** a key is derived from the password with PBKDF2, and every update is encrypted with AES-256-GCM before it leaves the machine. The password itself is never sent.
*   **Without a room password:** anyone with the invite link or room code can join and read the workspace. Kalynt shows this in the invite dialog; set a password for anything sensitive.
*   **Signaling:** the built-in signaling server listens only on `127.0.0.1`. Peers on other machines meet through the public y-webrtc signaling server, which relays connection offers but never document data.

### 2. AI Agent Safeguards
*   **Approval modes:** *Ask before changes* (the default) asks before every edit, deletion and command; *Auto-edit* applies file edits directly but still asks for deletions and commands; *Full auto* runs everything without asking. Reading, searching and web search never ask.
*   **Risky commands always ask,** in every mode: `sudo`, recursive force deletes, `mkfs`/`dd`, force pushes, `git reset --hard`, `git clean -f`, piping a download into a shell, `npm publish` and similar. "Always allow" remembers a command prefix (such as `npm run test`) for that conversation only, and never for inline code (`python -c`, `node -e`) or commands with shell operators.
*   **Commands run in your shell with your permissions.** The agent's `run_command` uses a real shell so it can run scripts and pipelines, with a non-interactive environment (no prompts, no pager). Its file tools are limited to the workspace by the same path validation as everything else, but a command you approve can reach anything your user account can. Stop ends the command's whole process tree.
*   **Web access:** pages are fetched from the main process with a size and time limit. Only public addresses are allowed: the host is resolved and every redirect is checked, and a URL on your machine or local network (`localhost`, `192.168.x.x`, `*.local`, …) is fetched only after you approve it.
*   **Undo:** files are snapshotted before the agent's first change in a run, and *Undo* restores them. Snapshots are saved with the conversation in your profile folder (`agent-sessions/`, owner-only), so deleting a conversation deletes them too.
*   **Untrusted content:** files and web pages the agent reads can contain instructions aimed at it (prompt injection). Keep *Ask before changes* when working with repositories or sites you don't trust.
*   **Self-checking edits** are a quality check, not a sandbox: approved edits apply to your real files.

### 3. Path Traversal Protection
*   **Validation:** every file system operation passes through one `validatePath` function (`electron/utils/pathValidator.ts`).
*   **Symlinks:** paths are resolved with `fs.realpath`, so a symbolic link can't point outside the workspace root.

### 4. Secrets
*   **API keys** (Anthropic, OpenAI, Google, DeepSeek, Moonshot, Z.ai) and the GitHub token are **never** stored in plain text. Electron's `safeStorage` encrypts them with the OS keychain (Windows DPAPI, macOS Keychain, Linux Secret Service), and the file is written atomically with owner-only permissions.
*   **Git** credentials are passed per command and never written to `.git/config`. Tokens that earlier versions stored there are removed.
*   **Cloud requests** go directly from your machine to the provider; Kalynt has no server in between. They are made by the main process, which is the only part of the app that reads provider keys; the interface keeps no copy once a key is saved.

### 5. Process Isolation and Command Execution
*   **Renderer sandbox:** `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`. The renderer reaches the system only through the preload API.
*   **Content Security Policy:** applied to every response. Scripts, styles and fonts load only from the app itself (`default-src 'self'`, `object-src 'none'`, `base-uri 'self'`); fonts are bundled, so no third-party style or font origins are allowed. `script-src` still permits `unsafe-eval` and `unsafe-inline` because the Monaco editor needs them.
*   **No shell:** Run and package-manager commands, and Build tasks of type `process`, are spawned with argument lists, so file names and arguments can't inject shell syntax. Build tasks of type `shell` in `tasks.json` run in a shell as written, like VS Code, and the agent's commands use your shell (see above).
*   **"Stop all processes"** stops only processes Kalynt started.
*   **Extensions** run in a separate process with a restricted environment, are downloaded only from Open VSX, and their archives can't write outside their folder.
*   **Native helper (macOS)** runs as a child process and communicates only through JSON-RPC over stdin/stdout.
*   **Mobile bridge** listens on the network only after you start pairing a phone, and each pairing must be approved on the desktop.

### 6. Updates
*   Updates come from this repository's GitHub releases and download only after you agree. The updater never offers an older version.

---

##  Reporting Vulnerabilities

We take security vulnerabilities seriously. If you discover a security issue, please **DO NOT** open a public issue.

**Contact:** [hermeslekkasdev@gmail.com](mailto:hermeslekkasdev@gmail.com)

Please include:
*   Description of the vulnerability.
*   Steps to reproduce.
*   Potential impact.

We will acknowledge receipt within 48 hours and strive to provide a patch within 14 days.

---

##  Security Updates (v2.0.0)

*   **Shell execution removed** from Run and package managers. Build uses a shell only for tasks declared as `shell` tasks, and the new agent runs commands through your shell by design, behind the approval rules above.
*   **Provider keys moved out of the interface:** a main-process AI gateway makes every cloud request, and the renderer only learns which providers have a key.
*   **Agent network guard:** web fetches resolve hosts and check every redirect, so a public link can't bounce the agent to a local or private address without approval.
*   **Process cleanup scoped:** "Stop all processes" previously killed processes by port, which could hit unrelated programs. It now stops only processes Kalynt started.
*   **Git token handling:** tokens are no longer stored in `.git/config`, and existing ones are removed; clone rejects option-like and `file://` URLs.
*   **Single path validator:** four diverging copies of `validatePath` were merged into one with symlink resolution.
*   **Extension hardening:** Open VSX-only downloads, VSIX path-traversal guard, restricted extension-host environment.
*   **Network exposure reduced:** the mobile bridge starts only when pairing; the signaling server binds to `127.0.0.1`.
*   **Secure storage:** atomic, owner-only writes with real error reporting.
*   **No downgrade updates:** the updater could offer an older release as an update; downgrades are now disallowed.

##  Security Updates (v1.0.5-beta)

### Critical Security Fixes
*   **Dynamic Code Execution Eliminated (CRITICAL-001):** Removed unsafe `new Function()` usage for dynamic imports in `llm-inference.ts`. Replaced with direct ESM `import()` to eliminate arbitrary code execution attack vectors.
*   **Shell Command Injection Prevention (CRITICAL-003):** Added PID validation (numeric format, range checks 1-4194304) and port validation (1-65535) to `nuke-handler.ts`. Replaced `exec()` string interpolation with validated parameters to prevent command injection attacks.
*   **Safe JSON Parsing Infrastructure (CRITICAL-002):** Created `safeJson.ts` utility with `safeJsonParse`, `safeJsonStringify`, and localStorage wrappers providing type-safe JSON handling with validation and prototype pollution prevention.

### High Severity Fixes
*   **Extension Host Promise Timeout (HIGH-001):** Fixed promise in `extensionHostProcess.ts` that never rejected on timeout. Now properly rejects with timeout error, preventing hung operations.
*   **Terminal Race Condition (HIGH-002):** Added `cleanupTimers` Map to track and clear existing timers before creating new ones in `terminalService.ts`. Prevents duplicate cleanup attempts and race conditions during terminal destruction.
*   **Content Security Policy Strengthened (HIGH-003):** Added `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`, and `frame-ancestors 'none'` directives to prevent XSS, clickjacking, and form injection attacks.

### Additional Security Improvements
*   **Electron Sandboxing (SEC-001):** Enabled the `sandbox: true` flag for Electron renderers to enforce strict process isolation.
*   **Dynamic Import Validation (SEC-002):** Implemented strict path validation for local LLM modules before dynamic `import()` to prevent unauthorized code execution.
*   **Deep Link Hardening (SEC-003):** Added rigorous validation for custom protocol deep links to prevent URL-based injection attacks.
*   **Environment Filtering (SEC-004):** Whitelisted safe environment variables for child processes to prevent credential leakage.
*   **Sanitized Debugging (SEC-006):** Hardened the debug handler to sanitize input from `package.json` fields, preventing path traversal during debugger initialization.
*   **Update Integrity (SEC-008):** Added GitHub token validation and checksum verification to the update handler.
*   **Enhanced Path Sanitization:** Hardened `file-system.ts` against advanced path traversal techniques involving complex symlink chains.
*   **XSS Mitigation:** Replaced `dangerouslySetInnerHTML` with `react-syntax-highlighter` in `CodeBlockRenderer.tsx` and enhanced AI response sanitization in `UnifiedAgentPanel.tsx`.
*   **Dependency Audits:** Updated `node-llama-cpp` and `electron` to patched versions.
