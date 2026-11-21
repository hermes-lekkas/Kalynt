# Security Policy

## Security Philosophy

Kalynt is built around a local-first, least-privilege security model. We assume networks are untrusted, isolate the UI renderer from Node.js, and keep credentials inside the operating system's keychain.

### Core Principles

1. **Local-First:** Code, conversations, recovery drafts, and search indexes stay on your machine unless you explicitly choose cloud AI or P2P collaboration.
2. **End-to-End Encryption:** Password-protected workspaces encrypt P2P updates, chat messages, moderation actions, and shared files with AES-256-GCM and HMAC-SHA256 integrity verification (protocol v2).
3. **Least Privilege:** The renderer runs sandboxed without Node.js access, extensions execute in a separate process with a restricted environment, and agent modifications require approval unless you explicitly opt into *Auto-edit* or *Full auto*.
4. **Transparency:** Kalynt is free and open-source under AGPL-3.0-only for public inspection and audit.

---

## Supported Versions

| Version | Supported | Notes |
| --- | --- | --- |
| **2.1.x** | Yes | Current stable release (collaboration protocol v2) |
| **2.0.x** | No | Please upgrade to 2.1.x (save open files before updating) |
| **1.0.x (beta)** | No | Discontinued; please upgrade to 2.1.x |

---

## Security Architecture

### 1. Peer-to-Peer Collaboration Encryption (Protocol v2)

- **Transport:** Yjs CRDT updates over WebRTC data channels.
- **With a room password (protocol v2):** Kalynt derives a deterministic room-scoped salt (`SHA-256`), runs PBKDF2-SHA256 (100,000 iterations), and expands domain-separated HKDF-SHA256 subkeys for AES-256-GCM encryption, HMAC-SHA256 update integrity, and a non-secret 16-byte key-confirmation commitment (`keyCheck`). Passwords are never transmitted or embedded in generated invite links (`#lock=1` signals password protection without revealing the secret).
- **Fail-closed authentication:** Encrypted rooms reject plaintext downgrades, truncated packets, unready keys, and modified ciphertext. Wrong passwords and incompatible pre-2.1 protocol peers are explicitly detected and surfaced without delivering protected workspace content to unauthenticated clients.
- **Cryptographic identity & moderation:** Peers announce ECDSA P-256 identities; ownership claims, moderation actions, and durable `bannedRecords` entries are cryptographically signed and role-checked so unprivileged or impersonating peers cannot escalate privileges or forge bans.
- **Without a room password:** Anyone with the invite link or room code can join and read the workspace. Kalynt highlights this in the Invite dialog; set a password for sensitive projects.
- **Signaling:** The built-in signaling server binds strictly to `127.0.0.1:4444`. Remote peers discover offers through the public `y-webrtc` signaling fallback, which relays WebRTC signaling only and never sees decrypted workspace data.

### 2. AI Agent Safeguards

- **Approval modes:** *Ask before changes* (default) prompts before every edit, deletion, and command; *Auto-edit* applies file edits directly while prompting for deletions and commands; *Full auto* executes without prompting except for high-risk commands. Read-only file inspection and search never prompt.
- **Risky commands always prompt:** Regardless of mode, Kalynt requires explicit approval for `sudo`, recursive force deletes (`rm -rf`), `mkfs`/`dd`, force pushes, `git reset --hard`, `git clean -f`, pipe-to-shell downloads, `npm publish`, and similar operations. "Always allow" scopes only to safe command prefixes for the current chat — never inline execution flags (`node -e`, `python -c`) or shell operators.
- **Shell scope:** Approved agent `run_command` executions run in your shell with your OS user permissions (non-interactive environment). File tools remain confined to the workspace root via `validatePath`. Stopping a run terminates the full child process tree.
- **SSRF-guarded web access:** Agent web fetches execute in the main process with size and timeout limits. DNS resolution and every redirect hop are checked; private, link-local, and loopback hosts (`localhost`, `127.0.0.0/8`, `192.168.x.x`, `*.local`, etc.) are blocked unless explicitly approved.
- **Checkpoints & Undo:** Files are snapshotted before the agent's first write in a run and stored owner-only alongside the conversation (`agent-sessions/`). Deleting a conversation deletes its snapshots.
- **Prompt injection caution:** Untrusted repositories and web pages can contain adversarial instructions. Keep *Ask before changes* active on untrusted codebases.

### 3. Path Traversal & Filesystem Protection

- **Single path validator:** Every filesystem IPC handler validates paths through `electron/utils/pathValidator.ts`.
- **Symlink & boundary resolution:** Existing paths and new-file parent directories are resolved with `fs.realpath`, preventing `..` escapes, sibling-prefix collisions, and symlink traversal on POSIX and Windows (including drive/UNC normalization).
- **Atomic writes & permissions:** Editor recovery drafts, agent sessions, and secret stores are written atomically with owner-only permissions.

### 4. Secrets & Credentials

- **Keychain storage:** Provider API keys (Anthropic, OpenAI, Google, DeepSeek, Moonshot, Z.ai), GitHub tokens, TURN credentials, and saved room passwords are encrypted through Electron `safeStorage` (Windows DPAPI, macOS Keychain, Linux Secret Service) and never written in plaintext to disk.
- **Main-process isolation:** Cloud requests originate exclusively in the main-process AI gateway (`electron/ai/`); the renderer only learns whether a provider has a saved key.
- **Local inference servers:** Ollama and LM Studio connections are restricted to loopback addresses on this machine; optional server tokens are stored via `safeStorage`.
- **Git tokens:** Passed per command and never written into `.git/config`; legacy tokens found in `.git/config` are scrubbed, and `git clone` rejects option-like and `file://` URLs.

### 5. Process Isolation, Extensions & Updates

- **Renderer sandbox:** `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`.
- **Content Security Policy:** Applied to every response (`default-src 'self'`, `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`, `frame-ancestors 'none'`). Fonts are bundled locally with no third-party style/font origins (`script-src` retains `unsafe-eval`/`unsafe-inline` solely for Monaco Editor).
- **No shell for Run/package managers:** Single-file Run, package manager operations, and `process` build tasks spawn with argument arrays (`shell: false`). Only `tasks.json` tasks explicitly typed as `shell` and approved agent commands invoke a shell.
- **Scoped process cleanup:** "Stop all processes" (`shutdown.ts`) terminates only Kalynt-spawned PTYs, `TaskRunnerService` executions, direct runs, builds, debuggers, package installs, agent commands, and AI requests — never unrelated OS processes.
- **Extensions & themes:** Downloaded only from Open VSX; VSIX archive extraction and JSONC color-theme `include` resolution reject path traversal; the extension host runs in a separate process with a filtered environment.
- **Deep links:** `kalynt://join/<roomId>` URLs are strictly validated (scheme, host, segment syntax, raw `..` check, query/hash sanitization) in the main process before reaching the renderer.
- **Updates:** Sourced from GitHub Releases, require explicit user approval before downloading, and disallow version downgrades.

---

## Reporting a Vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities.

**Contact:** [hermeslekkasdev@gmail.com](mailto:hermeslekkasdev@gmail.com)

Please include:
- A clear description of the vulnerability and affected Kalynt version
- Minimal reproduction steps or proof of concept
- Assessed impact and any suggested remediation

We aim to acknowledge reports within **48 hours** and provide a fix or mitigation plan within **14 days**.

---

## Security Changelog

### v2.1.0 (2026-11-21)
- **Collaboration protocol v2:** Deterministic room salt + PBKDF2→HKDF key separation (`AES-256-GCM` + `HMAC-SHA256` + non-secret `keyCheck`), explicit mixed-version vs. wrong-password detection, and fail-closed rejection of plaintext/truncated packets (including zero-prefixed AES-GCM IVs).
- **Cryptographic ban enforcement:** Durable ECDSA-signed `bannedRecords` enforced both live and on rejoin, preventing unauthorized or spoofed bans.
- **Deep-link hardening:** Cold-start `argv` and macOS `open-url` links undergo strict host/segment/traversal validation before queuing for single-delivery consumption (`deep-link:consume`); password-protected invites pass `#lock=1` instead of embedding passwords.
- **Theme loader hardening:** Contributed VS Code JSONC themes enforce path-traversal validation on theme files and `include` chains.
- **Complete process shutdown:** `TaskRunnerService` process trees are now included in `stopEverythingWithDetails()` and `shutdownApp()`.
- **Model download validation:** Resumed HTTP 206/416 downloads verify byte ranges and total length and reject unsupported redirect schemes.
- **Loopback local servers:** Ollama/LM Studio integrations restrict endpoints to loopback hosts and store optional bearer tokens in `safeStorage`.

### v2.0.0 (2026-10-19)
- Removed shell execution from Run and package managers; moved all cloud provider keys into the main-process AI gateway; added SSRF-checked agent web guard; scoped "Stop all processes" strictly to Kalynt-started processes; removed Git tokens from `.git/config`; consolidated path validation with `fs.realpath`; hardened Open VSX/VSIX extension isolation; bound signaling server to `127.0.0.1`; made `safeStorage` writes atomic and owner-only; disabled updater downgrades.

### v1.0.5-beta (2026-02-27)
- Eliminated dynamic `new Function()` imports (CRITICAL-001), prevented shell injection in process cleanup (CRITICAL-003), added safe JSON helpers (CRITICAL-002), hardened CSP directives (HIGH-003), enabled Electron renderer sandboxing (SEC-001), filtered child-process environment variables (SEC-004), and strengthened path sanitization and XSS defenses.
