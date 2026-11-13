import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as https from 'https';
import * as http from 'http';
import { BoxLiteBridgeClient } from '../bridge/client';
import { SecretSpec } from '../bridge/protocol';
import { CredentialsManager } from '../auth/credentials';
import { SecretsManager } from '../auth/secretsStore';
import { ProjectManager, buildSupervisorEntrypoint } from './project';
import { LogStreamManager } from '../logs/logStream';
import { diagnoseError } from '../util/diagnosis';
import { formatSecretPlaceholder, validateEnvAgainstSecrets } from '../util/validation';

export class BoxLiteDeployer {
  constructor(
    private bridge: BoxLiteBridgeClient,
    private credentials: CredentialsManager,
    private logManager: LogStreamManager,
    private outputChannel: vscode.OutputChannel,
    private onDeploySuccess?: () => void,
    private secretsManager?: SecretsManager
  ) {}

  public async deployWorkspace(targetBoxId?: string): Promise<void> {
    const projectInfo = await ProjectManager.findProjectConfig();
    if (!projectInfo) {
      const choice = await vscode.window.showInformationMessage(
        'No boxlite.json found in workspace. Would you like to create a new BoxLite project?',
        'Create Project'
      );
      if (choice === 'Create Project') {
        await vscode.commands.executeCommand('boxlite.newProject');
      }
      return;
    }

    const { config, fileUri } = projectInfo;
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
    const appDir = path.resolve(workspaceRoot, config.appDir || './app');

    if (!fs.existsSync(appDir)) {
      vscode.window.showErrorMessage(`Application directory "${config.appDir}" does not exist in workspace.`);
      return;
    }

    // Step 1: Ensure API Key
    let apiKey = await this.credentials.getApiKey();
    if (!apiKey) {
      apiKey = await this.credentials.promptForApiKey();
      if (!apiKey) {
        vscode.window.showWarningMessage('Deployment aborted: BoxLite API Key is required.');
        return;
      }
    }

    this.outputChannel.show(true);
    this.outputChannel.appendLine(`\n=== BoxLite Deployment: ${config.name} ===`);
    this.outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] Starting deployment pipeline...`);

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Deploying ${config.name} to BoxLite Cloud...`,
        cancellable: false
      },
      async (progress) => {
        try {
          // Step 2: Resolve Box (reuse or create)
          let boxId = targetBoxId || config.boxId;
          let boxName = config.name;

          progress.report({ message: 'Resolving Box instance...' });
          if (boxId) {
            this.outputChannel.appendLine(`[deploy] Reusing configured boxId: ${boxId}`);
            try {
              await this.bridge.inspectBox(boxId);
              // Ensure box is started
              await this.bridge.startBox(boxId);
            } catch (e: any) {
              this.outputChannel.appendLine(`[deploy] Box ${boxId} not found or inactive. Creating a new Box...`);
              boxId = null;
            }
          }

          if (!boxId) {
            const randomSuffix = Math.random().toString(16).substring(2, 8);
            boxName = `${config.name}-${randomSuffix}`;
            this.outputChannel.appendLine(`[deploy] Provisioning new Box: ${boxName}...`);

            // Supervisor entrypoint ensures PID 1 stays alive and restarts app when server.py exists
            const supervisor = buildSupervisorEntrypoint(config.start || 'python3 -u server.py');

            if (config.volumes && config.volumes.length > 0) {
              for (const v of config.volumes) {
                this.outputChannel.appendLine(`[deploy] Mounting volume '${v.managed_volume}' at '${v.guest_path}'`);
              }
            }

            // Resolve Secrets proxy injection rules from workstation SecretStorage
            let resolvedSecrets: SecretSpec[] | undefined;
            const envMap: Record<string, string> = {};
            if (config.env) {
              if (Array.isArray(config.env)) {
                for (const entry of config.env) {
                  const idx = String(entry).indexOf('=');
                  if (idx > 0) {
                    envMap[String(entry).substring(0, idx)] = String(entry).substring(idx + 1);
                  }
                }
              } else {
                Object.assign(envMap, config.env);
              }
            }

            if (config.secrets && config.secrets.length > 0) {
              const resolvedList: SecretSpec[] = [];
              for (const s of config.secrets) {
                let secretVal: string | undefined;
                if (this.secretsManager) {
                  const stored = await this.secretsManager.getSecret(s.name);
                  secretVal = stored?.value;
                }
                if (!secretVal) {
                  const prompted = await vscode.window.showInputBox({
                    title: `BoxLite Secret Credential: ${s.name}`,
                    prompt: `Enter credential value for secret "${s.name}" (hosts: ${(s.hosts || []).join(', ')})`,
                    password: true,
                    ignoreFocusOut: true,
                    validateInput: (val) => (!val || !val.trim() ? 'Secret value cannot be empty.' : null)
                  });
                  if (!prompted) {
                    throw new Error(`Deployment aborted: credential value for secret "${s.name}" is required.`);
                  }
                  secretVal = prompted.trim();
                  if (this.secretsManager) {
                    await this.secretsManager.saveSecret({
                      name: s.name,
                      value: secretVal,
                      hosts: s.hosts || [],
                      headers: s.headers || { Authorization: 'Bearer {value}' },
                      envVar: s.envVar
                    });
                  }
                }
                resolvedList.push({
                  name: s.name,
                  value: secretVal,
                  hosts: s.hosts || [],
                  headers: s.headers || { Authorization: 'Bearer {value}' }
                });
                if (s.envVar && !envMap[s.envVar]) {
                  envMap[s.envVar] = formatSecretPlaceholder(s.name);
                }
                this.outputChannel.appendLine(
                  `[deploy] Configuring Secret '${s.name}' (placeholder ${formatSecretPlaceholder(s.name)}) for hosts: ${(s.hosts || []).join(', ')}`
                );
              }
              const envCheck = validateEnvAgainstSecrets(envMap, resolvedList);
              if (!envCheck.valid) {
                throw new Error(envCheck.error || 'Environment contains raw secret value.');
              }
              resolvedSecrets = resolvedList;
            }

            const created = await this.bridge.createBox({
              name: boxName,
              image: config.image || 'python',
              autoRemove: false,
              autoStop: config.autoStop ?? 0,
              entrypoint: supervisor,
              env: Object.keys(envMap).length > 0 ? envMap : undefined,
              network: {
                inbound: { mode: config.network?.inbound || 'enabled' },
                outbound: {
                  mode: config.network?.outbound?.mode || 'enabled',
                  allow_net: config.network?.outbound?.allow_net || []
                }
              },
              volumes: config.volumes && config.volumes.length > 0 ? config.volumes : undefined,
              secrets: resolvedSecrets
            });

            boxId = created.boxId;
            this.outputChannel.appendLine(`[deploy] Box created: ID=${boxId}`);
            await ProjectManager.saveBoxId(fileUri, boxId);
          }

          // Step 3: Prepare guest destination
          progress.report({ message: 'Preparing /app in guest rootfs...' });
          const mkdirRes = await this.bridge.exec(boxId, 'mkdir', ['-p', '/app']);
          if (mkdirRes.exitCode !== 0) {
            throw new Error(`Failed to create /app in guest: ${mkdirRes.stderr}`);
          }

          // Step 4: Copy application files
          progress.report({ message: 'Uploading application code...' });
          this.outputChannel.appendLine(`[deploy] Copying ${appDir} to /app...`);
          // Note: copy contents via source + "/."
          const sourcePath = appDir.endsWith('/') || appDir.endsWith('\\') ? appDir + '.' : appDir + '/.';
          await this.bridge.copyIn(boxId, sourcePath, '/app');

          // Clean any ignored paths (.venv, node_modules, .env, __pycache__) from guest rootfs
          const ignores = ProjectManager.getIgnorePatterns(workspaceRoot);
          for (const ign of ignores) {
            if (ign.startsWith('*')) {
              continue;
            }
            await this.bridge.exec(boxId, 'rm', ['-rf', `/app/${ign}`]);
          }

          // Step 5: Restart running process so supervisor re-launches with newly deployed files
          progress.report({ message: 'Restarting application in guest...' });
          await this.bridge.exec(boxId, 'sh', ['-c', 'pkill -f python3 || true']);
          this.outputChannel.appendLine('[deploy] Code uploaded and application restart signal sent.');

          // Step 6: Wait for guest healthz readiness
          progress.report({ message: 'Verifying internal service health...' });
          const port = config.port || 8080;
          const healthPath = config.healthPath || '/healthz';
          const probePy = `import urllib.request; resp = urllib.request.urlopen('http://127.0.0.1:${port}${healthPath}', timeout=2); assert 200 <= resp.status < 300`;

          let healthy = false;
          for (let attempt = 1; attempt <= 30; attempt++) {
            this.outputChannel.appendLine(`[deploy] Health probe attempt ${attempt}/30...`);
            const probeRes = await this.bridge.exec(boxId, 'python3', ['-c', probePy]);
            if (probeRes.exitCode === 0) {
              healthy = true;
              break;
            }
            await new Promise((r) => setTimeout(r, 2000));
          }

          if (!healthy) {
            const logs = await this.bridge.tailLog(boxId, '/tmp/server.log', 40);
            this.outputChannel.appendLine(`[deploy] ERROR: App did not respond to /healthz. Recent logs:\n${logs.content}`);
            throw new Error(`Service did not become healthy within 60s. Check /tmp/server.log output.`);
          }
          this.outputChannel.appendLine('[deploy] Guest service healthy!');

          // Step 7: Configure network & declare tunnel
          progress.report({ message: 'Configuring network and tunnel...' });
          await this.bridge.updateInbound(boxId, 'enabled');

          const isPublic = config.access !== 'private';
          const tunnel = await this.bridge.tunnel(boxId, port, isPublic);
          const publicUrl = tunnel.url;
          this.outputChannel.appendLine(`[deploy] Tunnel established: ${publicUrl}`);

          // Step 8: Outside-the-box readiness check (proxy propagation)
          progress.report({ message: 'Testing external URL access...' });
          let externalOk = false;
          const base = publicUrl.endsWith('/') ? publicUrl : `${publicUrl}/`;
          const rel = healthPath.startsWith('/') ? healthPath.substring(1) : healthPath;
          const checkUrl = new URL(rel, base).toString();

          for (let attempt = 1; attempt <= 10; attempt++) {
            try {
              const status = await checkHttpHealth(checkUrl, tunnel.token);
              if (status === 200) {
                externalOk = true;
                break;
              }
            } catch (err) {
              // Wait for cloud proxy propagation
            }
            await new Promise((r) => setTimeout(r, 2000));
          }

          if (!externalOk) {
            this.outputChannel.appendLine('[deploy] Warning: External proxy health check timed out. URL may take a few moments to propagate.');
          } else {
            this.outputChannel.appendLine('[deploy] External public URL is reachable and healthy!');
          }

          // Step 9: Notify user
          this.outputChannel.appendLine(`\n=== Deployment Complete! ===`);
          this.outputChannel.appendLine(`Public URL: ${publicUrl}`);
          if (tunnel.token) {
            this.outputChannel.appendLine(`Access Token (Private): ${tunnel.token}`);
          }

          if (this.onDeploySuccess) {
            this.onDeploySuccess();
          }

          const actionOpen = 'Open in Browser';
          const actionCopy = 'Copy URL';
          const actionLogs = 'Stream Logs';

          vscode.window
            .showInformationMessage(
              `Deployed ${config.name} successfully to BoxLite!`,
              actionOpen,
              actionCopy,
              actionLogs
            )
            .then(async (selection) => {
              if (selection === actionOpen) {
                vscode.env.openExternal(vscode.Uri.parse(publicUrl));
              } else if (selection === actionCopy) {
                await vscode.env.clipboard.writeText(publicUrl);
                vscode.window.showInformationMessage('Public URL copied to clipboard.');
              } else if (selection === actionLogs) {
                this.logManager.openOrStreamLogs(boxId!, boxName);
              }
            });
        } catch (error: any) {
          this.outputChannel.appendLine(`[deploy] ERROR: ${error.message}`);
          const diag = diagnoseError(error.message);
          const msg = error.message.includes('Diagnosis:') ? error.message : `${error.message}\nDiagnosis: ${diag.summary}`;
          vscode.window.showErrorMessage(`Deployment failed: ${msg}`);
        }
      }
    );
  }
}

function checkHttpHealth(targetUrl: string, token?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(targetUrl);
    const client = urlObj.protocol === 'https:' ? https : http;

    const headers: Record<string, string> = {};
    if (token) {
      headers['X-BoxLite-Access-Token'] = token;
    }

    const req = client.get(
      targetUrl,
      {
        headers,
        timeout: 10000
      },
      (res) => {
        res.resume();
        resolve(res.statusCode || 0);
      }
    );

    req.on('error', (err) => reject(err));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Timeout'));
    });
  });
}
