---
name: vscode-extension-startup-crash
description: >-
  Diagnoses and prevents VS Code Extension Host crashes (exit code 134 / SIGABRT) that occur when a contributed Activity Bar view container or TreeView is already focused while VS Code or the F5 Extension Development Host is loading. Use when investigating VS Code extension startup/focus crashes, missing extension-host log directories, SecretStorage or bridge storms during onView activation, or when hardening VS Code extensions against startup race conditions.
---

# VS Code Extension Startup & Focus Crash Runbook

## Why Focused Views Crash During Extension Host Startup

When VS Code launches (or opens via `F5` Extension Development Host) with a custom sidebar view container already open (`workbench.view.extension.<container>.state.hidden = false`), the renderer immediately fires `onView:<viewId>` activation events and initial `TreeDataProvider.getChildren()` (`$getChildren`) requests within the first ~200–1400ms—before eager extensions, `@vscode/spdlog` async rotating loggers, `SecretStorage` IPC, and `js-debug` child-process inspection settle.

Doing synchronous logger creation, uncached `SecretStorage` bursts, multi-view RPC storms, or subprocess spawning on that first tick can abort the Extension Host `UtilityProcess` with **exit code 134 (`SIGABRT`)**, often before `%APPDATA%\Code\logs\<session>\windowX\exthost\` is even flushed to disk.

---

## Diagnostic Checklist

1. **Check VS Code Main Log for Extension Host `UtilityProcess` Abort (`code 134`)**
   - Inspect `%APPDATA%\Code\logs\<latest-timestamp>\main.log`.
   - Look for:
     ```text
     [info] Started local extension host with pid <PID>.
     [info] Loading development extension at <repoPath>
     [info] Extension host with pid <PID> exited with code: 134, signal: unknown.
     [error] [UtilityProcess id: <N>, type: extensionHost, pid: <PID>]: crashed with code 134 and reason 'crashed'
     ```
2. **Confirm View Container Focus Timing**
   - If the crashing `windowX\` folder is missing `exthost\exthost.log`, the crash occurred inside the early startup window while `@vscode/spdlog` was still buffering initial log lines in memory.
   - Compare against a non-crashing session in `exthost.log` and `userDataSync.log`: check whether `onView:<viewId>` fires **before** `Eager extensions activated` and whether `workbench.view.extension.<containerId>.state.hidden` was active in the prior window state.
3. **Check for Secondary Startup / Shutdown Exceptions**
   - Scan healthy `exthost.log` runs for `Error: Channel has been closed` (uncaught `OutputChannel.appendLine` writes during subprocess stderr/exit or extension disposal) and broken asset paths in `package.json`.

---

## Mandatory Prevention & Remediation Patterns

### 1. Startup Readiness Gate on All TreeDataProviders + Buffered Lazy OutputChannel
- Add `setStartupReady(ready: boolean)` (default `true` so direct unit tests pass untouched) and return `[]` immediately at the top of `getChildren()` while `!this.startupReady`.
- In `activate(context)`, instantiate providers and call `setStartupReady(false)` on all of them **before** calling `vscode.window.createTreeView(...)`.
- Never invoke `vscode.window.createOutputChannel(name)` synchronously during `activate()` just to log boot messages; use a buffered lazy wrapper (`createSafeLazyOutputChannel`) that buffers `append`/`appendLine` calls in memory until `flush()` (triggered on the startup settle timer) or `.show()` is called.
- Defer credential warm-up, `outputChannel.flush()`, `setStartupReady(true)`, and provider `.refresh()` behind a startup timer (`process.uptime() < 15 ? 1000 : 150` ms), and clear that timer in both `context.subscriptions` and `deactivate()`.

### 2. Single-Flight Promise Deduplication & Caching for `SecretStorage`
- Never let multiple TreeViews and `activate()` issue redundant concurrent `context.secrets.get(...)` / `store(...)` IPC calls.
- Cache parsed payloads in memory, coalesce concurrent `load()` callers onto a single shared in-flight `loadPromise`, clone objects returned from the cache so callers cannot mutate cached state, update the cache synchronously on writes (`save()`), and wrap all `SecretStorage` IPC calls in `try/catch`.

### 3. Coalesce Read-Only Sidecar / Backend RPCs
- When multiple sidebar views (`Boxes`, `Images`, `Volumes`, `Checkpoints`, `Secrets`) refresh together, coalesce concurrent identical read-only RPCs (`coalesceRead(key, fn)`) via an in-flight `Map<string, Promise<unknown>>` in the bridge/API client so only one backend request executes at a time.

### 4. Sanitize Subprocess Environments & Launch Config
- Strip VS Code / Electron / Node inspector environment variables before every `child_process.spawn` call (`createCleanSubprocessEnv()`):
  - `ELECTRON_RUN_AS_NODE`
  - `VSCODE_INSPECTOR_OPTIONS`
  - `NODE_OPTIONS`
  - `VSCODE_ESM_ENTRYPOINT`
  - `VSCODE_HANDLES_UNCAUGHT_ERRORS`
- Pass `windowsHide: true` in `spawn(...)` options.
- Parse launcher commands containing flags (e.g. `py -3`) cleanly without running unnecessary synchronous `fs.existsSync()` checks on strings with spaces/flags first.
- In `.vscode/launch.json`, set `"autoAttachChildProcesses": false` on `"type": "extensionHost"` launch configurations instead of passing `"--disable-extensions"` (which breaks the user's installed extensions).

### 5. Safe `OutputChannel` Disposal & Manifest Asset Verification
- Guard every `outputChannel.append`, `appendLine`, `show`, and `dispose` call in bridge clients, Python env setup helpers, and log-streaming intervals with `isDisposed` flags and `try/catch` so `Error: Channel has been closed` can never crash child-process event callbacks.
- Add a unit test verifying that `package.json` `icon` and every `contributes.viewsContainers.activitybar[].icon` file actually exist on disk.

---

## Verification Steps

1. Run TypeScript compilation, bundle build, and unit tests:
   ```bash
   npm run compile && npm run build && npm test
   ```
2. Verify in a real VS Code Extension Development Host (`F5`):
   - Open the contributed Activity Bar container, close the Extension Development Host window while the view container remains focused, then press `F5` again to relaunch with the container focused at startup.
   - Confirm no `crashed with code 134` entry appears in `%APPDATA%\Code\logs\<session>\main.log` and `%APPDATA%\Code\logs\<session>\window*\exthost\exthost.log` initializes cleanly.
