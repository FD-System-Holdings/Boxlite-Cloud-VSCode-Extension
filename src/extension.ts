import * as vscode from 'vscode';
import { CredentialsManager } from './auth/credentials';
import { PythonEnvManager } from './bridge/env';
import { BoxLiteBridgeClient } from './bridge/client';
import { BoxesTreeDataProvider } from './tree/boxesProvider';
import { BoxLiteDeployer } from './deploy/deployer';
import { LogStreamManager } from './logs/logStream';
import { registerCommands } from './commands';

let statusBarItem: vscode.StatusBarItem;

export async function activate(context: vscode.ExtensionContext) {
  const outputChannel = vscode.window.createOutputChannel('BoxLite Cloud');
  context.subscriptions.push(outputChannel);

  outputChannel.appendLine('[boxlite] Initializing BoxLite VS Code Extension (rc-boxlite-vscode)...');

  const credentials = new CredentialsManager(context);
  const envManager = new PythonEnvManager(context, outputChannel);
  const bridge = new BoxLiteBridgeClient(context, credentials, envManager, outputChannel);
  context.subscriptions.push(bridge);

  const logManager = new LogStreamManager(bridge);
  context.subscriptions.push(logManager);

  const treeProvider = new BoxesTreeDataProvider(bridge, credentials, logManager);
  const treeView = vscode.window.createTreeView('boxlite.boxesView', {
    treeDataProvider: treeProvider,
    showCollapseAll: true
  });
  context.subscriptions.push(treeView);

  const deployer = new BoxLiteDeployer(
    bridge,
    credentials,
    logManager,
    outputChannel,
    () => treeProvider.refresh()
  );

  // Register all commands
  registerCommands(
    context,
    bridge,
    credentials,
    envManager,
    treeProvider,
    deployer,
    logManager
  );

  // Status Bar Item
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
  statusBarItem.command = 'boxlite.deploy';
  statusBarItem.text = '$(cloud-upload) BoxLite';
  statusBarItem.tooltip = 'Click to deploy application to BoxLite Cloud';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // Check if API key is present; if not, prompt or show info
  const apiKey = await credentials.getApiKey();
  if (!apiKey) {
    outputChannel.appendLine('[boxlite] No BOXLITE_API_KEY found. Prompting sign in on first use.');
  } else {
    outputChannel.appendLine(`[boxlite] Authenticated with API key: ${CredentialsManager.redactKey(apiKey)}`);
  }

  outputChannel.appendLine('[boxlite] BoxLite extension activated successfully.');
}

export function deactivate() {}
