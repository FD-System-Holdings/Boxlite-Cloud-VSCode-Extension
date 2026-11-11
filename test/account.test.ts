import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { AccountTreeDataProvider } from '../src/tree/accountProvider';
import { AccountTreeItem, ApiKeyTreeItem, LinkApiKeyActionTreeItem } from '../src/tree/nodes';

describe('AccountTreeDataProvider and Account View Contributions', () => {
  it('should return AccountTreeItem with account-signed-in context and children when authenticated', async () => {
    const mockCredentials: any = {
      getApiKey: async () => 'test-api-key',
      getRestUrl: () => 'https://api.boxlite.ai',
      getActiveKey: async () => ({ id: 'key1', name: 'Production' }),
      listKeys: async () => [
        { id: 'key1', name: 'Production', active: true },
        { id: 'key2', name: 'Staging', active: false }
      ]
    };

    const provider = new AccountTreeDataProvider(mockCredentials);
    const items = await provider.getChildren();

    assert.strictEqual(items.length, 1);
    const accountNode = items[0] as AccountTreeItem;
    assert.strictEqual(accountNode.label, 'BoxLite Cloud Account');
    assert.strictEqual(accountNode.contextValue, 'account-signed-in');
    assert.strictEqual(accountNode.description, 'Production · api.boxlite.ai');
    assert.strictEqual(accountNode.collapsibleState, vscode.TreeItemCollapsibleState.Expanded);
    assert.strictEqual(provider.getTreeItem(accountNode), accountNode);

    // Expanding root returns the API keys and the "Link new API key..." action
    const children = await provider.getChildren(accountNode);
    assert.strictEqual(children.length, 3);

    const activeKeyItem = children[0] as ApiKeyTreeItem;
    assert.strictEqual(activeKeyItem.label, 'Production');
    assert.strictEqual(activeKeyItem.description, 'Active');
    assert.strictEqual(activeKeyItem.contextValue, 'apikey-active');
    assert.strictEqual((activeKeyItem.iconPath as vscode.ThemeIcon)?.id, 'check');

    const stagingKeyItem = children[1] as ApiKeyTreeItem;
    assert.strictEqual(stagingKeyItem.label, 'Staging');
    assert.strictEqual(stagingKeyItem.description, '');
    assert.strictEqual(stagingKeyItem.contextValue, 'apikey');
    assert.strictEqual((stagingKeyItem.iconPath as vscode.ThemeIcon)?.id, 'key');
    assert.strictEqual(stagingKeyItem.command?.command, 'boxlite.selectApiKey');
    assert.deepStrictEqual(stagingKeyItem.command?.arguments, ['key2']);

    const linkItem = children[2] as LinkApiKeyActionTreeItem;
    assert.strictEqual(linkItem.label, 'Link new API key...');
    assert.strictEqual(linkItem.command?.command, 'boxlite.setApiKey');
  });

  it('should return AccountTreeItem with account-signed-out and setApiKey command when signed out', async () => {
    const mockCredentials: any = {
      getApiKey: async () => undefined,
      getRestUrl: () => 'https://api.boxlite.ai'
    };

    const provider = new AccountTreeDataProvider(mockCredentials);
    const items = await provider.getChildren();

    assert.strictEqual(items.length, 1);
    const accountNode = items[0] as AccountTreeItem;
    assert.strictEqual(accountNode.label, 'BoxLite Cloud (Not Signed In)');
    assert.strictEqual(accountNode.contextValue, 'account-signed-out');
    assert.strictEqual(accountNode.command?.command, 'boxlite.setApiKey');

    const children = await provider.getChildren(accountNode);
    assert.deepStrictEqual(children, []);
  });

  it('should fire onDidChangeTreeData when refresh is called', (done) => {
    const mockCredentials: any = {
      getApiKey: async () => undefined,
      getRestUrl: () => 'https://api.boxlite.ai'
    };

    const provider = new AccountTreeDataProvider(mockCredentials);
    provider.onDidChangeTreeData(() => {
      done();
    });
    provider.refresh();
  });

  it('should contribute boxlite.accountView above all sections in package.json with unified actions', () => {
    const pkgPath = path.resolve(__dirname, '../../package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));

    const views = pkg.contributes?.views?.['boxlite-explorer'] || [];
    assert.strictEqual(views[0]?.id, 'boxlite.accountView');
    assert.strictEqual(views[0]?.name, 'BoxLite Cloud Account');

    const contextMenus = pkg.contributes?.menus?.['view/item/context'] || [];
    const accountMenus = contextMenus.filter(
      (m: any) => m.when && m.when === "view == boxlite.accountView && viewItem == 'account-signed-in'"
    );

    assert.strictEqual(accountMenus.length, 5);
    const commands = accountMenus.map((m: any) => m.command);
    assert.deepStrictEqual(commands, [
      'boxlite.createBox',
      'boxlite.createBoxWithOptions',
      'boxlite.addImage',
      'boxlite.createVolume',
      'boxlite.signOut'
    ]);

    const apiKeyMenus = contextMenus.filter(
      (m: any) => m.when && m.when.includes('view == boxlite.accountView') && m.when.includes('apikey')
    );
    assert.strictEqual(apiKeyMenus.length, 2);
    const apiKeyCommands = apiKeyMenus.map((m: any) => m.command);
    assert.ok(apiKeyCommands.includes('boxlite.selectApiKey'));
    assert.ok(apiKeyCommands.includes('boxlite.removeApiKey'));
  });
});
