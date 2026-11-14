import * as vscode from 'vscode';
import { BoxLiteBridgeClient } from '../bridge/client';
import { CredentialsManager } from '../auth/credentials';
import {
  BoxLiteTreeItem,
  VolumeTreeItem,
  VolumeChildTreeItem
} from './nodes';

export class VolumesTreeDataProvider implements vscode.TreeDataProvider<BoxLiteTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<BoxLiteTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private cachedVolumes: VolumeTreeItem[] = [];
  private startupReady = true;

  constructor(
    private bridge: BoxLiteBridgeClient,
    private credentials: CredentialsManager
  ) {}

  public setStartupReady(ready: boolean): void {
    this.startupReady = ready;
  }

  public refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  public getTreeItem(element: BoxLiteTreeItem): vscode.TreeItem {
    return element;
  }

  public async getChildren(element?: BoxLiteTreeItem): Promise<BoxLiteTreeItem[]> {
    if (!this.startupReady) {
      return [];
    }

    if (!element) {
      // Root level: Volume nodes
      const items: BoxLiteTreeItem[] = [];
      const apiKey = await this.credentials.getApiKey();

      if (!apiKey) {
        items.push(
          new VolumeChildTreeItem(
            'Sign in to BoxLite Cloud',
            'Use the account section above to sign in',
            'sign-in',
            { command: 'boxlite.setApiKey', title: 'Sign In / Set API Key' }
          )
        );
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
        const rawMsg = err.message || '';
        const is403 = rawMsg.includes('403') || rawMsg.toLowerCase().includes('forbidden');
        const is401 = rawMsg.includes('401') || rawMsg.toLowerCase().includes('unauthorized');

        let desc = rawMsg;
        let tooltip = rawMsg;
        let command = { command: 'boxlite.refreshVolumes', title: 'Retry' };

        if (is403) {
          desc = '403 Forbidden · Managed volumes not permitted (agent.md §4)';
          tooltip = `BoxLite Cloud API Error (403): Forbidden resource.\n\nDiagnosis (agent.md §5):\nCheck authentication/token and requested URL; do not assume either app health or one particular policy cause.\n\nNote (agent.md §4):\nDo not infer managed database or shared-volume support. BoxLite Cloud may restrict or not support shared volumes for your account tier. Click to retry.`;
        } else if (is401) {
          desc = '401 Unauthorized · Invalid credentials';
          tooltip = `BoxLite Cloud API Error (401): Unauthorized.\n\nDiagnosis (agent.md §5):\nCheck credentials. Configure your BOXLITE_API_KEY via "BoxLite: Sign In / Set API Key".`;
          command = { command: 'boxlite.setApiKey', title: 'Sign In / Set API Key' };
        } else {
          const firstLine = rawMsg.split('\n')[0];
          desc = firstLine.length > 60 ? firstLine.slice(0, 57) + '...' : firstLine;
          tooltip = rawMsg;
        }

        items.push(
          new VolumeChildTreeItem(
            'Error loading volumes',
            desc,
            is403 ? 'lock' : (is401 ? 'key' : 'warning'),
            command,
            vscode.TreeItemCollapsibleState.None,
            is403 ? 'volume-forbidden' : 'volume-error',
            undefined,
            tooltip
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
