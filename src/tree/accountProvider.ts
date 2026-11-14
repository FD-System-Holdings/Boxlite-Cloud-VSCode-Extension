import * as vscode from 'vscode';
import { CredentialsManager } from '../auth/credentials';
import { BoxLiteTreeItem, AccountTreeItem, ApiKeyTreeItem, LinkApiKeyActionTreeItem } from './nodes';

export class AccountTreeDataProvider implements vscode.TreeDataProvider<BoxLiteTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<BoxLiteTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private startupReady = true;

  constructor(private credentials: CredentialsManager) {}

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
      const apiKey = await this.credentials.getApiKey();
      const restUrl = this.credentials.getRestUrl();
      const active = this.credentials.getActiveKey ? await this.credentials.getActiveKey() : undefined;
      return [new AccountTreeItem(restUrl, apiKey, active?.name)];
    }

    if (element instanceof AccountTreeItem && element.apiKey) {
      const keys = this.credentials.listKeys ? await this.credentials.listKeys() : [];
      const items: BoxLiteTreeItem[] = keys.map(
        (k) => new ApiKeyTreeItem(k.id, k.name, k.active, k.isEnv)
      );
      items.push(new LinkApiKeyActionTreeItem());
      return items;
    }

    return [];
  }
}
