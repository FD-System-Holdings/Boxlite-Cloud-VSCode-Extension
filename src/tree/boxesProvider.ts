import * as vscode from 'vscode';
import { BoxLiteBridgeClient } from '../bridge/client';
import { CredentialsManager } from '../auth/credentials';
import { BoxLiteTreeItem, AccountTreeItem, BoxTreeItem, BoxChildTreeItem } from './nodes';

export class BoxesTreeDataProvider implements vscode.TreeDataProvider<BoxLiteTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<BoxLiteTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private cachedBoxes: BoxTreeItem[] = [];

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
      // Root level: Account node + Box nodes
      const items: BoxLiteTreeItem[] = [];
      const apiKey = await this.credentials.getApiKey();
      const restUrl = this.credentials.getRestUrl();

      items.push(new AccountTreeItem(restUrl, apiKey));

      if (!apiKey) {
        return items;
      }

      try {
        const boxes = await this.bridge.listBoxes();
        this.cachedBoxes = boxes.map((b) => new BoxTreeItem(b));
        items.push(...this.cachedBoxes);
      } catch (err: any) {
        items.push(
          new BoxChildTreeItem(
            'Error loading boxes',
            err.message,
            'warning',
            { command: 'boxlite.refresh', title: 'Retry' }
          )
        );
      }

      return items;
    }

    if (element instanceof BoxTreeItem) {
      // Children of a Box: Tunnels, Network, Logs, Info
      const children: BoxLiteTreeItem[] = [];

      // 1. Tunnels / URLs
      if (element.tunnels && element.tunnels.length > 0) {
        for (const t of element.tunnels) {
          const typeLabel = t.isPublic ? 'Public URL' : 'Private URL';
          children.push(
            new BoxChildTreeItem(
              typeLabel,
              t.url,
              t.isPublic ? 'globe' : 'lock',
              {
                command: 'boxlite.openUrl',
                title: 'Open in Browser',
                arguments: [element, t.url]
              },
              vscode.TreeItemCollapsibleState.None,
              'tunnel-item'
            )
          );
        }
      } else {
        children.push(
          new BoxChildTreeItem(
            'No Active Tunnels',
            'Port 8080',
            'radio-tower',
            {
              command: 'boxlite.setAccess',
              title: 'Create Tunnel',
              arguments: [element]
            }
          )
        );
      }

      // 2. Network policy
      children.push(
        new BoxChildTreeItem(
          'Network Policy',
          'Inbound & Outbound rules',
          'shield',
          {
            command: 'boxlite.configureOutbound',
            title: 'Configure Network',
            arguments: [element]
          }
        )
      );

      // 3. Application Logs
      children.push(
        new BoxChildTreeItem(
          'Application Logs',
          '/tmp/server.log',
          'output',
          {
            command: 'boxlite.streamLogs',
            title: 'Stream Logs',
            arguments: [element]
          }
        )
      );

      // 4. Execute Command
      children.push(
        new BoxChildTreeItem(
          'Execute Command',
          'Run CLI in Box',
          'terminal',
          {
            command: 'boxlite.execCommand',
            title: 'Execute Command',
            arguments: [element]
          }
        )
      );

      // 5. Inspect JSON
      children.push(
        new BoxChildTreeItem(
          'Inspect Box Details',
          'View JSON specification',
          'json',
          {
            command: 'boxlite.inspectBox',
            title: 'Inspect JSON',
            arguments: [element]
          }
        )
      );

      return children;
    }

    return [];
  }
}
