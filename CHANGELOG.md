# Changelog

All notable changes to this project will be documented in this file.

## [v2.0.0] - 2026-10-18

Kalynt 2.0 is a ground-up rebuild of the interface and a reliability pass over every backend service. It is the first stable release.

### A new interface

The whole renderer was rebuilt from scratch on a small design system, replacing the previous UI.

- **Home and workspaces.** A home screen to create a workspace, open a folder, clone a repository or join a session, plus recent workspaces. Each workspace now remembers its own folder, open tabs and last state (previously one folder was shared by every workspace).
- **Code view.** Explorer (virtualised tree, drag to move), workspace search with replace preview, source control (stage, commit, branches, diff view), Monaco editor with split view and breadcrumbs, a bottom panel with Terminal, Output, Build and Debug, and the agent panel. Every region fails independently, so one crash no longer takes down the window.
- **Tasks, History and Shared files** are full-page views: a shared task board, the real git log grouped by day with search and author filters, and peer-to-peer file sharing.
- **Command palette** (`Ctrl+P` for files, `Ctrl+Shift+P` for commands, `#` for workspaces), keyboard shortcuts for every view, and a single dialog for extensions and language runtimes.
- **Settings** reorganised into General, Models and keys, Security, Members, Network, Performance, Advanced and About.
- **Light and dark themes** that also cover Monaco and the terminal; Instrument Sans and JetBrains Mono are bundled, so nothing loads from Google Fonts.
- **New app icon** to match the new interface.
- Every UI file is under 500 lines; the old 139 KB agent panel and similar monoliths are gone.

### Agent and AI

- **Cloud models updated.** The previous model IDs had all been retired by their providers, so Anthropic and Google keys no longer worked. Kalynt now offers Claude Opus 5.5, Sonnet 5.5 and Haiku 5.5; GPT-4o and GPT-4o mini; Gemini 2.5 Pro, 3.8 Flash, 2.5 Flash and 3.5 Flash-Lite. A saved choice of a retired model switches to the current default.
- **Cloud requests fixed for current models:** adaptive thinking instead of fixed thinking budgets, responses read by block type, room for thinking tokens in the output limit, and refusals reported clearly. Streaming no longer drops tokens when a network chunk ends mid-line.
- **API keys are checked against the provider's model list,** which costs nothing and does not depend on any model still being served.
- **Local models (AIME).** The engine was rewritten on node-llama-cpp's current API: streaming, cancel, JSON-schema output, a queue so two requests don't fail with "no sequences left", speculative decoding with a draft model, and plain-language errors (damaged file, not enough memory, unsupported quantization).
- **MemoryGuard** unloads a local model before the machine starts swapping, and optionally after a period of inactivity. New *Local model memory* settings cover the context window, GPU offload, batch size, threads and reserved RAM, and power modes feed into inference tuning.
- **Model downloads** can pause and resume, survive servers that ignore `Range` requests, and clean up partial files when cancelled.
- **Tool approvals.** Each agent action can be denied, allowed once or allowed for the session.

### Running, building and debugging

- **Run** supports 25 languages and runs the real file from the workspace. Arguments are parsed like a shell would, without ever invoking one.
- **Build** only runs real build tasks (it previously fell back to the first task, which could be a dev server), and `tasks.json` with comments and trailing commas parses.
- **The debugger was rewritten** (from 2,020 lines to five focused modules) with a corrected Debug Adapter Protocol handshake: Python (debugpy), Node.js (js-debug), C/C++ (GDB) and Go (Delve, with an install hint when it's missing). Breakpoints set before launch are honoured.
- **Language runtimes:** a catalogue of 34 runtimes with detection, install and uninstall.
- **"Stop all processes"** and quitting the app now stop only processes Kalynt started (including everything running inside its terminals). Previously, processes were killed by port, which could hit unrelated programs.

### Security and reliability

- No backend code path spawns a shell any more; package manager and run commands are argument lists.
- One path validator, with symlink resolution, guards every file operation (four diverging copies were merged).
- Git: tokens are passed per command and old tokens stored in `.git/config` by earlier versions are removed; clone rejects option-like and `file://` URLs.
- Secure storage writes are atomic and owner-only.
- Extensions download only from Open VSX, VSIX archives cannot write outside their folder, and the extension host runs with a restricted environment.
- The mobile companion bridge starts only when you pair a phone instead of listening on the network at every launch; the signaling server binds to `127.0.0.1`.
- Terminal: killing a terminal now reports its exit, and terminals kill their whole process tree.
- Production builds keep `console.error` and `console.warn`, so failures on users' machines can be diagnosed.

### Updates and packaging

- **Packaged builds can load the local AI engine.** Installers shipped node-llama-cpp without the packages it depends on, so local models could not load outside a development build. A build step now copies its full dependency set.
- The updater no longer offers an older release as an "update" (electron-updater enables downgrades whenever a channel is set).
- Release notes in either format display correctly in the update dialog.
- Builds no longer accumulate stale chunks in `dist-electron`, so installers don't ship dead code.

### Removed

- The "26 agentic services" layer (goal stack, intent classification, learning service and others) was removed: none of it was wired into the agent.
- Document checkpoints (they snapshotted an unrelated empty document), the autonomous monitor toggle and the inline edit widget.
- Inline AI completions are now off by default (Settings → General), and the artificial 2-second splash delay is gone.

### Known issues

- OpenAI's dated GPT-4o snapshots retire on 14 January 2027. Kalynt will need a release that moves to OpenAI's current models before then.
- Ten renderer services (for example `ideAgentTools.ts` and `agentLoopService.ts`) are still over 500 lines.
- The Android companion can't be paired yet: the desktop bridge exists, but the desktop app has no pairing screen (this was also true in 1.0.5).
- There is no unit-test suite yet; 2.0.0 was verified with end-to-end checks against the built app.

## [v1.0.5-beta] - 2026-02-27

### Major Architecture Update: Agentic AI System

This release introduces a comprehensive agentic architecture overhaul with 26 new services enabling autonomous decision-making, tool orchestration, and intelligent task execution.

#### Phase 1: Critical Reliability

- **Transaction Service**: ACID-compliant file operations with shadow file system and commit/rollback support for writeFile, replaceInFile, and fuzzyReplace tools
- **Cycle Detection Service**: State fingerprinting with three detection patterns (repetition, oscillation, stagnation) and automatic cycle breaking with randomized backoff
- **Tool Cache Service**: LRU cache with TTL invalidation, file dependency tracking for automatic invalidation, and hit rate monitoring
- **LSP Integration**: Enhanced shadow workspace with real-time diagnostics validation via Language Server Protocol
- **AIME Expansion**: Expanded from 10 to 50+ supported file extensions covering all major programming languages including TypeScript, Python, Go, Rust, Java, C/C++, C#, Ruby, PHP, Swift, and many more

#### Phase 2: Enhanced Autonomy

- **Goal Stack Service**: Hierarchical task planning with goal decomposition strategies, dependency management, retry logic, and plan persistence
- **Intent Classification Service**: 14 task categories (code_generation, debugging, refactoring, etc.) with regex pattern matching and keyword scoring
- **Confidence Scoring Service**: Tool performance tracking with historical success rates, context-aware confidence scoring, and auto-approval for high-confidence operations
- **Learning Service**: Correction history database with pattern matching for similar errors and adaptive tool selection based on historical performance
- **Enhanced Agent Loop**: Full integration of all Phase 2 services with hierarchical goal execution, intent-based routing, and confidence-driven tool selection

#### Phase 3: Advanced Capabilities

- **File Watcher Service**: Incremental AIME updates with configurable ignored patterns, debounced change processing, and batch handlers
- **Symbol Service**: Comprehensive symbol relationship tracking with symbol graph (classes, functions, variables), relationship types (extends, calls, references), impact analysis for refactoring, and inheritance hierarchy tracking
- **Semantic Operation Service**: High-level refactoring operations including extract method, rename symbol (with reference updates), move symbol (with import updates), and inline variable
- **Dependency Analysis Service**: Tool call dependency analysis with dependency graph construction, topological sort with parallel execution grouping, critical path identification, and resource conflict detection

#### Phase 4: Performance Optimization

- **Parallel Execution Service**: Concurrent tool execution with concurrency management (configurable limits), retry logic with exponential backoff, timeout handling, and execution plan optimization
- **Context Assembly Service**: Priority-based context management with critical context protection, token budget management, focus-based assembly, and intelligent deduplication
- **Token Optimization Service**: Context window optimization with compression strategies (comment removal, whitespace reduction, summarization), conversation window management, and token estimation

#### Security & Reliability Hardening
- **Dynamic Code Execution Eliminated (CRITICAL)**: Removed unsafe `new Function()` for dynamic imports in `llm-inference.ts`. Now uses direct ESM `import()` with proper file URL conversion for Windows compatibility.
- **Shell Command Injection Prevention (CRITICAL)**: Added PID validation (numeric format, range checks) and port validation to `nuke-handler.ts`. Replaced string interpolation with validated parameters to prevent command injection attacks.
- **Safe JSON Parsing Infrastructure**: Created `safeJson.ts` utility with `safeJsonParse`, `safeJsonStringify`, and localStorage wrappers that provide type-safe JSON handling with validation and error recovery.
- **Content Security Policy Strengthened**: Added `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`, and `frame-ancestors 'none'` directives to prevent XSS, clickjacking, and form injection attacks.
- **Extension Host Promise Timeout Fix**: Fixed promise in `extensionHostProcess.ts` that never rejected on timeout. Now properly rejects with timeout error, preventing hung operations.
- **Terminal Race Condition Fixed**: Added `cleanupTimers` Map to track and clear existing timers before creating new ones in `terminalService.ts`. Prevents duplicate cleanup attempts and race conditions during terminal destruction.
- **P2P Service Race Condition**: Added `isDestroyed` flag to prevent operations on destroyed P2P service instances, fixing race conditions in rate limiter cleanup.
- **Error Handling Improvements**: Fixed all empty catch blocks across `workspaceScanService.ts`, `agentLoopService.ts`, and `file-system.ts` - now log errors with context instead of silently swallowing them.
- **JavaScript Search Fallback**: Implemented `performJSSearch()` function in `file-system.ts` with regex pattern matching, file filtering, and result limiting. Provides fallback when ripgrep is unavailable.
- **Strict Type Safety Infrastructure**: Created `electron-api.ts` with comprehensive TypeScript interfaces for all Electron APIs, replacing 75+ `any` type assertions with proper type definitions.

#### Critical Bug Fixes
- **Terminal Flashing Fix**: Fixed infinite re-render loop in `useTerminalManager.ts` caused by useEffect dependencies. The effect was updating `tabs` state while depending on it, causing constant flashing and preventing user input. Now runs only once on mount with proper initialization guard.
- **P2P Decryption Infinite Loop**: Fixed infinite loop in `UnifiedAgentPanel.tsx` decryption effect that depended on `decryptedCache` while updating it. Now uses functional state updates to avoid dependency cycles.
- **Session Sync Dependencies**: Fixed missing/stale dependencies in chat session sync effect, preventing stale closures and session synchronization failures.
- **useAgent Stale Closure**: Restructured `useAgent.ts` into two separate effects - one for config updates, one for initialization - preventing stale closures where callbacks captured initial config values.
- **AgentService Memory Leak**: Added try-catch with cleanup in `agentService.start()` to ensure YJS observers are unregistered if initialization fails, preventing memory leaks on repeated start/stop cycles.
- **NodeJS Type Fix**: Changed `NodeJS.Timeout` to `ReturnType<typeof setTimeout>` in `UnifiedAgentPanel.tsx` for browser compatibility.

#### Major Bug Fixes (Phase 2)
- **Scroll Performance**: Added debouncing to scroll effect and removed `agent.activityLog` from dependencies to prevent excessive re-renders during agent operations.
- **Dead Code Removal**: Removed empty useEffect at lines 201-209 that was running on every message change without functionality.
- **IndexedDB Error Handling**: Added proper `onerror` handlers and Promise rejections for all IndexedDB operations in `loadSuggestions()` and `saveSuggestions()`.
- **Unused Props Marked**: Marked `currentFile`, `currentFileContent`, and `onRunCommand` props as deprecated since they're not used internally but kept for API compatibility.
- **Tool Confirmation Race Condition**: Fixed race condition where pending tool confirmations would block the agent loop if component unmounted. Now properly rejects pending confirmations on cleanup.

#### Minor Improvements (Phase 3)
- **Store Access Pattern**: Fixed architectural issue where `agentService` accessed Zustand store directly. Now `loadedModelId` is passed through proper dependency injection from React layer via `setLoadedModelId()` method.
- **Timeout Cleanup**: Added cleanup for `typingTimeoutRef` and `scrollTimeoutRef` in component unmount effect to prevent state updates on unmounted components.

#### Windows Compatibility Fix
- **AI Engine Loading on Windows**: Fixed ESM loader error "Received protocol 'c:'" on Windows. The `dynamicImportESM` function in `llm-inference.ts` now converts file paths to `file://` URLs using `pathToFileURL()` before passing to dynamic import, ensuring Windows absolute paths (e.g., `C:\Users\...`) are properly handled by the ESM loader.

#### UI & Management Services

- **Task Complexity Service**: Complexity estimation based on scope, uncertainty, dependencies, risk, and novelty factors with 5 complexity levels (trivial to very_complex)
- **Iteration Allocation Service**: Dynamic iteration budget allocation with bonus grants, early termination detection, and budget compression for well-progressing tasks
- **Progress Monitoring Service**: Real-time progress tracking with milestones, activity logging, comprehensive statistics, and listener-based updates
- **User Confirmation Service**: Multi-file change confirmation with risk assessment (low/medium/high/critical), batch operations, preview generation, and partial approval support
- **Cycle Notification Service**: UI notifications for detected cycles with severity levels, auto-dismiss, resolution tracking, and suggested actions

### Improvements & Fixes

#### Agent & AI
- **Retry Logic**: Added retry mechanism with exponential backoff for AI analysis operations
- **Duplicate Filtering**: Suggestions are now deduplicated based on action-target-description hash
- **Type Safety**: Improved TypeScript types in mission history handling

#### Debugging
- **js-debug-dap Support**: Node.js debugging now uses VS Code's official js-debug-dap adapter instead of legacy inspector protocol
- **Improved launch.json Parsing**: Fixed comment removal to handle URLs correctly (http:// no longer breaks parsing)
- **DAP Reliability**: Added initialized event handling and proper adapter lifecycle management
- **Event Listener Management**: Added proper event listener tracking and cleanup in debug sessions

#### Shadow Workspace
- **LSP Session Management**: Automatic LSP session startup for supported languages with document synchronization
- **Language Mapping**: Added comprehensive language ID mapping for LSP compatibility
- **Real-time Validation**: Diagnostics are now requested after document changes are synchronized

#### Security
- **Event Listener Isolation**: Added event listener maps to prevent cross-session pollution
- **Launch Argument Filtering**: Non-DAP properties are filtered from launch configurations

#### Architecture
- **P2P Improvements**: Signaling server implementation for WebRTC connection establishment
- **Workspace Trust**: Added workspace trust hooks for security-sensitive operations

### Files Added
- 26 new service files in `apps/desktop/src/services/` for agentic architecture
- `apps/desktop/electron/services/lspService.ts` - LSP bridge implementation
- `apps/desktop/electron/signalingServer.ts` - WebRTC signaling server

### Files Modified
- `apps/desktop/src/services/aimeService.ts` - Expanded to 50+ file extensions
- `apps/desktop/src/services/shadowWorkspaceService.ts` - LSP integration
- `apps/desktop/src/services/agentService.ts` - Retry logic and duplicate filtering
- `apps/desktop/src/services/p2pService.ts` - Removed unused method causing TS warning
- `apps/desktop/src/components/ide/terminal/useTerminalManager.ts` - Fixed infinite loop in shell initialization
- `apps/desktop/src/components/UnifiedAgentPanel.tsx` - Fixed infinite loop in P2P decryption, fixed session sync dependencies
- `apps/desktop/src/hooks/useAgent.ts` - Fixed stale closure by restructuring effects
- `apps/desktop/src/services/agentService.ts` - Fixed memory leak with proper observer cleanup
- `apps/desktop/electron/handlers/llm-inference.ts` - Windows path fix for ESM dynamic imports
- `apps/desktop/electron/handlers/debug.ts` - js-debug-dap support, improved parsing
- `apps/desktop/electron/handlers/file-system.ts` - Path validation enhancements
- `apps/desktop/package.json` - Updated dependencies

## [v1.0.4-beta] - 2026-02-16

### Key Highlights

#### Unified & Modern UI
- **Redesigned Settings Panel:** Completely rebuilt `UnifiedSettingsPanel` with a sleek, glassmorphism-based design, proper sidebar, responsive tabs, and a dedicated "Danger Zone".
- **Streamlined Agent Header:** Simplified `UnifiedAgentPanel` header by removing cluttered buttons and adding a unified "Configure AI" entry point.
- **Compact Mode Switcher:** Added pill-style toggles for "Cloud" vs "Local" AI modes and "Chat" vs "AI Scan" tabs.

#### Persistent Chat History
- **Automatic Saving:** AI conversations are now automatically saved to a local SQLite/JSON database.
- **History Panel:** Added a "Previous Chats" overlay for browsing, renaming, and deleting past sessions.
- **Session Management:** Users can now pick up exactly where they left off.

#### Resizable Panels Everywhere
- **Draggable Agent Sidebar:** The right-hand Agent panel is now fully resizable.
- **Consistent Layout:** Resizing logic matches Terminal and File Explorer behavior.

### Improvements & Fixes

#### Performance & Stability
- **Resource Monitor:** Fixed crash caused by missing iVRAM (Integrated VRAM) stats on some systems.
- **Build Stability:** Resolved numerous TypeScript errors and unused variable warnings blocking production builds.
- **File Watcher:** Optimized watcher to prevent over-firing during workspace indexing.
- **Resize Lifecycle (BUG-001):** Fixed resize listener lifecycle in `IDEWorkspace.tsx` to prevent memory leaks.
- **Agent Service (BUG-009/010):** Added immediate state sync for callbacks and introduced error type classification.
- **Member Sync (BUG-002/003):** Improved promise handling and prevented double-processing in `MemberSyncService`.

#### Collaboration & P2P
- **P2P Hardening (SEC-007/BUG-011/012):** Added rate limiter cleanup and fixed peer count consistency in `p2pService.ts`.
- **Encryption Flow (BUG-007):** Added proper error handling for encryption initialization failures.
- **State Sync (BUG-005/006):** Fixed race conditions in salt listener setup in `useYjs.ts`.

#### AI & Agent Panel
- **Scan Stability (BUG-008):** Added `isMounted` checks to prevent state updates on unmounted scan loops.
- **Error Handling (BUG-004):** Introduced `AnalysisTimeoutError` for better feedback during long AI scans.
- **Action Handlers (FEAT-001):** Implemented a new "Suggest Action" handler in the agent service.

#### Security
- **Electron Sandboxing (SEC-001):** Enabled renderer sandboxing for enhanced process isolation.
- **Import Validation (SEC-002):** Added module path validation before dynamic imports in LLM inference.
- **Deep Link Security (SEC-003):** Implemented validation for application deep links to prevent injection.
- **Env Var Filtering (SEC-004):** Whitelisted safe environment variables for child processes in the debugger.
- **Path Sanitization (SEC-006):** Sanitized entry point paths in the debug handler to prevent traversal.
- **Update Integrity (SEC-008):** Added validation for update tokens and metadata.
- **XSS Mitigation:** Replaced unsafe HTML rendering with `react-syntax-highlighter` in code blocks.
- **Filesystem Hardening:** Enhanced path validation logic to resolve symlinks before checking bounds.

#### Linux Compatibility
- **Fixed Crash on Launch:** Disabled window transparency on Linux platforms to prevent segmentation faults common on Wayland and modern Ubuntu versions.
- **Early Path Resolution:** Fixed a critical crash caused by accessing `app.getPath('userData')` before the Electron app was ready.
- **Native Module Synchronization:** Rebuilt `node-pty` and `better-sqlite3` specifically for Electron 28 to resolve ABI-related segmentation faults.
- **Binary Naming:** Fixed an issue where the executable was incorrectly named `@kalyntdesktop`. It is now correctly named `kalynt`.
- **Permission Fixes:** Updated terminal session storage to use `userData` directory instead of `process.cwd()`, preventing crashes when launched from read-only environments.
- **Stability Flags:** Integrated `--disable-software-rasterizer` and `--no-sandbox` into development scripts for maximum reliability on modern distributions.
- **Icon Support:** Improved desktop integration by using PNG icons specifically for Linux builds.

#### Documentation
- Updated licensing information to clearly distinguish between AGPL-3.0 core modules and Proprietary Pro modules.
- Removed emojis from documentation for a cleaner, professional look.

### Architecture

#### Chat Store
- Introduced dedicated `chatStore` (Zustand + Persistence) to manage sessions independently of main application state.

#### Agent Loop Config
- Updated `AgentLoopConfig` types to support dynamic model overrides per session.

## [v1.0.3-beta] - 2026-02-03

### Team Collaboration Fixes

#### Workspace Sharing Bug Fixed
- **Issue**: When sharing a workspace link, the joiner would see "Shared Space" instead of the actual workspace name
- **Fix**: Workspace name is now included in the invite link URL fragment (`#n=WorkspaceName`) and parsed when joining

#### Chat Encryption Fixed
- **Issue**: Messages in the collaboration chat appeared encrypted/unreadable - decryption was failing
- **Root Cause**: Each peer was independently generating their own random encryption salt, resulting in different derived keys
- **Fix**: Encryption salt is now shared via the Yjs awareness protocol:
  - Room creator broadcasts their salt to all peers
  - Joiners receive and use the creator's salt before deriving their encryption key
  - All peers now use the same salt → same key → successful decryption

#### Connection Race Condition Fixed
- **Issue**: Users joining with a password could end up in different P2P rooms
- **Root Cause**: Password was stored in localStorage AFTER setting the current space, causing `useYDoc` to connect before the password was available
- **Fix**: Password is now stored BEFORE triggering the space change, ensuring both users join the same encrypted room (`kalynt-{spaceId}#{password}`)

### Security Hardening

#### Command Injection Prevention
- Added allowlists for safe commands in `dependencyManager.ts` and `debug.ts`
- Commands are validated against known-safe package managers and debugger binaries before execution
- Python module checks now validate against allowlist before spawning

#### XSS Protection Enhanced
- Improved `sanitizeContent()` to also encode `&` character (OWASP recommendation)
- All HTML special characters now properly escaped: `& < > " ' /`

#### Credential Storage Hardened
- Removed insecure base64 fallback when Electron's safeStorage is unavailable
- Now properly rejects credential storage when encryption is not available
- Prevents plaintext credential storage on systems without keychain access

#### Path Traversal Prevention
- Added symlink resolution using `fs.realpathSync()` before path validation
- Prevents symlink-based escapes from workspace directory
- Catches both `../` traversal and symlink attacks

#### Environment Variable Protection
- Created whitelist of safe environment variables for child processes
- Prevents leaking sensitive data (API keys, tokens) to user-executed code
- Safe vars include: PATH, HOME, NODE_ENV, language-specific paths

#### Content Security Policy
- Added CSP headers to Electron BrowserWindow
- Restricts script sources to 'self' and required API endpoints
- Prevents XSS attacks from loading external malicious scripts

### Bug Fixes

#### Offline LLM ESM Loading Fixed
- **Issue**: Offline AI engine failed to load with "require() of ES Module not supported" error
- **Root Cause**: Bundler was converting dynamic `import()` to `require()` for node-llama-cpp
- **Fix**: Added `dynamicImportESM()` helper using Function constructor to prevent bundler transformation

#### Memory Leak in Salt Listener Fixed
- **Issue**: Salt listener in useYjs was never removed on component unmount
- **Fix**: Added `saltListenerRef` to store listener and proper cleanup in useEffect return

#### FileTransferService Race Condition Fixed
- **Issue**: Rapid init/destroy cycles could register duplicate observers
- **Fix**: Added `initSequence` tracking to invalidate stale setTimeout callbacks

#### AgentService Promise Handling Fixed
- **Issue**: Timeout promise didn't properly handle abort and leaked event listeners
- **Fix**: Proper abort rejection and cleanup of event listeners using `.finally()`

#### Base64 Binary Data Fixed
- **Issue**: `storageService.ts` used `fromCodePoint`/`codePointAt` instead of `fromCharCode`/`charCodeAt`
- **Fix**: Corrected to use byte-appropriate methods for Uint8Array serialization

### Files Modified
- `apps/desktop/src/services/p2pService.ts` - Added `spaceName` parameter to link generation/parsing
- `apps/desktop/src/components/CollaborationPanel.tsx` - Fixed join flow race condition, use parsed workspace name
- `apps/desktop/src/hooks/useYjs.ts` - Salt sharing, memory leak fix for salt listener
- `apps/desktop/electron/terminal/dependencyManager.ts` - Command injection prevention
- `apps/desktop/electron/handlers/debug.ts` - Binary/module allowlists for security
- `apps/desktop/electron/handlers/safeStorage.ts` - Removed insecure fallback
- `apps/desktop/electron/handlers/file-system.ts` - Symlink resolution for path validation
- `apps/desktop/electron/handlers/code-execution.ts` - Environment variable whitelist
- `apps/desktop/electron/handlers/llm-inference.ts` - ESM dynamic import fix
- `apps/desktop/electron/main.ts` - Added CSP headers
- `apps/desktop/src/components/UnifiedAgentPanel.tsx` - Enhanced XSS sanitization
- `apps/desktop/src/services/fileTransferService.ts` - Race condition fix
- `apps/desktop/src/services/agentService.ts` - Promise handling fix
- `apps/desktop/src/services/storageService.ts` - Binary encoding fix

