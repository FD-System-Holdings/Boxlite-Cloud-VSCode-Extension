import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { CredentialsManager } from '../src/auth/credentials';
import { SecretsManager } from '../src/auth/secretsStore';
import { BoxLiteBridgeClient } from '../src/bridge/client';
import { PythonEnvManager } from '../src/bridge/env';
import { createSafeLazyOutputChannel } from '../src/extension';
import { AccountTreeDataProvider } from '../src/tree/accountProvider';
import { BoxesTreeDataProvider } from '../src/tree/boxesProvider';
import { ImagesTreeDataProvider } from '../src/tree/imagesProvider';
import { VolumesTreeDataProvider } from '../src/tree/volumesProvider';
import { CheckpointsTreeDataProvider } from '../src/tree/checkpointsProvider';
import { SecretsTreeDataProvider } from '../src/tree/secretsProvider';
import { createCleanSubprocessEnv, parseExecutableCommand } from '../src/util/process';

describe('Startup Focus Crash Prevention & Hardening', () => {
  const repoRoot = path.resolve(__dirname, '../..');

  describe('Manifest & Launch Assets', () => {
    it('ensures package.json icon and activitybar icon files exist on disk', () => {
      const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf-8'));

      assert.ok(pkg.icon, 'Expected top-level package.json icon');
      assert.strictEqual(
        fs.existsSync(path.join(repoRoot, pkg.icon)),
        true,
        `Missing extension icon file on disk: ${pkg.icon}`
      );

      const containers: Array<{ id: string; icon?: string }> =
        pkg.contributes?.viewsContainers?.activitybar || [];
      assert.ok(containers.length > 0, 'Expected at least one activitybar viewContainer');
      for (const container of containers) {
        assert.ok(container.icon, `Expected icon on activitybar container ${container.id}`);
        assert.strictEqual(
          fs.existsSync(path.join(repoRoot, container.icon!)),
          true,
          `Missing activitybar container icon file on disk: ${container.icon}`
        );
      }
    });

    it('configures Run Extension launch profile with autoAttachChildProcesses=false and without disabling user extensions', () => {
      const launch = JSON.parse(fs.readFileSync(path.join(repoRoot, '.vscode', 'launch.json'), 'utf-8'));
      const runExt = (launch.configurations || []).find((c: { name?: string }) => c.name === 'Run Extension');
      assert.ok(runExt, 'Expected Run Extension configuration in .vscode/launch.json');
      assert.strictEqual(runExt.autoAttachChildProcesses, false);
      assert.strictEqual(
        (runExt.args || []).includes('--disable-extensions'),
        false,
        'Run Extension must not pass --disable-extensions'
      );
    });
  });

  describe('Subprocess Environment Sanitization', () => {
    const trackedVars = [
      'ELECTRON_RUN_AS_NODE',
      'VSCODE_INSPECTOR_OPTIONS',
      'NODE_OPTIONS',
      'VSCODE_ESM_ENTRYPOINT',
      'VSCODE_HANDLES_UNCAUGHT_ERRORS',
      'BOXLITE_TEST_PRESERVED_VAR'
    ];
    const savedEnv: Record<string, string | undefined> = {};

    beforeEach(() => {
      for (const k of trackedVars) {
        savedEnv[k] = process.env[k];
      }
    });

    afterEach(() => {
      for (const k of trackedVars) {
        if (savedEnv[k] === undefined) {
          delete process.env[k];
        } else {
          process.env[k] = savedEnv[k];
        }
      }
    });

    it('strips VS Code and Electron inspector env vars while keeping overrides', () => {
      process.env.ELECTRON_RUN_AS_NODE = '1';
      process.env.VSCODE_INSPECTOR_OPTIONS = '{"ipcAddress":"\\\\.\\pipe\\test"}';
      process.env.NODE_OPTIONS = '--require /tmp/bootloader.js';
      process.env.VSCODE_ESM_ENTRYPOINT = 'vs/workbench/api/node/extensionHostProcess';
      process.env.VSCODE_HANDLES_UNCAUGHT_ERRORS = 'true';
      process.env.BOXLITE_TEST_PRESERVED_VAR = 'keep-me';

      const clean = createCleanSubprocessEnv({ PYTHONUNBUFFERED: '1' });

      assert.strictEqual(clean.ELECTRON_RUN_AS_NODE, undefined);
      assert.strictEqual(clean.VSCODE_INSPECTOR_OPTIONS, undefined);
      assert.strictEqual(clean.NODE_OPTIONS, undefined);
      assert.strictEqual(clean.VSCODE_ESM_ENTRYPOINT, undefined);
      assert.strictEqual(clean.VSCODE_HANDLES_UNCAUGHT_ERRORS, undefined);
      assert.strictEqual(clean.BOXLITE_TEST_PRESERVED_VAR, 'keep-me');
      assert.strictEqual(clean.PYTHONUNBUFFERED, '1');
    });

    it('parses py launcher flags cleanly without treating py -3 as a literal file path', () => {
      const parsed = parseExecutableCommand('  py -3  ');
      assert.strictEqual(parsed.bin, 'py');
      assert.deepStrictEqual(parsed.args, ['-3']);
    });
  });

  describe('CredentialsManager & SecretsManager Single-Flight Caching', () => {
    it('deduplicates concurrent CredentialsManager reads and updates cache on mutations', async () => {
      let getCount = 0;
      const storeMap = new Map<string, string>();
      storeMap.set(
        'boxlite.apiKeys',
        JSON.stringify({ activeId: 'k1', keys: [{ id: 'k1', name: 'Prod', key: 'blk_live_1' }] })
      );

      const secretStorage = {
        get: async (k: string) => {
          getCount++;
          await new Promise((r) => setTimeout(r, 15));
          return storeMap.get(k);
        },
        store: async (k: string, v: string) => {
          storeMap.set(k, v);
        },
        delete: async (k: string) => {
          storeMap.delete(k);
        }
      };

      const mgr = new CredentialsManager({ secrets: secretStorage } as unknown as vscode.ExtensionContext);

      // Fire 9 concurrent reads simulating activate() + all 6 sidebar views
      const results = await Promise.all([
        mgr.getApiKey(),
        mgr.getApiKey(),
        mgr.getApiKey(),
        mgr.getActiveKey(),
        mgr.listKeys(),
        mgr.getApiKey(),
        mgr.getApiKey(),
        mgr.getActiveKey(),
        mgr.listKeys()
      ]);

      assert.strictEqual(getCount, 1, 'Concurrent startup reads must coalesce into a single SecretStorage.get');
      assert.strictEqual(results[0], 'blk_live_1');

      // Subsequent reads hit the in-memory cache
      assert.strictEqual(await mgr.getApiKey(), 'blk_live_1');
      assert.strictEqual(getCount, 1);

      // Mutations keep cache coherent without redundant reads
      const k2 = await mgr.addKey('Staging', 'blk_live_2');
      assert.strictEqual(await mgr.getApiKey(), 'blk_live_2');
      assert.strictEqual(getCount, 1);

      await mgr.selectKey('k1');
      assert.strictEqual(await mgr.getApiKey(), 'blk_live_1');

      await mgr.removeKey(k2);
      assert.strictEqual((await mgr.listKeys()).length, 1);

      await mgr.clearApiKey();
      assert.strictEqual(await mgr.getApiKey(), undefined);
    });

    it('deduplicates concurrent SecretsManager reads and survives SecretStorage errors during startup', async () => {
      let getCount = 0;
      const mgrFailing = new SecretsManager({
        secrets: {
          get: async () => {
            getCount++;
            throw new Error('Keychain locked during startup');
          },
          store: async () => {},
          delete: async () => {}
        }
      } as unknown as vscode.ExtensionContext);

      const failedConcurrent = await Promise.all([mgrFailing.listSecrets(), mgrFailing.listSecrets()]);
      assert.strictEqual(getCount, 1);
      assert.deepStrictEqual(failedConcurrent, [[], []]);

      // Successful store + read caching
      let okGetCount = 0;
      const storeMap = new Map<string, string>();
      const mgrOk = new SecretsManager({
        secrets: {
          get: async (k: string) => {
            okGetCount++;
            await new Promise((r) => setTimeout(r, 10));
            return storeMap.get(k);
          },
          store: async (k: string, v: string) => {
            storeMap.set(k, v);
          },
          delete: async (k: string) => {
            storeMap.delete(k);
          }
        }
      } as unknown as vscode.ExtensionContext);

      await mgrOk.saveSecret({
        name: 'openai',
        value: 'sk-test-123',
        hosts: ['api.openai.com'],
        headers: { Authorization: 'Bearer {value}' }
      });

      const [listA, listB] = await Promise.all([mgrOk.listSecrets(), mgrOk.listSecrets()]);
      assert.strictEqual(listA.length, 1);
      assert.strictEqual(listB.length, 1);
      assert.strictEqual(okGetCount, 1);
    });
  });

  describe('BoxLiteBridgeClient Coalescing & Safe Logging', () => {
    it('coalesces concurrent listBoxes, listImages, listVolumes, and listCheckpoints RPCs', async () => {
      const mockChannel = {
        name: 'BoxLite Test',
        append: () => {},
        appendLine: () => {},
        replace: () => {},
        clear: () => {},
        show: () => {},
        hide: () => {},
        dispose: () => {}
      } as unknown as vscode.OutputChannel;

      const client = new BoxLiteBridgeClient(
        {} as vscode.ExtensionContext,
        {} as CredentialsManager,
        {} as never,
        mockChannel
      );

      const opCounts: Record<string, number> = {};
      (client as unknown as { sendRequest: (op: string) => Promise<unknown> }).sendRequest = async (op: string) => {
        opCounts[op] = (opCounts[op] || 0) + 1;
        await new Promise((r) => setTimeout(r, 15));
        if (op === 'list_boxes') return { boxes: [{ id: 'box-1', name: 'b1', status: 'running' }] };
        if (op === 'list_images') return { images: [{ name: 'alpine' }] };
        if (op === 'list_volumes') return { volumes: [{ id: 'vol-1', name: 'v1', state: 'ready' }] };
        if (op === 'list_checkpoints') return { checkpoints: [{ id: 'chk-1', name: 'c1', sourceBoxId: 'box-1', state: 'ready' }] };
        return {};
      };

      const [boxes1, boxes2, boxes3, boxes4] = await Promise.all([
        client.listBoxes(),
        client.listBoxes(),
        client.listBoxes(),
        client.listBoxes()
      ]);
      assert.strictEqual(opCounts['list_boxes'], 1, 'Expected 4 concurrent listBoxes calls to send 1 RPC');
      assert.strictEqual(boxes1.length, 1);
      assert.strictEqual(boxes4[0].id, boxes2[0].id);
      assert.strictEqual(boxes3[0].id, 'box-1');

      await Promise.all([
        client.listImages(),
        client.listImages(),
        client.listVolumes(),
        client.listVolumes(),
        client.listCheckpoints(),
        client.listCheckpoints()
      ]);
      assert.strictEqual(opCounts['list_images'], 1);
      assert.strictEqual(opCounts['list_volumes'], 1);
      assert.strictEqual(opCounts['list_checkpoints'], 1);

      // Next call after completion starts a fresh RPC
      await client.listBoxes();
      assert.strictEqual(opCounts['list_boxes'], 2);
    });

    it('swallows Channel has been closed errors when logging or disposing', () => {
      const closedChannel = {
        name: 'Closed Channel',
        append: () => {
          throw new Error('Channel has been closed');
        },
        appendLine: () => {
          throw new Error('Channel has been closed');
        },
        replace: () => {},
        clear: () => {},
        show: () => {},
        hide: () => {},
        dispose: () => {}
      } as unknown as vscode.OutputChannel;

      const client = new BoxLiteBridgeClient(
        {} as vscode.ExtensionContext,
        {} as CredentialsManager,
        {} as never,
        closedChannel
      );

      assert.doesNotThrow(() => {
        (client as unknown as { safeLog: (msg: string) => void }).safeLog('[bridge] test line');
        (client as unknown as { handleStdoutLine: (line: string) => void }).handleStdoutLine('not-json');
        client.dispose();
        (client as unknown as { safeLog: (msg: string) => void }).safeLog('[bridge] after dispose');
      });
    });
  });

  describe('createSafeLazyOutputChannel', () => {
    const mockVscode = vscode.window as unknown as { createOutputChannel: (name: string) => vscode.OutputChannel };
    const origCreateOutputChannel = mockVscode.createOutputChannel;

    afterEach(() => {
      mockVscode.createOutputChannel = origCreateOutputChannel;
    });

    it('defers createOutputChannel until flush() or show(), replays buffered lines, and guards closed channels', () => {
      let createCalls = 0;
      const recorded: string[] = [];
      let isClosed = false;

      mockVscode.createOutputChannel = (_name: string) => {
        createCalls++;
        return {
          name: _name,
          append: (v: string) => {
            if (isClosed) throw new Error('Channel has been closed');
            recorded.push(`append:${v}`);
          },
          appendLine: (v: string) => {
            if (isClosed) throw new Error('Channel has been closed');
            recorded.push(`line:${v}`);
          },
          replace: (v: string) => {
            if (isClosed) throw new Error('Channel has been closed');
            recorded.push(`replace:${v}`);
          },
          clear: () => {},
          show: () => {
            if (isClosed) throw new Error('Channel has been closed');
            recorded.push('show');
          },
          hide: () => {},
          dispose: () => {
            isClosed = true;
          }
        } as unknown as vscode.OutputChannel;
      };

      const ch = createSafeLazyOutputChannel('BoxLite Cloud');
      ch.appendLine('boot 1');
      ch.append('boot 2');
      assert.strictEqual(createCalls, 0, 'Must not call createOutputChannel before flush() or show()');

      ch.flush();
      assert.strictEqual(createCalls, 1);
      assert.deepStrictEqual(recorded, ['line:boot 1', 'append:boot 2']);

      ch.appendLine('after flush');
      assert.deepStrictEqual(recorded, ['line:boot 1', 'append:boot 2', 'line:after flush']);

      isClosed = true;
      assert.doesNotThrow(() => {
        ch.appendLine('on shutdown');
        ch.show(true);
        ch.dispose();
        ch.appendLine('post dispose');
      });

      // Second channel verifying show() triggers immediate creation + flush
      createCalls = 0;
      isClosed = false;
      recorded.length = 0;
      const chShow = createSafeLazyOutputChannel('BoxLite Early Show');
      chShow.appendLine('early line');
      assert.strictEqual(createCalls, 0);
      chShow.show(true);
      assert.strictEqual(createCalls, 1);
      assert.deepStrictEqual(recorded, ['line:early line', 'show']);
    });
  });

  describe('TreeDataProvider Startup Readiness Gate', () => {
    it('returns empty [] without querying SecretStorage or Bridge while startupReady is false, then loads after setStartupReady(true)', async () => {
      let credCalls = 0;
      let bridgeCalls = 0;

      const spyCreds = {
        getApiKey: async () => {
          credCalls++;
          return 'blk_live_mock';
        },
        getRestUrl: () => 'https://api.boxlite.ai',
        getActiveKey: async () => ({ id: 'k1', name: 'Default' }),
        listKeys: async () => [{ id: 'k1', name: 'Default', active: true }]
      } as unknown as CredentialsManager;

      const spyBridge = {
        listBoxes: async () => {
          bridgeCalls++;
          return [{ id: 'box-1', name: 'my-box', status: 'running', image: 'python' }];
        },
        listImages: async () => {
          bridgeCalls++;
          return { images: [] };
        },
        listVolumes: async () => {
          bridgeCalls++;
          return [{ id: 'vol-1', name: 'my-vol', state: 'ready' }];
        },
        listCheckpoints: async () => {
          bridgeCalls++;
          return [{ id: 'chk-1', name: 'my-chk', sourceBoxId: 'box-1', state: 'ready' }];
        }
      } as unknown as BoxLiteBridgeClient;

      const spySecrets = {
        listSecrets: async () => {
          credCalls++;
          return [];
        }
      } as unknown as SecretsManager;

      const providers = [
        new AccountTreeDataProvider(spyCreds),
        new BoxesTreeDataProvider(spyBridge, spyCreds),
        new ImagesTreeDataProvider(spyBridge, spyCreds),
        new VolumesTreeDataProvider(spyBridge, spyCreds),
        new CheckpointsTreeDataProvider(spyBridge, spyCreds),
        new SecretsTreeDataProvider(spyBridge, spyCreds, spySecrets)
      ];

      for (const p of providers) {
        p.setStartupReady(false);
      }

      const gatedResults = await Promise.all(providers.map((p) => p.getChildren()));
      for (const res of gatedResults) {
        assert.deepStrictEqual(res, [], 'Expected [] while startupReady is false');
      }
      assert.strictEqual(credCalls, 0, 'Must not query credentials during gated startup tick');
      assert.strictEqual(bridgeCalls, 0, 'Must not query bridge during gated startup tick');

      for (const p of providers) {
        p.setStartupReady(true);
      }

      const readyResults = await Promise.all(providers.map((p) => p.getChildren()));
      for (const res of readyResults) {
        assert.ok(res.length > 0, 'Expected populated tree items once startupReady is true');
      }
      assert.ok(credCalls > 0);
      assert.ok(bridgeCalls > 0);
    });
  });

  describe('PythonEnvManager & Bridge Stdin Safety', () => {
    it('deduplicates concurrent getPythonPath() resolution calls', async () => {
      const dummyChannel = createSafeLazyOutputChannel('Test PythonEnv');
      const envMgr = new PythonEnvManager(
        { globalStorageUri: { fsPath: path.join(repoRoot, '.nonexistent-storage') } } as unknown as vscode.ExtensionContext,
        dummyChannel
      );

      let probeCount = 0;
      (envMgr as any).testExecutable = async () => {
        probeCount++;
        await new Promise((r) => setTimeout(r, 20));
        return true;
      };

      const results = await Promise.all([
        envMgr.getPythonPath(),
        envMgr.getPythonPath(),
        envMgr.getPythonPath(),
        envMgr.getPythonPath()
      ]);

      assert.strictEqual(probeCount, 1, 'Concurrent getPythonPath() calls must coalesce into one probe');
      assert.strictEqual(new Set(results).size, 1);
    });

    it('rejects cleanly when bridge stdin is closed or throws on write', async () => {
      const dummyChannel = createSafeLazyOutputChannel('Test Bridge Stdin');
      const client = new BoxLiteBridgeClient(
        { extensionPath: repoRoot } as unknown as vscode.ExtensionContext,
        { getApiKey: async () => 'blk_test', getRestUrl: () => 'https://api.boxlite.ai' } as unknown as CredentialsManager,
        { getPythonPath: async () => 'python3' } as unknown as PythonEnvManager,
        dummyChannel
      );

      (client as any).process = {
        killed: false,
        stdin: {
          destroyed: false,
          writable: true,
          write: () => {
            throw new Error('EPIPE');
          }
        },
        kill: () => true
      };

      await assert.rejects(() => client.sendRequest('list_boxes', {}, 1000), /EPIPE/);
      client.dispose();
    });
  });
});
