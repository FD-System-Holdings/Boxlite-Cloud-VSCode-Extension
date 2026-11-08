import * as assert from 'assert';
import { BoxTreeItem } from '../src/tree/nodes';
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
});
