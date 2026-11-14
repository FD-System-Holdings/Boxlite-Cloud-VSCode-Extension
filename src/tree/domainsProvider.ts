import * as vscode from 'vscode';
import { BoxLiteBridgeClient } from '../bridge/client';
import { CredentialsManager } from '../auth/credentials';
import {
  BoxLiteTreeItem,
  DomainTreeItem,
  DomainChildTreeItem
} from './nodes';

export class DomainsTreeDataProvider implements vscode.TreeDataProvider<BoxLiteTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<BoxLiteTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private cachedDomains: DomainTreeItem[] = [];
  private startupReady = true;
  private refreshTimer?: NodeJS.Timeout;

  constructor(
    private bridge: BoxLiteBridgeClient,
    private credentials: CredentialsManager
  ) {}

  public setStartupReady(ready: boolean): void {
    this.startupReady = ready;
  }

  public refresh(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
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
      const items: BoxLiteTreeItem[] = [];
      const apiKey = await this.credentials.getApiKey();

      if (!apiKey) {
        items.push(
          new DomainChildTreeItem(
            'Sign in to BoxLite Cloud',
            'Use the account section above to sign in',
            'sign-in',
            { command: 'boxlite.setApiKey', title: 'Sign In / Set API Key' }
          )
        );
        return items;
      }

      try {
        const domains = await this.bridge.listDomains();
        if (domains.length === 0) {
          this.cachedDomains = [];
          items.push(
            new DomainChildTreeItem(
              'No Custom Domains',
              'Click to add a custom domain',
              'add',
              { command: 'boxlite.createDomain', title: 'Add Domain...' }
            )
          );
        } else {
          this.cachedDomains = domains.map((d) => new DomainTreeItem(d));
          items.push(...this.cachedDomains);

          const hasTransient = domains.some((d) => {
            const s = (d.status || '').toLowerCase().trim();
            return s === 'pending' || s === 'verifying' || s === 'provisioning' || s === 'deleting';
          });
          if (hasTransient) {
            if (this.refreshTimer) {
              clearTimeout(this.refreshTimer);
            }
            this.refreshTimer = setTimeout(() => this.refresh(), 2500);
          }
        }
      } catch (err: any) {
        const rawMsg = err.message || '';
        const lower = rawMsg.toLowerCase();
        const is401 = rawMsg.includes('401') || lower.includes('unauthorized');
        const is403 = rawMsg.includes('403') || lower.includes('forbidden');
        const is404 = rawMsg.includes('404') || rawMsg.includes('501') || lower.includes('not found') || lower.includes('not implemented');

        let desc = rawMsg;
        let tooltip = rawMsg;
        let command: vscode.Command = { command: 'boxlite.refreshDomains', title: 'Retry' };
        let icon = 'warning';
        let contextValue = 'domain-error';

        if (is401) {
          desc = '401 Unauthorized · Invalid credentials';
          tooltip = 'BoxLite Cloud API Error (401): Unauthorized.\n\nConfigure your BOXLITE_API_KEY via "BoxLite: Sign In / Set API Key".';
          command = { command: 'boxlite.setApiKey', title: 'Sign In / Set API Key' };
          icon = 'key';
        } else if (is403) {
          desc = '403 Forbidden · Domains access denied';
          tooltip = 'BoxLite Cloud API Error (403): Forbidden.\n\nEnsure your API key has permission to manage domains.';
          icon = 'lock';
          contextValue = 'domain-forbidden';
        } else if (is404) {
          desc = 'Custom Domains API unavailable on this server';
          tooltip = 'BoxLite Cloud REST endpoint /v1/domains returned 404/501.\n\nCustom Domains may not be enabled on this BoxLite Cloud target yet. Click to retry.';
          icon = 'info';
          contextValue = 'domain-unavailable';
        } else {
          const firstLine = rawMsg.split('\n')[0];
          desc = firstLine.length > 60 ? firstLine.slice(0, 57) + '...' : firstLine;
        }

        items.push(
          new DomainChildTreeItem(
            'Error loading domains',
            desc,
            icon,
            command,
            vscode.TreeItemCollapsibleState.None,
            contextValue,
            undefined,
            tooltip
          )
        );
      }

      return items;
    }

    if (element instanceof DomainTreeItem) {
      const dom = element.domain;
      const children: BoxLiteTreeItem[] = [];
      const status = (dom.status || 'pending').toLowerCase().trim();
      const domainKey = dom.id || dom.domain;

      const statusDesc = dom.errorReason ? `${status} (${dom.errorReason})` : status;
      children.push(
        new DomainChildTreeItem(
          'Status',
          statusDesc,
          status === 'active' || status === 'verified' || status === 'ready'
            ? 'pass'
            : status === 'failed' || status === 'error'
              ? 'error'
              : 'clock',
          undefined,
          vscode.TreeItemCollapsibleState.None,
          'domain-status',
          domainKey
        )
      );

      const targetLabel = dom.boxName || dom.boxId;
      const targetDesc = targetLabel
        ? `${targetLabel}${dom.port ? `:${dom.port}` : ''}`
        : 'Unattached (click to bind to a Box)';
      children.push(
        new DomainChildTreeItem(
          'Target Box',
          targetDesc,
          'vm',
          {
            command: 'boxlite.bindDomainToBox',
            title: 'Bind Domain to Box',
            arguments: [element]
          },
          vscode.TreeItemCollapsibleState.None,
          'domain-target',
          domainKey
        )
      );

      if (status === 'pending' || status === 'failed' || status === 'error') {
        children.push(
          new DomainChildTreeItem(
            'Verify DNS',
            'Trigger DNS verification check',
            'check',
            {
              command: 'boxlite.verifyDomain',
              title: 'Verify DNS',
              arguments: [element]
            },
            vscode.TreeItemCollapsibleState.None,
            'domain-verify-action',
            domainKey
          )
        );
      }

      if (dom.verificationRecordName && dom.verificationRecordValue) {
        const method = dom.verificationMethod || 'TXT';
        children.push(
          new DomainChildTreeItem(
            `DNS ${method} Record`,
            `${dom.verificationRecordName} → ${dom.verificationRecordValue}`,
            'key',
            {
              command: 'boxlite.copyDomainVerification',
              title: 'Copy DNS Verification Value',
              arguments: [dom.verificationRecordValue, `${method} verification value`]
            },
            vscode.TreeItemCollapsibleState.None,
            'domain-dns-record',
            domainKey,
            `Record Type: ${method}\nName: ${dom.verificationRecordName}\nValue: ${dom.verificationRecordValue}\n\nClick to copy value.`
          )
        );
      }

      if (dom.cnameTarget) {
        children.push(
          new DomainChildTreeItem(
            'CNAME Target',
            dom.cnameTarget,
            'globe',
            {
              command: 'boxlite.copyDomainVerification',
              title: 'Copy CNAME Target',
              arguments: [dom.cnameTarget, 'CNAME target']
            },
            vscode.TreeItemCollapsibleState.None,
            'domain-cname',
            domainKey,
            `Point your DNS CNAME record to: ${dom.cnameTarget}\n\nClick to copy.`
          )
        );
      }

      if (dom.tlsStatus) {
        children.push(
          new DomainChildTreeItem(
            'TLS Certificate',
            dom.tlsStatus,
            'lock',
            undefined,
            vscode.TreeItemCollapsibleState.None,
            'domain-tls',
            domainKey
          )
        );
      }

      if (status === 'active' || status === 'verified' || status === 'ready') {
        children.push(
          new DomainChildTreeItem(
            'Open in Browser',
            `https://${dom.domain}`,
            'link-external',
            {
              command: 'boxlite.openDomainUrl',
              title: 'Open Domain in Browser',
              arguments: [element]
            },
            vscode.TreeItemCollapsibleState.None,
            'domain-open-url',
            domainKey
          )
        );
      }

      if (dom.id && dom.id !== dom.domain) {
        children.push(
          new DomainChildTreeItem(
            'Domain ID',
            dom.id,
            'symbol-key',
            {
              command: 'boxlite.copyDomainVerification',
              title: 'Copy Domain ID',
              arguments: [dom.id, 'Domain ID']
            },
            vscode.TreeItemCollapsibleState.None,
            'domain-id',
            domainKey
          )
        );
      }

      return children;
    }

    return [];
  }
}
