import * as vscode from 'vscode';
import { SecretConfigSpec, SecretSpec } from '../bridge/protocol';
import { formatSecretPlaceholder } from '../util/validation';

const SECRET_KEY_PROXY_SECRETS = 'boxlite.proxySecrets';

export interface StoredProxySecret {
  name: string;
  value: string;
  hosts: string[];
  headers: Record<string, string>;
  envVar?: string;
  createdAt?: string;
  updatedAt?: string;
}

interface ProxySecretsPayload {
  secrets: StoredProxySecret[];
}

export class SecretsManager {
  private secretStorage: vscode.SecretStorage;
  private cachedPayload?: ProxySecretsPayload;
  private loadPromise?: Promise<ProxySecretsPayload>;

  constructor(context: vscode.ExtensionContext) {
    this.secretStorage = context.secrets;
  }

  public invalidateCache(): void {
    this.cachedPayload = undefined;
    this.loadPromise = undefined;
  }

  private clonePayload(payload: ProxySecretsPayload): ProxySecretsPayload {
    return {
      secrets: (payload.secrets || []).map((s) => ({
        ...s,
        hosts: [...(s.hosts || [])],
        headers: { ...(s.headers || {}) }
      }))
    };
  }

  private async load(): Promise<ProxySecretsPayload> {
    if (this.cachedPayload) {
      return this.clonePayload(this.cachedPayload);
    }

    if (this.loadPromise) {
      return this.clonePayload(await this.loadPromise);
    }

    this.loadPromise = this.performLoad();
    try {
      const loaded = await this.loadPromise;
      this.cachedPayload = this.clonePayload(loaded);
      return this.clonePayload(loaded);
    } finally {
      this.loadPromise = undefined;
    }
  }

  private async performLoad(): Promise<ProxySecretsPayload> {
    try {
      const raw = await this.secretStorage.get(SECRET_KEY_PROXY_SECRETS);
      if (raw) {
        const parsed: ProxySecretsPayload = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.secrets)) {
          return parsed;
        }
      }
    } catch {
      // Ignore malformed storage payload or transient SecretStorage errors
    }
    return { secrets: [] };
  }

  private async save(payload: ProxySecretsPayload): Promise<void> {
    this.cachedPayload = this.clonePayload(payload);
    try {
      await this.secretStorage.store(SECRET_KEY_PROXY_SECRETS, JSON.stringify(payload));
    } catch {
      // Preserve in-memory cache if SecretStorage IPC is unavailable
    }
  }

  public async listSecrets(): Promise<StoredProxySecret[]> {
    const data = await this.load();
    return data.secrets.map((s) => ({
      ...s,
      hosts: [...(s.hosts || [])],
      headers: { ...(s.headers || {}) }
    }));
  }

  public async getSecret(name: string): Promise<StoredProxySecret | undefined> {
    const normalized = name.trim().toLowerCase();
    const data = await this.load();
    const found = data.secrets.find((s) => s.name.trim().toLowerCase() === normalized);
    if (!found) {
      return undefined;
    }
    return {
      ...found,
      hosts: [...(found.hosts || [])],
      headers: { ...(found.headers || {}) }
    };
  }

  public async saveSecret(secret: StoredProxySecret): Promise<void> {
    const trimmedName = secret.name.trim();
    if (!trimmedName) {
      throw new Error('Secret name cannot be empty.');
    }
    if (!secret.value || !secret.value.trim()) {
      throw new Error('Secret value cannot be empty.');
    }

    const now = new Date().toISOString();
    const data = await this.load();
    const existingIdx = data.secrets.findIndex(
      (s) => s.name.trim().toLowerCase() === trimmedName.toLowerCase()
    );

    const normalized: StoredProxySecret = {
      name: trimmedName,
      value: secret.value,
      hosts: secret.hosts.map((h) => h.trim()).filter((h) => h.length > 0),
      headers: { ...secret.headers },
      envVar: secret.envVar?.trim() ? secret.envVar.trim() : undefined,
      createdAt: existingIdx >= 0 ? data.secrets[existingIdx].createdAt || now : secret.createdAt || now,
      updatedAt: now
    };

    if (existingIdx >= 0) {
      data.secrets[existingIdx] = normalized;
    } else {
      data.secrets.push(normalized);
    }

    await this.save(data);
  }

  public async removeSecret(name: string): Promise<boolean> {
    const normalized = name.trim().toLowerCase();
    const data = await this.load();
    const idx = data.secrets.findIndex((s) => s.name.trim().toLowerCase() === normalized);
    if (idx === -1) {
      return false;
    }
    data.secrets.splice(idx, 1);
    await this.save(data);
    return true;
  }

  public async resolveSecrets(
    specs: Array<SecretConfigSpec | SecretSpec>
  ): Promise<{ resolved: SecretSpec[]; missing: string[] }> {
    const resolved: SecretSpec[] = [];
    const missing: string[] = [];

    for (const spec of specs) {
      const maybeWithVal = spec as SecretSpec;
      if (maybeWithVal.value && maybeWithVal.value.trim().length > 0) {
        resolved.push({
          name: spec.name,
          value: maybeWithVal.value,
          hosts: [...(spec.hosts || [])],
          headers: { ...(spec.headers || {}) }
        });
        continue;
      }

      const stored = await this.getSecret(spec.name);
      if (stored && stored.value && stored.value.trim().length > 0) {
        resolved.push({
          name: spec.name,
          value: stored.value,
          hosts: spec.hosts && spec.hosts.length > 0 ? [...spec.hosts] : [...stored.hosts],
          headers:
            spec.headers && Object.keys(spec.headers).length > 0
              ? { ...spec.headers }
              : { ...stored.headers }
        });
      } else {
        missing.push(spec.name);
      }
    }

    return { resolved, missing };
  }

  public static getPlaceholder(name: string): string {
    return formatSecretPlaceholder(name);
  }

  public static getGuestHeaderExample(secret: Pick<SecretConfigSpec, 'name' | 'headers'>): string {
    const placeholder = formatSecretPlaceholder(secret.name);
    const entries = Object.entries(secret.headers || {});
    if (entries.length === 0) {
      return `Authorization: Bearer ${placeholder}`;
    }
    const [headerName, template] = entries[0];
    const headerValue = template.replace(/\{value\}/g, placeholder);
    return `${headerName}: ${headerValue}`;
  }

  public static toConfigSpec(secret: StoredProxySecret | SecretSpec | SecretConfigSpec): SecretConfigSpec {
    const spec: SecretConfigSpec = {
      name: secret.name,
      hosts: [...(secret.hosts || [])],
      headers: { ...(secret.headers || {}) }
    };
    const envVar = (secret as StoredProxySecret | SecretConfigSpec).envVar;
    if (envVar && envVar.trim()) {
      spec.envVar = envVar.trim();
    }
    return spec;
  }
}
