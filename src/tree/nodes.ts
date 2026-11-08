import * as vscode from 'vscode';
import { BoxListItem, TunnelInfo } from '../bridge/protocol';

export abstract class BoxLiteTreeItem extends vscode.TreeItem {
  constructor(
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState = vscode.TreeItemCollapsibleState.None
  ) {
    super(label, collapsibleState);
  }
}

export class AccountTreeItem extends BoxLiteTreeItem {
  constructor(public readonly restUrl: string, public readonly apiKey?: string) {
    super(
      apiKey ? 'BoxLite Cloud Account' : 'BoxLite Cloud (Not Signed In)',
      vscode.TreeItemCollapsibleState.None
    );

    this.description = apiKey
      ? `Connected · ${restUrl.replace(/^https?:\/\//, '')}`
      : 'Click to Sign In';
    this.iconPath = new vscode.ThemeIcon(apiKey ? 'account' : 'sign-in');
    this.contextValue = apiKey ? 'account-signed-in' : 'account-signed-out';

    if (!apiKey) {
      this.command = {
        command: 'boxlite.setApiKey',
        title: 'Sign In / Set API Key'
      };
    }
  }
}

export class BoxTreeItem extends BoxLiteTreeItem {
  public readonly box: BoxListItem;
  public readonly tunnels: TunnelInfo[] = [];

  constructor(box: BoxListItem) {
    super(box.name || `box-${box.id.substring(0, 8)}`, vscode.TreeItemCollapsibleState.Collapsed);
    this.box = box;
    this.tunnels = box.tunnels || [];

    const isRunning = box.status === 'running';
    const isStopped = box.status === 'stopped';

    this.description = `${box.status} · ${box.id.substring(0, 8)}`;
    this.tooltip = `Box ID: ${box.id}\nName: ${box.name}\nStatus: ${box.status}\nImage: ${box.image || 'python'}`;

    if (isRunning) {
      this.iconPath = new vscode.ThemeIcon('play-circle', new vscode.ThemeColor('testing.iconPassed'));
    } else if (isStopped) {
      this.iconPath = new vscode.ThemeIcon('circle-outline', new vscode.ThemeColor('testing.iconQueued'));
    } else {
      this.iconPath = new vscode.ThemeIcon('sync~spin');
    }

    // Context value controls context menu actions
    const hasTunnels = this.tunnels.length > 0;
    const hasToken = this.tunnels.some((t) => !!t.token);
    this.contextValue = `box-${box.status}${isRunning ? '-isRunning' : ''}${isStopped ? '-isStopped' : ''}${hasTunnels ? '-canOpenUrl' : ''}${hasToken ? '-hasToken' : ''}`;
  }
}

export class BoxChildTreeItem extends BoxLiteTreeItem {
  constructor(
    label: string,
    description?: string,
    icon?: string,
    command?: vscode.Command,
    collapsible: vscode.TreeItemCollapsibleState = vscode.TreeItemCollapsibleState.None,
    contextValue?: string
  ) {
    super(label, collapsible);
    this.description = description;
    if (icon) {
      this.iconPath = new vscode.ThemeIcon(icon);
    }
    this.command = command;
    this.contextValue = contextValue;
  }
}
