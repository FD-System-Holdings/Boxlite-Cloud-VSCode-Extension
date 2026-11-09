import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import { VolumeTreeItem, BoxTreeItem } from '../src/tree/nodes';
import { VolumesTreeDataProvider } from '../src/tree/volumesProvider';
import { BoxesTreeDataProvider } from '../src/tree/boxesProvider';
import { ProjectManager } from '../src/deploy/project';

describe('Volume Tree Items and Lifecycle Management', () => {
  it('should format ready volume with correct description, icon and contextValue', () => {
    const item = new VolumeTreeItem({
      id: 'vol_01k2example12345',
      name: 'postgres-data',
      state: 'ready',
      createdAt: '2026-11-08T12:00:00Z'
    });

    assert.strictEqual(item.label, 'postgres-data');
    assert.strictEqual(item.description, 'ready · vol_01k2');
    assert.ok(item.contextValue?.includes('volume-ready'));
    assert.ok(item.contextValue?.includes('volume-item'));
  });

  it('should format creating volume with transient spin icon and contextValue', () => {
    const item = new VolumeTreeItem({
      id: 'vol_01k2creating999',
      name: 'upload-cache',
      state: 'creating'
    });

    assert.strictEqual(item.description, 'creating · vol_01k2');
    assert.ok(item.contextValue?.includes('volume-creating'));
    assert.ok(!item.contextValue?.includes('volume-ready'));
  });

  it('should format deleting volume with trash contextValue', () => {
    const item = new VolumeTreeItem({
      id: 'vol_01k2deleting888',
      name: 'temp-vol',
      state: 'deleting'
    });

    assert.strictEqual(item.description, 'deleting · vol_01k2');
    assert.ok(item.contextValue?.includes('volume-deleting'));
  });

  it('should fallback to short ID label when name is not provided', () => {
    const item = new VolumeTreeItem({
      id: 'vol_01k2unnamed777',
      name: '',
      state: 'ready'
    });

    assert.strictEqual(item.label, 'vol-vol_01k2');
  });

  it('should provide complete children hierarchy for a Volume', async () => {
    const vol = new VolumeTreeItem({
      id: 'vol_01k2hierarchy123',
      name: 'app-storage',
      state: 'ready',
      createdAt: '2026-11-08T10:00:00Z'
    });

    const provider = new VolumesTreeDataProvider({} as any, { getApiKey: async () => 'key' } as any);
    const children = await provider.getChildren(vol);

    const idNode = children.find((c) => c.label === 'Volume ID');
    assert.ok(idNode, 'Expected "Volume ID" child node');
    assert.strictEqual(idNode.description, 'vol_01k2hierarchy123');
    assert.strictEqual(idNode.command?.command, 'boxlite.copyVolumeId');

    const stateNode = children.find((c) => c.label === 'State');
    assert.ok(stateNode, 'Expected "State" child node');
    assert.strictEqual(stateNode.description, 'ready');

    const createdNode = children.find((c) => c.label === 'Created At');
    assert.ok(createdNode, 'Expected "Created At" child node');
    assert.strictEqual(createdNode.description, '2026-11-08T10:00:00Z');

    const mountNode = children.find((c) => c.label === 'Mount in Box / Project...');
    assert.ok(mountNode, 'Expected "Mount in Box / Project..." child node');
    assert.strictEqual(mountNode.command?.command, 'boxlite.addVolumeToBox');

    const inspectNode = children.find((c) => c.label === 'Inspect Volume Details');
    assert.ok(inspectNode, 'Expected "Inspect Volume Details" child node');
    assert.strictEqual(inspectNode.command?.command, 'boxlite.inspectVolume');

    const deleteNode = children.find((c) => c.label === 'Delete Volume');
    assert.ok(deleteNode, 'Expected "Delete Volume" child node');
    assert.strictEqual(deleteNode.command?.command, 'boxlite.deleteVolume');
  });

  it('should show friendly empty state when no volumes exist', async () => {
    const mockBridge: any = {
      listVolumes: async () => []
    };
    const mockCredentials: any = {
      getApiKey: async () => 'test-key',
      getRestUrl: () => 'https://api.boxlite.ai'
    };

    const provider = new VolumesTreeDataProvider(mockBridge, mockCredentials);
    const rootItems = await provider.getChildren();

    assert.strictEqual(rootItems.length, 2); // AccountTreeItem + Empty State Item
    const emptyItem = rootItems[1];
    assert.strictEqual(emptyItem.label, 'No Managed Volumes');
    assert.strictEqual(emptyItem.command?.command, 'boxlite.createVolume');
  });

  it('should show error node when listVolumes fails', async () => {
    const mockBridge: any = {
      listVolumes: async () => {
        throw new Error('502 Bad Gateway / Cloud unavailable');
      }
    };
    const mockCredentials: any = {
      getApiKey: async () => 'test-key',
      getRestUrl: () => 'https://api.boxlite.ai'
    };

    const provider = new VolumesTreeDataProvider(mockBridge, mockCredentials);
    const rootItems = await provider.getChildren();

    assert.strictEqual(rootItems.length, 2);
    const errorItem = rootItems[1];
    assert.strictEqual(errorItem.label, 'Error loading volumes');
    assert.strictEqual(errorItem.command?.command, 'boxlite.refreshVolumes');
  });

  it('should present 403 forbidden resource with agent.md diagnosis guidance', async () => {
    const mockBridge: any = {
      listVolumes: async () => {
        throw new Error('BoxLite Cloud API error (403): Forbidden resource\nDiagnosis: 403 Forbidden: Check authentication/token and requested URL; do not assume either app health or one particular policy cause (agent.md §5). Note: do not infer managed database or shared-volume support (agent.md §4).');
      }
    };
    const mockCredentials: any = {
      getApiKey: async () => 'test-key',
      getRestUrl: () => 'https://api.boxlite.ai'
    };

    const provider = new VolumesTreeDataProvider(mockBridge, mockCredentials);
    const rootItems = await provider.getChildren();

    assert.strictEqual(rootItems.length, 2);
    const errorItem = rootItems[1];
    assert.strictEqual(errorItem.label, 'Error loading volumes');
    assert.ok(String(errorItem.description).includes('403 Forbidden'));
    assert.ok(String(errorItem.description).includes('agent.md §4'));
    assert.strictEqual(errorItem.contextValue, 'volume-forbidden');
    assert.ok(String(errorItem.tooltip).includes('agent.md §5'));
    assert.ok(String(errorItem.tooltip).includes('agent.md §4'));
  });
});

describe('Box Tree Display of Mounted Volumes', () => {
  it('should display mounted volume child node under Box when volumes are configured', async () => {
    const boxWithVolumes = new BoxTreeItem({
      id: 'box-vol-attached',
      name: 'database-srv',
      status: 'running',
      volumes: [
        {
          managed_volume: 'postgres-vol',
          guest_path: '/var/lib/postgresql/data',
          read_only: false
        }
      ]
    });

    const provider = new BoxesTreeDataProvider({} as any, {} as any);
    const children = await provider.getChildren(boxWithVolumes);

    const volumeChild = children.find((c) => typeof c.label === 'string' && c.label.includes('Volume: postgres-vol'));
    assert.ok(volumeChild, 'Expected mounted volume child node under Box');
    assert.strictEqual(volumeChild.description, 'Mounted at /var/lib/postgresql/data');
  });
});

describe('Project Configuration with Volumes in boxlite.json', () => {
  const tmpDir = path.join(__dirname, '..', 'out', 'test-vol-tmp');
  const tmpConfigFile = path.join(tmpDir, 'boxlite.json');

  beforeEach(() => {
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }
  });

  afterEach(() => {
    if (fs.existsSync(tmpConfigFile)) {
      fs.unlinkSync(tmpConfigFile);
    }
    if (fs.existsSync(tmpDir)) {
      try {
        fs.rmdirSync(tmpDir);
      } catch {
        // Ignore
      }
    }
  });

  it('should add volume mount to boxlite.json and update existing mount cleanly', async () => {
    const initialConfig = {
      name: 'test-app',
      image: 'python',
      volumes: []
    };
    fs.writeFileSync(tmpConfigFile, JSON.stringify(initialConfig, null, 2), 'utf-8');

    const fileUri = { fsPath: tmpConfigFile } as any;

    await ProjectManager.addVolumeMount(fileUri, {
      managed_volume: 'data-vol-1',
      guest_path: '/data',
      read_only: false
    });

    let saved = JSON.parse(fs.readFileSync(tmpConfigFile, 'utf-8'));
    assert.strictEqual(saved.volumes.length, 1);
    assert.strictEqual(saved.volumes[0].managed_volume, 'data-vol-1');
    assert.strictEqual(saved.volumes[0].guest_path, '/data');

    // Update same volume
    await ProjectManager.addVolumeMount(fileUri, {
      managed_volume: 'data-vol-1',
      guest_path: '/app/data',
      read_only: false
    });

    saved = JSON.parse(fs.readFileSync(tmpConfigFile, 'utf-8'));
    assert.strictEqual(saved.volumes.length, 1);
    assert.strictEqual(saved.volumes[0].guest_path, '/app/data');

    // Add second volume
    await ProjectManager.addVolumeMount(fileUri, {
      managed_volume: 'logs-vol-2',
      guest_path: '/var/log',
      read_only: false
    });

    saved = JSON.parse(fs.readFileSync(tmpConfigFile, 'utf-8'));
    assert.strictEqual(saved.volumes.length, 2);
  });
});

describe('Package.json Volumes UI Contribution Specifications', () => {
  it('should contribute boxlite.volumesView and all volume management commands', () => {
    const pkgPath = path.join(__dirname, '..', '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));

    // 1. Views
    const explorerViews = pkg.contributes?.views?.['boxlite-explorer'];
    assert.ok(explorerViews, 'Expected boxlite-explorer views contribution');
    const volumesView = explorerViews.find((v: any) => v.id === 'boxlite.volumesView');
    assert.ok(volumesView, 'Expected boxlite.volumesView view');
    assert.strictEqual(volumesView.name, 'Volumes');

    // 2. Commands
    const commands: any[] = pkg.contributes?.commands || [];
    const requiredCommands = [
      'boxlite.createVolume',
      'boxlite.refreshVolumes',
      'boxlite.deleteVolume',
      'boxlite.inspectVolume',
      'boxlite.copyVolumeId',
      'boxlite.copyVolumeName',
      'boxlite.addVolumeToBox'
    ];
    for (const cmd of requiredCommands) {
      assert.ok(
        commands.some((c) => c.command === cmd),
        `Expected command ${cmd} to be declared in package.json`
      );
    }

    // 3. Menus
    const titleMenus: any[] = pkg.contributes?.menus?.['view/title'] || [];
    assert.ok(
      titleMenus.some((m) => m.command === 'boxlite.createVolume' && m.when.includes('boxlite.volumesView')),
      'Expected createVolume in view/title for volumesView'
    );
    assert.ok(
      titleMenus.some((m) => m.command === 'boxlite.refreshVolumes' && m.when.includes('boxlite.volumesView')),
      'Expected refreshVolumes in view/title for volumesView'
    );

    const contextMenus: any[] = pkg.contributes?.menus?.['view/item/context'] || [];
    assert.ok(
      contextMenus.some((m) => m.command === 'boxlite.deleteVolume' && m.when.includes('boxlite.volumesView')),
      'Expected deleteVolume in view/item/context for volumesView'
    );
    assert.ok(
      contextMenus.some((m) => m.command === 'boxlite.addVolumeToBox' && m.when.includes('boxlite.volumesView')),
      'Expected addVolumeToBox in view/item/context for volumesView'
    );
  });
});

describe('Volume Creation Command Lifecycle', () => {
  it('should complete withProgress before awaiting showInformationMessage', async () => {
    const vscode = require('vscode');
    const { registerCommands } = require('../src/commands');

    let withProgressCompleted = false;
    let messageShownWhileProgressPending = false;
    let createdVolume = false;

    const originalWithProgress = vscode.window.withProgress;
    const originalShowInputBox = vscode.window.showInputBox;
    const originalShowInfo = vscode.window.showInformationMessage;

    try {
      vscode.window.showInputBox = async () => 'exampleName';
      vscode.window.withProgress = async (_options: any, task: any) => {
        const res = await task({ report: () => {} });
        withProgressCompleted = true;
        return res;
      };
      vscode.window.showInformationMessage = async () => {
        if (!withProgressCompleted) {
          messageShownWhileProgressPending = true;
        }
        return undefined;
      };

      const mockBridge: any = {
        createVolume: async (args: any) => {
          createdVolume = true;
          return { id: 'vol_test123', name: args.name || 'vol_test123', state: 'ready' };
        }
      };
      const mockVolumesProvider: any = {
        refresh: () => {}
      };

      registerCommands(
        { subscriptions: [] } as any,
        mockBridge,
        {} as any,
        {} as any,
        { refresh: () => {} } as any,
        {} as any,
        {} as any,
        mockVolumesProvider
      );

      const execResult = await vscode.commands.executeCommand('boxlite.createVolume');
      if (execResult instanceof Error) {
        throw execResult;
      }

      assert.strictEqual(createdVolume, true, 'Expected bridge.createVolume to have been called');
      assert.strictEqual(withProgressCompleted, true, 'Expected withProgress to have completed');
      assert.strictEqual(
        messageShownWhileProgressPending,
        false,
        'showInformationMessage must not be called while withProgress is still pending'
      );
    } finally {
      vscode.window.withProgress = originalWithProgress;
      vscode.window.showInputBox = originalShowInputBox;
      vscode.window.showInformationMessage = originalShowInfo;
    }
  });
});
