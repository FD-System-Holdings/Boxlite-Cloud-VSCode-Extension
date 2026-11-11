import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import { AccountTreeDataProvider } from '../src/tree/accountProvider';
import { AccountTreeItem } from '../src/tree/nodes';

describe('AccountTreeDataProvider and Account View Contributions', () => {
  it('should return AccountTreeItem with account-signed-in context when authenticated', async () => {
    const mockCredentials: any = {
      getApiKey: async () => 'test-api-key',
      getRestUrl: () => 'https://api.boxlite.ai'
    };

    const provider = new AccountTreeDataProvider(mockCredentials);
    const items = await provider.getChildren();

    assert.strictEqual(items.length, 1);
    const accountNode = items[0] as AccountTreeItem;
    assert.strictEqual(accountNode.label, 'BoxLite Cloud Account');
    assert.strictEqual(accountNode.contextValue, 'account-signed-in');
    assert.strictEqual(accountNode.description, 'Connected · api.boxlite.ai');
    assert.strictEqual(provider.getTreeItem(accountNode), accountNode);

    // No children when expanding root element
    const children = await provider.getChildren(accountNode);
    assert.deepStrictEqual(children, []);
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
  });
});
