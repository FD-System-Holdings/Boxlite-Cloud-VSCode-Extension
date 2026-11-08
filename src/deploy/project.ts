import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export interface BoxliteProjectConfig {
  name: string;
  boxId?: string | null;
  image?: string;
  appDir: string;
  port: number;
  healthPath: string;
  start: string;
  access: 'public' | 'private';
  network?: {
    inbound?: 'enabled' | 'disabled';
    outbound?: {
      mode?: 'enabled' | 'disabled';
      allow_net?: string[];
    };
  };
  env?: string[];
  persistent?: boolean;
  autoStop?: number;
}

export const DEFAULT_CONFIG: BoxliteProjectConfig = {
  name: 'boxlite-app',
  boxId: null,
  image: 'python',
  appDir: './app',
  port: 8080,
  healthPath: '/healthz',
  start: 'python3 -u server.py',
  access: 'public',
  network: {
    inbound: 'enabled',
    outbound: {
      mode: 'enabled',
      allow_net: []
    }
  },
  persistent: true,
  autoStop: 0
};

export function buildSupervisorEntrypoint(startCmd: string = 'python3 -u server.py'): string[] {
  return [
    'sh',
    '-c',
    `while true; do if [ -d /app ] && [ "$(ls -A /app 2>/dev/null)" ]; then cd /app && ${startCmd} >>/tmp/server.log 2>&1; fi; sleep 2; done`
  ];
}

export class ProjectManager {
  public static async findProjectConfig(
    folderUri?: vscode.Uri
  ): Promise<{ config: BoxliteProjectConfig; fileUri: vscode.Uri } | undefined> {
    const root = folderUri || (vscode.workspace.workspaceFolders?.[0]?.uri);
    if (!root) {
      return undefined;
    }

    const configFile = path.join(root.fsPath, 'boxlite.json');
    if (!fs.existsSync(configFile)) {
      return undefined;
    }

    try {
      const content = fs.readFileSync(configFile, 'utf-8');
      const parsed = JSON.parse(content);
      const merged: BoxliteProjectConfig = {
        ...DEFAULT_CONFIG,
        ...parsed,
        network: {
          inbound: parsed.network?.inbound || DEFAULT_CONFIG.network?.inbound,
          outbound: {
            mode: parsed.network?.outbound?.mode || DEFAULT_CONFIG.network?.outbound?.mode,
            allow_net: parsed.network?.outbound?.allow_net || []
          }
        }
      };
      return { config: merged, fileUri: vscode.Uri.file(configFile) };
    } catch (e: any) {
      vscode.window.showErrorMessage(`Failed to parse boxlite.json: ${e.message}`);
      return undefined;
    }
  }

  public static async saveBoxId(fileUri: vscode.Uri, boxId: string): Promise<void> {
    try {
      const content = fs.readFileSync(fileUri.fsPath, 'utf-8');
      const json = JSON.parse(content);
      json.boxId = boxId;
      fs.writeFileSync(fileUri.fsPath, JSON.stringify(json, null, 2), 'utf-8');
    } catch (e: any) {
      console.error('Failed to update boxId in boxlite.json', e);
    }
  }

  public static getIgnorePatterns(rootPath: string): string[] {
    const defaultIgnores = [
      '.git',
      '.github',
      'node_modules',
      '.venv',
      'venv',
      '__pycache__',
      '*.pyc',
      '.env',
      '.DS_Store',
      'dist',
      'out',
      '.boxlite'
    ];

    const ignoreFile = path.join(rootPath, '.boxliteignore');
    if (fs.existsSync(ignoreFile)) {
      try {
        const lines = fs
          .readFileSync(ignoreFile, 'utf-8')
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l.length > 0 && !l.startsWith('#'));
        return Array.from(new Set([...defaultIgnores, ...lines]));
      } catch {
        return defaultIgnores;
      }
    }

    return defaultIgnores;
  }
}
