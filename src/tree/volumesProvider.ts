import * as vscode from 'vscode';
import { BoxLiteBridgeClient } from '../bridge/client';
import { CredentialsManager } from '../auth/credentials';
import {
  BoxLiteTreeItem,
  AccountTreeItem,
  VolumeTreeItem,
  VolumeChildTreeItem
} from './nodes';

export class VolumesTreeDataProvider implements vscode.TreeDataProvider<BoxLiteTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<BoxLiteTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private cachedVolumes: VolumeTreeItem[] = [];

  constructor(
    private bridge: BoxLiteBridgeClient,
    private credentials: CredentialsManager
  ) {}

  public refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  public getTreeItem(element: BoxLiteTreeItem): vscode.TreeItem {
    return element;
  }

  public async getChildren(element?: BoxLiteTreeItem): Promise<BoxLiteTreeItem[]> {
    if (!element) {
      // Root level: Account node + Volume nodes
      const items: BoxLiteTreeItem[] = [];
      const apiKey = await this.credentials.getApiKey();
      const restUrl = this.credentials.getRestUrl();

      items.push(new AccountTreeItem(restUrl, apiKey));

      if (!apiKey) {
        return items;
      }

      try {
        const volumes = await this.bridge.listVolumes();
        if (volumes.length === 0) {
          items.push(
            new VolumeChildTreeItem(
              'No Managed Volumes',
              'Click to create a persistent volume',
              'add',
              { command: 'boxlite.createVolume', title: 'Add New Volume...' }
            )
          );
        } else {
          this.cachedVolumes = volumes.map((v) => new VolumeTreeItem(v));
          items.push(...this.cachedVolumes);

          // Auto-refresh if any volume is in a transient state
          const hasTransient = volumes.some((v) => {
            const s = (v.state || '').toLowerCase().trim();
            return s === 'creating' || s === 'pending_create' || s === 'deleting' || s === 'pending_delete';
          });
          if (hasTransient) {
            setTimeout(() => this.refresh(), 1500);
          }
        }
      } catch (err: any) {
        items.push(
          new VolumeChildTreeItem(
            'Error loading volumes',
            err.message,
            'warning',
            { command: 'boxlite.refreshVolumes', title: 'Retry' }
          )
        );
      }

      return items;
    }

    if (element instanceof VolumeTreeItem) {
      const vol = element.volume;
      const children: BoxLiteTreeItem[] = [];

      // 1. Volume ID
      children.push(
        new VolumeChildTreeItem(
          'Volume ID',
          vol.id,
          'key',
          {
            command: 'boxlite.copyVolumeId',
            title: 'Copy Volume ID',
            arguments: [element]
          },
          vscode.TreeItemCollapsibleState.None,
          'volume-id-item',
          vol.id
        )
      );

      // 2. State
      const state = (vol.state || 'ready').toLowerCase().trim();
      children.push(
        new VolumeChildTreeItem(
          'State',
          state,
          state === 'ready' ? 'check' : state === 'error' ? 'error' : 'sync~spin',
          undefined,
          vscode.TreeItemCollapsibleState.None,
          'volume-state-item',
          vol.id
        )
      );

      // 3. Created At
      if (vol.createdAt) {
        children.push(
          new VolumeChildTreeItem(
            'Created At',
            vol.createdAt,
            'calendar',
            undefined,
            vscode.TreeItemCollapsibleState.None,
            'volume-created-item',
            vol.id
          )
        );
      }

      // 4. Mount / Add to Box or Project
      children.push(
        new VolumeChildTreeItem(
          'Mount in Box / Project...',
          'Configure mount in boxlite.json or Box',
          'link',
          {
            command: 'boxlite.addVolumeToBox',
            title: 'Mount Volume in Box...',
            arguments: [element]
          },
          vscode.TreeItemCollapsibleState.None,
          'volume-mount-action',
          vol.id
        )
      );

      // 5. Inspect JSON
      children.push(
        new VolumeChildTreeItem(
          'Inspect Volume Details',
          'View JSON specification',
          'json',
          {
            command: 'boxlite.inspectVolume',
            title: 'Inspect Volume',
            arguments: [element]
          },
          vscode.TreeItemCollapsibleState.None,
          'volume-inspect-action',
          vol.id
        )
      );

      // 6. Delete Volume
      children.push(
        new VolumeChildTreeItem(
          'Delete Volume',
          'Permanently remove volume',
          'trash',
          {
            command: 'boxlite.deleteVolume',
            title: 'Delete Volume',
            arguments: [element]
          },
          vscode.TreeItemCollapsibleState.None,
          'volume-delete-action',
          vol.id
        )
      );

      return children;
    }

    return [];
  }
}
