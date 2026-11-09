import * as vscode from 'vscode';
import { BoxListItem, TunnelInfo, VolumeItem } from '../bridge/protocol';

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
    // shortcut: account context menu targets signed-in accounts; add signed-out actions if offline configuration is needed
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

    const status = (box.status || '').toLowerCase().trim() || 'unknown';
    const isRunning = status === 'running' || status === 'ready' || status === 'active';
    const isStopped =
      status === 'stopped' ||
      status === 'terminated' ||
      status === 'exited' ||
      status === 'configured' ||
      status === 'paused' ||
      status === 'inactive' ||
      status === 'shutdown';
    const canStop = isRunning;
    const canStart = isStopped && !isRunning;

    this.description = `${status} · ${box.id.substring(0, 8)}`;
    this.tooltip = `Box ID: ${box.id}\nName: ${box.name}\nStatus: ${status}\nImage: ${box.image || 'python'}`;

    if (isRunning) {
      this.iconPath = new vscode.ThemeIcon('play-circle', new vscode.ThemeColor('testing.iconPassed'));
    } else if (isStopped) {
      this.iconPath = new vscode.ThemeIcon('circle-outline', new vscode.ThemeColor('testing.iconQueued'));
    } else {
      this.iconPath = new vscode.ThemeIcon('sync~spin');
    }

    // Context value controls context menu and inline actions
    const hasTunnels = this.tunnels.length > 0;
    const hasToken = this.tunnels.some((t) => !!t.token);
    this.contextValue = `box-${status}${canStop ? '-canStop' : ''}${canStart ? '-canStart' : ''}${isRunning ? '-isRunning' : ''}${isStopped ? '-isStopped' : ''}${hasTunnels ? '-canOpenUrl' : ''}${hasToken ? '-hasToken' : ''}`;
  }
}

export class BoxChildTreeItem extends BoxLiteTreeItem {
  constructor(
    label: string,
    description?: string,
    icon?: string,
    command?: vscode.Command,
    collapsible: vscode.TreeItemCollapsibleState = vscode.TreeItemCollapsibleState.None,
    contextValue?: string,
    public readonly boxId?: string
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

export class VolumeTreeItem extends BoxLiteTreeItem {
  public readonly volume: VolumeItem;

  constructor(volume: VolumeItem) {
    super(volume.name || `vol-${volume.id.substring(0, 8)}`, vscode.TreeItemCollapsibleState.Collapsed);
    this.volume = volume;

    const state = (volume.state || 'ready').toLowerCase().trim();
    const isReady = state === 'ready';
    const isDeleting = state === 'deleting' || state === 'pending_delete' || state === 'deleted';
    const isError = state === 'error';
    const isCreating = state === 'creating' || state === 'pending_create';

    const shortId = volume.id.length > 8 ? volume.id.substring(0, 8) : volume.id;
    this.description = `${state} · ${shortId}`;
    this.tooltip = `Volume ID: ${volume.id}\nName: ${volume.name}\nState: ${state}\nCreated: ${volume.createdAt || 'N/A'}`;

    if (isReady) {
      this.iconPath = new vscode.ThemeIcon('database', new vscode.ThemeColor('symbolIcon.fieldForeground'));
    } else if (isCreating) {
      this.iconPath = new vscode.ThemeIcon('sync~spin');
    } else if (isDeleting) {
      this.iconPath = new vscode.ThemeIcon('trash');
    } else if (isError) {
      this.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('testing.iconFailed'));
    } else {
      this.iconPath = new vscode.ThemeIcon('database');
    }

    this.contextValue = `volume-item volume-${state}${isReady ? '-ready' : ''}${isDeleting ? '-deleting' : ''}${isError ? '-error' : ''}`;
  }
}

export class VolumeChildTreeItem extends BoxLiteTreeItem {
  constructor(
    label: string,
    description?: string,
    icon?: string,
    command?: vscode.Command,
    collapsible: vscode.TreeItemCollapsibleState = vscode.TreeItemCollapsibleState.None,
    contextValue?: string,
    public readonly volumeId?: string
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
