# BoxLite for Visual Studio Code (`rc-boxlite-vscode`)

Deploy and manage applications on **BoxLite Cloud** directly from VS Code.

Modeled after the Azure Functions extension workflow, **BoxLite for VS Code** provides a unified developer experience for creating, deploying, tunneling, configuring network isolation, streaming logs, and inspecting your microVM Box instances.

---

## Key Features

- ** 1-Click Deploy ("Deploy to Box"):** Seamless deployment pipeline following canonical BoxLite practices:
  - Automates supervisor loops (`PID 1` foreground lifecycle) to prevent premature container exits.
  - Copies code into guest rootfs without extra nesting (`copy_in`).
  - Verifies local guest health probes (`/healthz` on `0.0.0.0:8080`).
  - Establishes public or private tunnels and verifies external proxy propagation.
  - Automatically preserves and updates `boxId` in `boxlite.json` for rapid updates.
- ** BoxLite Explorer Tree View:**
  - View account status and active REST API target.
  - Real-time status for all Boxes (Running, Stopped, Provisioning).
  - Inspect tunnels, active public/private URLs, and network rules.
  - Direct context menu actions: Start, Stop, Restart, Stream Logs, Exec CLI, Inspect JSON, and Delete.
- ** Granular Network & Security Policies:**
  - Inbound toggle: Enable or disable Cloud proxy access.
  - Outbound allowlist editor: Strict validation for hostnames (`api.example.com`), wildcards (`*.example.com`), IPv4 (`1.2.3.4`), and CIDR (`10.0.0.0/8`).
  - Private access token support (`X-BoxLite-Access-Token`).
- ** Live Application Log Streaming:**
  - Real-time output channel tailing `/tmp/server.log`.
- ** Project Scaffolding:**
  - Generates ready-to-run Python HTTP services binding `0.0.0.0:8080` with a healthy `/healthz` route, `boxlite.json`, `.boxliteignore`, and `.gitignore`.

---

## Quick Start

### 1. Authenticate
Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) and run:
```
BoxLite: Sign In / Set API Key
```
Enter your BoxLite Cloud API key (`BOXLITE_API_KEY`). It is stored securely in VS Code's `SecretStorage` and never committed or written to project files.

### 2. Create a New Project
Run:
```
BoxLite: Create New BoxLite Project...
```
This scaffolds:
- `app/server.py` — Standard library HTTP server with `/healthz` listening on `0.0.0.0:8080`
- `app/index.html` — Web page
- `boxlite.json` — Project configuration
- `.boxliteignore` — Excludes local artifacts (`.git`, `.venv`, `node_modules`, etc.)

### 3. Deploy
Click the **BoxLite** status bar button or run:
```
BoxLite: Deploy to Box
```
The extension executes the deployment pipeline and displays your public service URL.

---

## Configuration (`boxlite.json`)

```json
{
  "name": "my-app",
  "boxId": null,
  "image": "python",
  "appDir": "./app",
  "port": 8080,
  "healthPath": "/healthz",
  "start": "python3 -u server.py",
  "access": "public",
  "network": {
    "inbound": "enabled",
    "outbound": {
      "mode": "enabled",
      "allow_net": [
        "api.example.com",
        "*.github.com"
      ]
    }
  },
  "persistent": true,
  "autoStop": 0
}
```

---

## Architecture: Python Sidecar Bridge

The extension utilizes a managed Python sidecar (`src/bridge/python/bridge.py`) running in a pinned environment (`boxlite==0.11.0`):
- Communicates via line-delimited JSON-RPC over stdio.
- Never translates async SDK idioms mechanically into unverified runtimes.
- Passes `BOXLITE_API_KEY` and `BOXLITE_REST_URL` through child process environment variables.
- Translates network errors and cloud lifecycle transitions into actionable diagnostics.

---

## Extension Commands

| Command | Title | Description |
|---|---|---|
| `boxlite.deploy` | Deploy to Box | Deploy current workspace to a Box instance |
| `boxlite.newProject` | Create New BoxLite Project... | Generate starter template |
| `boxlite.setApiKey` | Sign In / Set API Key | Configure BOXLITE_API_KEY |
| `boxlite.signOut` | Sign Out | Remove stored API key |
| `boxlite.refresh` | Refresh | Refresh boxes explorer tree |
| `boxlite.startBox` | Start Box | Start a stopped Box |
| `boxlite.stopBox` | Stop Box | Stop a running Box |
| `boxlite.restartApp` | Restart Application | Restart process inside Box |
| `boxlite.deleteBox` | Delete Box | Safely remove Box with confirmation |
| `boxlite.openUrl` | Open Public URL | Open tunnel URL in browser |
| `boxlite.copyUrl` | Copy Public URL | Copy tunnel URL to clipboard |
| `boxlite.streamLogs` | Stream Logs | Stream `/tmp/server.log` in Output Channel |
| `boxlite.setAccess` | Configure Inbound / Public Access | Configure tunnel & public/private status |
| `boxlite.configureOutbound` | Configure Outbound Network Policy | Set outbound mode & hostname allowlists |
| `boxlite.execCommand` | Execute Command in Box... | Run ad-hoc shell commands in Box |
| `boxlite.inspectBox` | Inspect Box (JSON) | View complete Box state JSON |
| `boxlite.openDocs` | Open Documentation | Open BoxLite agent documentation |
