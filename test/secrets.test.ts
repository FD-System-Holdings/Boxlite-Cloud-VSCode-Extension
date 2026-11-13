import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { SecretsManager } from '../src/auth/secretsStore';
import { SecretsTreeDataProvider } from '../src/tree/secretsProvider';
import { BoxesTreeDataProvider } from '../src/tree/boxesProvider';
import { BoxTreeItem, SecretTreeItem } from '../src/tree/nodes';
import { ProjectManager } from '../src/deploy/project';
import {
  BOX_TEMPLATES,
  convertBoxConfigToCreateArgs,
  getDefaultBoxConfiguration,
  BoxConfiguration
} from '../src/commands/boxConfiguration';
import { registerCommands } from '../src/commands';

const mockVscode: any = vscode;

function createMockContext() {
  const secretStore = new Map<string, string>();
  const globalStore = new Map<string, any>();
  return {
    subscriptions: [] as Array<{ dispose?: () => void }>,
    extensionUri: mockVscode.Uri.file(path.resolve(__dirname, '../..')),
    globalState: {
      get: (k: string, def?: any) => (globalStore.has(k) ? globalStore.get(k) : def),
      update: async (k: string, v: any) => {
        globalStore.set(k, v);
      }
    },
    secrets: {
      get: async (k: string) => secretStore.get(k),
      store: async (k: string, v: string) => {
        secretStore.set(k, v);
      },
      delete: async (k: string) => {
        secretStore.delete(k);
      }
    }
  } as unknown as vscode.ExtensionContext;
}

describe('Outbound Proxy Secrets Support (docs.boxlite.ai/cloud/secrets)', () => {
  const origEnv = mockVscode.env;
  const origWorkspaceFolders = mockVscode.workspace.workspaceFolders;
  const origShowInputBox = mockVscode.window.showInputBox;
  const origShowQuickPick = mockVscode.window.showQuickPick;
  const origShowInfo = mockVscode.window.showInformationMessage;
  const origShowWarn = mockVscode.window.showWarningMessage;
  const origShowErr = mockVscode.window.showErrorMessage;
  const origWithProgress = mockVscode.window.withProgress;
  const origRegisterCommand = mockVscode.commands.registerCommand;

  afterEach(() => {
    mockVscode.env = origEnv;
    mockVscode.workspace.workspaceFolders = origWorkspaceFolders;
    mockVscode.window.showInputBox = origShowInputBox;
    mockVscode.window.showQuickPick = origShowQuickPick;
    mockVscode.window.showInformationMessage = origShowInfo;
    mockVscode.window.showWarningMessage = origShowWarn;
    mockVscode.window.showErrorMessage = origShowErr;
    mockVscode.window.withProgress = origWithProgress;
    mockVscode.commands.registerCommand = origRegisterCommand;
  });

  describe('package.json contributions', () => {
    const pkgPath = path.resolve(__dirname, '..', '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));

    it('declares boxlite.secretsView right after boxlite.checkpointsView', () => {
      const views: Array<{ id: string; name: string }> = pkg.contributes.views['boxlite-explorer'];
      const chkIdx = views.findIndex((v) => v.id === 'boxlite.checkpointsView');
      const secIdx = views.findIndex((v) => v.id === 'boxlite.secretsView');
      assert.ok(chkIdx >= 0, 'checkpointsView missing');
      assert.strictEqual(secIdx, chkIdx + 1, 'secretsView should immediately follow checkpointsView');
      assert.strictEqual(views[secIdx].name, 'Secrets');
    });

    it('registers all 10 secret commands and expected menus', () => {
      const commandIds = new Set((pkg.contributes.commands as Array<{ command: string }>).map((c) => c.command));
      const expected = [
        'boxlite.refreshSecrets',
        'boxlite.createSecret',
        'boxlite.createBoxWithSecret',
        'boxlite.addSecretToProject',
        'boxlite.rotateSecret',
        'boxlite.copySecretPlaceholder',
        'boxlite.copySecretHeader',
        'boxlite.copySecretSnippet',
        'boxlite.verifySecretInjection',
        'boxlite.deleteSecret'
      ];
      for (const id of expected) {
        assert.ok(commandIds.has(id), `Missing command in package.json: ${id}`);
      }

      const viewTitleMenus = pkg.contributes.menus['view/title'] as Array<{ command: string; when: string }>;
      assert.ok(viewTitleMenus.some((m) => m.command === 'boxlite.createSecret' && m.when === 'view == boxlite.secretsView'));
      assert.ok(
        viewTitleMenus.some((m) => m.command === 'boxlite.verifySecretInjection' && m.when === 'view == boxlite.secretsView')
      );

      const itemMenus = pkg.contributes.menus['view/item/context'] as Array<{ command: string; when: string }>;
      for (const cmd of [
        'boxlite.createBoxWithSecret',
        'boxlite.addSecretToProject',
        'boxlite.copySecretPlaceholder',
        'boxlite.copySecretHeader',
        'boxlite.copySecretSnippet',
        'boxlite.rotateSecret',
        'boxlite.deleteSecret'
      ]) {
        assert.ok(
          itemMenus.some((m) => m.command === cmd && m.when.includes('view == boxlite.secretsView')),
          `Missing view/item/context menu for ${cmd}`
        );
      }
    });
  });

  describe('SecretsManager CRUD, redaction, and resolution', () => {
    it('stores, lists, updates, resolves, and removes proxy secrets safely', async () => {
      const ctx = createMockContext();
      const mgr = new SecretsManager(ctx);

      await mgr.saveSecret({
        name: 'openai',
        value: 'sk-test-real-value-1',
        hosts: ['api.openai.com'],
        headers: { Authorization: 'Bearer {value}' },
        envVar: 'OPENAI_API_KEY'
      });

      const list = await mgr.listSecrets();
      assert.strictEqual(list.length, 1);
      assert.strictEqual(list[0].name, 'openai');
      assert.strictEqual(list[0].value, 'sk-test-real-value-1');

      assert.strictEqual(SecretsManager.getPlaceholder('openai'), '<BOXLITE_SECRET:openai>');
      assert.strictEqual(
        SecretsManager.getGuestHeaderExample({ name: 'openai', headers: { Authorization: 'Bearer {value}' } }),
        'Authorization: Bearer <BOXLITE_SECRET:openai>'
      );

      const redacted = SecretsManager.toConfigSpec(list[0]);
      assert.strictEqual((redacted as any).value, undefined, 'toConfigSpec must strip raw value');
      assert.deepStrictEqual(redacted.hosts, ['api.openai.com']);

      const resolved = await mgr.resolveSecrets([
        redacted,
        { name: 'anthropic', hosts: ['api.anthropic.com'], headers: { 'x-api-key': '{value}' } }
      ]);
      assert.strictEqual(resolved.resolved.length, 1);
      assert.strictEqual(resolved.resolved[0].value, 'sk-test-real-value-1');
      assert.deepStrictEqual(resolved.missing, ['anthropic']);

      assert.strictEqual(await mgr.removeSecret('openai'), true);
      assert.strictEqual(await mgr.removeSecret('openai'), false);
      assert.strictEqual((await mgr.listSecrets()).length, 0);
    });
  });

  describe('SecretsTreeDataProvider & BoxesTreeDataProvider', () => {
    it('prompts to sign in when unauthenticated', async () => {
      const ctx = createMockContext();
      const mgr = new SecretsManager(ctx);
      const mockCreds = { getApiKey: async () => undefined } as any;
      const mockBridge = { listBoxes: async () => [] } as any;

      const provider = new SecretsTreeDataProvider(mockBridge, mockCreds, mgr);
      const items = await provider.getChildren();
      assert.strictEqual(items.length, 1);
      assert.strictEqual(items[0].label, 'Sign in to BoxLite Cloud');
    });

    it('merges workstation, project, and active box secrets without exposing raw values', async () => {
      const ctx = createMockContext();
      const mgr = new SecretsManager(ctx);
      await mgr.saveSecret({
        name: 'openai',
        value: 'sk-super-secret-value',
        hosts: ['api.openai.com'],
        headers: { Authorization: 'Bearer {value}' },
        envVar: 'OPENAI_API_KEY'
      });

      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boxlite-sec-tree-'));
      fs.writeFileSync(
        path.join(tmpDir, 'boxlite.json'),
        JSON.stringify({
          name: 'agent-app',
          secrets: [
            {
              name: 'openai',
              hosts: ['api.openai.com', 'oai.example.com'],
              headers: { Authorization: 'Bearer {value}' },
              envVar: 'OPENAI_API_KEY'
            }
          ]
        }),
        'utf-8'
      );
      mockVscode.workspace.workspaceFolders = [{ uri: mockVscode.Uri.file(tmpDir) }];

      try {
        const mockCreds = { getApiKey: async () => 'blk_live_mock' } as any;
        const mockBridge = {
          listBoxes: async () => [
            {
              id: 'box-1',
              name: 'agent-box',
              status: 'running',
              secrets: [{ name: 'openai', hosts: ['api.openai.com'], headers: { Authorization: 'Bearer {value}' } }]
            }
          ]
        } as any;

        const provider = new SecretsTreeDataProvider(mockBridge, mockCreds, mgr);
        const top = await provider.getChildren();
        assert.strictEqual(top.length, 2);
        assert.ok(top[0] instanceof SecretTreeItem);
        assert.strictEqual(top[1].contextValue, 'secret-verify-action');
        const secItem = top[0] as SecretTreeItem;
        assert.strictEqual(secItem.secret.name, 'openai');
        assert.strictEqual(secItem.secret.source, 'merged');
        assert.deepStrictEqual(secItem.secret.usedByBoxes, ['agent-box']);

        const children = await provider.getChildren(secItem);
        const joined = children.map((c) => `${c.label}: ${c.description}`).join('\n');
        assert.ok(joined.includes('<BOXLITE_SECRET:openai>'), 'Should display placeholder');
        assert.ok(joined.includes('api.openai.com'), 'Should display host');
        assert.ok(!joined.includes('sk-super-secret-value'), 'Must never display raw secret value in tree');
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('renders attached outbound proxy secrets under a Box node', async () => {
      const mockBridge = {
        listBoxes: async () => [],
        getBoxUrls: async () => [],
        getTunnels: async () => []
      } as any;
      const mockCreds = { getApiKey: async () => 'blk_live_mock' } as any;
      const provider = new BoxesTreeDataProvider(mockBridge, mockCreds);

      const boxNode = new BoxTreeItem({
        id: 'box-sec-1',
        name: 'secret-runner',
        status: 'running',
        image: 'python:alpine',
        secrets: [{ name: 'anthropic', hosts: ['api.anthropic.com'], headers: { 'x-api-key': '{value}' } }]
      });

      const children = await provider.getChildren(boxNode);
      const secChild = children.find((c) => (c.contextValue || '') === 'box-secret-item');
      assert.ok(secChild, 'Expected box-secret-item child under BoxTreeItem');
      assert.ok(String(secChild!.label).includes('anthropic'));
      assert.ok(String(secChild!.description).includes('<BOXLITE_SECRET:anthropic>'));
    });
  });

  describe('ProjectManager & BoxConfiguration integration', () => {
    it('adds redacted secret config and env placeholder to boxlite.json without ever writing raw value', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boxlite-proj-sec-'));
      const configPath = path.join(tmpDir, 'boxlite.json');
      fs.writeFileSync(configPath, JSON.stringify({ name: 'demo', image: 'python:alpine', env: {} }), 'utf-8');
      const fileUri = vscode.Uri.file(configPath);
      mockVscode.workspace.workspaceFolders = [{ uri: mockVscode.Uri.file(tmpDir) }];

      try {
        await ProjectManager.addSecretConfig(fileUri, {
          name: 'openai',
          value: 'sk-SHOULD-NOT-BE-WRITTEN',
          hosts: ['api.openai.com'],
          headers: { Authorization: 'Bearer {value}' },
          envVar: 'OPENAI_API_KEY'
        } as any);

        const rawText = fs.readFileSync(configPath, 'utf-8');
        assert.ok(!rawText.includes('sk-SHOULD-NOT-BE-WRITTEN'), 'Raw secret value must NEVER be written to boxlite.json');

        const parsed = JSON.parse(rawText);
        assert.strictEqual(parsed.secrets.length, 1);
        assert.strictEqual(parsed.secrets[0].name, 'openai');
        assert.strictEqual(parsed.secrets[0].value, undefined);
        assert.strictEqual(parsed.env.OPENAI_API_KEY, '<BOXLITE_SECRET:openai>');
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('includes llm-secret-box template and forwards secrets in convertBoxConfigToCreateArgs', () => {
      const tpl = BOX_TEMPLATES.find((t) => t.id === 'llm-secret-box');
      assert.ok(tpl, 'Expected llm-secret-box template in BOX_TEMPLATES');

      const config: BoxConfiguration = {
        ...getDefaultBoxConfiguration(),
        name: 'llm-runner',
        image: 'python:alpine',
        cpus: 2,
        memoryMib: 1024,
        diskSizeGb: 10,
        env: { OPENAI_API_KEY: '<BOXLITE_SECRET:openai>' },
        volumes: [],
        secrets: [
          {
            name: 'openai',
            value: 'sk-live-test',
            hosts: ['api.openai.com'],
            headers: { Authorization: 'Bearer {value}' }
          }
        ],
        autoStop: 900,
        autoDelete: 0,
        autoResume: true
      };

      const args = convertBoxConfigToCreateArgs(config);
      assert.strictEqual(args.secrets?.length, 1);
      assert.strictEqual(args.secrets?.[0].name, 'openai');
      assert.strictEqual(args.secrets?.[0].value, 'sk-live-test');
      assert.strictEqual(args.env?.OPENAI_API_KEY, '<BOXLITE_SECRET:openai>');
    });
  });

  describe('Secret command handlers', () => {
    function setupCommandsHarness() {
      const ctx = createMockContext();
      const secretsManager = new SecretsManager(ctx);
      let refreshCount = 0;
      const secretsProvider = { refresh: () => { refreshCount++; } } as any;
      const treeProvider = { refresh: () => {} } as any;
      const calls: Array<{ method: string; args?: any }> = [];

      const mockBridge = {
        createBox: async (args: any) => {
          calls.push({ method: 'createBox', args });
          return { boxId: 'box-new-1', name: args.name || 'box-new-1', status: 'running' };
        },
        inspectBox: async (boxId: string) => {
          calls.push({ method: 'inspectBox', args: boxId });
          return {
            id: boxId,
            name: 'old-llm-box',
            image: 'python:alpine',
            cpus: 2,
            memoryMib: 1024,
            secrets: [{ name: 'openai', hosts: ['api.openai.com'], headers: { Authorization: 'Bearer {value}' } }]
          };
        },
        removeBox: async (boxId: string) => {
          calls.push({ method: 'removeBox', args: boxId });
          return { boxId, removed: true };
        },
        listBoxes: async () => [
          { id: 'old-box-1', name: 'old-llm-box', status: 'running', image: 'python:alpine' }
        ],
        verifySecretInjection: async (args: any) => {
          calls.push({ method: 'verifySecretInjection', args });
          return {
            boxId: 'diag-box-1',
            envCheckPassed: true,
            headerInjectionPassed: true,
            cleanedUp: true,
            summary: 'ok'
          };
        }
      } as any;

      const mockCreds = {
        getApiKey: async () => 'blk_live_test'
      } as any;

      const copiedTexts: string[] = [];
      mockVscode.env = {
        ...origEnv,
        clipboard: {
          writeText: async (text: string) => {
            copiedTexts.push(text);
          }
        }
      };

      const infoMessages: string[] = [];
      mockVscode.window.showInformationMessage = async (msg: string) => {
        infoMessages.push(msg);
        return undefined;
      };
      mockVscode.window.showErrorMessage = async (msg: string) => {
        throw new Error(`Unexpected error message: ${msg}`);
      };
      mockVscode.window.withProgress = async (_opts: any, task: any) => task();

      const handlers = new Map<string, (...args: any[]) => any>();
      mockVscode.commands.registerCommand = (id: string, fn: (...args: any[]) => any) => {
        handlers.set(id, fn);
        return { dispose: () => {} };
      };

      registerCommands(
        ctx,
        mockBridge,
        mockCreds,
        {} as any,
        treeProvider,
        {} as any,
        {} as any,
        undefined,
        undefined,
        undefined,
        undefined,
        secretsProvider,
        secretsManager
      );

      return { secretsManager, handlers, calls, copiedTexts, infoMessages, getRefreshCount: () => refreshCount };
    }

    it('executes createSecret, copy placeholder/header/snippet, verify, rotate, and delete flows', async () => {
      const { secretsManager, handlers, calls, copiedTexts, infoMessages, getRefreshCount } = setupCommandsHarness();

      // 1. boxlite.createSecret
      const inputQueue = ['openai', 'api.openai.com', 'sk-secret-v1'];
      mockVscode.window.showInputBox = async () => inputQueue.shift();
      mockVscode.window.showQuickPick = async (items: any[]) => items[0]; // Authorization: Bearer {value}

      await handlers.get('boxlite.createSecret')!();
      const stored = await secretsManager.getSecret('openai');
      assert.ok(stored);
      assert.strictEqual(stored!.value, 'sk-secret-v1');
      assert.deepStrictEqual(stored!.hosts, ['api.openai.com']);
      assert.ok(getRefreshCount() >= 1);

      // 2. Copy placeholder, header, snippet
      await handlers.get('boxlite.copySecretPlaceholder')!('openai');
      await handlers.get('boxlite.copySecretHeader')!('openai');
      await handlers.get('boxlite.copySecretSnippet')!('openai');
      assert.strictEqual(copiedTexts[0], '<BOXLITE_SECRET:openai>');
      assert.strictEqual(copiedTexts[1], 'Authorization: Bearer <BOXLITE_SECRET:openai>');
      assert.ok(copiedTexts[2].includes('<BOXLITE_SECRET:openai>'));

      // 3. boxlite.createBoxWithSecret
      const boxInputs = ['agent-openai', 'OPENAI_API_KEY'];
      mockVscode.window.showInputBox = async () => boxInputs.shift();
      mockVscode.window.showQuickPick = async (items: any[]) => items[0]; // python:alpine
      await handlers.get('boxlite.createBoxWithSecret')!('openai');
      const createCall = calls.find((c) => c.method === 'createBox');
      assert.ok(createCall);
      assert.strictEqual(createCall!.args.name, 'agent-openai');
      assert.strictEqual(createCall!.args.env.OPENAI_API_KEY, '<BOXLITE_SECRET:openai>');
      assert.strictEqual(createCall!.args.secrets[0].value, 'sk-secret-v1');

      // 4. boxlite.rotateSecret + replace existing box + remove old box
      mockVscode.window.showInputBox = async () => 'sk-secret-v2';
      let quickPickStep = 0;
      mockVscode.window.showQuickPick = async (items: any[]) => {
        quickPickStep++;
        if (quickPickStep === 1) {
          return items.find((i) => i.action === 'replace') || items[0];
        }
        return items[0]; // pick old-box-1 in resolveBoxId
      };
      mockVscode.window.showInformationMessage = async (msg: string, ...buttons: string[]) => {
        infoMessages.push(msg);
        return buttons.includes('Remove Old Box') ? 'Remove Old Box' : undefined;
      };
      await handlers.get('boxlite.rotateSecret')!('openai');
      assert.strictEqual((await secretsManager.getSecret('openai'))?.value, 'sk-secret-v2');
      assert.ok(calls.some((c) => c.method === 'inspectBox' && c.args === 'old-box-1'));
      assert.ok(calls.some((c) => c.method === 'removeBox' && c.args === 'old-box-1'));

      // 5. boxlite.verifySecretInjection
      mockVscode.window.showInputBox = async () => 'python:alpine';
      await handlers.get('boxlite.verifySecretInjection')!();
      assert.ok(calls.some((c) => c.method === 'verifySecretInjection'));
      assert.ok(infoMessages.some((m) => m.includes('Secret injection verified')));

      // 6. boxlite.deleteSecret
      mockVscode.window.showWarningMessage = async (_msg: string, ...buttons: any[]) =>
        buttons.includes('Delete') ? 'Delete' : undefined;
      await handlers.get('boxlite.deleteSecret')!('openai');
      assert.strictEqual(await secretsManager.getSecret('openai'), undefined);
    });
  });
});
