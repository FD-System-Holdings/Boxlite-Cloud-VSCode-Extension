import * as vscode from 'vscode';
import { CredentialsManager } from './auth/credentials';
import { SecretsManager } from './auth/secretsStore';
import { PythonEnvManager } from './bridge/env';
import { BoxLiteBridgeClient } from './bridge/client';
import { BoxesTreeDataProvider } from './tree/boxesProvider';
import { VolumesTreeDataProvider } from './tree/volumesProvider';
import { ImagesTreeDataProvider } from './tree/imagesProvider';
import { CheckpointsTreeDataProvider } from './tree/checkpointsProvider';
import { SecretsTreeDataProvider } from './tree/secretsProvider';
import { AccountTreeDataProvider } from './tree/accountProvider';
import { BoxLiteDeployer } from './deploy/deployer';
import { LogStreamManager } from './logs/logStream';
import { registerCommands } from './commands';

let statusBarItem: vscode.StatusBarItem;
let startupTimer: NodeJS.Timeout | undefined;

export interface SafeLazyOutputChannel extends vscode.OutputChannel {
  flush(): void;
}

/**
 * Defers OutputChannel creation until startup settles or show() is called,
 * preventing early @vscode/spdlog initialization races while safeguarding closed channels.
 */
export function createSafeLazyOutputChannel(name: string): SafeLazyOutputChannel {
  let channel: vscode.OutputChannel | undefined;
  let disposed = false;
  let flushed = false;
  const bufferedOps: Array<{ kind: 'append' | 'appendLine' | 'replace'; value: string }> = [];

  const ensureCreated = (): vscode.OutputChannel | undefined => {
    if (disposed) {
      return undefined;
    }
    if (!channel) {
      try {
        channel = vscode.window.createOutputChannel(name);
      } catch {
        return undefined;
      }
    }
    return channel;
  };

  const replayOp = (target: vscode.OutputChannel, op: { kind: 'append' | 'appendLine' | 'replace'; value: string }) => {
    try {
      target[op.kind](op.value);
    } catch {
      // Ignore closed channel errors
    }
  };

  const flush = (): void => {
    flushed = true;
    if (disposed) {
      bufferedOps.length = 0;
      return;
    }
    const target = ensureCreated();
    if (!target || bufferedOps.length === 0) {
      return;
    }
    const pending = bufferedOps.splice(0, bufferedOps.length);
    for (const op of pending) {
      replayOp(target, op);
    }
  };

  const pushOrWrite = (kind: 'append' | 'appendLine' | 'replace', value: string): void => {
    if (disposed) {
      return;
    }
    if (!flushed) {
      if (kind === 'replace') {
        bufferedOps.length = 0;
      }
      bufferedOps.push({ kind, value });
      return;
    }
    flush();
    const target = ensureCreated();
    if (target) {
      replayOp(target, { kind, value });
    }
  };

  const safeShow: SafeLazyOutputChannel['show'] = (
    columnOrPreserveFocus?: vscode.ViewColumn | boolean,
    preserveFocus?: boolean
  ): void => {
    if (disposed) {
      return;
    }
    flush();
    const target = ensureCreated();
    if (!target) {
      return;
    }
    try {
      if (typeof columnOrPreserveFocus === 'number') {
        target.show(columnOrPreserveFocus, preserveFocus);
      } else {
        target.show(columnOrPreserveFocus);
      }
    } catch {
      // Ignore closed channel errors
    }
  };

  return {
    name,
    flush,
    append(value: string): void {
      pushOrWrite('append', value);
    },
    appendLine(value: string): void {
      pushOrWrite('appendLine', value);
    },
    replace(value: string): void {
      pushOrWrite('replace', value);
    },
    clear(): void {
      bufferedOps.length = 0;
      if (disposed || !channel) {
        return;
      }
      try {
        channel.clear();
      } catch {
        // Ignore closed channel errors
      }
    },
    show: safeShow,
    hide(): void {
      if (disposed || !channel) {
        return;
      }
      try {
        channel.hide();
      } catch {
        // Ignore closed channel errors
      }
    },
    dispose(): void {
      disposed = true;
      bufferedOps.length = 0;
      if (channel) {
        try {
          channel.dispose();
        } catch {
          // Ignore closed channel errors
        }
        channel = undefined;
      }
    }
  };
}

export async function activate(context: vscode.ExtensionContext) {
  let extensionDisposed = false;
  const outputChannel = createSafeLazyOutputChannel('BoxLite Cloud');
  context.subscriptions.push(outputChannel);
  context.subscriptions.push({
    dispose: () => {
      extensionDisposed = true;
      if (startupTimer) {
        clearTimeout(startupTimer);
        startupTimer = undefined;
      }
    }
  });

  outputChannel.appendLine('[boxlite] Initializing BoxLite VS Code Extension (rc-boxlite-vscode)...');

  const credentials = new CredentialsManager(context);
  const secretsManager = new SecretsManager(context);
  const envManager = new PythonEnvManager(context, outputChannel);
  const bridge = new BoxLiteBridgeClient(context, credentials, envManager, outputChannel);
  context.subscriptions.push(bridge);

  const logManager = new LogStreamManager(bridge);
  context.subscriptions.push(logManager);

  const accountProvider = new AccountTreeDataProvider(credentials);
  const treeProvider = new BoxesTreeDataProvider(bridge, credentials, logManager);
  const imagesProvider = new ImagesTreeDataProvider(bridge, credentials);
  const volumesProvider = new VolumesTreeDataProvider(bridge, credentials);
  const checkpointsProvider = new CheckpointsTreeDataProvider(bridge, credentials);
  const secretsProvider = new SecretsTreeDataProvider(bridge, credentials, secretsManager);

  const allProviders = [
    accountProvider,
    secretsProvider,
    treeProvider,
    imagesProvider,
    volumesProvider,
    checkpointsProvider
  ];
  for (const provider of allProviders) {
    provider.setStartupReady(false);
  }

  const accountTreeView = vscode.window.createTreeView('boxlite.accountView', {
    treeDataProvider: accountProvider
  });
  context.subscriptions.push(accountTreeView);

  const treeView = vscode.window.createTreeView('boxlite.boxesView', {
    treeDataProvider: treeProvider,
    showCollapseAll: true
  });
  context.subscriptions.push(treeView);

  const imagesTreeView = vscode.window.createTreeView('boxlite.imagesView', {
    treeDataProvider: imagesProvider,
    showCollapseAll: true
  });
  context.subscriptions.push(imagesTreeView);

  const volumesTreeView = vscode.window.createTreeView('boxlite.volumesView', {
    treeDataProvider: volumesProvider,
    showCollapseAll: true
  });
  context.subscriptions.push(volumesTreeView);

  const checkpointsTreeView = vscode.window.createTreeView('boxlite.checkpointsView', {
    treeDataProvider: checkpointsProvider,
    showCollapseAll: true
  });
  context.subscriptions.push(checkpointsTreeView);

  const secretsTreeView = vscode.window.createTreeView('boxlite.secretsView', {
    treeDataProvider: secretsProvider,
    showCollapseAll: true
  });
  context.subscriptions.push(secretsTreeView);

  const deployer = new BoxLiteDeployer(
    bridge,
    credentials,
    logManager,
    outputChannel,
    () => {
      accountProvider.refresh();
      treeProvider.refresh();
      volumesProvider.refresh();
      imagesProvider.refresh();
      checkpointsProvider.refresh();
      secretsProvider.refresh();
    },
    secretsManager
  );

  // Register all commands
  registerCommands(
    context,
    bridge,
    credentials,
    envManager,
    treeProvider,
    deployer,
    logManager,
    volumesProvider,
    imagesProvider,
    accountProvider,
    checkpointsProvider,
    secretsProvider,
    secretsManager
  );

  // Configuration change listener
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration('boxlite.defaultImage') ||
        e.affectsConfiguration('boxlite.customImages')
      ) {
        imagesProvider.refresh();
      }
    })
  );

  // Status Bar Item
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
  statusBarItem.command = 'boxlite.deploy';
  statusBarItem.text = '$(cloud-upload) BoxLite';
  statusBarItem.tooltip = 'Click to deploy application to BoxLite Cloud';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  outputChannel.appendLine('[boxlite] BoxLite extension activated successfully.');

  // Defer SecretStorage warm-up and initial sidebar population until Extension Host startup settles
  const startupDelayMs = process.uptime() < 15 ? 1000 : 150;
  startupTimer = setTimeout(async () => {
    startupTimer = undefined;
    if (extensionDisposed) {
      return;
    }

    outputChannel.flush();

    try {
      const [apiKey] = await Promise.all([
        credentials.getApiKey().catch(() => undefined),
        secretsManager.listSecrets().catch(() => [])
      ]);
      if (extensionDisposed) {
        return;
      }
      if (!apiKey) {
        outputChannel.appendLine('[boxlite] No BOXLITE_API_KEY found. Prompting sign in on first use.');
      } else {
        outputChannel.appendLine(`[boxlite] Authenticated with API key: ${CredentialsManager.redactKey(apiKey)}`);
      }
    } catch {
      // Ignore transient startup credential warm-up errors
    }

    if (extensionDisposed) {
      return;
    }

    for (const provider of allProviders) {
      provider.setStartupReady(true);
    }

    accountProvider.refresh();
    secretsProvider.refresh();
    treeProvider.refresh();
    imagesProvider.refresh();
    volumesProvider.refresh();
    checkpointsProvider.refresh();
  }, startupDelayMs);
}

export function deactivate() {
  if (startupTimer) {
    clearTimeout(startupTimer);
    startupTimer = undefined;
  }
}
