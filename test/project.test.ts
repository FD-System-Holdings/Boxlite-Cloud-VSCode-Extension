import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { DEFAULT_CONFIG, ProjectManager, buildSupervisorEntrypoint } from '../src/deploy/project';

describe('Project Configuration & Defaults', () => {
  it('should have canonical default configuration values', () => {
    assert.strictEqual(DEFAULT_CONFIG.port, 8080);
    assert.strictEqual(DEFAULT_CONFIG.healthPath, '/healthz');
    assert.strictEqual(DEFAULT_CONFIG.image, 'python');
    assert.strictEqual(DEFAULT_CONFIG.access, 'public');
    assert.strictEqual(DEFAULT_CONFIG.network?.inbound, 'enabled');
    assert.strictEqual(DEFAULT_CONFIG.network?.outbound?.mode, 'enabled');
  });

  it('should include common build/git directories in default ignores', () => {
    const ignores = ProjectManager.getIgnorePatterns('non-existent-dir');
    assert.strictEqual(ignores.includes('.git'), true);
    assert.strictEqual(ignores.includes('.venv'), true);
    assert.strictEqual(ignores.includes('node_modules'), true);
    assert.strictEqual(ignores.includes('__pycache__'), true);
  });

  it('should build supervisor entrypoint with default start command', () => {
    const cmd = buildSupervisorEntrypoint();
    assert.strictEqual(cmd[0], 'sh');
    assert.strictEqual(cmd[1], '-c');
    assert.strictEqual(cmd[2].includes('python3 -u server.py'), true);
    assert.strictEqual(cmd[2].includes('>>/tmp/server.log 2>&1'), true);
  });

  it('should build supervisor entrypoint with custom start command', () => {
    const cmd = buildSupervisorEntrypoint('python3 -u main.py');
    assert.strictEqual(cmd[2].includes('python3 -u main.py'), true);
    assert.strictEqual(cmd[2].includes('server.py'), false);
  });

  it('should save boxId into boxlite.json correctly', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boxlite-test-'));
    const configPath = path.join(tempDir, 'boxlite.json');
    fs.writeFileSync(configPath, JSON.stringify({ name: 'test-app', boxId: null }), 'utf-8');

    const fakeUri: any = { fsPath: configPath };
    await ProjectManager.saveBoxId(fakeUri, 'box_test_12345');

    const saved = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    assert.strictEqual(saved.boxId, 'box_test_12345');
    assert.strictEqual(saved.name, 'test-app');

    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});
