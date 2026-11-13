import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { CheckpointTreeItem, CheckpointChildTreeItem } from '../src/tree/nodes';
import { CheckpointsTreeDataProvider } from '../src/tree/checkpointsProvider';
import { BoxesTreeDataProvider } from '../src/tree/boxesProvider';
import { registerCommands } from '../src/commands';

describe('Checkpoints Support', () => {
  const pkgPath = path.resolve(__dirname, '../../package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

  it('registers boxlite.checkpointsView after boxlite.volumesView and keeps account/images ordering intact', () => {
    const views = pkg.contributes.views['boxlite-explorer'];
    const ids = views.map((v: { id: string }) => v.id);

    const volumesIdx = ids.indexOf('boxlite.volumesView');
    const checkpointsIdx = ids.indexOf('boxlite.checkpointsView');
    assert.ok(volumesIdx !== -1, 'boxlite.volumesView must exist');
    assert.ok(checkpointsIdx !== -1, 'boxlite.checkpointsView must exist');
    assert.ok(checkpointsIdx > volumesIdx, 'boxlite.checkpointsView must appear after boxlite.volumesView');

    const commandIds = new Set(pkg.contributes.commands.map((c: { command: string }) => c.command));
    for (const cmd of [
      'boxlite.createCheckpoint',
      'boxlite.createCheckpointFromBox',
      'boxlite.createBoxFromCheckpoint',
      'boxlite.forkFleetFromCheckpoint',
      'boxlite.refreshCheckpoints',
      'boxlite.inspectCheckpoint',
      'boxlite.copyCheckpointId',
      'boxlite.copyCheckpointName',
      'boxlite.deleteCheckpoint'
    ]) {
      assert.ok(commandIds.has(cmd), `Expected command ${cmd} to be declared in package.json`);
    }

    const viewTitleMenus = pkg.contributes.menus['view/title'] || [];
    const checkpointTitleCommands = viewTitleMenus
      .filter((m: { when?: string }) => m.when?.includes('boxlite.checkpointsView'))
      .map((m: { command: string }) => m.command);
    assert.ok(checkpointTitleCommands.includes('boxlite.createCheckpoint'));
    assert.ok(checkpointTitleCommands.includes('boxlite.refreshCheckpoints'));

    const itemContextMenus = pkg.contributes.menus['view/item/context'] || [];
    const checkpointContextCommands = itemContextMenus
      .filter((m: { when?: string }) => m.when?.includes('boxlite.checkpointsView'))
      .map((m: { command: string }) => m.command);
    assert.ok(checkpointContextCommands.includes('boxlite.createBoxFromCheckpoint'));
    assert.ok(checkpointContextCommands.includes('boxlite.forkFleetFromCheckpoint'));
    assert.ok(checkpointContextCommands.includes('boxlite.inspectCheckpoint'));
    assert.ok(checkpointContextCommands.includes('boxlite.copyCheckpointId'));
    assert.ok(checkpointContextCommands.includes('boxlite.copyCheckpointName'));
    assert.ok(checkpointContextCommands.includes('boxlite.deleteCheckpoint'));

    const boxCheckpointMenu = itemContextMenus.find(
      (m: { command: string; when?: string }) =>
        m.command === 'boxlite.createCheckpointFromBox' && m.when?.includes('boxlite.boxesView')
    );
    assert.ok(boxCheckpointMenu, 'Expected boxlite.createCheckpointFromBox in boxlite.boxesView context menus');
  });

  it('formats CheckpointTreeItem across ready, creating, failed, deleting, and fallback names', () => {
    const ready = new CheckpointTreeItem({
      id: '01CHKREADY1234567890',
      name: 'warm-env',
      sourceBoxId: '01BOXSRC1234567890',
      state: 'ready',
      createdAt: '2026-11-12T10:00:00Z',
      sizeBytes: 1024 * 1024 * 512
    });
    assert.strictEqual(ready.label, 'warm-env');
    assert.ok(String(ready.description).includes('ready'));
    assert.ok(String(ready.description).includes('01CHKREA'));
    assert.ok(String(ready.description).includes('512 MiB'));
    assert.ok(ready.contextValue?.includes('checkpoint-ready'));

    const creating = new CheckpointTreeItem({
      id: '01CHKCREATING123456',
      name: '',
      sourceBoxId: '01BOXSRC1234567890',
      state: 'creating'
    });
    assert.strictEqual(creating.label, 'chk-01CHKCRE');
    assert.ok(String(creating.description).includes('creating'));
    assert.ok(creating.contextValue?.includes('checkpoint-creating'));

    const failed = new CheckpointTreeItem({
      id: '01CHKFAILED12345678',
      name: 'broken-snap',
      sourceBoxId: '01BOXSRC1234567890',
      state: 'failed',
      errorReason: 'Quota exceeded'
    });
    assert.ok(failed.contextValue?.includes('checkpoint-failed'));
    assert.ok(String(failed.tooltip).includes('Quota exceeded'));

    const deleting = new CheckpointTreeItem({
      id: '01CHKDELETING12345',
      name: 'old-snap',
      sourceBoxId: '01BOXSRC1234567890',
      state: 'deleting'
    });
    assert.ok(deleting.contextValue?.includes('checkpoint-deleting'));
  });

  it('handles CheckpointsTreeDataProvider signed-out, empty, populated, child hierarchy, and error states', async () => {
    const providerSignedOut = new CheckpointsTreeDataProvider(
      {} as never,
      { getApiKey: async () => undefined } as never
    );
    const signedOutNodes = await providerSignedOut.getChildren();
    assert.strictEqual(signedOutNodes.length, 1);
    assert.strictEqual(signedOutNodes[0].label, 'Sign in to BoxLite Cloud');

    const providerEmpty = new CheckpointsTreeDataProvider(
      { listCheckpoints: async () => [] } as never,
      { getApiKey: async () => 'blk_live_test' } as never
    );
    const emptyNodes = await providerEmpty.getChildren();
    assert.strictEqual(emptyNodes.length, 1);
    assert.strictEqual(emptyNodes[0].label, 'No Managed Checkpoints');

    const provider403 = new CheckpointsTreeDataProvider(
      {
        listCheckpoints: async () => {
          throw new Error('HTTP 403 Forbidden');
        }
      } as never,
      { getApiKey: async () => 'blk_live_test' } as never
    );
    const err403 = await provider403.getChildren();
    assert.strictEqual(err403[0].label, 'Error loading checkpoints');
    assert.ok(String(err403[0].description).includes('403 Forbidden'));

    const provider401 = new CheckpointsTreeDataProvider(
      {
        listCheckpoints: async () => {
          throw new Error('401 Unauthorized');
        }
      } as never,
      { getApiKey: async () => 'blk_live_test' } as never
    );
    const err401 = await provider401.getChildren();
    assert.strictEqual(err401[0].label, 'Error loading checkpoints');
    assert.ok(String(err401[0].description).includes('401 Unauthorized'));

    const providerGenericErr = new CheckpointsTreeDataProvider(
      {
        listCheckpoints: async () => {
          throw new Error('Network timeout');
        }
      } as never,
      { getApiKey: async () => 'blk_live_test' } as never
    );
    const errGeneric = await providerGenericErr.getChildren();
    assert.strictEqual(errGeneric[0].label, 'Error loading checkpoints');
    assert.ok(String(errGeneric[0].description).includes('Network timeout'));

    const providerPopulated = new CheckpointsTreeDataProvider(
      {
        listCheckpoints: async () => [
          {
            id: '01CHKLIST123456789',
            name: 'ci-base',
            sourceBoxId: '01BOXSRC987654321',
            state: 'ready',
            createdAt: '2026-11-12T10:00:00Z',
            sizeBytes: 2048
          }
        ]
      } as never,
      { getApiKey: async () => 'blk_live_test' } as never
    );
    const rootItems = await providerPopulated.getChildren();
    assert.strictEqual(rootItems.length, 1);
    assert.ok(rootItems[0] instanceof CheckpointTreeItem);

    const children = await providerPopulated.getChildren(rootItems[0]);
    assert.ok(children.length >= 6);
    assert.ok(children.every((c) => c instanceof CheckpointChildTreeItem));
    const labels = children.map((c) => String(c.label));
    assert.ok(labels.some((l) => l.includes('Create Box from Checkpoint...')));
    assert.ok(labels.some((l) => l.includes('Fork Worker Fleet...')));
    assert.ok(labels.some((l) => l.includes('Inspect Checkpoint Details')));
    assert.ok(labels.some((l) => l.includes('Delete Checkpoint')));
  });

  it('exposes Save Checkpoint action node under BoxesTreeDataProvider box items', async () => {
    const boxesProvider = new BoxesTreeDataProvider(
      {
        listBoxes: async () => [
          {
            id: '01BOX123',
            name: 'worker-src',
            status: 'stopped',
            image: 'python:3.12',
            cpus: 2,
            memoryMib: 2048
          }
        ]
      } as never,
      { getApiKey: async () => 'blk_live_test' } as never
    );

    const boxes = await boxesProvider.getChildren();
    assert.strictEqual(boxes.length, 1);
    const children = await boxesProvider.getChildren(boxes[0]);
    const saveCheckpointChild = children.find(
      (c) => c.label === 'Save Checkpoint...' && c.contextValue === 'box-checkpoint-action'
    );
    assert.ok(saveCheckpointChild, 'Expected Save Checkpoint... child item on BoxTreeItem');
    assert.strictEqual(saveCheckpointChild?.command?.command, 'boxlite.createCheckpointFromBox');
  });

  describe('Checkpoint Command Handlers', () => {
    function setupMockCommands() {
      const handlers = new Map<string, (...args: unknown[]) => unknown>();
      const origRegisterCommand = vscode.commands.registerCommand;
      const origExecuteCommand = vscode.commands.executeCommand;

      (vscode.commands as { registerCommand: unknown }).registerCommand = (
        id: string,
        handler: (...args: unknown[]) => unknown
      ) => {
        handlers.set(id, handler);
        return { dispose: () => undefined };
      };
      (vscode.commands as { executeCommand: unknown }).executeCommand = async () => undefined;

      const fakeContext = { subscriptions: [] } as unknown as vscode.ExtensionContext;
      const fakeEnvManager = { ensureReady: async () => true };
      const fakeTreeProvider = { refresh: () => undefined };
      const fakeDeployer = { deploy: async () => undefined };
      const fakeLogManager = { getChannel: () => ({ appendLine: () => undefined, show: () => undefined }) };
      const fakeVolumesProvider = { refresh: () => undefined };
      const fakeImagesProvider = { refresh: () => undefined };
      const fakeAccountProvider = { refresh: () => undefined };
      const fakeCheckpointsProvider = { refresh: () => undefined };

      const restore = () => {
        (vscode.commands as { registerCommand: unknown }).registerCommand = origRegisterCommand;
        (vscode.commands as { executeCommand: unknown }).executeCommand = origExecuteCommand;
      };

      const registerWithBridge = (bridge: Record<string, unknown>) => {
        registerCommands(
          fakeContext,
          bridge as never,
          { getCredentials: async () => ({ apiKey: 'blk_live_test' }) } as never,
          fakeEnvManager as never,
          fakeTreeProvider as never,
          fakeDeployer as never,
          fakeLogManager as never,
          fakeVolumesProvider as never,
          fakeImagesProvider as never,
          fakeAccountProvider as never,
          fakeCheckpointsProvider as never
        );
      };

      return { handlers, registerWithBridge, restore };
    }

    it('creates a checkpoint from a stopped box and finishes progress before showing confirmation', async () => {
      const { handlers, registerWithBridge, restore } = setupMockCommands();
      const origInput = vscode.window.showInputBox;
      const origProgress = vscode.window.withProgress;
      const origInfo = vscode.window.showInformationMessage;
      const events: string[] = [];

      try {
        registerWithBridge({
          listBoxes: async () => [{ id: '01BOXSTOPPED', name: 'stopped-box', status: 'stopped' }],
          getBox: async () => ({
            id: '01BOXSTOPPED',
            name: 'stopped-box',
            status: 'stopped',
            hasVolumes: false,
            hasSecrets: false
          }),
          createCheckpoint: async (args: { sourceBoxId: string; name?: string }) => {
            events.push(`create:${args.sourceBoxId}:${args.name}`);
            return {
              id: '01CHKNEW999999',
              name: args.name || 'chk-01CHKNEW',
              sourceBoxId: args.sourceBoxId,
              state: 'creating'
            };
          }
        });

        (vscode.window as { showInputBox: unknown }).showInputBox = async () => 'warm-snapshot';
        (vscode.window as { withProgress: unknown }).withProgress = async (
          _opts: unknown,
          task: (progress: unknown) => Promise<unknown>
        ) => {
          const res = await task({ report: () => undefined });
          events.push('progress-done');
          return res;
        };
        (vscode.window as { showInformationMessage: unknown }).showInformationMessage = async (msg: string) => {
          events.push(`info:${msg}`);
          return undefined;
        };

        const handler = handlers.get('boxlite.createCheckpointFromBox');
        assert.ok(handler);
        await handler!({ box: { id: '01BOXSTOPPED', name: 'stopped-box', status: 'stopped' } });

        assert.deepStrictEqual(events.slice(0, 2), ['create:01BOXSTOPPED:warm-snapshot', 'progress-done']);
        assert.ok(events[2]?.startsWith('info:Checkpoint '));
      } finally {
        (vscode.window as { showInputBox: unknown }).showInputBox = origInput;
        (vscode.window as { withProgress: unknown }).withProgress = origProgress;
        (vscode.window as { showInformationMessage: unknown }).showInformationMessage = origInfo;
        restore();
      }
    });

    it('rejects checkpoint creation when source box has attached volumes or secrets', async () => {
      const { handlers, registerWithBridge, restore } = setupMockCommands();
      const origError = vscode.window.showErrorMessage;
      let capturedError = '';
      let createCalled = false;

      try {
        registerWithBridge({
          listBoxes: async () => [{ id: '01BOXVOL', name: 'vol-box', status: 'stopped' }],
          inspectBox: async () => ({
            id: '01BOXVOL',
            name: 'vol-box',
            status: 'stopped',
            volumes: [{ name: 'my-vol', mountPoint: '/data' }],
            secrets: []
          }),
          createCheckpoint: async () => {
            createCalled = true;
            return {};
          }
        });

        (vscode.window as { showErrorMessage: unknown }).showErrorMessage = async (msg: string) => {
          capturedError = msg;
          return undefined;
        };

        const handler = handlers.get('boxlite.createCheckpointFromBox');
        assert.ok(handler);
        await handler!({ box: { id: '01BOXVOL', name: 'vol-box', status: 'stopped' } });

        assert.strictEqual(createCalled, false);
        assert.ok(capturedError.includes('attached volumes'));
      } finally {
        (vscode.window as { showErrorMessage: unknown }).showErrorMessage = origError;
        restore();
      }
    });

    it('prompts before stopping a running box to capture a checkpoint', async () => {
      const { handlers, registerWithBridge, restore } = setupMockCommands();
      const origWarning = vscode.window.showWarningMessage;
      const origInput = vscode.window.showInputBox;
      const origProgress = vscode.window.withProgress;
      const origInfo = vscode.window.showInformationMessage;
      const calls: string[] = [];

      try {
        registerWithBridge({
          listBoxes: async () => [{ id: '01BOXRUN', name: 'run-box', status: 'running' }],
          inspectBox: async () => ({
            id: '01BOXRUN',
            name: 'run-box',
            status: 'running',
            volumes: [],
            secrets: []
          }),
          stopBox: async (id: string) => {
            calls.push(`stop:${id}`);
            return { ok: true, status: 'stopped' };
          },
          createCheckpoint: async (args: { sourceBoxId: string; name?: string }) => {
            calls.push(`create:${args.sourceBoxId}:${args.name}`);
            return { id: '01CHKAFTERSTOP', name: args.name || 'snap', sourceBoxId: args.sourceBoxId, state: 'ready' };
          }
        });

        (vscode.window as { showWarningMessage: unknown }).showWarningMessage = async () => 'Stop Box & Capture';
        (vscode.window as { showInputBox: unknown }).showInputBox = async () => 'after-stop';
        (vscode.window as { withProgress: unknown }).withProgress = async (
          _opts: unknown,
          task: (progress: unknown) => Promise<unknown>
        ) => task({ report: () => undefined });
        (vscode.window as { showInformationMessage: unknown }).showInformationMessage = async () => undefined;

        const handler = handlers.get('boxlite.createCheckpointFromBox');
        await handler!({ box: { id: '01BOXRUN', name: 'run-box', status: 'running' } });

        assert.deepStrictEqual(calls, ['stop:01BOXRUN', 'create:01BOXRUN:after-stop']);
      } finally {
        (vscode.window as { showWarningMessage: unknown }).showWarningMessage = origWarning;
        (vscode.window as { showInputBox: unknown }).showInputBox = origInput;
        (vscode.window as { withProgress: unknown }).withProgress = origProgress;
        (vscode.window as { showInformationMessage: unknown }).showInformationMessage = origInfo;
        restore();
      }
    });

    it('creates a single box from a checkpoint with only checkpoint and optional name', async () => {
      const { handlers, registerWithBridge, restore } = setupMockCommands();
      const origInput = vscode.window.showInputBox;
      const origProgress = vscode.window.withProgress;
      const origInfo = vscode.window.showInformationMessage;
      let receivedPayload: Record<string, unknown> | undefined;

      try {
        registerWithBridge({
          listCheckpoints: async () => [
            { id: '01CHKRESTORE', name: 'gold-img', sourceBoxId: '01BOXSRC', state: 'ready' }
          ],
          createBox: async (args: Record<string, unknown>) => {
            receivedPayload = args;
            return { id: '01BOXFORKED', name: args.name || 'forked', status: 'running' };
          }
        });

        (vscode.window as { showInputBox: unknown }).showInputBox = async () => 'restored-worker';
        (vscode.window as { withProgress: unknown }).withProgress = async (
          _opts: unknown,
          task: (progress: unknown) => Promise<unknown>
        ) => task({ report: () => undefined });
        (vscode.window as { showInformationMessage: unknown }).showInformationMessage = async () => undefined;

        const handler = handlers.get('boxlite.createBoxFromCheckpoint');
        await handler!({
          checkpoint: { id: '01CHKRESTORE', name: 'gold-img', sourceBoxId: '01BOXSRC', state: 'ready' }
        });

        assert.deepStrictEqual(receivedPayload, {
          checkpoint: '01CHKRESTORE',
          name: 'restored-worker'
        });
      } finally {
        (vscode.window as { showInputBox: unknown }).showInputBox = origInput;
        (vscode.window as { withProgress: unknown }).withProgress = origProgress;
        (vscode.window as { showInformationMessage: unknown }).showInformationMessage = origInfo;
        restore();
      }
    });

    it('forks N parallel fleet boxes from a checkpoint', async () => {
      const { handlers, registerWithBridge, restore } = setupMockCommands();
      const origInput = vscode.window.showInputBox;
      const origProgress = vscode.window.withProgress;
      const origInfo = vscode.window.showInformationMessage;
      const createdPayloads: Array<Record<string, unknown>> = [];
      let infoMessage = '';

      try {
        registerWithBridge({
          listCheckpoints: async () => [
            { id: '01CHKFLEET', name: 'agent-base', sourceBoxId: '01BOXSRC', state: 'ready' }
          ],
          createBox: async (args: Record<string, unknown>) => {
            createdPayloads.push(args);
            return { id: `01BOXW${createdPayloads.length}`, name: args.name, status: 'running' };
          }
        });

        const answers = ['3', 'eval-worker'];
        (vscode.window as { showInputBox: unknown }).showInputBox = async () => answers.shift();
        (vscode.window as { withProgress: unknown }).withProgress = async (
          _opts: unknown,
          task: (progress: unknown) => Promise<unknown>
        ) => task({ report: () => undefined });
        (vscode.window as { showInformationMessage: unknown }).showInformationMessage = async (msg: string) => {
          infoMessage = msg;
          return undefined;
        };

        const handler = handlers.get('boxlite.forkFleetFromCheckpoint');
        await handler!({
          checkpoint: { id: '01CHKFLEET', name: 'agent-base', sourceBoxId: '01BOXSRC', state: 'ready' }
        });

        assert.strictEqual(createdPayloads.length, 3);
        assert.deepStrictEqual(createdPayloads, [
          { checkpoint: '01CHKFLEET', name: 'eval-worker-1' },
          { checkpoint: '01CHKFLEET', name: 'eval-worker-2' },
          { checkpoint: '01CHKFLEET', name: 'eval-worker-3' }
        ]);
        assert.ok(infoMessage.includes('Forked 3 worker Boxes'));
      } finally {
        (vscode.window as { showInputBox: unknown }).showInputBox = origInput;
        (vscode.window as { withProgress: unknown }).withProgress = origProgress;
        (vscode.window as { showInformationMessage: unknown }).showInformationMessage = origInfo;
        restore();
      }
    });

    it('deletes a checkpoint with modal confirmation', async () => {
      const { handlers, registerWithBridge, restore } = setupMockCommands();
      const origWarning = vscode.window.showWarningMessage;
      const origProgress = vscode.window.withProgress;
      const origInfo = vscode.window.showInformationMessage;
      let removedArgs: { idOrName: string; force?: boolean } | undefined;

      try {
        registerWithBridge({
          listCheckpoints: async () => [
            { id: '01CHKDEL', name: 'stale-snap', sourceBoxId: '01BOXSRC', state: 'ready' }
          ],
          removeCheckpoint: async (idOrName: string, force?: boolean) => {
            removedArgs = { idOrName, force };
            return { ok: true };
          }
        });

        (vscode.window as { showWarningMessage: unknown }).showWarningMessage = async () => 'Delete (Force)';
        (vscode.window as { withProgress: unknown }).withProgress = async (
          _opts: unknown,
          task: (progress: unknown) => Promise<unknown>
        ) => task({ report: () => undefined });
        (vscode.window as { showInformationMessage: unknown }).showInformationMessage = async () => undefined;

        const handler = handlers.get('boxlite.deleteCheckpoint');
        await handler!({
          checkpoint: { id: '01CHKDEL', name: 'stale-snap', sourceBoxId: '01BOXSRC', state: 'ready' }
        });

        assert.deepStrictEqual(removedArgs, { idOrName: '01CHKDEL', force: true });
      } finally {
        (vscode.window as { showWarningMessage: unknown }).showWarningMessage = origWarning;
        (vscode.window as { withProgress: unknown }).withProgress = origProgress;
        (vscode.window as { showInformationMessage: unknown }).showInformationMessage = origInfo;
        restore();
      }
    });
  });
});
