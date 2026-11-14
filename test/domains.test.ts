import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { DomainsTreeDataProvider } from '../src/tree/domainsProvider';
import { DomainTreeItem } from '../src/tree/nodes';
import { DomainItem } from '../src/bridge/protocol';
import { validateCustomDomain } from '../src/util/validation';
import { registerCommands } from '../src/commands';

describe('Domains Support', () => {
  const pkgPath = path.resolve(__dirname, '../../package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));

  it('places boxlite.domainsView strictly under boxlite.boxesView and above boxlite.secretsView', () => {
    const views: Array<{ id: string; name: string }> = pkg.contributes.views['boxlite-explorer'];
    const boxesIdx = views.findIndex((v) => v.id === 'boxlite.boxesView');
    const domainsIdx = views.findIndex((v) => v.id === 'boxlite.domainsView');
    const secretsIdx = views.findIndex((v) => v.id === 'boxlite.secretsView');

    assert.ok(boxesIdx >= 0, 'boxlite.boxesView must exist');
    assert.ok(domainsIdx >= 0, 'boxlite.domainsView must exist');
    assert.ok(secretsIdx >= 0, 'boxlite.secretsView must exist');
    assert.strictEqual(domainsIdx, boxesIdx + 1, 'boxlite.domainsView must appear immediately under boxlite.boxesView');
    assert.strictEqual(secretsIdx, domainsIdx + 1, 'boxlite.domainsView must appear immediately above boxlite.secretsView');
    assert.strictEqual(views[domainsIdx].name, 'Domains');
  });

  it('registers all domain commands and view/title + view/item/context menus', () => {
    const commandIds = new Set((pkg.contributes.commands as Array<{ command: string }>).map((c) => c.command));
    const expected = [
      'boxlite.refreshDomains',
      'boxlite.createDomain',
      'boxlite.verifyDomain',
      'boxlite.bindDomainToBox',
      'boxlite.openDomainUrl',
      'boxlite.copyDomainName',
      'boxlite.inspectDomain',
      'boxlite.deleteDomain'
    ];
    for (const cmd of expected) {
      assert.ok(commandIds.has(cmd), `Expected command ${cmd} in package.json`);
    }

    const titleMenus: Array<{ command: string; when?: string }> = pkg.contributes.menus['view/title'] || [];
    assert.ok(titleMenus.some((m) => m.command === 'boxlite.refreshDomains' && m.when === 'view == boxlite.domainsView'));
    assert.ok(titleMenus.some((m) => m.command === 'boxlite.createDomain' && m.when === 'view == boxlite.domainsView'));

    const itemMenus: Array<{ command: string; when?: string }> = pkg.contributes.menus['view/item/context'] || [];
    for (const cmd of [
      'boxlite.verifyDomain',
      'boxlite.bindDomainToBox',
      'boxlite.openDomainUrl',
      'boxlite.copyDomainName',
      'boxlite.inspectDomain',
      'boxlite.deleteDomain'
    ]) {
      assert.ok(
        itemMenus.some((m) => m.command === cmd && m.when?.includes('view == boxlite.domainsView')),
        `Expected ${cmd} in view/item/context for boxlite.domainsView`
      );
    }
  });

  describe('validateCustomDomain', () => {
    it('accepts and normalizes valid FQDNs', () => {
      const res = validateCustomDomain('  App.Example.COM. ');
      assert.strictEqual(res.valid, true);
      assert.strictEqual(res.normalized, 'app.example.com');
    });

    it('rejects empty, schemes, paths, ports, wildcards, and IPv4', () => {
      assert.strictEqual(validateCustomDomain('').valid, false);
      assert.strictEqual(validateCustomDomain('https://app.example.com').valid, false);
      assert.strictEqual(validateCustomDomain('app.example.com/api').valid, false);
      assert.strictEqual(validateCustomDomain('app.example.com:8080').valid, false);
      assert.strictEqual(validateCustomDomain('*.example.com').valid, false);
      assert.strictEqual(validateCustomDomain('192.168.1.10').valid, false);
      assert.strictEqual(validateCustomDomain('localhost').valid, false);
    });

    it('warns on platform-managed boxlite.ai subdomains', () => {
      const res = validateCustomDomain('demo.boxlite.ai');
      assert.strictEqual(res.valid, true);
      assert.ok(res.warning && res.warning.includes('boxlite.ai'));
    });
  });

  it('formats DomainTreeItem across active, pending, failed, and deleting states', () => {
    const active = new DomainTreeItem({
      id: 'dom_1',
      domain: 'app.example.com',
      status: 'active',
      boxId: 'box_1',
      boxName: 'web-api',
      port: 8080,
      tlsStatus: 'issued'
    });
    assert.strictEqual(active.label, 'app.example.com');
    assert.strictEqual(active.description, 'active · → web-api:8080');
    assert.strictEqual(active.contextValue, 'domain-active');

    const pending = new DomainTreeItem({
      id: 'dom_2',
      domain: 'api.example.com',
      status: 'pending'
    });
    assert.strictEqual(pending.description, 'pending · unattached');
    assert.strictEqual(pending.contextValue, 'domain-pending');

    const failed = new DomainTreeItem({
      id: 'dom_3',
      domain: 'bad.example.com',
      status: 'failed',
      errorReason: 'TXT mismatch'
    });
    assert.strictEqual(failed.contextValue, 'domain-failed');
    assert.ok(String(failed.tooltip).includes('TXT mismatch'));

    const deleting = new DomainTreeItem({
      id: 'dom_4',
      domain: 'old.example.com',
      status: 'deleting'
    });
    assert.strictEqual(deleting.contextValue, 'domain-deleting');
  });

  it('handles DomainsTreeDataProvider startup gate, signed-out, empty, populated, child hierarchy, and error states', async () => {
    let apiKey: string | undefined = undefined;
    let domainsToReturn: DomainItem[] = [];
    let listError: Error | undefined = undefined;

    const mockBridge: any = {
      listDomains: async () => {
        if (listError) throw listError;
        return domainsToReturn;
      }
    };
    const mockCreds: any = {
      getApiKey: async () => apiKey
    };

    const provider = new DomainsTreeDataProvider(mockBridge, mockCreds);

    // Startup gate
    provider.setStartupReady(false);
    assert.deepStrictEqual(await provider.getChildren(), []);
    provider.setStartupReady(true);

    // Signed out
    const signedOut = await provider.getChildren();
    assert.strictEqual(signedOut.length, 1);
    assert.strictEqual(signedOut[0].label, 'Sign in to BoxLite Cloud');

    // Empty
    apiKey = 'blk_live_test';
    const empty = await provider.getChildren();
    assert.strictEqual(empty.length, 1);
    assert.strictEqual(empty[0].label, 'No Custom Domains');

    // Populated + children
    domainsToReturn = [
      {
        id: 'dom_abc',
        domain: 'app.example.com',
        status: 'pending',
        boxId: 'box_1',
        boxName: 'web',
        port: 8080,
        verificationMethod: 'TXT',
        verificationRecordName: '_boxlite.app.example.com',
        verificationRecordValue: 'verify-123',
        cnameTarget: 'edge.boxlite.ai',
        tlsStatus: 'pending'
      }
    ];
    const root = await provider.getChildren();
    assert.strictEqual(root.length, 1);
    assert.ok(root[0] instanceof DomainTreeItem);

    const children = await provider.getChildren(root[0]);
    const labels = children.map((c) => c.label);
    assert.ok(labels.includes('Status'));
    assert.ok(labels.includes('Target Box'));
    assert.ok(labels.includes('Verify DNS'));
    assert.ok(labels.includes('DNS TXT Record'));
    assert.ok(labels.includes('CNAME Target'));
    assert.ok(labels.includes('TLS Certificate'));
    assert.ok(labels.includes('Domain ID'));

    // 404/501 unavailable server error
    listError = new Error('HTTP 404 Not Found');
    const err404 = await provider.getChildren();
    assert.strictEqual(err404.length, 1);
    assert.strictEqual(err404[0].contextValue, 'domain-unavailable');
    provider.refresh(); // clears any pending auto-refresh timer
  });

  describe('Domain Command Handlers', () => {
    const origRegisterCommand = vscode.commands.registerCommand;
    const origShowInputBox = vscode.window.showInputBox;
    const origShowQuickPick = vscode.window.showQuickPick;
    const origShowInfo = vscode.window.showInformationMessage;
    const origShowWarning = vscode.window.showWarningMessage;
    const origWithProgress = vscode.window.withProgress;

    afterEach(() => {
      (vscode.commands as any).registerCommand = origRegisterCommand;
      (vscode.window as any).showInputBox = origShowInputBox;
      (vscode.window as any).showQuickPick = origShowQuickPick;
      (vscode.window as any).showInformationMessage = origShowInfo;
      (vscode.window as any).showWarningMessage = origShowWarning;
      (vscode.window as any).withProgress = origWithProgress;
    });

    it('executes createDomain, verifyDomain, bindDomainToBox, and deleteDomain flows', async () => {
      const handlers = new Map<string, (...args: any[]) => any>();
      (vscode.commands as any).registerCommand = (cmd: string, fn: (...args: any[]) => any) => {
        handlers.set(cmd, fn);
        return { dispose() {} };
      };
      (vscode.window as any).withProgress = async (_opts: any, task: any) => task({ report() {} });

      let createdPayload: any;
      let verifiedKey: string | undefined;
      let updatedPayload: any;
      let removedKey: string | undefined;
      let refreshCount = 0;

      const mockBridge: any = {
        listBoxes: async () => [{ id: 'box_1', name: 'api-box', status: 'running' }],
        listDomains: async () => [
          { id: 'dom_1', domain: 'api.example.com', status: 'pending', boxId: 'box_1', boxName: 'api-box', port: 8080 }
        ],
        createDomain: async (args: any) => {
          createdPayload = args;
          return { id: 'dom_1', domain: args.domain, status: 'pending', boxId: args.boxId, port: args.port };
        },
        verifyDomain: async (key: string) => {
          verifiedKey = key;
          return { id: 'dom_1', domain: 'api.example.com', status: 'active' };
        },
        updateDomain: async (args: any) => {
          updatedPayload = args;
          return { id: 'dom_1', domain: 'api.example.com', status: 'active', boxId: args.boxId, port: args.port };
        },
        removeDomain: async (key: string) => {
          removedKey = key;
          return { domainKey: key, removed: true };
        }
      };

      const mockCreds: any = { getApiKey: async () => 'blk_live_test' };
      const mockDomainsProvider: any = { refresh: () => { refreshCount++; } };

      registerCommands(
        { subscriptions: [] } as any,
        mockBridge,
        mockCreds,
        {} as any,
        { refresh() {} } as any,
        {} as any,
        {} as any,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        mockDomainsProvider
      );

      const infoMessages: string[] = [];
      (vscode.window as any).showInformationMessage = async (msg: string) => {
        infoMessages.push(msg);
        return undefined;
      };

      // 1. createDomain
      let inputStep = 0;
      (vscode.window as any).showInputBox = async () => (inputStep++ === 0 ? 'api.example.com' : '8080');
      (vscode.window as any).showQuickPick = async (items: any[]) => items[1]; // api-box
      await handlers.get('boxlite.createDomain')!();
      assert.deepStrictEqual(createdPayload, { domain: 'api.example.com', boxId: 'box_1', port: 8080 });

      // 2. verifyDomain
      const item = new DomainTreeItem({ id: 'dom_1', domain: 'api.example.com', status: 'pending' });
      await handlers.get('boxlite.verifyDomain')!(item);
      assert.strictEqual(verifiedKey, 'dom_1');

      // 3. bindDomainToBox
      (vscode.window as any).showQuickPick = async (items: any[]) => items[0]; // api-box
      (vscode.window as any).showInputBox = async () => '3000';
      await handlers.get('boxlite.bindDomainToBox')!(item);
      assert.deepStrictEqual(updatedPayload, { domainKey: 'dom_1', boxId: 'box_1', port: 3000 });

      // 4. deleteDomain
      (vscode.window as any).showWarningMessage = async () => 'Delete';
      await handlers.get('boxlite.deleteDomain')!(item);
      assert.strictEqual(removedKey, 'dom_1');
      assert.ok(refreshCount >= 4);
      assert.ok(infoMessages.some((m) => m.includes('deleted')));
    });
  });
});
