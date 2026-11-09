import * as vscode from 'vscode';
import { BoxLiteBridgeClient } from '../bridge/client';
import { CredentialsManager } from '../auth/credentials';
import { LogStreamManager } from '../logs/logStream';
import { BoxLiteTreeItem, AccountTreeItem, BoxTreeItem, BoxChildTreeItem } from './nodes';

export class BoxesTreeDataProvider implements vscode.TreeDataProvider<BoxLiteTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<BoxLiteTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private cachedBoxes: BoxTreeItem[] = [];

  constructor(
    private bridge: BoxLiteBridgeClient,
    private credentials: CredentialsManager,
    private logManager?: LogStreamManager
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

        // Auto-refresh if any box is transitioning (e.g. stopping or starting)
        const hasTransient = boxes.some((b) => {
          const s = (b.status || '').toLowerCase().trim();
          return s === 'stopping' || s === 'starting' || s === 'provisioning';
        });
        if (hasTransient) {
          setTimeout(() => this.refresh(), 1500);
        }
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
      // Children of a Box: Power Action, Tunnels, Network, Logs, Info
      const children: BoxLiteTreeItem[] = [];
      const status = (element.box.status || '').toLowerCase().trim();
      // 1. Power Action (Stop / Start Box)
      const isRunning = status === 'running' || status === 'ready' || status === 'active';
      const isStopped =
        status === 'stopped' ||
        status === 'terminated' ||
        status === 'exited' ||
        status === 'configured' ||
        status === 'paused' ||
        status === 'inactive' ||
        status === 'shutdown';

      if (isRunning) {
        children.push(
          new BoxChildTreeItem(
            'Stop Box',
            'Halt microVM execution',
            'primitive-square',
            {
              command: 'boxlite.stopBox',
              title: 'Stop Box',
              arguments: [element]
            },
            vscode.TreeItemCollapsibleState.None,
            'box-stop-action',
            element.box.id
          )
        );
      } else if (isStopped) {
        children.push(
          new BoxChildTreeItem(
            'Start Box',
            'Boot microVM',
            'play',
            {
              command: 'boxlite.startBox',
              title: 'Start Box',
              arguments: [element]
            },
            vscode.TreeItemCollapsibleState.None,
            'box-start-action',
            element.box.id
          )
        );
      } else {
        children.push(
          new BoxChildTreeItem(
            status === 'stopping' ? 'Stopping Box...' : 'Starting Box...',
            `Box is ${status}`,
            'sync~spin',
            undefined,
            vscode.TreeItemCollapsibleState.None,
            'box-transient-action',
            element.box.id
          )
        );
      }

      // 2. Tunnels / URLs
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

      // 3. Network policy
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

      // 3b. Mounted Volumes
      if (element.box.volumes && element.box.volumes.length > 0) {
        for (const v of element.box.volumes) {
          children.push(
            new BoxChildTreeItem(
              `Volume: ${v.managed_volume}`,
              `Mounted at ${v.guest_path}${v.read_only ? ' (ro)' : ''}`,
              'database',
              {
                command: 'boxlite.inspectBox',
                title: 'Inspect Box Volumes',
                arguments: [element]
              },
              vscode.TreeItemCollapsibleState.None,
              'box-volume-item',
              element.box.id
            )
          );
        }
      }

      // 4. Application Logs
      const isStreaming = this.logManager?.isStreaming(element.box.id);
      children.push(
        new BoxChildTreeItem(
          isStreaming ? 'Stop Streaming Logs' : 'Application Logs',
          isStreaming ? 'Active log stream (polling)' : '/tmp/server.log',
          isStreaming ? 'close' : 'output',
          {
            command: isStreaming ? 'boxlite.stopLogs' : 'boxlite.streamLogs',
            title: isStreaming ? 'Stop Streaming' : 'Stream Logs',
            arguments: [element]
          },
          vscode.TreeItemCollapsibleState.None,
          isStreaming ? 'box-stop-logs-action' : 'box-stream-logs-action',
          element.box.id
        )
      );

      // 5. Execute Command
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

      // 6. Inspect JSON
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
