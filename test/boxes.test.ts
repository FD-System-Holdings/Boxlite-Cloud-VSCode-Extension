import * as assert from 'assert';
import { BoxTreeItem, AccountTreeItem } from '../src/tree/nodes';
import { BoxesTreeDataProvider } from '../src/tree/boxesProvider';

describe('Box Tree Items and Lifecycle Management', () => {
  it('should normalize uppercase RUNNING and provide canStop context value', () => {
    const item = new BoxTreeItem({
      id: 'box-12345678',
      name: 'my-app',
      status: 'RUNNING' as any
    });
    assert.strictEqual(item.contextValue?.includes('canStop'), true);
    assert.strictEqual(item.contextValue?.includes('isRunning'), true);
    assert.strictEqual(item.contextValue?.includes('canStart'), false);
    assert.strictEqual(item.contextValue?.includes('isStopped'), false);
  });

  it('should normalize STOPPED and provide canStart context value', () => {
    const item = new BoxTreeItem({
      id: 'box-12345678',
      name: 'my-app',
      status: 'STOPPED' as any
    });
    assert.strictEqual(item.contextValue?.includes('canStart'), true);
    assert.strictEqual(item.contextValue?.includes('isStopped'), true);
    assert.strictEqual(item.contextValue?.includes('canStop'), false);
    assert.strictEqual(item.contextValue?.includes('isRunning'), false);
  });

  it('should treat CONFIGURED status as stopped and provide canStart context value', () => {
    const item = new BoxTreeItem({
      id: 'box-12345678',
      name: 'configured-app',
      status: 'configured' as any
    });
    assert.strictEqual(item.contextValue?.includes('canStart'), true);
    assert.strictEqual(item.contextValue?.includes('isStopped'), true);
    assert.strictEqual(item.contextValue?.includes('canStop'), false);
    assert.strictEqual(item.contextValue?.includes('isRunning'), false);
  });

  it('should not allow stopping an already STOPPING box and present transient child action', async () => {
    const item = new BoxTreeItem({
      id: 'box-12345678',
      name: 'stopping-app',
      status: 'stopping' as any
    });
    assert.strictEqual(item.contextValue?.includes('canStop'), false);
    assert.strictEqual(item.contextValue?.includes('isRunning'), false);
    assert.strictEqual(item.contextValue?.includes('canStart'), false);

    const provider = new BoxesTreeDataProvider({} as any, {} as any);
    const children = await provider.getChildren(item);
    assert.strictEqual(children.some((c) => c.label === 'Stop Box'), false);
    assert.strictEqual(children.some((c) => c.label === 'Stopping Box...'), true);
  });

  it('should expose Stop Box action child node for running boxes', async () => {
    const provider = new BoxesTreeDataProvider({} as any, {} as any);
    const boxItem = new BoxTreeItem({
      id: 'box-abcdef01',
      name: 'web-srv',
      status: 'running'
    });

    const children = await provider.getChildren(boxItem);
    const stopNode = children.find((c) => c.label === 'Stop Box');
    assert.ok(stopNode, 'Expected "Stop Box" child node for running box');
    assert.strictEqual(stopNode.command?.command, 'boxlite.stopBox');
  });

  it('should expose Start Box action child node for stopped boxes', async () => {
    const provider = new BoxesTreeDataProvider({} as any, {} as any);
    const boxItem = new BoxTreeItem({
      id: 'box-abcdef02',
      name: 'web-srv-2',
      status: 'stopped'
    });

    const children = await provider.getChildren(boxItem);
    const startNode = children.find((c) => c.label === 'Start Box');
    assert.ok(startNode, 'Expected "Start Box" child node for stopped box');
    assert.strictEqual(startNode.command?.command, 'boxlite.startBox');
  });

  it('should toggle Stop Streaming Logs when streaming is active', async () => {
    const mockLogManager: any = {
      isStreaming: (id: string) => id === 'box-active-log'
    };
    const provider = new BoxesTreeDataProvider({} as any, {} as any, mockLogManager);

    const activeItem = new BoxTreeItem({
      id: 'box-active-log',
      name: 'active',
      status: 'running'
    });
    const inactiveItem = new BoxTreeItem({
      id: 'box-inactive-log',
      name: 'inactive',
      status: 'running'
    });

    const activeChildren = await provider.getChildren(activeItem);
    assert.ok(activeChildren.some((c) => c.label === 'Stop Streaming Logs'));

    const inactiveChildren = await provider.getChildren(inactiveItem);
    assert.ok(inactiveChildren.some((c) => c.label === 'Application Logs'));
  });

  it('should format description with normalized status and ID prefix', () => {
    const item = new BoxTreeItem({
      id: '01HJK4TNRPQSXYZ8WM6NCVT9R5',
      name: 'prod-box',
      status: 'running',
      image: 'python:3.11'
    });
    assert.strictEqual(item.description, 'running · 01HJK4TN');
    assert.strictEqual(String(item.tooltip).includes('Status: running'), true);
  });

  it('should fallback to unknown when status is missing or empty', () => {
    const item = new BoxTreeItem({
      id: '01HJK4TNRPQSXYZ8WM6NCVT9R5',
      name: 'empty-box',
      status: ''
    });
    assert.strictEqual(item.description, 'unknown · 01HJK4TN');
    assert.strictEqual(String(item.tooltip).includes('Status: unknown'), true);
    assert.strictEqual(item.contextValue?.includes('box-unknown'), true);
  });

  it('should configure AccountTreeItem with account-signed-in context when authenticated', () => {
    const signedInItem = new AccountTreeItem('https://api.boxlite.ai', 'test-api-key');
    assert.strictEqual(signedInItem.contextValue, 'account-signed-in');
    assert.strictEqual(signedInItem.label, 'BoxLite Cloud Account');

    const signedOutItem = new AccountTreeItem('https://api.boxlite.ai', undefined);
    assert.strictEqual(signedOutItem.contextValue, 'account-signed-out');
  });

  it('should contribute context menu commands for account-signed-in in package.json', () => {
    const pkg = require('../../package.json');
    const contextMenus = pkg.contributes?.menus?.['view/item/context'] || [];
    const accountMenus = contextMenus.filter(
      (m: any) => m.when && m.when.includes("viewItem == 'account-signed-in'")
    );

    const commands = accountMenus.map((m: any) => m.command);
    assert.ok(commands.includes('boxlite.createBox'), 'Expected createBox in account context menu');
    assert.ok(commands.includes('boxlite.createBoxWithOptions'), 'Expected createBoxWithOptions in account context menu');
    assert.ok(commands.includes('boxlite.signOut'), 'Expected signOut in account context menu');
  });

  it('should stop log streaming immediately before stopping box', async () => {
    const vscode = require('vscode');
    const { registerCommands } = require('../src/commands');

    const executionOrder: string[] = [];
    const mockBridge: any = {
      stopBox: async (_id: string) => {
        executionOrder.push('bridge.stopBox');
        return { boxId: _id, status: 'stopped' };
      }
    };
    const mockLogManager: any = {
      stopStreaming: (_id: string) => {
        executionOrder.push('logManager.stopStreaming');
      }
    };
    const mockTreeProvider: any = {
      refresh: () => {}
    };

    const subscriptions: any[] = [];
    registerCommands(
      { subscriptions } as any,
      mockBridge,
      {} as any,
      {} as any,
      mockTreeProvider,
      {} as any,
      mockLogManager
    );

    const boxItem = new BoxTreeItem({
      id: 'box-test-order',
      name: 'test-box',
      status: 'running'
    });

    await vscode.commands.executeCommand('boxlite.stopBox', boxItem);
    assert.deepStrictEqual(executionOrder, ['logManager.stopStreaming', 'bridge.stopBox']);
  });
});
