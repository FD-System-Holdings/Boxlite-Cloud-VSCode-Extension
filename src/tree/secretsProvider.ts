import * as vscode from 'vscode';
import { BoxLiteBridgeClient } from '../bridge/client';
import { CredentialsManager } from '../auth/credentials';
import { SecretsManager } from '../auth/secretsStore';
import { ProjectManager } from '../deploy/project';
import { BoxLiteTreeItem, SecretTreeItem, SecretChildTreeItem, SecretTreeItemData } from './nodes';

export class SecretsTreeDataProvider implements vscode.TreeDataProvider<BoxLiteTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<BoxLiteTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(
    private bridge: BoxLiteBridgeClient,
    private credentials: CredentialsManager,
    private secretsManager: SecretsManager
  ) {}

  public refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  public getTreeItem(element: BoxLiteTreeItem): vscode.TreeItem {
    return element;
  }

  public async getChildren(element?: BoxLiteTreeItem): Promise<BoxLiteTreeItem[]> {
    if (!element) {
      const items: BoxLiteTreeItem[] = [];
      const apiKey = await this.credentials.getApiKey();

      if (!apiKey) {
        items.push(
          new SecretChildTreeItem(
            'Sign in to BoxLite Cloud',
            'Use the account section above to sign in',
            'sign-in',
            { command: 'boxlite.setApiKey', title: 'Sign In / Set API Key' }
          )
        );
        return items;
      }

      const merged = new Map<string, SecretTreeItemData>();

      try {
        const stored = await this.secretsManager.listSecrets();
        for (const s of stored) {
          const key = s.name.trim().toLowerCase();
          merged.set(key, {
            name: s.name,
            hosts: [...(s.hosts || [])],
            headers: { ...(s.headers || {}) },
            envVar: s.envVar,
            hasValue: !!s.value && s.value.trim().length > 0,
            usedByBoxes: [],
            source: 'workstation'
          });
        }
      } catch {
        // Ignore SecretStorage read errors
      }

      try {
        const projectInfo = await ProjectManager.findProjectConfig();
        const projectSecrets = projectInfo?.config.secrets || [];
        for (const ps of projectSecrets) {
          const key = ps.name.trim().toLowerCase();
          const existing = merged.get(key);
          if (existing) {
            existing.hosts = ps.hosts && ps.hosts.length > 0 ? [...ps.hosts] : existing.hosts;
            existing.headers =
              ps.headers && Object.keys(ps.headers).length > 0 ? { ...ps.headers } : existing.headers;
            existing.envVar = ps.envVar || existing.envVar;
            existing.source = 'merged';
          } else {
            merged.set(key, {
              name: ps.name,
              hosts: [...(ps.hosts || [])],
              headers: { ...(ps.headers || {}) },
              envVar: ps.envVar,
              hasValue: false,
              usedByBoxes: [],
              source: 'project'
            });
          }
        }
      } catch {
        // Ignore missing/invalid boxlite.json
      }

      try {
        const boxes = await this.bridge.listBoxes();
        for (const b of boxes) {
          for (const bs of b.secrets || []) {
            const key = bs.name.trim().toLowerCase();
            const existing = merged.get(key);
            const boxLabel = b.name || b.id;
            if (existing) {
              existing.usedByBoxes = [...(existing.usedByBoxes || []), boxLabel];
            } else {
              merged.set(key, {
                name: bs.name,
                hosts: [...(bs.hosts || [])],
                headers: { ...(bs.headers || {}) },
                hasValue: false,
                usedByBoxes: [boxLabel],
                source: 'box'
              });
            }
          }
        }
      } catch {
        // Gracefully ignore box listing errors in Secrets view
      }

      const secretItems = Array.from(merged.values()).sort((a, b) => a.name.localeCompare(b.name));

      if (secretItems.length === 0) {
        items.push(
          new SecretChildTreeItem(
            'No Configured Secrets',
            'Click to add a Secret for outbound proxy injection',
            'add',
            { command: 'boxlite.createSecret', title: 'Add Secret...' }
          )
        );
      } else {
        for (const s of secretItems) {
          items.push(new SecretTreeItem(s));
        }
      }

      items.push(
        new SecretChildTreeItem(
          'Verify Secret Injection (Fake-Token Diagnostic)...',
          'Test proxy header injection with httpbingo.org',
          'beaker',
          { command: 'boxlite.verifySecretInjection', title: 'Verify Secret Injection...' },
          vscode.TreeItemCollapsibleState.None,
          'secret-verify-action'
        )
      );

      return items;
    }

    if (element instanceof SecretTreeItem) {
      const s = element.secret;
      const children: BoxLiteTreeItem[] = [];
      const placeholder = SecretsManager.getPlaceholder(s.name);
      const headerTemplate = Object.entries(s.headers || {})
        .map(([k, v]) => `${k}: ${v}`)
        .join(', ');
      const guestHeaderExample = SecretsManager.getGuestHeaderExample(s);

      children.push(
        new SecretChildTreeItem(
          'Placeholder',
          placeholder,
          'symbol-string',
          {
            command: 'boxlite.copySecretPlaceholder',
            title: 'Copy Secret Placeholder',
            arguments: [element]
          },
          vscode.TreeItemCollapsibleState.None,
          'secret-placeholder-item',
          s.name,
          `Click to copy placeholder ${placeholder} to clipboard`
        )
      );

      children.push(
        new SecretChildTreeItem(
          'Allowed Hosts',
          (s.hosts || []).join(', ') || 'None',
          'globe',
          undefined,
          vscode.TreeItemCollapsibleState.None,
          'secret-hosts-item',
          s.name
        )
      );

      children.push(
        new SecretChildTreeItem(
          'Header Template',
          headerTemplate || 'Authorization: Bearer {value}',
          'symbol-key',
          undefined,
          vscode.TreeItemCollapsibleState.None,
          'secret-header-template-item',
          s.name
        )
      );

      children.push(
        new SecretChildTreeItem(
          'Guest Request Header',
          guestHeaderExample,
          'copy',
          {
            command: 'boxlite.copySecretHeader',
            title: 'Copy Guest Request Header',
            arguments: [element]
          },
          vscode.TreeItemCollapsibleState.None,
          'secret-guest-header-item',
          s.name,
          `Click to copy guest HTTP header "${guestHeaderExample}" to clipboard`
        )
      );

      if (s.envVar) {
        children.push(
          new SecretChildTreeItem(
            'Guest Env Variable',
            `${s.envVar}=${placeholder}`,
            'symbol-variable',
            undefined,
            vscode.TreeItemCollapsibleState.None,
            'secret-env-item',
            s.name
          )
        );
      }

      if (s.usedByBoxes && s.usedByBoxes.length > 0) {
        children.push(
          new SecretChildTreeItem(
            'Attached Boxes',
            s.usedByBoxes.join(', '),
            'vm',
            undefined,
            vscode.TreeItemCollapsibleState.None,
            'secret-boxes-item',
            s.name
          )
        );
      }

      children.push(
        new SecretChildTreeItem(
          'Create Box with Secret...',
          `Launch box with ${s.name} proxy injection`,
          'plus',
          {
            command: 'boxlite.createBoxWithSecret',
            title: 'Create Box with Secret...',
            arguments: [element]
          },
          vscode.TreeItemCollapsibleState.None,
          'secret-create-box-action',
          s.name
        )
      );

      children.push(
        new SecretChildTreeItem(
          'Add Secret to Project (boxlite.json)...',
          'Save redacted metadata & env placeholder',
          'save',
          {
            command: 'boxlite.addSecretToProject',
            title: 'Add Secret to Project...',
            arguments: [element]
          },
          vscode.TreeItemCollapsibleState.None,
          'secret-add-project-action',
          s.name
        )
      );

      children.push(
        new SecretChildTreeItem(
          'Rotate / Update Secret Credential...',
          'Update stored key and optionally replace boxes',
          'sync',
          {
            command: 'boxlite.rotateSecret',
            title: 'Rotate / Update Secret...',
            arguments: [element]
          },
          vscode.TreeItemCollapsibleState.None,
          'secret-rotate-action',
          s.name
        )
      );

      children.push(
        new SecretChildTreeItem(
          'Copy SDK / Guest Code Snippet...',
          'Python, TypeScript, or REST create snippet',
          'code',
          {
            command: 'boxlite.copySecretSnippet',
            title: 'Copy SDK / Guest Code Snippet...',
            arguments: [element]
          },
          vscode.TreeItemCollapsibleState.None,
          'secret-snippet-action',
          s.name
        )
      );

      children.push(
        new SecretChildTreeItem(
          'Delete Secret',
          'Remove secret from local workstation store',
          'trash',
          {
            command: 'boxlite.deleteSecret',
            title: 'Delete Secret',
            arguments: [element]
          },
          vscode.TreeItemCollapsibleState.None,
          'secret-delete-action',
          s.name
        )
      );

      return children;
    }

    return [];
  }
}
