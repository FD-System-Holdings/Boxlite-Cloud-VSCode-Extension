import * as vscode from 'vscode';
import { BoxListItem, TunnelInfo, VolumeItem, ImageItem, ImageUsage, CheckpointItem, SecretConfigSpec } from '../bridge/protocol';

export abstract class BoxLiteTreeItem extends vscode.TreeItem {
  constructor(
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState = vscode.TreeItemCollapsibleState.None
  ) {
    super(label, collapsibleState);
  }
}

export class AccountTreeItem extends BoxLiteTreeItem {
  constructor(
    public readonly restUrl: string,
    public readonly apiKey?: string,
    public readonly activeKeyName?: string
  ) {
    super(
      apiKey ? 'BoxLite Cloud Account' : 'BoxLite Cloud (Not Signed In)',
      apiKey ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None
    );

    const displayName = activeKeyName || (apiKey ? 'Connected' : 'Click to Sign In');
    this.description = apiKey
      ? `${displayName} · ${restUrl.replace(/^https?:\/\//, '')}`
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

export class ApiKeyTreeItem extends BoxLiteTreeItem {
  constructor(
    public readonly keyId: string,
    public readonly keyName: string,
    public readonly isActive: boolean,
    public readonly isEnv?: boolean
  ) {
    super(keyName, vscode.TreeItemCollapsibleState.None);

    this.description = isActive ? 'Active' : '';
    this.iconPath = new vscode.ThemeIcon(isActive ? 'check' : 'key');
    this.contextValue = isEnv ? 'apikey-env' : (isActive ? 'apikey-active' : 'apikey');
    this.tooltip = `API Key: ${keyName}${isActive ? ' (Active)' : ''}${isEnv ? ' (From environment)' : ''}\nClick to switch active API key.`;

    this.command = {
      command: 'boxlite.selectApiKey',
      title: 'Select API Key',
      arguments: [keyId]
    };
  }
}

export class LinkApiKeyActionTreeItem extends BoxLiteTreeItem {
  constructor() {
    super('Link new API key...', vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon('add');
    this.contextValue = 'account-link-key';
    this.command = {
      command: 'boxlite.setApiKey',
      title: 'Link API Key'
    };
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
    public readonly volumeId?: string,
    tooltip?: string
  ) {
    super(label, collapsible);
    this.description = description;
    this.tooltip = tooltip || description;
    if (icon) {
      this.iconPath = new vscode.ThemeIcon(icon);
    }
    this.command = command;
    this.contextValue = contextValue;
  }
}

export function formatBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) {
    return '0 B';
  }
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let val = bytes;
  let idx = 0;
  while (val >= 1024 && idx < units.length - 1) {
    val /= 1024;
    idx++;
  }
  return `${val.toFixed(1).replace(/\.0$/, '')} ${units[idx]}`;
}

export class ImageUsageTreeItem extends BoxLiteTreeItem {
  constructor(public readonly usage: ImageUsage) {
    const bytesFormatted = formatBytes(usage.knownBytes);
    super(`${usage.count} of ${usage.limit} images · ${bytesFormatted}`, vscode.TreeItemCollapsibleState.None);
    this.description = usage.count >= usage.limit ? 'Limit reached' : (usage.count >= usage.limit - 2 ? 'Near limit' : undefined);
    this.iconPath = new vscode.ThemeIcon(
      usage.count >= usage.limit ? 'warning' : 'layers',
      usage.count >= usage.limit ? new vscode.ThemeColor('testing.iconFailed') : undefined
    );
    this.tooltip = `BoxLite Cloud Organization Catalog Usage:\n${usage.count} of ${usage.limit} custom images recorded (${bytesFormatted}). Limit: ${usage.limit} per organization.\n\nBuilt-in images (base, python, node, sandbaseai-hermes) are free and do not count against this limit (agent.md & docs.boxlite.ai/cloud/image-catalog).`;
    this.contextValue = 'image-usage-item';
  }
}

export class ImageGroupTreeItem extends BoxLiteTreeItem {
  constructor(
    label: string,
    description?: string,
    icon: string = 'package',
    collapsible: vscode.TreeItemCollapsibleState = vscode.TreeItemCollapsibleState.Expanded
  ) {
    super(label, collapsible);
    this.description = description;
    this.iconPath = new vscode.ThemeIcon(icon);
    this.contextValue = 'image-group-item';
  }
}

export class ImageTreeItem extends BoxLiteTreeItem {
  public readonly image: ImageItem;

  constructor(image: ImageItem) {
    super(image.name, vscode.TreeItemCollapsibleState.Collapsed);
    this.image = image;

    const isBuiltin = !!image.builtin;
    const isDefault = !!image.isDefault;
    const isRecorded = image.recorded !== false;
    const boxCount = image.boxCount || (image.boxes ? image.boxes.length : 0);

    const parts: string[] = [];
    if (isDefault) {
      parts.push('★ default');
    }
    if (isBuiltin) {
      parts.push('free');
    } else if (!isRecorded) {
      parts.push('saved (not booted)');
    }

    if (boxCount > 0) {
      parts.push(`${boxCount} ${boxCount === 1 ? 'box' : 'boxes'}`);
    } else if (!isDefault && isRecorded) {
      parts.push('unused');
    }

    if (image.sizeBytes && image.sizeBytes > 0) {
      parts.push(formatBytes(image.sizeBytes));
    }

    this.description = parts.join(' · ');

    let tooltip = `Image: ${image.name}\nType: ${isBuiltin ? 'BoxLite Built-in (free · not counted)' : 'Catalog / Custom'}`;
    if (isDefault) {
      tooltip += '\nStatus: Default creation image (boxlite.defaultImage)';
    }
    if (boxCount > 0) {
      tooltip += `\nIn use by: ${boxCount} active box(es)`;
    }
    if (image.lastUsedAt) {
      tooltip += `\nLast used: ${image.lastUsedAt}`;
    }
    if (image.sizeBytes) {
      tooltip += `\nSize: ${formatBytes(image.sizeBytes)}`;
    }
    this.tooltip = tooltip;

    if (isDefault) {
      this.iconPath = new vscode.ThemeIcon('star-full', new vscode.ThemeColor('symbolIcon.fieldForeground'));
    } else if (isBuiltin) {
      this.iconPath = new vscode.ThemeIcon('symbol-package', new vscode.ThemeColor('symbolIcon.colorForeground'));
    } else if (!isRecorded) {
      this.iconPath = new vscode.ThemeIcon('cloud-download');
    } else {
      this.iconPath = new vscode.ThemeIcon('package');
    }

    this.contextValue = `image-item ${isBuiltin ? 'image-builtin' : 'image-custom'}${isDefault ? ' image-default' : ''}${isRecorded ? ' image-recorded' : ' image-unrecorded'}${boxCount > 0 ? ' image-in-use' : ''}`;
  }
}

export class ImageChildTreeItem extends BoxLiteTreeItem {
  constructor(
    label: string,
    description?: string,
    icon?: string,
    command?: vscode.Command,
    collapsible: vscode.TreeItemCollapsibleState = vscode.TreeItemCollapsibleState.None,
    contextValue?: string,
    public readonly imageName?: string,
    tooltip?: string
  ) {
    super(label, collapsible);
    this.description = description;
    this.tooltip = tooltip || description;
    if (icon) {
      this.iconPath = new vscode.ThemeIcon(icon);
    }
    this.command = command;
    this.contextValue = contextValue;
  }
}

export class CheckpointTreeItem extends BoxLiteTreeItem {
  public readonly checkpoint: CheckpointItem;

  constructor(checkpoint: CheckpointItem) {
    const shortId = checkpoint.id.length > 8 ? checkpoint.id.substring(0, 8) : checkpoint.id;
    super(checkpoint.name || `chk-${shortId}`, vscode.TreeItemCollapsibleState.Collapsed);
    this.checkpoint = checkpoint;

    const state = (checkpoint.state || 'ready').toLowerCase().trim();
    const isReady = state === 'ready';
    const isCreating = state === 'creating' || state === 'pending_create';
    const isDeleting = state === 'deleting' || state === 'pending_delete';
    const isFailed = state === 'failed' || state === 'error';

    const sizeSuffix = checkpoint.sizeBytes && checkpoint.sizeBytes > 0 ? ` · ${formatBytes(checkpoint.sizeBytes)}` : '';
    this.description = `${state} · ${shortId}${sizeSuffix}`;

    let tooltip = `Checkpoint ID: ${checkpoint.id}\nName: ${checkpoint.name || `chk-${shortId}`}\nState: ${state}\nSource Box: ${checkpoint.sourceBoxId || 'N/A'}`;
    if (checkpoint.sizeBytes && checkpoint.sizeBytes > 0) {
      tooltip += `\nSize: ${formatBytes(checkpoint.sizeBytes)}`;
    }
    if (checkpoint.createdAt) {
      tooltip += `\nCreated: ${checkpoint.createdAt}`;
    }
    if (checkpoint.errorReason) {
      tooltip += `\nError: ${checkpoint.errorReason}`;
    }
    this.tooltip = tooltip;

    if (isReady) {
      this.iconPath = new vscode.ThemeIcon('archive', new vscode.ThemeColor('symbolIcon.fieldForeground'));
    } else if (isCreating) {
      this.iconPath = new vscode.ThemeIcon('sync~spin');
    } else if (isDeleting) {
      this.iconPath = new vscode.ThemeIcon('trash');
    } else if (isFailed) {
      this.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('testing.iconFailed'));
    } else {
      this.iconPath = new vscode.ThemeIcon('archive');
    }

    this.contextValue = `checkpoint-item checkpoint-${state}${isReady ? '-ready' : ''}${isCreating ? '-creating' : ''}${isDeleting ? '-deleting' : ''}${isFailed ? '-failed' : ''}`;
  }
}

export class CheckpointChildTreeItem extends BoxLiteTreeItem {
  constructor(
    label: string,
    description?: string,
    icon?: string,
    command?: vscode.Command,
    collapsible: vscode.TreeItemCollapsibleState = vscode.TreeItemCollapsibleState.None,
    contextValue?: string,
    public readonly checkpointKey?: string,
    tooltip?: string
  ) {
    super(label, collapsible);
    this.description = description;
    this.tooltip = tooltip || description;
    if (icon) {
      this.iconPath = new vscode.ThemeIcon(icon);
    }
    this.command = command;
    this.contextValue = contextValue;
  }
}

export interface SecretTreeItemData extends SecretConfigSpec {
  hasValue?: boolean;
  usedByBoxes?: string[];
  source?: 'workstation' | 'project' | 'box' | 'merged';
}

export class SecretTreeItem extends BoxLiteTreeItem {
  public readonly secret: SecretTreeItemData;

  constructor(secret: SecretTreeItemData) {
    super(secret.name, vscode.TreeItemCollapsibleState.Collapsed);
    this.secret = secret;

    const placeholder = `<BOXLITE_SECRET:${secret.name}>`;
    const hostsStr = (secret.hosts || []).join(', ') || 'no hosts';
    const hasValue = secret.hasValue !== false;
    this.description = `${placeholder} · ${hostsStr}${hasValue ? '' : ' · (value not set)'}`;

    this.iconPath = new vscode.ThemeIcon(
      hasValue ? 'shield' : 'warning',
      hasValue
        ? new vscode.ThemeColor('symbolIcon.fieldForeground')
        : new vscode.ThemeColor('testing.iconQueued')
    );

    const headerMappings = Object.entries(secret.headers || {})
      .map(([k, v]) => `${k}: ${v}`)
      .join(', ');

    let tooltip = `Secret: ${secret.name}\nPlaceholder (inside box): ${placeholder}\nAllowed Hosts: ${hostsStr}\nHeader Template: ${headerMappings || 'Authorization: Bearer {value}'}`;
    if (secret.envVar) {
      tooltip += `\nGuest Env Variable: ${secret.envVar}=${placeholder}`;
    }
    if (secret.usedByBoxes && secret.usedByBoxes.length > 0) {
      tooltip += `\nAttached to Boxes: ${secret.usedByBoxes.join(', ')}`;
    }
    tooltip += '\nStatus: ' + (hasValue ? 'Credential stored securely in VS Code SecretStorage' : 'Missing local credential value (set before deploying)');
    tooltip += '\n\nSecurity boundary: Real value is supplied only via BoxOptions.secrets; outbound proxy injects it only on matching hosts with an existing target header.';
    this.tooltip = tooltip;

    this.contextValue = `secret-item ${hasValue ? 'secret-ready' : 'secret-missing-value'}`;
  }
}

export class SecretChildTreeItem extends BoxLiteTreeItem {
  constructor(
    label: string,
    description?: string,
    icon?: string,
    command?: vscode.Command,
    collapsible: vscode.TreeItemCollapsibleState = vscode.TreeItemCollapsibleState.None,
    contextValue?: string,
    public readonly secretName?: string,
    tooltip?: string
  ) {
    super(label, collapsible);
    this.description = description;
    this.tooltip = tooltip || description;
    if (icon) {
      this.iconPath = new vscode.ThemeIcon(icon);
    }
    this.command = command;
    this.contextValue = contextValue;
  }
}
