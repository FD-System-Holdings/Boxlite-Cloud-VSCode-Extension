import * as vscode from 'vscode';

const SECRET_KEY_API_KEY = 'boxlite.apiKey';

export class CredentialsManager {
  private secretStorage: vscode.SecretStorage;

  constructor(context: vscode.ExtensionContext) {
    this.secretStorage = context.secrets;
  }

  public async getApiKey(): Promise<string | undefined> {
    // Priority: SecretStorage > Environment Variable
    try {
      const stored = await this.secretStorage.get(SECRET_KEY_API_KEY);
      if (stored && stored.trim().length > 0) {
        return stored.trim();
      }
    } catch {
      // SecretStorage may fail during early window startup
    }
    const envKey = process.env.BOXLITE_API_KEY;
    if (envKey && envKey.trim().length > 0) {
      return envKey.trim();
    }
    return undefined;
  }

  public async setApiKey(apiKey: string): Promise<void> {
    await this.secretStorage.store(SECRET_KEY_API_KEY, apiKey.trim());
  }

  public async clearApiKey(): Promise<void> {
    await this.secretStorage.delete(SECRET_KEY_API_KEY);
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

    if (key && key.trim().length > 0) {
      await this.setApiKey(key.trim());
      vscode.window.showInformationMessage('BoxLite Cloud API key saved securely.');
      return key.trim();
    }
    return undefined;
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
