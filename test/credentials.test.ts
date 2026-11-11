import * as assert from 'assert';
import { CredentialsManager } from '../src/auth/credentials';

class MockSecretStorage {
  private map = new Map<string, string>();

  async get(key: string): Promise<string | undefined> {
    return this.map.get(key);
  }

  async store(key: string, value: string): Promise<void> {
    this.map.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }

  has(key: string): boolean {
    return this.map.has(key);
  }
}

describe('CredentialsManager multi-key management', () => {
  const originalEnvKey = process.env.BOXLITE_API_KEY;

  beforeEach(() => {
    delete process.env.BOXLITE_API_KEY;
  });

  afterEach(() => {
    if (originalEnvKey !== undefined) {
      process.env.BOXLITE_API_KEY = originalEnvKey;
    } else {
      delete process.env.BOXLITE_API_KEY;
    }
  });

  it('should add, list, get, and select API keys', async () => {
    const mockStorage = new MockSecretStorage();
    const manager = new CredentialsManager({ secrets: mockStorage } as any);

    const id1 = await manager.addKey('Production', 'key_prod_123');
    assert.strictEqual(await manager.getApiKey(), 'key_prod_123');

    const active1 = await manager.getActiveKey();
    assert.strictEqual(active1?.id, id1);
    assert.strictEqual(active1?.name, 'Production');

    await manager.addKey('Staging', 'key_stage_456');
    // Newly added key becomes active
    assert.strictEqual(await manager.getApiKey(), 'key_stage_456');

    const keys = await manager.listKeys();
    assert.strictEqual(keys.length, 2);
    assert.strictEqual(keys[0].name, 'Production');
    assert.strictEqual(keys[0].active, false);
    assert.strictEqual(keys[1].name, 'Staging');
    assert.strictEqual(keys[1].active, true);

    // Switch back to Production
    const selected = await manager.selectKey(id1);
    assert.strictEqual(selected, true);
    assert.strictEqual(await manager.getApiKey(), 'key_prod_123');
  });

  it('should reject empty or duplicate key names', async () => {
    const mockStorage = new MockSecretStorage();
    const manager = new CredentialsManager({ secrets: mockStorage } as any);

    await manager.addKey('Default', 'key_123');

    await assert.rejects(async () => {
      await manager.addKey('default', 'key_456');
    }, /already exists/);

    await assert.rejects(async () => {
      await manager.addKey('', 'key_789');
    }, /cannot be empty/);
  });

  it('should promote next key when active key is removed', async () => {
    const mockStorage = new MockSecretStorage();
    const manager = new CredentialsManager({ secrets: mockStorage } as any);

    const id1 = await manager.addKey('First', 'key_1');
    const id2 = await manager.addKey('Second', 'key_2');

    assert.strictEqual(await manager.getApiKey(), 'key_2');

    // Remove active key (Second)
    await manager.removeKey(id2);
    assert.strictEqual(await manager.getApiKey(), 'key_1');

    const active = await manager.getActiveKey();
    assert.strictEqual(active?.id, id1);
    assert.strictEqual(active?.name, 'First');

    // Clear remaining key
    await manager.clearApiKey();
    assert.strictEqual(await manager.getApiKey(), undefined);
    assert.strictEqual(await manager.getActiveKey(), undefined);
  });

  it('should migrate legacy single API key seamlessly', async () => {
    const mockStorage = new MockSecretStorage();
    await mockStorage.store('boxlite.apiKey', 'legacy_bl_key');

    const manager = new CredentialsManager({ secrets: mockStorage } as any);

    assert.strictEqual(await manager.getApiKey(), 'legacy_bl_key');
    const active = await manager.getActiveKey();
    assert.strictEqual(active?.name, 'Default');

    // Legacy key entry deleted in favour of new format
    assert.strictEqual(mockStorage.has('boxlite.apiKey'), false);
    assert.strictEqual(mockStorage.has('boxlite.apiKeys'), true);
  });

  it('should fallback to BOXLITE_API_KEY environment variable when no stored keys', async () => {
    const mockStorage = new MockSecretStorage();
    const manager = new CredentialsManager({ secrets: mockStorage } as any);

    process.env.BOXLITE_API_KEY = 'env_secret_key';

    assert.strictEqual(await manager.getApiKey(), 'env_secret_key');
    const active = await manager.getActiveKey();
    assert.strictEqual(active?.name, 'Environment');
    assert.strictEqual(active?.isEnv, true);

    const keys = await manager.listKeys();
    assert.strictEqual(keys.length, 1);
    assert.strictEqual(keys[0].name, 'Environment');
    assert.strictEqual(keys[0].isEnv, true);
  });
});
