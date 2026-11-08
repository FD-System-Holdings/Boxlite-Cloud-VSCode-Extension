import * as assert from 'assert';
import { DEFAULT_CONFIG, ProjectManager } from '../src/deploy/project';

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
});
