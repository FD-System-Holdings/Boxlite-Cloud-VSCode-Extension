import * as vscode from 'vscode';

const SECRET_KEY_API_KEYS = 'boxlite.apiKeys';
const LEGACY_SECRET_KEY_API_KEY = 'boxlite.apiKey';

export interface StoredApiKey {
  id: string;
  name: string;
  key: string;
}

interface ApiKeysPayload {
  activeId?: string;
  keys: StoredApiKey[];
}

export class CredentialsManager {
  private secretStorage: vscode.SecretStorage;

  constructor(context: vscode.ExtensionContext) {
    this.secretStorage = context.secrets;
  }

  private async load(): Promise<ApiKeysPayload> {
    try {
      const raw = await this.secretStorage.get(SECRET_KEY_API_KEYS);
      if (raw) {
        const parsed: ApiKeysPayload = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.keys)) {
          return parsed;
        }
      }
    } catch {}

    // Migration: migrate legacy single-key storage if present
    try {
      const legacy = await this.secretStorage.get(LEGACY_SECRET_KEY_API_KEY);
      if (legacy && legacy.trim().length > 0) {
        const migrated: ApiKeysPayload = {
          activeId: 'default',
          keys: [{ id: 'default', name: 'Default', key: legacy.trim() }]
        };
        await this.save(migrated);
        try {
          await this.secretStorage.delete(LEGACY_SECRET_KEY_API_KEY);
        } catch {}
        return migrated;
      }
    } catch {}

    return { keys: [] };
  }

  private async save(payload: ApiKeysPayload): Promise<void> {
    await this.secretStorage.store(SECRET_KEY_API_KEYS, JSON.stringify(payload));
  }

  public async getApiKey(): Promise<string | undefined> {
    try {
      const data = await this.load();
      if (data.keys.length > 0) {
        const active = data.keys.find((k) => k.id === data.activeId) || data.keys[0];
        if (active && active.key.trim().length > 0) {
          return active.key.trim();
        }
      }
    } catch {}

    const envKey = process.env.BOXLITE_API_KEY;
    if (envKey && envKey.trim().length > 0) {
      return envKey.trim();
    }
    return undefined;
  }

  public async getActiveKey(): Promise<{ id: string; name: string; isEnv?: boolean } | undefined> {
    try {
      const data = await this.load();
      if (data.keys.length > 0) {
        const active = data.keys.find((k) => k.id === data.activeId) || data.keys[0];
        if (active) {
          return { id: active.id, name: active.name };
        }
      }
    } catch {}

    const envKey = process.env.BOXLITE_API_KEY;
    if (envKey && envKey.trim().length > 0) {
      return { id: 'env', name: 'Environment', isEnv: true };
    }
    return undefined;
  }

  public async listKeys(): Promise<Array<{ id: string; name: string; active: boolean; isEnv?: boolean }>> {
    try {
      const data = await this.load();
      if (data.keys.length > 0) {
        const activeId = data.activeId || data.keys[0].id;
        return data.keys.map((k) => ({
          id: k.id,
          name: k.name,
          active: k.id === activeId
        }));
      }
    } catch {}

    const envKey = process.env.BOXLITE_API_KEY;
    if (envKey && envKey.trim().length > 0) {
      return [{ id: 'env', name: 'Environment', active: true, isEnv: true }];
    }
    return [];
  }

  public async addKey(name: string, apiKey: string): Promise<string> {
    const trimmedKey = apiKey.trim();
    const trimmedName = name.trim();
    if (!trimmedKey) {
      throw new Error('API key cannot be empty');
    }
    if (!trimmedName) {
      throw new Error('API key name cannot be empty');
    }

    const data = await this.load();
    if (data.keys.some((k) => k.name.toLowerCase() === trimmedName.toLowerCase())) {
      throw new Error(`An API key with the name "${trimmedName}" already exists.`);
    }

    const id = `key_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    data.keys.push({ id, name: trimmedName, key: trimmedKey });
    data.activeId = id;
    await this.save(data);
    return id;
  }

  public async selectKey(id: string): Promise<boolean> {
    const data = await this.load();
    const found = data.keys.find((k) => k.id === id);
    if (!found) {
      return false;
    }
    data.activeId = id;
    await this.save(data);
    return true;
  }

  public async removeKey(id: string): Promise<boolean> {
    const data = await this.load();
    const idx = data.keys.findIndex((k) => k.id === id);
    if (idx === -1) {
      return false;
    }
    data.keys.splice(idx, 1);
    if (data.activeId === id) {
      data.activeId = data.keys.length > 0 ? data.keys[0].id : undefined;
    }
    await this.save(data);
    return true;
  }

  public async setApiKey(apiKey: string, name?: string): Promise<void> {
    const data = await this.load();
    const keyName = name && name.trim().length > 0 ? name.trim() : (data.keys.length === 0 ? 'Default' : `Key ${data.keys.length + 1}`);
    const existing = data.keys.find((k) => k.name.toLowerCase() === keyName.toLowerCase());
    if (existing) {
      existing.key = apiKey.trim();
      data.activeId = existing.id;
      await this.save(data);
    } else {
      await this.addKey(keyName, apiKey);
    }
  }

  public async clearApiKey(): Promise<void> {
    const data = await this.load();
    if (data.activeId) {
      await this.removeKey(data.activeId);
    } else if (data.keys.length > 0) {
      await this.removeKey(data.keys[0].id);
    }
    try {
      await this.secretStorage.delete(LEGACY_SECRET_KEY_API_KEY);
    } catch {}
  }

  public getRestUrl(): string {
    const config = vscode.workspace.getConfiguration('boxlite');
    const configuredUrl = config.get<string>('restUrl');
    if (configuredUrl && configuredUrl.trim().length > 0) {
      return configuredUrl.trim();
    }
    return process.env.BOXLITE_REST_URL || 'https://api.boxlite.ai';
  }

  public async promptForApiKey(): Promise<string | undefined> {
    const key = await vscode.window.showInputBox({
      title: 'BoxLite Cloud API Key',
      prompt: 'Enter your BoxLite Cloud API key (BOXLITE_API_KEY)',
      password: true,
      ignoreFocusOut: true,
      placeHolder: 'e.g. bl_live_...'
    });

    if (!key || key.trim().length === 0) {
      return undefined;
    }

    const data = await this.load();
    const defaultName = data.keys.length === 0 ? 'Default' : `Key ${data.keys.length + 1}`;

    const name = await vscode.window.showInputBox({
      title: 'BoxLite API Key Name',
      prompt: 'Enter a name or label for this API key',
      value: defaultName,
      ignoreFocusOut: true,
      placeHolder: 'e.g. Production, Staging, Personal',
      validateInput: (val) => {
        const trimmed = val ? val.trim() : '';
        if (!trimmed) {
          return 'Name cannot be empty';
        }
        if (data.keys.some((k) => k.name.toLowerCase() === trimmed.toLowerCase())) {
          return `An API key named "${trimmed}" already exists.`;
        }
        return null;
      }
    });

    if (!name || name.trim().length === 0) {
      return undefined;
    }

    await this.addKey(name.trim(), key.trim());
    vscode.window.showInformationMessage(`BoxLite Cloud API key "${name.trim()}" linked successfully.`);
    return key.trim();
  }

  public static redactKey(apiKey?: string): string {
    if (!apiKey) {
      return 'None';
    }
    if (apiKey.length <= 8) {
      return '****';
    }
    return `${apiKey.substring(0, 4)}...${apiKey.substring(apiKey.length - 4)}`;
  }
}
