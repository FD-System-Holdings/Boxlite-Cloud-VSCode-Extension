import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  getDefaultBoxConfiguration,
  convertBoxConfigToCreateArgs,
  resolveEntrypoint,
  showBoxConfigurationWizard,
  BOX_TEMPLATES,
  SIZING_PRESETS,
  STANDARD_IMAGES,
  saveConfigToProject,
  BoxConfiguration
} from '../src/commands/boxConfiguration';
import { validateNetworkPolicy, validateAllowlistRule } from '../src/util/validation';

describe('Box Creation Configuration Options & Templates', () => {
  it('should generate canonical default configuration according to agent.md §1', () => {
    const config = getDefaultBoxConfiguration();
    assert.strictEqual(config.image, 'python');
    assert.strictEqual(config.sizingPreset, 'medium');
    assert.strictEqual(config.cpus, 2);
    assert.strictEqual(config.memoryMib, 4096);
    assert.strictEqual(config.diskSizeGb, 20);
    assert.strictEqual(config.inboundMode, 'enabled');
    assert.strictEqual(config.outboundMode, 'enabled');
    assert.deepStrictEqual(config.allowNet, []);
    assert.strictEqual(config.autoStop, 0);
    assert.strictEqual(config.autoDelete, 0);
    assert.strictEqual(config.autoResume, true);
    assert.strictEqual(config.entrypointPreset, 'supervisor');
    assert.strictEqual(config.defaultPort, 8080);
    assert.strictEqual(typeof config.name, 'string');
    assert.ok(config.name.startsWith('box-'));
  });

  it('should define valid compute sizing presets', () => {
    assert.strictEqual(SIZING_PRESETS.small.cpus, 1);
    assert.strictEqual(SIZING_PRESETS.small.memoryMib, 2048);
    assert.strictEqual(SIZING_PRESETS.small.diskSizeGb, 10);

    assert.strictEqual(SIZING_PRESETS.medium.cpus, 2);
    assert.strictEqual(SIZING_PRESETS.medium.memoryMib, 4096);
    assert.strictEqual(SIZING_PRESETS.medium.diskSizeGb, 20);

    assert.strictEqual(SIZING_PRESETS.large.cpus, 4);
    assert.strictEqual(SIZING_PRESETS.large.memoryMib, 8192);
    assert.strictEqual(SIZING_PRESETS.large.diskSizeGb, 40);
  });

  it('should include standard images matching Cloud image aliases', () => {
    const aliases = STANDARD_IMAGES.map((img) => img.label);
    assert.ok(aliases.includes('python'));
    assert.ok(aliases.includes('node'));
    assert.ok(aliases.includes('ubuntu'));
    assert.ok(aliases.includes('debian'));
    assert.ok(aliases.includes('alpine'));
  });

  it('should provide verified templates matching agent.md journeys', () => {
    const pythonTmpl = BOX_TEMPLATES.find((t) => t.id === 'python-app');
    assert.ok(pythonTmpl);
    assert.strictEqual(pythonTmpl.config.image, 'python');
    assert.strictEqual(pythonTmpl.config.autoStop, 0);
    assert.strictEqual(pythonTmpl.config.inboundMode, 'enabled');
    assert.strictEqual(pythonTmpl.config.outboundMode, 'enabled');
    assert.strictEqual(pythonTmpl.config.defaultPort, 8080);

    const secureTmpl = BOX_TEMPLATES.find((t) => t.id === 'secure-egress');
    assert.ok(secureTmpl);
    assert.strictEqual(secureTmpl.config.inboundMode, 'enabled');
    assert.strictEqual(secureTmpl.config.outboundMode, 'enabled');
    assert.ok(secureTmpl.config.allowNet && secureTmpl.config.allowNet.length > 0);
    for (const rule of secureTmpl.config.allowNet || []) {
      const res = validateAllowlistRule(rule);
      assert.strictEqual(res.valid, true);
    }

    const airgappedTmpl = BOX_TEMPLATES.find((t) => t.id === 'airgapped-sandbox');
    assert.ok(airgappedTmpl);
    assert.strictEqual(airgappedTmpl.config.inboundMode, 'disabled');
    assert.strictEqual(airgappedTmpl.config.outboundMode, 'disabled');
    assert.strictEqual(airgappedTmpl.config.entrypointPreset, 'keepalive');
  });

  it('should resolve entrypoint correctly for all presets', () => {
    const defaultCfg = getDefaultBoxConfiguration();

    // Supervisor
    const supEp = resolveEntrypoint({ ...defaultCfg, entrypointPreset: 'supervisor', customStartCommand: 'python3 -u server.py' });
    assert.ok(Array.isArray(supEp));
    assert.strictEqual(supEp![0], 'sh');
    assert.strictEqual(supEp![1], '-c');
    assert.ok(supEp![2].includes('python3 -u server.py'));

    // Keepalive
    const keepEp = resolveEntrypoint({ ...defaultCfg, entrypointPreset: 'keepalive' });
    assert.ok(Array.isArray(keepEp));
    assert.strictEqual(keepEp![0], 'sh');
    assert.strictEqual(keepEp![1], '-c');
    assert.ok(keepEp![2].includes('sleep 3600'));

    // Image Default
    const defEp = resolveEntrypoint({ ...defaultCfg, entrypointPreset: 'default' });
    assert.strictEqual(defEp, undefined);

    // Custom
    const customEp = resolveEntrypoint({
      ...defaultCfg,
      entrypointPreset: 'custom',
      customEntrypoint: ['my-bin', '--flag']
    });
    assert.deepStrictEqual(customEp, ['my-bin', '--flag']);
  });

  it('should convert BoxConfiguration to CreateBoxArgs accurately', () => {
    const config: BoxConfiguration = {
      name: 'test-custom-box',
      image: 'node',
      sizingPreset: 'large',
      cpus: 4,
      memoryMib: 8192,
      diskSizeGb: 40,
      inboundMode: 'enabled',
      outboundMode: 'enabled',
      allowNet: ['api.example.com', '*.boxlite.ai'],
      autoStop: 900,
      autoDelete: 604800,
      autoResume: true,
      entrypointPreset: 'supervisor',
      customStartCommand: 'npm run start',
      env: { NODE_ENV: 'production', PORT: '3000' },
      defaultPort: 3000
    };

    const args = convertBoxConfigToCreateArgs(config);
    assert.strictEqual(args.name, 'test-custom-box');
    assert.strictEqual(args.image, 'node');
    assert.strictEqual(args.autoRemove, false);
    assert.strictEqual(args.autoStop, 900);
    assert.strictEqual(args.autoDelete, 604800);
    assert.strictEqual(args.autoResume, true);
    assert.strictEqual(args.cpus, 4);
    assert.strictEqual(args.memoryMib, 8192);
    assert.strictEqual(args.diskSizeGb, 40);
    assert.deepStrictEqual(args.env, { NODE_ENV: 'production', PORT: '3000' });
    assert.strictEqual(args.network?.inbound?.mode, 'enabled');
    assert.strictEqual(args.network?.outbound?.mode, 'enabled');
    assert.deepStrictEqual(args.network?.outbound?.allow_net, ['api.example.com', '*.boxlite.ai']);
    assert.ok(Array.isArray(args.entrypoint));
  });

  it('should clear allow_net when outbound mode is disabled', () => {
    const config: BoxConfiguration = {
      ...getDefaultBoxConfiguration(),
      outboundMode: 'disabled',
      allowNet: ['should.not.persist.com']
    };

    const args = convertBoxConfigToCreateArgs(config);
    assert.strictEqual(args.network?.outbound?.mode, 'disabled');
    assert.deepStrictEqual(args.network?.outbound?.allow_net, []);
    const netRes = validateNetworkPolicy('disabled', 'disabled', args.network?.outbound?.allow_net || []);
    assert.strictEqual(netRes.valid, true);
  });

  it('should save box configuration to boxlite.json', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boxlite-config-test-'));
    const fakeUri: any = { fsPath: tempDir };

    const config: BoxConfiguration = {
      ...getDefaultBoxConfiguration(),
      name: 'persisted-app',
      image: 'python',
      cpus: 2,
      memoryMib: 4096,
      diskSizeGb: 20,
      autoStop: 1800,
      autoDelete: 86400,
      defaultPort: 8080,
      env: { SERVICE_NAME: 'test-service' }
    };

    const ok = await saveConfigToProject(config, fakeUri);
    assert.strictEqual(ok, true);

    const writtenPath = path.join(tempDir, 'boxlite.json');
    assert.ok(fs.existsSync(writtenPath));

    const content = JSON.parse(fs.readFileSync(writtenPath, 'utf-8'));
    assert.strictEqual(content.name, 'persisted-app');
    assert.strictEqual(content.image, 'python');
    assert.strictEqual(content.cpus, 2);
    assert.strictEqual(content.memoryMib, 4096);
    assert.strictEqual(content.autoStop, 1800);
    assert.strictEqual(content.autoDelete, 86400);
    assert.strictEqual(content.port, 8080);
    assert.deepStrictEqual(content.env, { SERVICE_NAME: 'test-service' });

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('should return undefined when wizard is cancelled', async () => {
    const vscode = require('vscode');
    const origQuickPick = vscode.window.showQuickPick;
    try {
      // Simulate user selecting Cancel
      vscode.window.showQuickPick = async (items: any[]) => {
        return items.find((i: any) => i.action === 'cancel');
      };
      const result = await showBoxConfigurationWizard();
      assert.strictEqual(result, undefined);
    } finally {
      vscode.window.showQuickPick = origQuickPick;
    }
  });

  it('should return finalized CreateBoxArgs when user proceeds to create', async () => {
    const vscode = require('vscode');
    const origQuickPick = vscode.window.showQuickPick;
    try {
      vscode.window.showQuickPick = async (items: any[]) => {
        return items.find((i: any) => i.action === 'create');
      };
      const result = await showBoxConfigurationWizard({
        name: 'wizard-box-123',
        image: 'node',
        cpus: 4,
        memoryMib: 8192
      });
      assert.ok(result);
      assert.strictEqual(result.name, 'wizard-box-123');
      assert.strictEqual(result.image, 'node');
      assert.strictEqual(result.cpus, 4);
      assert.strictEqual(result.memoryMib, 8192);
      assert.strictEqual(result.network?.inbound?.mode, 'enabled');
      assert.strictEqual(result.network?.outbound?.mode, 'enabled');
    } finally {
      vscode.window.showQuickPick = origQuickPick;
    }
  });

  it('should allow modifying box name in wizard', async () => {
    const vscode = require('vscode');
    const origQuickPick = vscode.window.showQuickPick;
    const origInputBox = vscode.window.showInputBox;
    try {
      let callCount = 0;
      vscode.window.showQuickPick = async (items: any[]) => {
        callCount++;
        if (callCount === 1) {
          return items.find((i: any) => i.action === 'name');
        }
        return items.find((i: any) => i.action === 'create');
      };

      vscode.window.showInputBox = async () => 'my-renamed-box';

      const result = await showBoxConfigurationWizard();
      assert.ok(result);
      assert.strictEqual(result.name, 'my-renamed-box');
    } finally {
      vscode.window.showQuickPick = origQuickPick;
      vscode.window.showInputBox = origInputBox;
    }
  });

  it('should contribute boxlite.createBoxWithOptions and configuration options in package.json', () => {
    const pkgPath = path.resolve(__dirname, '..', '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));

    const cmd = pkg.contributes.commands.find((c: any) => c.command === 'boxlite.createBoxWithOptions');
    assert.ok(cmd, 'boxlite.createBoxWithOptions must be contributed in package.json');
    assert.strictEqual(cmd.category, 'BoxLite');

    // Configuration properties
    const props = pkg.contributes.configuration.properties;
    assert.ok(props['boxlite.defaultImage'], 'boxlite.defaultImage must be contributed');
    assert.ok(props['boxlite.defaultCpu'], 'boxlite.defaultCpu must be contributed');
    assert.ok(props['boxlite.defaultMemory'], 'boxlite.defaultMemory must be contributed');
    assert.ok(props['boxlite.defaultDisk'], 'boxlite.defaultDisk must be contributed');
    assert.ok(props['boxlite.defaultInboundMode'], 'boxlite.defaultInboundMode must be contributed');
    assert.ok(props['boxlite.defaultOutboundMode'], 'boxlite.defaultOutboundMode must be contributed');
    assert.ok(props['boxlite.defaultAutoDelete'], 'boxlite.defaultAutoDelete must be contributed');
    assert.ok(props['boxlite.defaultAutoResume'], 'boxlite.defaultAutoResume must be contributed');
  });
});
