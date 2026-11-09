import * as vscode from 'vscode';
import { BoxLiteBridgeClient } from '../bridge/client';
import { CredentialsManager } from '../auth/credentials';
import { PythonEnvManager } from '../bridge/env';
import { BoxesTreeDataProvider } from '../tree/boxesProvider';
import { BoxTreeItem } from '../tree/nodes';
import { BoxLiteDeployer } from '../deploy/deployer';
import { scaffoldNewProject } from '../deploy/scaffold';
import { buildSupervisorEntrypoint } from '../deploy/project';
import { LogStreamManager } from '../logs/logStream';
import { validateNetworkPolicy, validateAllowlistRule } from '../util/validation';
import { diagnoseError } from '../util/diagnosis';

export function registerCommands(
  context: vscode.ExtensionContext,
  bridge: BoxLiteBridgeClient,
  credentials: CredentialsManager,
  envManager: PythonEnvManager,
  treeProvider: BoxesTreeDataProvider,
  deployer: BoxLiteDeployer,
  logManager: LogStreamManager
) {
  // 1. Auth commands
  context.subscriptions.push(
    vscode.commands.registerCommand('boxlite.setApiKey', async () => {
      const key = await credentials.promptForApiKey();
      if (key) {
        bridge.restartBridge();
        treeProvider.refresh();
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('boxlite.signOut', async () => {
      const confirm = await vscode.window.showWarningMessage(
        'Are you sure you want to log out of BoxLite Cloud?',
        'Log Out',
        'Cancel'
      );
      if (confirm === 'Log Out') {
        await credentials.clearApiKey();
        bridge.restartBridge();
        treeProvider.refresh();
        vscode.window.showInformationMessage('Logged out of BoxLite Cloud.');
      }
    })
  );

  // 2. Refresh
  context.subscriptions.push(
    vscode.commands.registerCommand('boxlite.refresh', async () => {
      treeProvider.refresh();
    })
  );

  // 3. Setup Python Environment
  context.subscriptions.push(
    vscode.commands.registerCommand('boxlite.setupEnvironment', async () => {
      try {
        await envManager.setupEnvironment();
        bridge.restartBridge();
        treeProvider.refresh();
      } catch (err: any) {
        vscode.window.showErrorMessage(`Environment setup failed: ${err.message}`);
      }
    })
  );

  // 4. Project Scaffolding
  context.subscriptions.push(
    vscode.commands.registerCommand('boxlite.newProject', async () => {
      await scaffoldNewProject();
    })
  );

  // 5. Deploy commands
  context.subscriptions.push(
    vscode.commands.registerCommand('boxlite.deploy', async () => {
      await deployer.deployWorkspace();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('boxlite.deployFromTree', async (item?: BoxTreeItem) => {
      const boxId = item?.box.id;
      await deployer.deployWorkspace(boxId);
    })
  );

  // 6. Create Box
  context.subscriptions.push(
    vscode.commands.registerCommand('boxlite.createBox', async () => {
      const name = await vscode.window.showInputBox({
        prompt: 'Enter a name for the new Box',
        value: `box-${Math.random().toString(16).substring(2, 8)}`,
        validateInput: (v) => (!v.trim() ? 'Name cannot be empty' : null)
      });
      if (!name) {
        return;
      }

      const image = await vscode.window.showInputBox({
        prompt: 'Enter base image (default: python)',
        value: 'python'
      });

      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Creating Box ${name}...` },
        async () => {
          try {
            const config = vscode.workspace.getConfiguration('boxlite');
            const defaultAutoStop = config.get<number>('autoStop', 0);
            const supervisor = buildSupervisorEntrypoint();
            const res = await bridge.createBox({
              name: name.trim(),
              image: (image && image.trim()) || 'python',
              autoRemove: false,
              autoStop: defaultAutoStop,
              entrypoint: supervisor,
              network: {
                inbound: { mode: 'enabled' },
                outbound: { mode: 'enabled', allow_net: [] }
              }
            });
            vscode.window.showInformationMessage(`Box "${name}" created (ID: ${res.boxId}).`);
            treeProvider.refresh();
          } catch (e: any) {
            const diag = diagnoseError(e.message);
            const msg = e.message.includes('Diagnosis:') ? e.message : `${e.message}\nDiagnosis: ${diag.summary}`;
            vscode.window.showErrorMessage(`Failed to create Box: ${msg}`);
          }
        }
      );
    })
  );

  // 7. Start / Stop / Restart
  context.subscriptions.push(
    vscode.commands.registerCommand('boxlite.startBox', async (item?: BoxTreeItem) => {
      const boxId = await resolveBoxId(item, bridge);
      if (!boxId) {
        return;
      }

      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Starting Box ${boxId.substring(0, 8)}...` },
        async () => {
          try {
            await bridge.startBox(boxId);
            vscode.window.showInformationMessage(`Box started successfully.`);
            treeProvider.refresh();
          } catch (e: any) {
            vscode.window.showErrorMessage(`Failed to start Box: ${e.message}`);
          }
        }
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('boxlite.stopBox', async (item?: BoxTreeItem) => {
      const boxId = await resolveBoxId(item, bridge);
      if (!boxId) {
        return;
      }

      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Stopping Box ${boxId.substring(0, 8)}...` },
        async () => {
          try {
            await bridge.stopBox(boxId);
            logManager.stopStreaming(boxId);
            vscode.window.showInformationMessage(`Box stopped successfully.`);
            treeProvider.refresh();
          } catch (e: any) {
            vscode.window.showErrorMessage(`Failed to stop Box: ${e.message}`);
          }
        }
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('boxlite.restartApp', async (item?: BoxTreeItem) => {
      const boxId = await resolveBoxId(item, bridge);
      if (!boxId) {
        return;
      }

      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Restarting application in Box...` },
        async () => {
          try {
            // Kill any running python process; the supervisor will immediately restart it
            await bridge.exec(boxId, 'pkill', ['-f', 'server.py']);
            vscode.window.showInformationMessage(`Application restarted successfully.`);
          } catch {
            vscode.window.showInformationMessage(`Restart signal sent.`);
          }
        }
      );
    })
  );

  // 8. Delete Box
  context.subscriptions.push(
    vscode.commands.registerCommand('boxlite.deleteBox', async (item?: BoxTreeItem) => {
      const boxId = await resolveBoxId(item, bridge);
      if (!boxId) {
        return;
      }

      const boxName = item?.box.name || boxId.substring(0, 8);
      const confirm = await vscode.window.showWarningMessage(
        `Are you sure you want to permanently delete Box "${boxName}" (${boxId})?\nThis will destroy the microVM disk and any unbacked-up data.`,
        { modal: true },
        'Delete Box'
      );

      if (confirm !== 'Delete Box') {
        return;
      }

      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Deleting Box ${boxName}...` },
        async () => {
          try {
            await bridge.removeBox(boxId);
            logManager.stopStreaming(boxId);
            vscode.window.showInformationMessage(`Box "${boxName}" deleted.`);
            treeProvider.refresh();
          } catch (e: any) {
            vscode.window.showErrorMessage(`Failed to delete Box: ${e.message}`);
          }
        }
      );
    })
  );

  // 9. URLs & Tunnels
  context.subscriptions.push(
    vscode.commands.registerCommand('boxlite.openUrl', async (itemOrUrl?: BoxTreeItem | string, maybeUrl?: string) => {
      let url: string | undefined;
      if (typeof itemOrUrl === 'string') {
        url = itemOrUrl;
      } else if (typeof maybeUrl === 'string') {
        url = maybeUrl;
      } else {
        url = await resolveBoxUrl(itemOrUrl, bridge);
      }

      if (url) {
        vscode.env.openExternal(vscode.Uri.parse(url));
      } else {
        vscode.window.showWarningMessage('No active tunnel URL found for this Box.');
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('boxlite.copyUrl', async (itemOrUrl?: BoxTreeItem | string, maybeUrl?: string) => {
      let url: string | undefined;
      if (typeof itemOrUrl === 'string') {
        url = itemOrUrl;
      } else if (typeof maybeUrl === 'string') {
        url = maybeUrl;
      } else {
        url = await resolveBoxUrl(itemOrUrl, bridge);
      }

      if (url) {
        await vscode.env.clipboard.writeText(url);
        vscode.window.showInformationMessage('URL copied to clipboard.');
      } else {
        vscode.window.showWarningMessage('No active tunnel URL found for this Box.');
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('boxlite.copyAccessToken', async (item?: BoxTreeItem) => {
      const token = item?.tunnels.find((t) => !!t.token)?.token;
      if (token) {
        await vscode.env.clipboard.writeText(token);
        vscode.window.showInformationMessage('Access Token copied to clipboard.');
      } else {
        vscode.window.showInformationMessage('No private access token found.');
      }
    })
  );

  // 10. Access & Network Configuration
  context.subscriptions.push(
    vscode.commands.registerCommand('boxlite.setAccess', async (item?: BoxTreeItem) => {
      const boxId = await resolveBoxId(item, bridge);
      if (!boxId) {
        return;
      }

      const choice = await vscode.window.showQuickPick(
        [
          { label: 'Public Tunnel', description: 'Enable inbound and create a public URL accessible to anyone' },
          { label: 'Private Tunnel', description: 'Create a private URL protected by X-BoxLite-Access-Token' },
          { label: 'Revoke Tunnel', description: 'Revoke external tunnel and deny incoming connections' },
          { label: 'Disable Inbound Access', description: 'Completely disable inbound cloud proxy access' }
        ],
        { placeHolder: 'Select inbound access option' }
      );

      if (!choice) {
        return;
      }

      const config = vscode.workspace.getConfiguration('boxlite');
      const port = config.get<number>('defaultPort', 8080);

      try {
        if (choice.label.startsWith('Public')) {
          await bridge.updateInbound(boxId, 'enabled');
          const t = await bridge.tunnel(boxId, port, true);
          vscode.window.showInformationMessage(`Public tunnel established: ${t.url}`);
        } else if (choice.label.startsWith('Private')) {
          await bridge.updateInbound(boxId, 'enabled');
          const t = await bridge.tunnel(boxId, port, false);
          vscode.window.showInformationMessage(`Private tunnel established: ${t.url}`);
        } else if (choice.label.startsWith('Revoke')) {
          await bridge.revokeTunnel(boxId, port);
          vscode.window.showInformationMessage(`Tunnel on port ${port} revoked.`);
        } else if (choice.label.startsWith('Disable')) {
          await bridge.updateInbound(boxId, 'disabled');
          vscode.window.showInformationMessage(`Inbound access disabled.`);
        }
        treeProvider.refresh();
      } catch (e: any) {
        vscode.window.showErrorMessage(`Failed to update access: ${e.message}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('boxlite.configureOutbound', async (item?: BoxTreeItem) => {
      const boxId = await resolveBoxId(item, bridge);
      if (!boxId) {
        return;
      }

      const modeChoice = await vscode.window.showQuickPick(
        [
          { label: 'Enabled (Unrestricted)', description: 'Allow all outbound connections (allow_net=[])' },
          { label: 'Enabled (Restricted Allowlist)', description: 'Restrict outbound traffic to specific hostnames/CIDRs' },
          { label: 'Disabled', description: 'Disable outbound traffic (Warning: suspends NIC & inbound)' }
        ],
        { placeHolder: 'Select outbound network mode' }
      );

      if (!modeChoice) {
        return;
      }

      let allowNet: string[] = [];
      let mode: 'enabled' | 'disabled' = 'enabled';

      if (modeChoice.label.startsWith('Enabled (Restricted')) {
        const input = await vscode.window.showInputBox({
          prompt: 'Enter allowed hosts separated by commas (e.g. api.example.com, *.github.com, 1.2.3.4)',
          placeHolder: 'api.example.com, *.github.com',
          validateInput: (val) => {
            const rules = val.split(',').map((r) => r.trim()).filter((r) => r.length > 0);
            for (const r of rules) {
              const check = validateAllowlistRule(r);
              if (!check.valid) {
                return check.error;
              }
            }
            return null;
          }
        });

        if (!input) {
          return;
        }

        allowNet = input.split(',').map((r) => r.trim()).filter((r) => r.length > 0);
      } else if (modeChoice.label.startsWith('Disabled')) {
        mode = 'disabled';
      }

      const validation = validateNetworkPolicy('enabled', mode, allowNet);
      if (!validation.valid) {
        vscode.window.showErrorMessage(`Invalid network policy: ${validation.errors.join('; ')}`);
        return;
      }

      if (validation.warnings.length > 0) {
        vscode.window.showWarningMessage(`Notice: ${validation.warnings.join(' ')}`);
      }

      try {
        await bridge.updateOutbound(boxId, mode, allowNet);
        vscode.window.showInformationMessage(`Outbound network policy updated for Box ${boxId.substring(0, 8)}.`);
        treeProvider.refresh();
      } catch (e: any) {
        vscode.window.showErrorMessage(`Failed to update outbound network: ${e.message}`);
      }
    })
  );

  // 11. Stream Logs
  context.subscriptions.push(
    vscode.commands.registerCommand('boxlite.streamLogs', async (item?: BoxTreeItem) => {
      const boxId = await resolveBoxId(item, bridge);
      if (!boxId) {
        return;
      }
      const boxName = item?.box?.name || boxId.substring(0, 8);
      await logManager.openOrStreamLogs(boxId, boxName);
      treeProvider.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('boxlite.stopLogs', async (item?: BoxTreeItem) => {
      const boxId = await resolveBoxId(item, bridge);
      if (!boxId) {
        return;
      }
      logManager.stopStreaming(boxId);
      treeProvider.refresh();
      vscode.window.showInformationMessage(`Stopped streaming logs for Box ${boxId.substring(0, 8)}.`);
    })
  );

  // 12. Exec Command
  context.subscriptions.push(
    vscode.commands.registerCommand('boxlite.execCommand', async (item?: BoxTreeItem) => {
      const boxId = await resolveBoxId(item, bridge);
      if (!boxId) {
        return;
      }

      const cmdInput = await vscode.window.showInputBox({
        prompt: 'Enter command to run in Box (e.g. python3 -c "print(2+2)")',
        value: 'python3 -c "print(2 + 2)"'
      });

      if (!cmdInput) {
        return;
      }

      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Executing "${cmdInput}"...` },
        async () => {
          try {
            const res = await bridge.exec(boxId, 'sh', ['-c', cmdInput.trim()]);
            const doc = await vscode.workspace.openTextDocument({
              content: `=== Execution Result ===\nCommand: ${cmdInput}\nExit Code: ${res.exitCode}\n\n--- Standard Output ---\n${res.stdout}\n\n--- Standard Error ---\n${res.stderr}`,
              language: 'text'
            });
            await vscode.window.showTextDocument(doc);
          } catch (e: any) {
            vscode.window.showErrorMessage(`Command execution failed: ${e.message}`);
          }
        }
      );
    })
  );

  // 13. Inspect Box
  context.subscriptions.push(
    vscode.commands.registerCommand('boxlite.inspectBox', async (item?: BoxTreeItem) => {
      const boxId = await resolveBoxId(item, bridge);
      if (!boxId) {
        return;
      }

      try {
        const info = await bridge.inspectBox(boxId);
        const doc = await vscode.workspace.openTextDocument({
          content: JSON.stringify(info, null, 2),
          language: 'json'
        });
        await vscode.window.showTextDocument(doc);
      } catch (e: any) {
        vscode.window.showErrorMessage(`Failed to inspect Box: ${e.message}`);
      }
    })
  );

  // 14. Documentation
  context.subscriptions.push(
    vscode.commands.registerCommand('boxlite.openDocs', () => {
      vscode.env.openExternal(vscode.Uri.parse('https://boxlite.ai/agent.md'));
    })
  );
}

async function resolveBoxId(item?: any, bridge?: BoxLiteBridgeClient): Promise<string | undefined> {
  if (typeof item === 'string' && item.trim().length > 0) {
    return item.trim();
  }
  if (item && item.box && item.box.id) {
    return item.box.id;
  }
  if (item && item.boxId) {
    return item.boxId;
  }
  if (!bridge) {
    return undefined;
  }
  try {
    const boxes = await bridge.listBoxes();
    if (boxes.length === 0) {
      vscode.window.showInformationMessage('No Boxes found in your BoxLite Cloud account.');
      return undefined;
    }
    const picked = await vscode.window.showQuickPick(
      boxes.map((b) => ({
        label: b.name || b.id,
        description: `${b.status} · ${b.id}`,
        id: b.id
      })),
      { placeHolder: 'Select a Box' }
    );
    return picked?.id;
  } catch (e: any) {
    vscode.window.showErrorMessage(`Failed to list boxes: ${e.message}`);
    return undefined;
  }
}

async function resolveBoxUrl(item?: BoxTreeItem, bridge?: BoxLiteBridgeClient): Promise<string | undefined> {
  if (item && item.tunnels && item.tunnels.length > 0) {
    return item.tunnels[0].url;
  }
  const boxId = await resolveBoxId(item, bridge);
  if (!boxId || !bridge) {
    return undefined;
  }
  try {
    const inspected = await bridge.inspectBox(boxId);
    if (inspected && inspected.tunnels && inspected.tunnels.length > 0) {
      return inspected.tunnels[0].url || inspected.tunnels[0].uri;
    }
  } catch {
    // Ignore
  }
  return undefined;
}
