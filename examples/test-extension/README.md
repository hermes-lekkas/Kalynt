# Kalynt Test Extension

A minimal VS Code-compatible extension fixture verifying Kalynt's extension host, Command Palette integration, and lifecycle management.

## Contributed Commands

- `Kalynt Test: Hello World` (`kalynt-test.helloWorld`) — activates the extension and displays a `"Hello from Kalynt!"` notification.
- `Kalynt Test: Show Current Date` (`kalynt-test.showDate`) — displays the current local date and time.

## Build & Install

1. Install dependencies and compile TypeScript:
   ```bash
   npm install
   npm run compile
   ```
2. Package as a `.vsix` archive:
   ```bash
   npx vsce package
   ```
3. Install in Kalynt:
   - Open **Extensions and runtimes** (`Ctrl+Shift+X`) → **VS Code extensions**
   - Select **Install from file** and pick the generated `.vsix` file

## Usage & Verification

1. Open the Command Palette (`Ctrl+Shift+P`), switch to **Commands**, and run:
   - `Kalynt Test: Hello World` → displays `"Hello from Kalynt!"`
   - `Kalynt Test: Show Current Date` → displays the current timestamp
2. Disabling or uninstalling the extension removes its contributed commands from the Command Palette immediately; re-enabling restores them on demand.

## Demonstrated API Surface

- Declarative `contributes.commands` registration and lazy activation
- Command execution forwarding (`extensions:execute-command`)
- User notifications (`vscode.window.showInformationMessage`)
- Configuration reading, output channels, and activate/deactivate lifecycle hooks
