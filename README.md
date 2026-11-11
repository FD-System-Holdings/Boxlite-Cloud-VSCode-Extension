# BoxLite Cloud for Visual Studio Code

Deploy and manage applications on **BoxLite Cloud** directly from VS Code.

This extension provides a unified developer experience for creating, deploying, tunneling, configuring network isolation, streaming logs, and inspecting your microVM Box instances within a Boxlite Cloud instance.

---

## Key Features

- **1-Click Deploy ("Deploy to Box"):** Deployment Pipleline:
  - Automates supervisor loops (`PID 1` foreground lifecycle) to prevent premature container exits.
  - Verifies local guest health (`/healthz` on `0.0.0.0:8080`).
  - Establishes private tunnels.
  - Automatically preserves and updates `boxId` in `boxlite.json` for rapid updates.
- **Advanced Box Creation Configuration Wizard:** Comprehensive list of options for customizing every aspect of a new Box:
  - **Base Images:** Quick selection of official Cloud image aliases (`python`, `node`, `ubuntu`, `debian`, `alpine`) or custom OCI container tags.
  - **Compute & Memory Sizing:** Choose preset tiers (Small: 1 vCPU / 2GB RAM / 10GB Disk, Medium: 2 vCPU / 4GB RAM / 20GB Disk, Large: 4 vCPU / 8GB RAM / 40GB Disk) or custom vCPU/RAM/Disk quotas.
  - **Network Policies:** Inbound proxy access toggle and outbound egress policies (Unrestricted `allow_net=[]`, Restricted Allowlist with strict host/CIDR validation, or Air-Gapped / Disabled without NIC).
  - **Lifecycle Management:** Idle auto-stop intervals (0s disabled, 5m, 15m, 30m, 1h, custom) and auto-delete lifecycle duration (0s persistent, 1d, 7d, custom).
  - **Auto-Resume:** Automatic request wake-up upon incoming HTTP proxy requests.
  - **Entrypoint & Supervisor:** `/app/server.py` supervisor, persistent keepalive shell loop, image default, or custom commands.
  - **Environment Variables:** Interactive key-value editor (`KEY=VALUE`).
  - **Verified Templates:** One-click presets for Python Web Apps, Node.js APIs, Egress-Restricted Boxes, and Air-Gapped Sandboxes.
  - **Project Persistence:** Save created configurations directly to `boxlite.json`.

- **BoxLite Explorer Tree View:**
  - View account status and active REST API target.
  - Real-time status for all Boxes (Running, Stopped, Provisioning).
  - Inspect tunnels, active public/private URLs, persistent volumes, and network rules.
  - Direct context menu actions: Start, Stop, Restart, Stream Logs, Exec CLI, Inspect JSON, and Delete.
- **Images Menu & Explorer (`boxlite.imagesView`):**
  - Dedicated Images menu positioned directly between **Boxes** and **Volumes** in the BoxLite Activity Bar sidebar.
  - Browse official BoxLite built-in images (`base`, `python`, `node`, `sandbaseai-hermes`), marked free and exempt from organization image quotas.
  - Track organization catalog image usage against the 20-image limit (e.g. `2 of 20 images · 3.5 MiB`).
  - Add and boot custom public container images from Docker Hub, GitHub Container Registry (`ghcr.io`), Quay, or Google Container Registry.
  - Connect private container registries (`Connect Private Registry...`) with scoped credentials and repository prefixes.
  - Pin, promote, and roll back version aliases (e.g. `stable`, `prod`) linked directly to exact sha256 build digests.
  - One-click "Create Box from Image...", "Set as Default Image", and safe catalog deletion.
- **Managed Volumes Menu & Explorer (`boxlite.volumesView`):**
  - Dedicated Volumes menu in the Activity Bar panel to view and manage storage within BoxLite Cloud.
  - Create new persistent volumes (`Add New Volume...`) with optional names or auto-generated identifiers.
  - Inspect volume state (`ready`, `creating`, `deleting`), volume IDs, and creation timestamps.
  - Mount volumes into existing boxes or workspace project configuration (`boxlite.json`).
  - Safe volume deletion with permanent data loss confirmation and force-deletion options.
  - Copy Volume ID and Name to clipboard for scripting and CLI compatibility.
- **Granular Network & Security Policies:**
  - Inbound toggle: Enable or disable Cloud proxy access.
  - Outbound allowlist editor: Strict validation for hostnames (`api.example.com`), wildcards (`*.example.com`), IPv4 (`1.2.3.4`), and CIDR (`10.0.0.0/8`).
  - Private access token support (`X-BoxLite-Access-Token`).
- **Live Application Log Streaming:**
  - Real-time output channel tailing `/tmp/server.log`.
- **Project Scaffolding:**
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

## Box Configuration Options Wizard

When creating a Box via `BoxLite: Create Box with Options...` (or by choosing **Configure Box Options...** from `BoxLite: Add New Box...`), an interactive QuickPick wizard displays the complete list of configurable options:

| Option | Values / Presets | Description |
|---|---|---|
| **Box Name** | Custom string (e.g. `box-a1b2c3`) | Unique instance identifier |
| **Base Image** | `python`, `node`, `ubuntu`, `debian`, `alpine`, or custom tag | OCI / Cloud image alias |
| **Compute Sizing** | Small (1 vCPU, 2GB RAM, 10GB Disk)<br>Medium (2 vCPU, 4GB RAM, 20GB Disk)<br>Large (4 vCPU, 8GB RAM, 40GB Disk)<br>Custom | Resource quota allocation |
| **Inbound Access** | `enabled` / `disabled` | Allows Cloud proxy tunnels & public/private URLs (§2) |
| **Outbound Policy** | `enabled` (Unrestricted `allow_net=[]`)<br>`enabled` (Restricted allowlist: hostnames / CIDR)<br>`disabled` (Air-gapped: no guest NIC provisioned) | Egress internet policy (§3) |
| **Auto-Stop Interval** | `0` (Disabled)<br>`300s` (5m), `900s` (15m), `1800s` (30m), `3600s` (1h), Custom | MicroVM idle shutdown timer (§1) |
| **Auto-Delete Interval** | `0` (Disabled / Persistent)<br>`86400s` (1d), `604800s` (7d), Custom | MicroVM lifecycle auto-removal timer (§4) |
| **Auto-Resume** | `enabled` / `disabled` | Automatic microVM boot/wake upon HTTP proxy request |
| **Entrypoint** | App Supervisor (`server.py` watcher §1)<br>Persistent Keepalive (`sleep 3600`)<br>Image Default<br>Custom Command | Container init command |
| **Environment Vars** | Interactive `KEY=VALUE` list | Environment variables passed to container |
| **Default Port** | Port number (default `8080`) | Target TCP port for declaring tunnels |
| **Save to Project** | Save to `boxlite.json` | Persists configuration into workspace project file |

### Configuration Templates
- **Python Web Application:** Python image, 2 vCPU, 4GB RAM, inbound enabled, unrestricted outbound, supervisor entrypoint, port 8080.
- **Node.js Web Application:** Node.js image, 2 vCPU, 4GB RAM, inbound enabled, unrestricted outbound, supervisor entrypoint (`npm start`), port 3000.
- **Secure Egress-Restricted Box:** Python image, inbound enabled, restricted outbound allowlist, 15m idle auto-stop.
- **Air-Gapped Isolated Sandbox:** Python image, 1 vCPU, 2GB RAM, inbound disabled, outbound disabled (no NIC provisioned), 5m idle auto-stop.
- **Ubuntu Linux Utility:** Ubuntu image, 2 vCPU, 4GB RAM, keepalive entrypoint, 30m idle auto-stop.

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
  "volumes": [
    {
      "managed_volume": "my-data",
      "guest_path": "/data"
    }
  ],
  "persistent": true,
  "autoStop": 0
}
```

---

## Persistent Volumes & Lifecycle Guidelines

- **Managed Volumes:** Volumes created in BoxLite Cloud are attached as block devices and formatted for persistent storage across Box stop/start lifecycles.
- **Rootfs Boundary:** Transfers via `copy_in` operate exclusively on the guest rootfs layer. Paths at or under guest mount points (including `/data`, `/tmp`, `/dev/shm`, and mounted volumes) can be refused because they hide rootfs content. For data inside mounted volumes, use an exec-based archive/stream workflow or configure your application to write directly to the volume mount point.
- **Stateful Services:** SQLite and other stateful databases can safely reside on persistent volumes (e.g. `/data/app.db`). Verify path readiness, commit data across stop/start cycles, and retain independent backups. Box deletion destroys unbacked resources; managed volumes outlive individual microVM boxes until explicitly removed.

---

## Images & Container Registry Guide

- **Built-in Images:** BoxLite Cloud provides four maintained base images:
  - `base`: A minimal, general-purpose Linux environment.
  - `python`: Python 3 runtime, ready for immediate execution.
  - `node`: Node.js runtime, ready for JavaScript/TypeScript services.
  - `sandbaseai-hermes`: Official Hermes agent image preinstalled.
  *Note:* Built-in images are free and do not count against your organization's 20-image catalog limit.
- **Using Custom Images:** Any OCI container image from a public registry can be booted with no approval or manual upload required (e.g. `docker.io/library/alpine:3.20` or `ghcr.io/acme/api:1.4.0`).
- **Namespace Shadowing Notice:** The short aliases `base`, `python`, and `node` refer to BoxLite's built-in images, not Docker Hub's. To boot an official image from Docker Hub, specify its full reference (e.g. `docker.io/library/python:3.12-slim`).
- **Catalog Lifecycle & Boot Recording Delay:** The first time a box boots an image, it is recorded in your organization catalog. Recording occurs when the microVM finishes booting (~12 seconds after launch), not when creation returns.
- **Organization Quota:** Catalogs support up to 20 recorded custom images. Images unused by active boxes can be safely deleted via the context menu.
- **Build Pinning & Rollbacks (Aliases):** Attach named aliases (e.g. `stable`, `prod`) to exact sha256 digests. Moving an alias promotes or rolls back production deployments instantly without touching external registries.
- **Private Registries:** Register credentials for private image repositories on `ghcr.io`, `docker.io`, `quay.io`, and `gcr.io`. Password/token credentials are write-only and require a Full-access Cloud API key.

---

## Extension Commands

| Command | Title | Description |
|---|---|---|
| `boxlite.deploy` | Deploy to Box | Deploy current workspace to a Box instance |
| `boxlite.newProject` | Create New BoxLite Project... | Generate starter template |
| `boxlite.setApiKey` | Sign In / Set API Key | Configure BOXLITE_API_KEY |
| `boxlite.signOut` | Log Out | Remove stored API key |
| `boxlite.createBox` | Add New Box... | Create a new Box instance (Wizard, Template, or Quick) |
| `boxlite.createBoxWithOptions` | Create Box with Options... | Interactive wizard with full list of configuration options |
| `boxlite.refresh` | Refresh | Refresh boxes and volumes explorer |
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
| `boxlite.refreshImages` | Refresh Images | Refresh the Images catalog and explorer view |
| `boxlite.addImage` | Use Your Own Image... | Add custom image reference or boot microVM from registry |
| `boxlite.createBoxFromImage` | Create Box from Image... | Launch a new Box preconfigured with selected image |
| `boxlite.setDefaultImage` | Set as Default Image | Set image as workspace default for future box creation |
| `boxlite.copyImageName` | Copy Image Reference | Copy image reference or alias to clipboard |
| `boxlite.inspectImage` | Inspect Image (JSON) | View catalog build versions, digests, and history |
| `boxlite.pinImageAlias` | Pin Image Alias... | Attach version alias to exact build digest |
| `boxlite.removeImage` | Delete Image | Safely remove image from organization catalog |
| `boxlite.addRegistryLogin` | Connect Private Registry... | Configure authentication for private image registries |
| `boxlite.createVolume` | Add New Volume... | Create a new persistent volume in BoxLite Cloud |
| `boxlite.refreshVolumes` | Refresh Volumes | Refresh the Volumes explorer view |
| `boxlite.deleteVolume` | Delete Volume | Remove a persistent volume with confirmation (§4) |
| `boxlite.inspectVolume` | Inspect Volume (JSON) | View volume state and metadata JSON |
| `boxlite.copyVolumeId` | Copy Volume ID | Copy volume ID to clipboard |
| `boxlite.copyVolumeName` | Copy Volume Name | Copy volume name to clipboard |
| `boxlite.addVolumeToBox` | Mount Volume in Box... | Mount a volume into container or boxlite.json |
| `boxlite.openDocs` | Open Documentation | Open BoxLite agent documentation |
