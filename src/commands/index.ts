import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { BoxLiteBridgeClient } from '../bridge/client';
import { CreateBoxArgs, VolumeItem, CheckpointItem, SecretConfigSpec, SecretSpec } from '../bridge/protocol';
import { CredentialsManager } from '../auth/credentials';
import { SecretsManager } from '../auth/secretsStore';
import { PythonEnvManager } from '../bridge/env';
import { BoxesTreeDataProvider } from '../tree/boxesProvider';
import { VolumesTreeDataProvider } from '../tree/volumesProvider';
import { ImagesTreeDataProvider } from '../tree/imagesProvider';
import { CheckpointsTreeDataProvider } from '../tree/checkpointsProvider';
import { SecretsTreeDataProvider } from '../tree/secretsProvider';
import { AccountTreeDataProvider } from '../tree/accountProvider';
import {
  BoxTreeItem,
  VolumeTreeItem,
  ImageTreeItem,
  CheckpointTreeItem,
  SecretTreeItem,
  ApiKeyTreeItem
} from '../tree/nodes';
import { BoxLiteDeployer } from '../deploy/deployer';
import { scaffoldNewProject } from '../deploy/scaffold';
import { ProjectManager, DEFAULT_CONFIG } from '../deploy/project';
import { LogStreamManager } from '../logs/logStream';
import {
  validateNetworkPolicy,
  validateAllowlistRule,
  validateVolumeName,
  validateGuestPath,
  validateImageReference,
  validateAliasName,
  validateDigest,
  validateRegistryHost,
  validateRepositoryPrefix,
  validateCheckpointName,
  validateCheckpointBoxOptions,
  validateSecretName,
  validateSecretHosts,
  validateSecretHeaders,
  ALLOWED_REGISTRY_HOSTS
} from '../util/validation';
import { diagnoseError } from '../util/diagnosis';
import {
  showBoxConfigurationWizard,
  BOX_TEMPLATES,
  convertBoxConfigToCreateArgs,
  getDefaultBoxConfiguration,
  getQuickCreateBoxConfiguration,
  generateBoxName
} from './boxConfiguration';

export function registerCommands(
  context: vscode.ExtensionContext,
  bridge: BoxLiteBridgeClient,
  credentials: CredentialsManager,
  envManager: PythonEnvManager,
  treeProvider: BoxesTreeDataProvider,
  deployer: BoxLiteDeployer,
  logManager: LogStreamManager,
  volumesProvider?: VolumesTreeDataProvider,
  imagesProvider?: ImagesTreeDataProvider,
  accountProvider?: AccountTreeDataProvider,
  checkpointsProvider?: CheckpointsTreeDataProvider,
  secretsProvider?: SecretsTreeDataProvider,
  secretsManager?: SecretsManager
) {
  const refreshAllViews = () => {
    bridge.restartBridge();
    accountProvider?.refresh();
    treeProvider.refresh();
    volumesProvider?.refresh();
    imagesProvider?.refresh();
    checkpointsProvider?.refresh();
    secretsProvider?.refresh();
  };

  // 1. Auth commands
  context.subscriptions.push(
    vscode.commands.registerCommand('boxlite.setApiKey', async () => {
      const key = await credentials.promptForApiKey();
      if (key) {
        refreshAllViews();
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('boxlite.selectApiKey', async (target?: string | ApiKeyTreeItem) => {
      let keyId: string | undefined;
      if (typeof target === 'string') {
        keyId = target;
      } else if (target && (target as any).keyId) {
        keyId = (target as any).keyId;
      }

      if (!keyId) {
        const keys = await credentials.listKeys();
        if (keys.length === 0) {
          vscode.window.showInformationMessage('No BoxLite API keys found. Link an API key first.');
          return;
        }
        const picked = await vscode.window.showQuickPick(
          keys.map((k) => ({
            label: `${k.active ? '$(check) ' : ''}${k.name}`,
            description: k.active ? 'Active' : '',
            id: k.id
          })),
          { placeHolder: 'Select an API key to activate' }
        );
        if (!picked) {
          return;
        }
        keyId = picked.id;
      }

      if (keyId === 'env') {
        refreshAllViews();
        return;
      }

      const success = await credentials.selectKey(keyId);
      if (success) {
        refreshAllViews();
        const active = await credentials.getActiveKey();
        vscode.window.showInformationMessage(`Switched active BoxLite API key to "${active?.name || keyId}".`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('boxlite.removeApiKey', async (target?: ApiKeyTreeItem) => {
      let keyId = target?.keyId;
      let keyName = target?.keyName;

      if (!keyId) {
        const keys = await credentials.listKeys();
        const removable = keys.filter((k) => !k.isEnv);
        if (removable.length === 0) {
          vscode.window.showInformationMessage('No removable BoxLite API keys found.');
          return;
        }
        const picked = await vscode.window.showQuickPick(
          removable.map((k) => ({
            label: k.name,
            description: k.active ? 'Active' : '',
            id: k.id
          })),
          { placeHolder: 'Select an API key to remove' }
        );
        if (!picked) {
          return;
        }
        keyId = picked.id;
        keyName = picked.label;
      }

      const confirm = await vscode.window.showWarningMessage(
        `Are you sure you want to remove the API key "${keyName || keyId}"?`,
        'Remove',
        'Cancel'
      );
      if (confirm === 'Remove') {
        await credentials.removeKey(keyId);
        refreshAllViews();
        vscode.window.showInformationMessage(`Removed BoxLite API key "${keyName || keyId}".`);
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
        refreshAllViews();
        vscode.window.showInformationMessage('Logged out of BoxLite Cloud.');
      }
    })
  );

  // 2. Refresh
  context.subscriptions.push(
    vscode.commands.registerCommand('boxlite.refresh', async () => {
      accountProvider?.refresh();
      treeProvider.refresh();
      volumesProvider?.refresh();
      imagesProvider?.refresh();
      checkpointsProvider?.refresh();
      secretsProvider?.refresh();
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

  // Shared helper for box creation
  async function performCreateBox(args: CreateBoxArgs): Promise<void> {
    const boxName = args.name || 'new-box';
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Creating Box ${boxName}...` },
      async () => {
        try {
          const res = await bridge.createBox(args);
          vscode.window.showInformationMessage(`Box "${boxName}" created (ID: ${res.boxId}).`);
          treeProvider.refresh();
          imagesProvider?.refresh();
          secretsProvider?.refresh();
        } catch (e: any) {
          const diag = diagnoseError(e.message);
          const msg = e.message.includes('Diagnosis:') ? e.message : `${e.message}\nDiagnosis: ${diag.summary}`;
          vscode.window.showErrorMessage(`Failed to create Box: ${msg}`);
        }
      }
    );
  }

  // 6. Create Box with Options (Interactive Configuration Wizard)
  context.subscriptions.push(
    vscode.commands.registerCommand('boxlite.createBoxWithOptions', async () => {
      const args = await showBoxConfigurationWizard(undefined, secretsManager);
      if (args) {
        await performCreateBox(args);
      }
    })
  );

  // 6b. Create Box (Quick Pick: Custom Options Wizard, Templates, or Quick Create)
  context.subscriptions.push(
    vscode.commands.registerCommand('boxlite.createBox', async () => {
      const choices = [
        {
          label: '$(gear) Configure Box Options...',
          description: 'Interactive configuration wizard',
          detail: 'Customize vCPU, RAM, disk, network policies, auto-stop, and environment variables',
          action: 'wizard'
        },
        {
          label: '$(file-code) Choose from Template...',
          description: 'Python Web App · Node.js · Secure Box · Air-Gapped Sandbox',
          detail: 'Start with an agent-verified configuration profile (§1, §2, §3)',
          action: 'template'
        },
        {
          label: '$(zap) Quick Create (Small Python Box)',
          description: 'python image · 1 vCPU · 1 GiB RAM · 10 GiB Disk · Network disabled · Stop on idle: 5m',
          detail: 'Fast one-click creation using small box sizing with inbound and outbound network disabled (agent.md §3)',
          action: 'quick'
        },
        {
          label: '$(archive) Create from Checkpoint...',
          description: 'Restore a new independent Box from a saved checkpoint',
          detail: 'Inherits saved root disk and execution configuration (docs.boxlite.ai/cloud/checkpoints)',
          action: 'checkpoint'
        }
      ];

      const choice = await vscode.window.showQuickPick(choices, {
        title: 'Create New BoxLite Instance',
        placeHolder: 'Select how you want to configure your new Box'
      });

      if (!choice) {
        return;
      }

      if (choice.action === 'wizard') {
        const args = await showBoxConfigurationWizard(undefined, secretsManager);
        if (args) {
          await performCreateBox(args);
        }
      } else if (choice.action === 'template') {
        const tmplItems = BOX_TEMPLATES.map((t) => ({
          label: t.label,
          description: t.description,
          detail: t.detail,
          template: t
        }));
        const selectedTmpl = await vscode.window.showQuickPick(tmplItems, {
          title: 'Select BoxLite Template',
          placeHolder: 'Choose a template for your new Box'
        });
        if (!selectedTmpl) {
          return;
        }

        const nextAction = await vscode.window.showQuickPick(
          [
            { label: '$(check) Create Immediately with Template Defaults', action: 'create' },
            { label: '$(gear) Customize Template Options First...', action: 'customize' }
          ],
          { title: `Template: ${selectedTmpl.template.label}` }
        );

        if (!nextAction) {
          return;
        }

        if (nextAction.action === 'customize') {
          const args = await showBoxConfigurationWizard({
            ...selectedTmpl.template.config,
            name: generateBoxName()
          }, secretsManager);
          if (args) {
            await performCreateBox(args);
          }
        } else {
          const config = {
            ...getDefaultBoxConfiguration(),
            ...selectedTmpl.template.config,
            name: generateBoxName()
          };
          const args = convertBoxConfigToCreateArgs(config);
          await performCreateBox(args);
        }
      } else if (choice.action === 'quick') {
        const name = await vscode.window.showInputBox({
          prompt: 'Enter a name for the new Box',
          value: generateBoxName(),
          validateInput: (v) => (!v.trim() ? 'Name cannot be empty' : null)
        });
        if (!name) {
          return;
        }

        const config = getQuickCreateBoxConfiguration(name);
        const args = convertBoxConfigToCreateArgs(config);
        await performCreateBox(args);
      } else if (choice.action === 'checkpoint') {
        await vscode.commands.executeCommand('boxlite.createBoxFromCheckpoint');
      }
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
            logManager.stopStreaming(boxId);
            await bridge.stopBox(boxId);
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
            logManager.stopStreaming(boxId);
            await bridge.removeBox(boxId);
            vscode.window.showInformationMessage(`Box "${boxName}" deleted.`);
            treeProvider.refresh();
            imagesProvider?.refresh();
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

  // 15. Volume Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('boxlite.refreshVolumes', async () => {
      volumesProvider?.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('boxlite.createVolume', async () => {
      const name = await vscode.window.showInputBox({
        prompt: 'Enter name for the managed persistent volume (leave empty for auto-assigned)',
        placeHolder: 'e.g. app-data, db-storage',
        validateInput: (v) => {
          if (v && v.trim()) {
            const check = validateVolumeName(v.trim());
            if (!check.valid) {
              return check.error;
            }
          }
          return null;
        }
      });
      if (name === undefined) {
        return;
      }

      let vol: VolumeItem | undefined;
      try {
        vol = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Creating BoxLite persistent volume${name.trim() ? ` "${name.trim()}"` : ''}...`
          },
          async () => {
            return await bridge.createVolume({
              name: name.trim() ? name.trim() : undefined
            });
          }
        );
        volumesProvider?.refresh();
      } catch (e: any) {
        const diag = diagnoseError(e.message);
        const msg = e.message.includes('Diagnosis:') ? e.message : `${e.message}\nDiagnosis: ${diag.summary}`;
        vscode.window.showErrorMessage(`Failed to create volume: ${msg}`);
        return;
      }

      if (vol) {
        const choice = await vscode.window.showInformationMessage(
          `Volume "${vol.name}" created (ID: ${vol.id}).`,
          'Mount in Box...',
          'Copy ID'
        );
        if (choice === 'Mount in Box...') {
          await vscode.commands.executeCommand('boxlite.addVolumeToBox', vol);
        } else if (choice === 'Copy ID') {
          await vscode.env.clipboard.writeText(vol.id);
        }
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('boxlite.deleteVolume', async (item?: any) => {
      const vol = await resolveVolume(item, bridge);
      if (!vol) {
        return;
      }

      const confirm = await vscode.window.showWarningMessage(
        `Are you sure you want to delete volume "${vol.name}" (${vol.id})? Any stored persistent data will be permanently destroyed (§4).`,
        { modal: true },
        'Delete',
        'Delete (Force)',
        'Cancel'
      );

      if (confirm !== 'Delete' && confirm !== 'Delete (Force)') {
        return;
      }

      const force = confirm === 'Delete (Force)';
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Deleting volume ${vol.name}...`
        },
        async () => {
          try {
            await bridge.removeVolume(vol.id, force);
            volumesProvider?.refresh();
            vscode.window.showInformationMessage(`Volume "${vol.name}" deleted successfully.`);
          } catch (e: any) {
            vscode.window.showErrorMessage(`Failed to delete volume: ${e.message}`);
          }
        }
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('boxlite.inspectVolume', async (item?: any) => {
      const vol = await resolveVolume(item, bridge);
      if (!vol) {
        return;
      }

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Inspecting volume ${vol.id}...`
        },
        async () => {
          try {
            const inspected = await bridge.inspectVolume(vol.id);
            const doc = await vscode.workspace.openTextDocument({
              content: JSON.stringify(inspected, null, 2),
              language: 'json'
            });
            await vscode.window.showTextDocument(doc, { preview: true });
          } catch (e: any) {
            vscode.window.showErrorMessage(`Failed to inspect volume: ${e.message}`);
          }
        }
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('boxlite.copyVolumeId', async (item?: any) => {
      const vol = await resolveVolume(item, bridge);
      if (vol) {
        await vscode.env.clipboard.writeText(vol.id);
        vscode.window.showInformationMessage(`Volume ID "${vol.id}" copied to clipboard.`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('boxlite.copyVolumeName', async (item?: any) => {
      const vol = await resolveVolume(item, bridge);
      if (vol) {
        await vscode.env.clipboard.writeText(vol.name);
        vscode.window.showInformationMessage(`Volume name "${vol.name}" copied to clipboard.`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('boxlite.addVolumeToBox', async (item?: any) => {
      const vol = await resolveVolume(item, bridge);
      if (!vol) {
        return;
      }

      const guestPath = await vscode.window.showInputBox({
        prompt: `Enter guest mount path inside container for volume "${vol.name}"`,
        value: '/data',
        placeHolder: 'e.g. /data, /mnt/storage, /app/data',
        validateInput: (v) => {
          const check = validateGuestPath(v);
          if (!check.valid) {
            return check.error;
          }
          return null;
        }
      });

      if (!guestPath) {
        return;
      }

      const pathCheck = validateGuestPath(guestPath);
      if (pathCheck.warning) {
        vscode.window.showWarningMessage(pathCheck.warning);
      }

      const projectInfo = await ProjectManager.findProjectConfig();
      if (projectInfo) {
        await ProjectManager.addVolumeMount(projectInfo.fileUri, {
          managed_volume: vol.name || vol.id,
          guest_path: guestPath.trim(),
          read_only: false
        });
        vscode.window.showInformationMessage(
          `Volume "${vol.name}" configured for mount at "${guestPath.trim()}" in boxlite.json. Run "Deploy to Box" to deploy.`
        );
      } else {
        vscode.window.showInformationMessage(
          `Volume mount configured: "${vol.name}" -> "${guestPath.trim()}". To persist, add to "volumes" in boxlite.json.`
        );
      }
    })
  );

  // 16. Image Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('boxlite.refreshImages', async () => {
      imagesProvider?.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('boxlite.createBoxFromImage', async (item?: any) => {
      const imageName = await resolveImageName(item, bridge);
      if (!imageName) {
        return;
      }
      const args = await showBoxConfigurationWizard({
        image: imageName,
        name: generateBoxName()
      });
      if (args) {
        await performCreateBox(args);
        imagesProvider?.refresh();
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('boxlite.setDefaultImage', async (item?: any) => {
      const imageName = await resolveImageName(item, bridge);
      if (!imageName) {
        return;
      }
      await vscode.workspace
        .getConfiguration('boxlite')
        .update('defaultImage', imageName, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(`Default box image set to "${imageName}".`);
      imagesProvider?.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('boxlite.copyImageName', async (item?: any) => {
      const imageName = await resolveImageName(item, bridge);
      if (imageName) {
        await vscode.env.clipboard.writeText(imageName);
        vscode.window.showInformationMessage(`Image reference "${imageName}" copied to clipboard.`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('boxlite.inspectImage', async (item?: any) => {
      const imageName = await resolveImageName(item, bridge);
      if (!imageName) {
        return;
      }

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Inspecting image ${imageName}...`
        },
        async () => {
          try {
            const inspected = await bridge.inspectImage(imageName);
            const doc = await vscode.workspace.openTextDocument({
              content: JSON.stringify(inspected, null, 2),
              language: 'json'
            });
            await vscode.window.showTextDocument(doc, { preview: true });
          } catch (e: any) {
            vscode.window.showErrorMessage(`Failed to inspect image: ${e.message}`);
          }
        }
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('boxlite.pinImageAlias', async (item?: any) => {
      const imageName = await resolveImageName(item, bridge);
      if (!imageName) {
        return;
      }

      const alias = await vscode.window.showInputBox({
        prompt: `Enter alias tag for image "${imageName}" (e.g. "stable", "v1.0", "prod")`,
        placeHolder: 'e.g. stable',
        validateInput: (v) => {
          const check = validateAliasName(v);
          return check.valid ? null : check.error || 'Invalid alias';
        }
      });
      if (!alias) {
        return;
      }

      const digest = await vscode.window.showInputBox({
        prompt: `Enter exact build digest for "${alias}" (e.g. sha256:c64c687c...)`,
        placeHolder: 'sha256:...',
        validateInput: (v) => {
          const check = validateDigest(v);
          return check.valid ? null : check.error || 'Invalid digest';
        }
      });
      if (!digest) {
        return;
      }

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Pinning alias "${alias}" on ${imageName}...`
        },
        async () => {
          try {
            await bridge.createImageAlias({
              name: imageName,
              alias: alias.trim(),
              digest: digest.trim()
            });
            vscode.window.showInformationMessage(`Alias "${alias}" pinned to ${imageName}@${digest.substring(0, 19)}...`);
            imagesProvider?.refresh();
          } catch (e: any) {
            vscode.window.showErrorMessage(`Failed to pin image alias: ${e.message}`);
          }
        }
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('boxlite.removeImage', async (item?: any) => {
      const imageName = await resolveImageName(item, bridge);
      if (!imageName) {
        return;
      }

      const builtins = ['base', 'python', 'node', 'sandbaseai-hermes'];
      if (builtins.includes(imageName.toLowerCase().trim())) {
        vscode.window.showErrorMessage(
          `Built-in image "${imageName}" is maintained by BoxLite and cannot be removed (docs.boxlite.ai/cloud/images).`
        );
        return;
      }

      const confirm = await vscode.window.showWarningMessage(
        `Are you sure you want to remove image "${imageName}" from your organization catalog?\nRemoving an image takes its versions, aliases, and history with it. Images used by active boxes cannot be removed (docs.boxlite.ai/cloud/image-catalog).`,
        { modal: true },
        'Delete Image',
        'Cancel'
      );

      if (confirm !== 'Delete Image') {
        return;
      }

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Removing image ${imageName}...`
        },
        async () => {
          try {
            await bridge.removeImage(imageName);

            // Also clean up from customImages setting if saved there
            const config = vscode.workspace.getConfiguration('boxlite');
            const custom = config.get<string[]>('customImages', []);
            if (custom.includes(imageName)) {
              const updated = custom.filter((x) => x !== imageName);
              await config.update('customImages', updated, vscode.ConfigurationTarget.Global);
            }

            imagesProvider?.refresh();
            vscode.window.showInformationMessage(`Image "${imageName}" removed successfully.`);
          } catch (e: any) {
            vscode.window.showErrorMessage(`Failed to remove image: ${e.message}`);
          }
        }
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('boxlite.addImage', async () => {
      const input = await vscode.window.showInputBox({
        prompt: 'Enter container image reference from public or private registry',
        placeHolder: 'e.g. docker.io/library/alpine:3.20 or ghcr.io/acme/app:1.4.0',
        validateInput: (v) => {
          const check = validateImageReference(v);
          return check.valid ? null : check.error || 'Invalid image reference';
        }
      });

      if (!input || !input.trim()) {
        return;
      }

      const imageRef = input.trim();
      const refCheck = validateImageReference(imageRef);
      if (refCheck.warning) {
        vscode.window.showWarningMessage(refCheck.warning);
      }

      const action = await vscode.window.showQuickPick(
        [
          {
            label: '$(play) Create a Box now with this image',
            description: 'Boots microVM and automatically records image into catalog (~12s)',
            action: 'create'
          },
          {
            label: '$(save) Save to custom image list',
            description: 'Keep in sidebar for later creation without starting a box now',
            action: 'save'
          }
        ],
        { title: `Use Image: ${imageRef}` }
      );

      if (!action) {
        return;
      }

      // Always save to custom images list in settings so user doesn't lose it
      const config = vscode.workspace.getConfiguration('boxlite');
      const current = config.get<string[]>('customImages', []);
      if (!current.includes(imageRef)) {
        const updated = [...current, imageRef];
        await config.update('customImages', updated, vscode.ConfigurationTarget.Global);
      }

      if (action.action === 'save') {
        vscode.window.showInformationMessage(`Image "${imageRef}" saved to your custom images list.`);
        imagesProvider?.refresh();
        return;
      }

      // Action: create
      const args = await showBoxConfigurationWizard({
        image: imageRef,
        name: generateBoxName()
      });

      if (args) {
        await performCreateBox(args);
        imagesProvider?.refresh();

        // Bounded polling for catalog recording (~12s lag as documented in agent.md & docs.boxlite.ai/cloud/image-catalog)
        let pollAttempts = 0;
        const pollInterval = setInterval(async () => {
          pollAttempts++;
          try {
            const res = await bridge.listImages();
            const found = (res.images || []).some(
              (img) => typeof img?.name === 'string' && img.name.toLowerCase() === imageRef.toLowerCase()
            );
            if (found || pollAttempts >= 8) {
              clearInterval(pollInterval);
              imagesProvider?.refresh();
            }
          } catch {
            clearInterval(pollInterval);
          }
        }, 3000);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('boxlite.addRegistryLogin', async () => {
      const hostChoices = [
        ...ALLOWED_REGISTRY_HOSTS.map((h) => ({
          label: h,
          description:
            h === 'ghcr.io'
              ? 'GitHub Container Registry'
              : h === 'docker.io'
              ? 'Docker Hub'
              : h === 'quay.io'
              ? 'Red Hat Quay'
              : 'Google Container Registry'
        })),
        { label: 'Other registry host...', description: 'Enter another supported host' }
      ];

      const hostPick = await vscode.window.showQuickPick(hostChoices, {
        title: 'Connect Private Container Registry',
        placeHolder: 'Select registry host'
      });
      if (!hostPick) {
        return;
      }
      let registryHost = hostPick.label;
      if (registryHost === 'Other registry host...') {
        const customHost = await vscode.window.showInputBox({
          prompt: 'Enter registry host (e.g. ghcr.io, docker.io)',
          validateInput: (v) => {
            const check = validateRegistryHost(v);
            return check.valid ? null : check.error || 'Invalid host';
          }
        });
        if (!customHost) {
          return;
        }
        registryHost = customHost.trim();
      }

      const username = await vscode.window.showInputBox({
        title: `Connect ${registryHost}`,
        prompt: `Enter registry username (e.g. GitHub username, robot account, or "_json_key" for GCR)`,
        validateInput: (v) => (!v.trim() ? 'Username cannot be empty.' : null)
      });
      if (!username) {
        return;
      }

      const password = await vscode.window.showInputBox({
        title: `Connect ${registryHost}`,
        prompt: `Enter registry access token or password (read-only token recommended)`,
        password: true,
        validateInput: (v) => (!v.trim() ? 'Token/Password cannot be empty.' : null)
      });
      if (!password) {
        return;
      }

      const prefix = await vscode.window.showInputBox({
        title: `Connect ${registryHost} (Optional Scope)`,
        prompt: 'Enter repository prefix ending with "/" to narrow access (leave empty to cover entire registry)',
        placeHolder: 'e.g. acme/ or team-a/',
        validateInput: (v) => {
          const check = validateRepositoryPrefix(v);
          return check.valid ? null : check.error || 'Invalid prefix';
        }
      });
      if (prefix === undefined) {
        return;
      }

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Connecting registry login for ${registryHost}...`
        },
        async () => {
          try {
            await bridge.createRegistryLogin({
              registryHost,
              username: username.trim(),
              password: password.trim(),
              repositoryPrefix: prefix.trim() ? prefix.trim() : undefined
            });
            vscode.window.showInformationMessage(`Connected private registry "${registryHost}" successfully.`);
            imagesProvider?.refresh();
          } catch (e: any) {
            const diag = diagnoseError(e.message);
            const msg = e.message.includes('Diagnosis:') ? e.message : `${e.message}\nDiagnosis: ${diag.summary}`;
            vscode.window.showErrorMessage(`Failed to connect registry: ${msg}`);
          }
        }
      );
    })
  );

  // 17. Checkpoint Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('boxlite.refreshCheckpoints', async () => {
      checkpointsProvider?.refresh();
    })
  );

  async function handleCreateCheckpoint(item?: any): Promise<void> {
    const boxId = await resolveBoxId(item, bridge);
    if (!boxId) {
      return;
    }

    // Check box status and attachments (volumes / secrets) before capture
    let currentStatus = ((item?.box?.status as string) || '').toLowerCase().trim();
    let hasVolumes = Array.isArray(item?.box?.volumes) && item.box.volumes.length > 0;
    let hasSecrets = false;

    if (typeof bridge.inspectBox === 'function') {
      try {
        const info = await bridge.inspectBox(boxId);
        if (info) {
          const rawStatus = info.status || info.state?.status || currentStatus;
          if (rawStatus) {
            currentStatus = String(rawStatus).toLowerCase().trim();
          }
          const vols = info.volumes || info.config?.volumes;
          if (Array.isArray(vols) && vols.length > 0) {
            hasVolumes = true;
          }
          const secrets = info.secrets || info.config?.secrets;
          if (Array.isArray(secrets) && secrets.length > 0) {
            hasSecrets = true;
          }
        }
      } catch {
        // Proceed with cached metadata if inspect is unavailable
      }
    }

    if (hasVolumes || hasSecrets) {
      vscode.window.showErrorMessage(
        'Checkpoints do not support boxes with attached volumes or Secrets (docs.boxlite.ai/cloud/checkpoints). Create a source box without those attachments.'
      );
      return;
    }

    const stoppedStatuses = ['stopped', 'terminated', 'exited', 'configured', 'paused', 'inactive', 'shutdown'];
    if (currentStatus && !stoppedStatuses.includes(currentStatus)) {
      const boxLabel = item?.box?.name || boxId.substring(0, 8);
      const stopConfirm = await vscode.window.showWarningMessage(
        `Box "${boxLabel}" is currently "${currentStatus}". A source box must be stopped before capturing a checkpoint. Stop it now and wait for "stopped"?`,
        { modal: true },
        'Stop Box & Capture',
        'Cancel'
      );
      if (stopConfirm !== 'Stop Box & Capture') {
        return;
      }

      let stoppedOk = false;
      try {
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Stopping Box ${boxLabel} before checkpoint capture...`
          },
          async () => {
            logManager?.stopStreaming?.(boxId);
            const stopRes = await bridge.stopBox(boxId);
            const finalStatus = (stopRes?.status || 'stopped').toLowerCase().trim();
            if (!stoppedStatuses.includes(finalStatus)) {
              throw new Error(`Box did not reach stopped state (current status: ${finalStatus}).`);
            }
            stoppedOk = true;
          }
        );
        treeProvider.refresh();
      } catch (e: any) {
        vscode.window.showErrorMessage(`Failed to stop Box before checkpoint: ${e.message}`);
        return;
      }

      if (!stoppedOk) {
        return;
      }
    }

    const name = await vscode.window.showInputBox({
      prompt: 'Enter name for the checkpoint (leave empty for auto-assigned)',
      placeHolder: 'e.g. dev-base, prepared-workspace',
      validateInput: (v) => {
        if (v && v.trim()) {
          const check = validateCheckpointName(v.trim());
          if (!check.valid) {
            return check.error;
          }
        }
        return null;
      }
    });
    if (name === undefined) {
      return;
    }

    let checkpoint: CheckpointItem | undefined;
    try {
      checkpoint = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Creating checkpoint${name.trim() ? ` "${name.trim()}"` : ''} from Box ${boxId.substring(0, 8)}...`
        },
        async () => {
          return await bridge.createCheckpoint({
            sourceBoxId: boxId,
            name: name.trim() ? name.trim() : undefined
          });
        }
      );
      checkpointsProvider?.refresh();
    } catch (e: any) {
      const diag = diagnoseError(e.message);
      const msg = e.message.includes('Diagnosis:') ? e.message : `${e.message}\nDiagnosis: ${diag.summary}`;
      vscode.window.showErrorMessage(`Failed to create checkpoint: ${msg}`);
      return;
    }

    if (checkpoint) {
      const state = (checkpoint.state || 'creating').toLowerCase().trim();
      if (state === 'ready') {
        const choice = await vscode.window.showInformationMessage(
          `Checkpoint "${checkpoint.name}" is ready (ID: ${checkpoint.id}).`,
          'Create Box from Checkpoint',
          'Copy ID'
        );
        if (choice === 'Create Box from Checkpoint') {
          await vscode.commands.executeCommand('boxlite.createBoxFromCheckpoint', checkpoint);
        } else if (choice === 'Copy ID') {
          await vscode.env.clipboard.writeText(checkpoint.id);
        }
      } else {
        const choice = await vscode.window.showInformationMessage(
          `Checkpoint "${checkpoint.name}" creation started (ID: ${checkpoint.id}, state: ${state}). Keep the source box stopped until it becomes ready.`,
          'Copy ID'
        );
        if (choice === 'Copy ID') {
          await vscode.env.clipboard.writeText(checkpoint.id);
        }
      }
    }
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('boxlite.createCheckpoint', async (item?: any) => {
      await handleCreateCheckpoint(item);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('boxlite.createCheckpointFromBox', async (item?: any) => {
      await handleCreateCheckpoint(item);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('boxlite.createBoxFromCheckpoint', async (item?: any) => {
      const chk = await resolveCheckpoint(item, bridge);
      if (!chk) {
        return;
      }

      const state = (chk.state || 'ready').toLowerCase().trim();
      if (state === 'failed' || state === 'error' || state === 'deleting' || state === 'pending_delete') {
        vscode.window.showErrorMessage(
          `Cannot restore a box from checkpoint "${chk.name}" while its state is "${state}".`
        );
        return;
      }

      if (state === 'creating' || state === 'pending_create') {
        const proceed = await vscode.window.showWarningMessage(
          `Checkpoint "${chk.name}" is still "${state}". Wait until it reaches "ready" before creating a box, or attempt anyway?`,
          'Attempt Anyway',
          'Cancel'
        );
        if (proceed !== 'Attempt Anyway') {
          return;
        }
      }

      const checkOpts = validateCheckpointBoxOptions(chk.id, false);
      if (!checkOpts.valid) {
        vscode.window.showErrorMessage(checkOpts.error || 'Invalid checkpoint restore options.');
        return;
      }

      const boxName = await vscode.window.showInputBox({
        prompt: `Enter optional name for the new Box restored from "${chk.name}" (saved config will be inherited)`,
        value: generateBoxName('worker'),
        placeHolder: 'Leave empty for auto-generated name'
      });
      if (boxName === undefined) {
        return;
      }

      const trimmedName = boxName.trim() ? boxName.trim() : undefined;
      let created: { boxId: string; name: string; status: string } | undefined;

      try {
        created = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Creating Box${trimmedName ? ` "${trimmedName}"` : ''} from checkpoint "${chk.name}"...`
          },
          async () => {
            // Only checkpoint and optional name are passed; saved settings are inherited
            const args: CreateBoxArgs = { checkpoint: chk.id };
            if (trimmedName) {
              args.name = trimmedName;
            }
            return await bridge.createBox(args);
          }
        );
        treeProvider.refresh();
      } catch (e: any) {
        const diag = diagnoseError(e.message);
        const msg = e.message.includes('Diagnosis:') ? e.message : `${e.message}\nDiagnosis: ${diag.summary}`;
        vscode.window.showErrorMessage(`Failed to create Box from checkpoint: ${msg}`);
        return;
      }

      if (created) {
        await vscode.window.showInformationMessage(
          `Box "${created.name || created.boxId}" created from checkpoint "${chk.name}" (ID: ${created.boxId}).`
        );
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('boxlite.forkFleetFromCheckpoint', async (item?: any) => {
      const chk = await resolveCheckpoint(item, bridge);
      if (!chk) {
        return;
      }

      const state = (chk.state || 'ready').toLowerCase().trim();
      if (state === 'failed' || state === 'error' || state === 'deleting' || state === 'pending_delete') {
        vscode.window.showErrorMessage(
          `Cannot fork worker fleet from checkpoint "${chk.name}" while its state is "${state}".`
        );
        return;
      }

      if (state === 'creating' || state === 'pending_create') {
        const proceed = await vscode.window.showWarningMessage(
          `Checkpoint "${chk.name}" is still "${state}". Wait until it reaches "ready" before forking workers, or attempt anyway?`,
          'Attempt Anyway',
          'Cancel'
        );
        if (proceed !== 'Attempt Anyway') {
          return;
        }
      }

      const countStr = await vscode.window.showInputBox({
        prompt: `How many independent worker Boxes should be forked from "${chk.name}"? (1-50)`,
        value: '3',
        validateInput: (v) => {
          const n = parseInt(v, 10);
          if (isNaN(n) || !/^\d+$/.test(v.trim()) || n < 1 || n > 50) {
            return 'Enter an integer between 1 and 50';
          }
          return null;
        }
      });
      if (!countStr) {
        return;
      }
      const count = parseInt(countStr.trim(), 10);

      const defaultPrefix = `${(chk.name || 'worker').replace(/[^A-Za-z0-9._-]/g, '-')}-worker`;
      const prefixInput = await vscode.window.showInputBox({
        prompt: 'Enter worker name prefix (workers will be named <prefix>-1, <prefix>-2, ...)',
        value: defaultPrefix
      });
      if (prefixInput === undefined) {
        return;
      }
      const prefix = prefixInput.trim() || 'worker';

      let succeeded = 0;
      const failures: string[] = [];

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Forking ${count} worker Box${count === 1 ? '' : 'es'} from "${chk.name}"...`
        },
        async () => {
          const tasks = Array.from({ length: count }, (_, idx) => {
            const workerName = `${prefix}-${idx + 1}`;
            return bridge.createBox({ checkpoint: chk.id, name: workerName });
          });
          const results = await Promise.allSettled(tasks);
          for (const res of results) {
            if (res.status === 'fulfilled') {
              succeeded++;
            } else {
              failures.push(res.reason?.message || String(res.reason));
            }
          }
        }
      );

      treeProvider.refresh();

      if (failures.length === 0) {
        await vscode.window.showInformationMessage(
          `Forked ${succeeded} worker Box${succeeded === 1 ? '' : 'es'} from checkpoint "${chk.name}".`
        );
      } else if (succeeded > 0) {
        await vscode.window.showWarningMessage(
          `Forked ${succeeded}/${count} worker Boxes from "${chk.name}". ${failures.length} failed: ${failures[0]}`
        );
      } else {
        await vscode.window.showErrorMessage(
          `Failed to fork worker Boxes from "${chk.name}": ${failures[0]}`
        );
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('boxlite.inspectCheckpoint', async (item?: any) => {
      const chk = await resolveCheckpoint(item, bridge);
      if (!chk) {
        return;
      }

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Inspecting checkpoint ${chk.id}...`
        },
        async () => {
          try {
            const inspected = await bridge.inspectCheckpoint(chk.id);
            const doc = await vscode.workspace.openTextDocument({
              content: JSON.stringify(inspected, null, 2),
              language: 'json'
            });
            await vscode.window.showTextDocument(doc, { preview: true });
          } catch (e: any) {
            vscode.window.showErrorMessage(`Failed to inspect checkpoint: ${e.message}`);
          }
        }
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('boxlite.copyCheckpointId', async (item?: any) => {
      const chk = await resolveCheckpoint(item, bridge);
      if (chk) {
        await vscode.env.clipboard.writeText(chk.id);
        vscode.window.showInformationMessage(`Checkpoint ID "${chk.id}" copied to clipboard.`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('boxlite.copyCheckpointName', async (item?: any) => {
      const chk = await resolveCheckpoint(item, bridge);
      if (chk) {
        await vscode.env.clipboard.writeText(chk.name);
        vscode.window.showInformationMessage(`Checkpoint name "${chk.name}" copied to clipboard.`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('boxlite.deleteCheckpoint', async (item?: any) => {
      const chk = await resolveCheckpoint(item, bridge);
      if (!chk) {
        return;
      }

      const confirm = await vscode.window.showWarningMessage(
        `Are you sure you want to delete checkpoint "${chk.name}" (${chk.id})?\nBoxes already created from it remain intact, but you will no longer be able to restore from this checkpoint.`,
        { modal: true },
        'Delete',
        'Delete (Force)',
        'Cancel'
      );

      if (confirm !== 'Delete' && confirm !== 'Delete (Force)') {
        return;
      }

      const force = confirm === 'Delete (Force)';
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Deleting checkpoint ${chk.name}...`
        },
        async () => {
          try {
            await bridge.removeCheckpoint(chk.id, force);
            checkpointsProvider?.refresh();
            vscode.window.showInformationMessage(`Checkpoint "${chk.name}" deleted successfully.`);
          } catch (e: any) {
            const diag = diagnoseError(e.message);
            const msg = e.message.includes('Diagnosis:') ? e.message : `${e.message}\nDiagnosis: ${diag.summary}`;
            vscode.window.showErrorMessage(`Failed to delete checkpoint: ${msg}`);
          }
        }
      );
    })
  );

  // ── Outbound Proxy Secrets ─────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand('boxlite.refreshSecrets', () => {
      secretsProvider?.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('boxlite.createSecret', async () => {
      if (!secretsManager) {
        vscode.window.showErrorMessage('Secrets manager is not initialized.');
        return;
      }
      const created = await promptSecretDetails(secretsManager);
      if (!created) {
        return;
      }
      await secretsManager.saveSecret(created);
      secretsProvider?.refresh();
      const placeholder = SecretsManager.getPlaceholder(created.name);
      const action = await vscode.window.showInformationMessage(
        `Proxy secret "${created.name}" saved in VS Code SecretStorage. Guest placeholder: ${placeholder}`,
        'Copy Placeholder',
        'Create Box with Secret'
      );
      if (action === 'Copy Placeholder') {
        await vscode.env.clipboard.writeText(placeholder);
      } else if (action === 'Create Box with Secret') {
        await vscode.commands.executeCommand('boxlite.createBoxWithSecret', created.name);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('boxlite.createBoxWithSecret', async (item?: SecretTreeItem | string) => {
      if (!(await credentials.getApiKey())) {
        vscode.window.showWarningMessage('Please sign in to BoxLite Cloud first.');
        return;
      }
      if (!secretsManager) {
        vscode.window.showErrorMessage('Secrets manager is not initialized.');
        return;
      }
      const secretConfig = await resolveSecret(item, secretsManager);
      if (!secretConfig) {
        return;
      }

      let stored = await secretsManager.getSecret(secretConfig.name);
      if (!stored) {
        const value = await vscode.window.showInputBox({
          prompt: `Enter the secret value for "${secretConfig.name}" (stored in VS Code SecretStorage, never in guest env)`,
          password: true,
          ignoreFocusOut: true,
          validateInput: (val) => (!val || !val.trim() ? 'Secret value is required' : undefined)
        });
        if (!value) {
          return;
        }
        stored = {
          name: secretConfig.name,
          hosts: secretConfig.hosts,
          headers: secretConfig.headers,
          value
        };
        await secretsManager.saveSecret(stored);
        secretsProvider?.refresh();
      }

      const name = await vscode.window.showInputBox({
        prompt: 'Box name (optional)',
        placeHolder: `${secretConfig.name}-box`,
        ignoreFocusOut: true
      });
      if (name === undefined) {
        return;
      }

      const imagePick = await vscode.window.showQuickPick(
        [
          { label: 'python:alpine', description: 'Lightweight Python 3 image (recommended for SDK/HTTP clients)' },
          { label: 'node:22-alpine', description: 'Lightweight Node.js 22 image' },
          { label: 'ubuntu:24.04', description: 'Full Ubuntu base image' },
          { label: '$(edit) Custom image...', description: 'Enter any catalog or registry image' }
        ],
        { placeHolder: 'Select image for the Box' }
      );
      if (!imagePick) {
        return;
      }

      let image = imagePick.label;
      if (imagePick.label.startsWith('$(edit)')) {
        const custom = await vscode.window.showInputBox({
          prompt: 'Enter Box image name',
          placeHolder: 'python:alpine',
          ignoreFocusOut: true,
          validateInput: (v) => (!v || !v.trim() ? 'Image is required' : undefined)
        });
        if (!custom) {
          return;
        }
        image = custom.trim();
      }

      const placeholder = SecretsManager.getPlaceholder(stored.name);
      const envVar = await vscode.window.showInputBox({
        prompt: `Optional env var inside Box set to ${placeholder} (leave blank to skip)`,
        placeHolder: 'OPENAI_API_KEY',
        ignoreFocusOut: true
      });
      if (envVar === undefined) {
        return;
      }

      const createArgs: CreateBoxArgs = {
        name: name.trim() || undefined,
        image,
        network: { outbound: { mode: 'enabled' } },
        secrets: [stored],
        env: envVar.trim() ? { [envVar.trim()]: placeholder } : undefined
      };

      try {
        const created = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Creating Box with proxy secret "${stored.name}"...`,
            cancellable: false
          },
          async () => bridge.createBox(createArgs)
        );
        treeProvider.refresh();
        secretsProvider?.refresh();
        const boxLabel = created.name || created.boxId;
        const action = await vscode.window.showInformationMessage(
          `Box "${boxLabel}" created with proxy secret "${stored.name}" (${stored.hosts.join(', ')}). Guest placeholder: ${placeholder}`,
          'Copy Placeholder',
          'Copy Snippet'
        );
        if (action === 'Copy Placeholder') {
          await vscode.env.clipboard.writeText(placeholder);
        } else if (action === 'Copy Snippet') {
          await vscode.commands.executeCommand('boxlite.copySecretSnippet', stored.name);
        }
      } catch (e: any) {
        const diag = diagnoseError(e.message);
        const msg = e.message.includes('Diagnosis:') ? e.message : `${e.message}\nDiagnosis: ${diag.summary}`;
        vscode.window.showErrorMessage(`Failed to create Box with secret: ${msg}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('boxlite.addSecretToProject', async (item?: SecretTreeItem | string) => {
      if (!secretsManager) {
        vscode.window.showErrorMessage('Secrets manager is not initialized.');
        return;
      }
      const secret = await resolveSecret(item, secretsManager);
      if (!secret) {
        return;
      }
      const folders = vscode.workspace.workspaceFolders;
      if (!folders || folders.length === 0) {
        vscode.window.showErrorMessage('Open a workspace folder first to add a secret to boxlite.json.');
        return;
      }

      const found = await ProjectManager.findProjectConfig();
      let targetUri = found?.fileUri;
      if (!targetUri) {
        const createConfig = await vscode.window.showInformationMessage(
          'No boxlite.json found in this workspace. Create one with this redacted secret config?',
          'Create boxlite.json'
        );
        if (createConfig !== 'Create boxlite.json') {
          return;
        }
        const configPath = path.join(folders[0].uri.fsPath, 'boxlite.json');
        fs.writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf-8');
        targetUri = vscode.Uri.file(configPath);
      }

      try {
        await ProjectManager.addSecretConfig(targetUri, SecretsManager.toConfigSpec(secret));
        secretsProvider?.refresh();
        vscode.window.showInformationMessage(
          `Added redacted proxy secret "${secret.name}" to boxlite.json (raw secret values are never written to disk).`
        );
      } catch (e: any) {
        vscode.window.showErrorMessage(`Failed to update boxlite.json: ${e.message}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('boxlite.rotateSecret', async (item?: SecretTreeItem | string) => {
      if (!secretsManager) {
        vscode.window.showErrorMessage('Secrets manager is not initialized.');
        return;
      }
      const secret = await resolveSecret(item, secretsManager);
      if (!secret) {
        return;
      }

      const newValue = await vscode.window.showInputBox({
        prompt: `Enter rotated secret value for "${secret.name}" (new boxes will inject the updated credential)`,
        password: true,
        ignoreFocusOut: true,
        validateInput: (val) => (!val || !val.trim() ? 'New secret value is required' : undefined)
      });
      if (!newValue) {
        return;
      }

      const updated: SecretSpec = {
        name: secret.name,
        hosts: secret.hosts,
        headers: secret.headers,
        value: newValue
      };
      await secretsManager.saveSecret(updated);
      secretsProvider?.refresh();

      const nextStep = await vscode.window.showQuickPick(
        [
          {
            label: '$(sync) Replace an existing Box with rotated secret',
            description: 'Secrets persist on a Box until replaced; create a new Box using the rotated credential',
            action: 'replace'
          },
          {
            label: '$(check) Done (saved in SecretStorage only)',
            description: 'Use the updated secret on the next Box creation or deploy',
            action: 'done'
          }
        ],
        {
          placeHolder: `Secret "${secret.name}" updated in SecretStorage. Existing Boxes keep their original proxy credential until replaced.`
        }
      );

      if (!nextStep || nextStep.action !== 'replace') {
        vscode.window.showInformationMessage(
          `Secret "${secret.name}" rotated in SecretStorage. Remember to replace existing Boxes and revoke the old key at the upstream provider.`
        );
        return;
      }

      if (!(await credentials.getApiKey())) {
        vscode.window.showWarningMessage('Please sign in to BoxLite Cloud first.');
        return;
      }
      const oldBoxId = await resolveBoxId(undefined, bridge);
      if (!oldBoxId) {
        return;
      }

      try {
        let oldBoxLabel = oldBoxId;
        const replacement = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Creating replacement Box for "${oldBoxId}"...`,
            cancellable: false
          },
          async () => {
            const inspected = await bridge.inspectBox(oldBoxId);
            oldBoxLabel = inspected.name || oldBoxId;
            const existingSecrets: SecretConfigSpec[] = Array.isArray(inspected.secrets) ? inspected.secrets : [];
            const otherSpecs = existingSecrets.filter((s: SecretConfigSpec) => s.name !== updated.name);
            const resolvedOthers = await secretsManager.resolveSecrets(otherSpecs);
            const mergedSecrets = [updated, ...resolvedOthers.resolved];
            const replacementName = inspected.name ? `${inspected.name}-rotated` : undefined;
            return bridge.createBox({
              name: replacementName,
              image: inspected.image || 'python:alpine',
              cpus: inspected.cpus,
              memoryMib: inspected.memoryMib ?? inspected.memory_mib,
              diskSizeGb: inspected.diskSizeGb ?? inspected.disk_size_gb,
              autoStop: inspected.autoStop ?? inspected.auto_stop,
              autoDelete: inspected.autoDelete ?? inspected.auto_delete,
              network: inspected.network || { outbound: { mode: 'enabled' } },
              secrets: mergedSecrets
            });
          }
        );

        treeProvider.refresh();
        secretsProvider?.refresh();
        const choice = await vscode.window.showInformationMessage(
          `Replacement Box "${replacement.name || replacement.boxId}" created with rotated secret "${updated.name}". Remove old Box "${oldBoxLabel}" and revoke the old key at your provider once traffic has moved.`,
          'Remove Old Box'
        );
        if (choice === 'Remove Old Box') {
          await bridge.removeBox(oldBoxId);
          treeProvider.refresh();
          secretsProvider?.refresh();
          vscode.window.showInformationMessage(`Removed old Box "${oldBoxLabel}".`);
        }
      } catch (e: any) {
        const diag = diagnoseError(e.message);
        const msg = e.message.includes('Diagnosis:') ? e.message : `${e.message}\nDiagnosis: ${diag.summary}`;
        vscode.window.showErrorMessage(`Failed to create replacement Box: ${msg}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('boxlite.copySecretPlaceholder', async (item?: SecretTreeItem | string) => {
      const secret = await resolveSecret(item, secretsManager);
      if (!secret) {
        return;
      }
      const placeholder = SecretsManager.getPlaceholder(secret.name);
      await vscode.env.clipboard.writeText(placeholder);
      vscode.window.showInformationMessage(`Copied placeholder "${placeholder}" to clipboard.`);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('boxlite.copySecretHeader', async (item?: SecretTreeItem | string) => {
      const secret = await resolveSecret(item, secretsManager);
      if (!secret) {
        return;
      }
      const headerExample = SecretsManager.getGuestHeaderExample(secret);
      await vscode.env.clipboard.writeText(headerExample);
      vscode.window.showInformationMessage(`Copied guest header "${headerExample}" to clipboard.`);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('boxlite.copySecretSnippet', async (item?: SecretTreeItem | string) => {
      const secret = await resolveSecret(item, secretsManager);
      if (!secret) {
        return;
      }
      const snippets = buildSecretSnippets(secret);
      const picked = await vscode.window.showQuickPick(
        snippets.map((s) => ({
          label: s.label,
          description: s.description,
          code: s.code
        })),
        { placeHolder: `Select snippet for secret "${secret.name}"` }
      );
      if (!picked) {
        return;
      }
      await vscode.env.clipboard.writeText(picked.code);
      vscode.window.showInformationMessage(`Copied ${picked.label} snippet to clipboard.`);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('boxlite.verifySecretInjection', async () => {
      if (!(await credentials.getApiKey())) {
        vscode.window.showWarningMessage('Please sign in to BoxLite Cloud first.');
        return;
      }
      const image = await vscode.window.showInputBox({
        prompt: 'Image to run the fake-token httpbingo.org diagnostic inside (always cleans up temporary Box)',
        value: 'python:alpine',
        ignoreFocusOut: true
      });
      if (image === undefined) {
        return;
      }

      try {
        const result = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: 'Verifying BoxLite Secret Proxy Injection (fake token via httpbingo.org)...',
            cancellable: false
          },
          async () => bridge.verifySecretInjection({ image: image.trim() || 'python:alpine' })
        );
        treeProvider.refresh();
        secretsProvider?.refresh();

        if (result.headerInjectionPassed && result.envCheckPassed) {
          vscode.window.showInformationMessage(
            `Secret injection verified (${result.summary}) — cleanedUp=${result.cleanedUp}`
          );
        } else {
          vscode.window.showWarningMessage(
            `Secret injection check reported issues (headerInjectionPassed=${result.headerInjectionPassed}, envCheckPassed=${result.envCheckPassed}): ${result.summary}`
          );
        }
      } catch (e: any) {
        const diag = diagnoseError(e.message);
        const msg = e.message.includes('Diagnosis:') ? e.message : `${e.message}\nDiagnosis: ${diag.summary}`;
        vscode.window.showErrorMessage(`Failed to verify secret injection: ${msg}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('boxlite.deleteSecret', async (item?: SecretTreeItem | string) => {
      if (!secretsManager) {
        vscode.window.showErrorMessage('Secrets manager is not initialized.');
        return;
      }
      const secret = await resolveSecret(item, secretsManager);
      if (!secret) {
        return;
      }
      const confirm = await vscode.window.showWarningMessage(
        `Delete secret "${secret.name}" from VS Code SecretStorage? Existing Boxes will keep their proxy config until removed or replaced.`,
        { modal: true },
        'Delete'
      );
      if (confirm !== 'Delete') {
        return;
      }
      const removed = await secretsManager.removeSecret(secret.name);
      secretsProvider?.refresh();
      if (removed) {
        vscode.window.showInformationMessage(`Secret "${secret.name}" deleted from VS Code SecretStorage.`);
      } else {
        vscode.window.showInformationMessage(
          `Secret "${secret.name}" was not stored in VS Code SecretStorage (it may be defined in boxlite.json or on a Box).`
        );
      }
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

async function resolveVolume(
  item?: any,
  bridge?: BoxLiteBridgeClient
): Promise<{ id: string; name: string } | undefined> {
  if (item instanceof VolumeTreeItem) {
    return { id: item.volume.id, name: item.volume.name || item.volume.id };
  }
  if (item && item.volume) {
    return { id: item.volume.id, name: item.volume.name || item.volume.id };
  }
  if (item && item.volumeId) {
    return { id: item.volumeId, name: item.label || item.volumeId };
  }
  if (typeof item === 'string' && item.trim().length > 0) {
    return { id: item.trim(), name: item.trim() };
  }
  if (!bridge) {
    return undefined;
  }
  try {
    const volumes = await bridge.listVolumes();
    if (volumes.length === 0) {
      const create = await vscode.window.showInformationMessage(
        'No managed persistent volumes found. Would you like to create one?',
        'Create Volume'
      );
      if (create === 'Create Volume') {
        await vscode.commands.executeCommand('boxlite.createVolume');
      }
      return undefined;
    }
    const picked = await vscode.window.showQuickPick(
      volumes.map((v) => ({
        label: v.name || v.id,
        description: `${v.state || 'ready'} · ${v.id}`,
        id: v.id,
        name: v.name || v.id
      })),
      { placeHolder: 'Select a Managed Volume' }
    );
    if (picked) {
      return { id: picked.id, name: picked.name };
    }
  } catch (e: any) {
    vscode.window.showErrorMessage(`Failed to list volumes: ${e.message}`);
  }
  return undefined;
}

async function resolveImageName(item?: any, bridge?: BoxLiteBridgeClient): Promise<string | undefined> {
  if (typeof item === 'string' && item.trim().length > 0) {
    return item.trim();
  }
  if (item instanceof ImageTreeItem) {
    return item.image.name;
  }
  if (item && item.image && item.image.name) {
    return item.image.name;
  }
  if (item && item.imageName) {
    return item.imageName;
  }
  if (item && item.label && typeof item.label === 'string') {
    return item.label;
  }

  const choices: { label: string; description?: string }[] = [
    { label: 'python', description: 'BoxLite Built-in (Python 3, ready to run)' },
    { label: 'node', description: 'BoxLite Built-in (Node.js, ready to run)' },
    { label: 'base', description: 'BoxLite Built-in (General-purpose Linux)' },
    { label: 'sandbaseai-hermes', description: 'BoxLite Built-in (Hermes agent preinstalled)' }
  ];

  if (bridge) {
    try {
      const res = await bridge.listImages();
      for (const img of res.images || []) {
        if (!img?.name || typeof img.name !== 'string') {
          continue;
        }
        if (!choices.some((c) => c.label.toLowerCase() === img.name.toLowerCase())) {
          choices.push({
            label: img.name,
            description: 'Catalog Image'
          });
        }
      }
    } catch {
      // Ignore
    }
  }

  const picked = await vscode.window.showQuickPick(choices, {
    placeHolder: 'Select an Image'
  });
  return picked?.label;
}

async function resolveCheckpoint(
  item?: any,
  bridge?: BoxLiteBridgeClient
): Promise<CheckpointItem | undefined> {
  if (item instanceof CheckpointTreeItem) {
    return item.checkpoint;
  }
  if (item && item.checkpoint) {
    return item.checkpoint;
  }
  if (item && item.checkpointKey) {
    return {
      id: item.checkpointKey,
      name: item.label || item.checkpointKey,
      sourceBoxId: '',
      state: 'ready'
    };
  }
  if (item && item.id && item.sourceBoxId !== undefined) {
    return item as CheckpointItem;
  }
  if (typeof item === 'string' && item.trim().length > 0) {
    return {
      id: item.trim(),
      name: item.trim(),
      sourceBoxId: '',
      state: 'ready'
    };
  }
  if (!bridge) {
    return undefined;
  }
  try {
    const checkpoints = await bridge.listCheckpoints();
    if (checkpoints.length === 0) {
      const create = await vscode.window.showInformationMessage(
        'No checkpoints found. Would you like to create one from a Box?',
        'Create Checkpoint'
      );
      if (create === 'Create Checkpoint') {
        await vscode.commands.executeCommand('boxlite.createCheckpoint');
      }
      return undefined;
    }
    const picked = await vscode.window.showQuickPick(
      checkpoints.map((c) => ({
        label: c.name || c.id,
        description: `${c.state || 'ready'} · ${c.id}`,
        checkpoint: c
      })),
      { placeHolder: 'Select a Checkpoint' }
    );
    return picked?.checkpoint;
  } catch (e: any) {
    vscode.window.showErrorMessage(`Failed to list checkpoints: ${e.message}`);
    return undefined;
  }
}

async function promptSecretDetails(secretsManager: SecretsManager): Promise<SecretSpec | undefined> {
  const name = await vscode.window.showInputBox({
    prompt: 'Secret name (letters, numbers, underscores, hyphens; placeholder will be <BOXLITE_SECRET:name>)',
    placeHolder: 'openai',
    ignoreFocusOut: true,
    validateInput: (val) => {
      const res = validateSecretName(val);
      return res.valid ? undefined : res.error;
    }
  });
  if (!name) {
    return undefined;
  }

  const normalizedName = name.trim();
  const existing = await secretsManager.getSecret(normalizedName);
  if (existing) {
    const overwrite = await vscode.window.showWarningMessage(
      `Secret "${normalizedName}" already exists in SecretStorage. Overwrite it?`,
      { modal: true },
      'Overwrite'
    );
    if (overwrite !== 'Overwrite') {
      return undefined;
    }
  }

  const hostsInput = await vscode.window.showInputBox({
    prompt: 'Allowed target hostnames (comma-separated, e.g. api.openai.com, *.openai.com — no https:// or paths)',
    placeHolder: 'api.openai.com',
    ignoreFocusOut: true,
    validateInput: (val) => {
      const hosts = val
        .split(',')
        .map((h) => h.trim())
        .filter(Boolean);
      const res = validateSecretHosts(hosts);
      return res.valid ? undefined : res.error;
    }
  });
  if (!hostsInput) {
    return undefined;
  }
  const hosts = hostsInput
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);

  const headerPreset = await vscode.window.showQuickPick(
    [
      { label: 'Authorization: Bearer {value}', headerName: 'Authorization', headerValue: 'Bearer {value}' },
      { label: 'x-api-key: {value}', headerName: 'x-api-key', headerValue: '{value}' },
      { label: 'X-Api-Key: {value}', headerName: 'X-Api-Key', headerValue: '{value}' },
      { label: '$(edit) Custom header...', headerName: '', headerValue: '' }
    ],
    { placeHolder: 'Select outbound header substitution rule ({value} is replaced with real secret at proxy)' }
  );
  if (!headerPreset) {
    return undefined;
  }

  let headers: Record<string, string>;
  if (!headerPreset.headerName) {
    const headerName = await vscode.window.showInputBox({
      prompt: 'Target HTTP header name',
      placeHolder: 'Authorization',
      ignoreFocusOut: true,
      validateInput: (val) => (!val || !val.trim() ? 'Header name is required' : undefined)
    });
    if (!headerName) {
      return undefined;
    }
    const headerTemplate = await vscode.window.showInputBox({
      prompt: 'Header template (must include {value})',
      value: 'Bearer {value}',
      ignoreFocusOut: true,
      validateInput: (val) => {
        const res = validateSecretHeaders({ [headerName.trim()]: val });
        return res.valid ? undefined : res.error;
      }
    });
    if (!headerTemplate) {
      return undefined;
    }
    headers = { [headerName.trim()]: headerTemplate.trim() };
  } else {
    headers = { [headerPreset.headerName]: headerPreset.headerValue };
  }

  const headersErr = validateSecretHeaders(headers);
  if (!headersErr.valid) {
    vscode.window.showErrorMessage(headersErr.error || 'Invalid secret header mapping.');
    return undefined;
  }

  const value = await vscode.window.showInputBox({
    prompt: `Secret value for "${normalizedName}" (stored in VS Code SecretStorage, never in boxlite.json or guest env)`,
    password: true,
    ignoreFocusOut: true,
    validateInput: (val) => (!val || !val.trim() ? 'Secret value is required' : undefined)
  });
  if (!value) {
    return undefined;
  }

  return {
    name: normalizedName,
    hosts,
    headers,
    value
  };
}

async function resolveSecret(
  item?: SecretTreeItem | string,
  secretsManager?: SecretsManager
): Promise<SecretConfigSpec | undefined> {
  if (item && typeof item === 'object' && 'secret' in item) {
    return item.secret;
  }
  if (!secretsManager) {
    vscode.window.showErrorMessage('Secrets manager is not initialized.');
    return undefined;
  }
  if (typeof item === 'string' && item.trim()) {
    const found = await secretsManager.getSecret(item.trim());
    if (found) {
      return SecretsManager.toConfigSpec(found);
    }
  }
  const stored = await secretsManager.listSecrets();
  if (stored.length === 0) {
    const create = await vscode.window.showInformationMessage(
      'No proxy secrets stored yet. Create one first?',
      'Create Secret'
    );
    if (create === 'Create Secret') {
      await vscode.commands.executeCommand('boxlite.createSecret');
    }
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(
    stored.map((s) => ({
      label: s.name,
      description: `${s.hosts.join(', ')} · ${SecretsManager.getPlaceholder(s.name)}`,
      secret: SecretsManager.toConfigSpec(s)
    })),
    { placeHolder: 'Select an outbound proxy secret' }
  );
  return picked?.secret;
}

function buildSecretSnippets(secret: SecretConfigSpec): Array<{ label: string; description: string; code: string }> {
  const placeholder = SecretsManager.getPlaceholder(secret.name);
  const headerEntries = Object.entries(secret.headers);
  const firstHeader = headerEntries[0] || ['Authorization', 'Bearer {value}'];
  const guestHeader = SecretsManager.getGuestHeaderExample(secret);
  const primaryHost = secret.hosts[0] || 'api.example.com';
  const hostsLiteral = JSON.stringify(secret.hosts);
  const headersLiteral = JSON.stringify(secret.headers);
  const envName = `${secret.name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`;

  return [
    {
      label: 'Python SDK (BoxOptions + Secret)',
      description: 'Create a Box with outbound proxy secret injection',
      code: [
        'import os',
        'from boxlite import BoxOptions, Boxlite, BoxliteRestOptions, NetworkSpec, Secret',
        '',
        'rt = Boxlite.rest(BoxliteRestOptions.from_env())',
        'box = rt.create(BoxOptions(',
        '    image="python:alpine",',
        '    network=NetworkSpec(mode="enabled"),',
        `    env={"${envName}": "${placeholder}"},`,
        '    secrets=[Secret(',
        `        name="${secret.name}",`,
        `        value=os.environ["${envName}"],`,
        `        hosts=${hostsLiteral},`,
        `        headers=${headersLiteral},`,
        '    )],',
        '))'
      ].join('\n')
    },
    {
      label: 'TypeScript SDK (@boxlite-ai/boxlite)',
      description: 'Create a Box with outbound proxy secret injection in JS/TS',
      code: [
        'const box = await rt.create({',
        '  image: "node:22-alpine",',
        '  network: { mode: "enabled" },',
        `  env: { ${envName}: "${placeholder}" },`,
        '  secrets: [{',
        `    name: "${secret.name}",`,
        `    value: process.env.${envName}!,`,
        `    hosts: ${hostsLiteral},`,
        `    headers: ${headersLiteral},`,
        '  }],',
        '});'
      ].join('\n')
    },
    {
      label: 'Guest Python (urllib + CA cert)',
      description: 'Send placeholder header from inside the Box using system CA bundle',
      code: [
        'import os, ssl, urllib.request',
        '',
        'ctx = ssl.create_default_context(cafile="/etc/ssl/certs/ca-certificates.crt")',
        `token = os.environ.get("${envName}", "${placeholder}")`,
        `req = urllib.request.Request("https://${primaryHost}/", headers={"${firstHeader[0]}": ${
          firstHeader[1].includes('Bearer') ? 'f"Bearer {token}"' : 'token'
        }})`,
        'with urllib.request.urlopen(req, context=ctx) as resp:',
        '    print(resp.read().decode())'
      ].join('\n')
    },
    {
      label: 'Guest Node.js (fetch)',
      description: 'Send placeholder header from Node.js inside the Box',
      code: [
        `const res = await fetch("https://${primaryHost}/", {`,
        `  headers: { "${firstHeader[0]}": "${firstHeader[1].replace('{value}', placeholder)}" }`,
        '});',
        'console.log(await res.text());'
      ].join('\n')
    },
    {
      label: 'Guest curl',
      description: 'Send placeholder header with curl inside the Box',
      code: `curl -sS -H "${guestHeader}" https://${primaryHost}/`
    }
  ];
}
