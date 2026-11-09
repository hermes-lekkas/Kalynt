# IDE reliability verification — 2026-11-10

This pass changes source on `codex/ide-reliability`. It does not replace the published 2.0.0 installers.

## Continued editor and developer-workflow pass

The follow-up adds per-workspace unsaved-buffer recovery, explicit external-disk conflict choices, atomic text saving, preservation of BOM/CRLF/executable permissions/symlinks, late-response isolation between workspaces, and retryable conversation persistence. Recovery snapshots are acknowledged synchronously during normal closing; a storage failure prevents that close. Forced process termination or machine failure can still lose changes after the last completed recovery write.

Search and replace now use dirty editor buffers and leave open files unsaved. Closed-file replacements compare the disk baseline before writing. Include patterns support nested globs and brace alternatives; regex single-match replacement preserves lookaround and capture context. Paths correctly distinguish POSIX case, sibling folder prefixes and Windows drive/UNC roots.

The test runner discovers all `.test.mjs` files under `electron/` and `src/`. React hook tests use the real hook/store logic with controlled filesystem responses and delayed saves/reads. The dev-server-only `tests/editor.html` fixture composes production Monaco/editor components over disposable virtual files. Direct UI checks verified typing/dirty state, workspace-switch recovery, reload recovery, Save, Ctrl+S, undo-to-clean, and the format-document action without console errors. This fixture is not a complete desktop end-to-end test and is not a production build entry point.

The real Python debugger was tested with `debugpy` 1.8.19: it launched a program, stopped on the configured breakpoint, returned stack frames, evaluated the expected variable value, continued and stopped cleanly. Set `KALYNT_SMOKE_PYTHON=python3` to include that check; the interpreter must have debugpy installed. Verification CI now includes this debugger check on Linux and unit/type/lint jobs on Windows and macOS.

## Reproduced and repaired

- JavaScript workspace search rewrote the regular-expression syntax produced for `**/`, so nested patterns such as `src/**/*.ts` returned no results. Translate the glob in one pass.
- Setting the same workspace again destroyed its active filesystem watchers. Keep those watchers; validate new folders, serialize transitions, dispose obsolete watchers, and clear the active folder when closing it. The renderer now recovers from missing saved folders.
- A model download redirected to an unsupported protocol could throw from a response callback. Reject invalid redirect URLs as normal download failures.
- HTTP 416 previously completed any nonempty partial model, even if it was incomplete. Verify the total length, and validate HTTP 206 ranges before appending.
- Agent undo marked a checkpoint complete after a partial failure. Retain only failed paths for retry so already restored files, including subsequent user edits, are not overwritten. Continue restoring other files if one IPC call throws and tell the model when undo was partial.
- The browser preview's generic agent-session response was an object rather than an array, crashing the agent panel. Supply the correct response shapes, validate session lists and loads, and report rejected conversation saves.
- The GGUF engine imposed a minimum 512-token context even for models with a smaller training context. Respect the model's maximum and use a matching minimum in memory estimates and context allocation.
- Repository tests referenced an absent Jest runner in the shared type package. Use an actual type check there. Added an ESLint configuration with React hook rules.

## Verification

- `npm test`: 66 desktop test cases (65 pass and one Windows-only check is skipped on Linux), plus the shared package's strict TypeScript check.
- `npm run lint`: TypeScript/TSX lint and React hook rules.
- `npx tsc --noEmit -p apps/desktop/tsconfig.node.json`: Electron type check.
- `npm run build:vite --workspace=apps/desktop`: renderer type check and production renderer, main-process and preload bundles.
- `KALYNT_SMOKE_MODEL=/absolute/path/to/model.gguf KALYNT_SMOKE_PYTHON=python3 xvfb-run -a npm run test:smoke --workspace=apps/desktop -- --no-sandbox --disable-gpu`: 18 real Electron integration checks using disposable data.

The Electron suite covers preload isolation, file create/read/write/stat/rename/delete, overwrite protection, nested search, file-change delivery, Git init/stage/commit/diff/branches, PTY output/resize/kill, real command execution, npm task discovery/execution, agent file discovery/commands, debugger configuration discovery, extension-host APIs, session disk persistence, local-server configuration/chat/disconnect, workspace recovery, and optional native inference.

Native inference was checked with `ggml-org/models`' `tinyllamas/stories15M-q4_0.gguf` from Hugging Face (19,077,344 bytes; 128-token training context). Loading, generation, streaming and unloading all ran on CPU through the real node-llama-cpp runtime. This validates runtime mechanics, not code-generation quality or large-model performance.

`npx electron-builder --linux --dir --publish never` also builds a Linux package under `apps/desktop/release/linux-unpacked`. Set `KALYNT_SMOKE_RESOURCES` to that package's `resources` directory to compare its ASAR bundles with the production build and exercise the packaged node-llama-cpp dependencies. This uses the isolated Electron harness and does not establish the installed application's entire GUI behavior.

Automated local-server tests use a loopback HTTP fixture and synthetic responses. The document-exchange tests use two isolated encryption modules, actual Web Crypto, and Yjs updates with a shared room password/salt; wrong passwords and modified ciphertext are rejected.

Browser UI checks covered workspace creation, task creation and persistence after reload, model-settings navigation, a clear desktop-only connection error, and recovery of the agent panel. Native desktop functionality was exercised separately through real Electron IPC.

## Remaining validation boundaries

- This machine ran Linux. Windows/macOS interactive behavior and the native macOS helper were not verified here.
- Cross-machine WebRTC connectivity, NAT traversal, file transfer and concurrent remote editing need a multi-machine test. Local encrypted document exchange does not establish those properties.
- Live paid provider APIs were not contacted. Local streaming fixtures do not establish current provider account/model compatibility.
- Python debugging is verified through a real debugpy session. Other debug adapters and arbitrary marketplace-extension compatibility remain unverified.
- The Electron harness loads production bundles from the checkout and can verify matching packaged bundles/dependencies. Full installed-application GUI behavior and platform installer flows need separate release validation.

`Verify IDE` now defines pull-request checks for lint, tests, types, production builds, native-module rebuilding and the Electron smoke suite. Defining the workflow does not mean remote CI has already run.
