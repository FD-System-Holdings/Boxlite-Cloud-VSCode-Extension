import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';

export interface PythonEnvInfo {
  pythonPath: string;
  version?: string;
  isBoxliteInstalled: boolean;
  boxliteVersion?: string;
}

export class PythonEnvManager {
  private outputChannel: vscode.OutputChannel;

  constructor(
    private context: vscode.ExtensionContext,
    outputChannel: vscode.OutputChannel
  ) {
    this.outputChannel = outputChannel;
  }

  public async getPythonPath(): Promise<string> {
    const config = vscode.workspace.getConfiguration('boxlite');
    const configured = config.get<string>('pythonPath');
    if (configured && configured.trim().length > 0) {
      return configured.trim();
    }

    // Check virtual environment in globalStorageUri
    const venvPython = this.getGlobalStorageVenvPython();
    if (fs.existsSync(venvPython)) {
      return venvPython;
    }

    // Fallback to system py or python3 or python
    const candidates = process.platform === 'win32'
      ? ['python', 'py -3', 'py', 'python3']
      : ['python3', 'python'];

    for (const candidate of candidates) {
      if (await this.testExecutable(candidate)) {
        return candidate;
      }
    }

    return 'python3';
  }

  public getGlobalStorageVenvPython(): string {
    const storagePath = this.context.globalStorageUri.fsPath;
    const isWindows = process.platform === 'win32';
    return isWindows
      ? path.join(storagePath, '.venv', 'Scripts', 'python.exe')
      : path.join(storagePath, '.venv', 'bin', 'python');
  }

  private async testExecutable(execName: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      try {
        const parts = execName.split(' ');
        const bin = parts[0];
        const args = parts.slice(1).concat(['-c', 'import sys; print(sys.version_info[0])']);
        const proc = spawn(bin, args, { stdio: 'pipe' });
        let out = '';
        proc.stdout.on('data', (d) => { out += d.toString(); });
        proc.on('close', (code) => {
          resolve(code === 0 && out.trim().startsWith('3'));
        });
        proc.on('error', () => resolve(false));
      } catch {
        resolve(false);
      }
    });
  }

  public async checkEnvironment(pythonPath: string): Promise<PythonEnvInfo> {
    return new Promise<PythonEnvInfo>((resolve) => {
      const parts = pythonPath.split(' ');
      const bin = parts[0];
      const args = parts.slice(1).concat([
        '-c',
        'import sys; print("PY:" + sys.version.split()[0]);' +
        'try:\n import boxlite;\n print("BOXLITE:" + getattr(boxlite, "__version__", "0.11.0"));\nexcept Exception as e:\n print("NO_BOXLITE:" + str(e))'
      ]);

      const proc = spawn(bin, args, { stdio: 'pipe' });
      let output = '';
      proc.stdout.on('data', (d) => { output += d.toString(); });
      proc.on('close', (code) => {
        if (code !== 0) {
          resolve({ pythonPath, isBoxliteInstalled: false });
          return;
        }

        let version: string | undefined;
        let isBoxliteInstalled = false;
        let boxliteVersion: string | undefined;

        for (const line of output.split('\n')) {
          const l = line.trim();
          if (l.startsWith('PY:')) {
            version = l.substring(3);
          } else if (l.startsWith('BOXLITE:')) {
            isBoxliteInstalled = true;
            boxliteVersion = l.substring(8);
          }
        }

        resolve({
          pythonPath,
          version,
          isBoxliteInstalled,
          boxliteVersion
        });
      });
      proc.on('error', () => {
        resolve({ pythonPath, isBoxliteInstalled: false });
      });
    });
  }

  public async setupEnvironment(): Promise<string> {
    const storagePath = this.context.globalStorageUri.fsPath;
    if (!fs.existsSync(storagePath)) {
      fs.mkdirSync(storagePath, { recursive: true });
    }

    const venvDir = path.join(storagePath, '.venv');
    const pythonExecutable = this.getGlobalStorageVenvPython();

    this.outputChannel.show(true);
    this.outputChannel.appendLine(`[setup] Setting up managed Python virtual environment in ${venvDir}...`);

    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Setting up BoxLite Python Environment...',
        cancellable: false
      },
      async (progress) => {
        progress.report({ message: 'Creating virtual environment...' });

        // Step 1: Create venv if not exists
        if (!fs.existsSync(pythonExecutable)) {
          const sysPython = await this.getPythonPath();
          const parts = sysPython.split(' ');
          const bin = parts[0];
          const args = parts.slice(1).concat(['-m', 'venv', venvDir]);
          await this.runProcess(bin, args, `Creating venv with ${bin}`);
        }

        progress.report({ message: 'Installing boxlite==0.11.0 SDK...' });
        const reqFile = path.join(
          this.context.extensionPath,
          'src',
          'bridge',
          'python',
          'requirements.txt'
        );

        await this.runProcess(
          pythonExecutable,
          ['-m', 'pip', 'install', '--upgrade', 'pip'],
          'Upgrading pip'
        );

        if (fs.existsSync(reqFile)) {
          await this.runProcess(
            pythonExecutable,
            ['-m', 'pip', 'install', '-r', reqFile],
            'Installing requirements'
          );
        } else {
          await this.runProcess(
            pythonExecutable,
            ['-m', 'pip', 'install', 'boxlite==0.11.0'],
            'Installing boxlite==0.11.0'
          );
        }

        this.outputChannel.appendLine('[setup] Python environment setup complete!');
        vscode.window.showInformationMessage('BoxLite Python environment successfully configured.');
        return pythonExecutable;
      }
    );
  }

  private runProcess(cmd: string, args: string[], stepName: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.outputChannel.appendLine(`[setup] ${stepName}: ${cmd} ${args.join(' ')}`);
      const proc = spawn(cmd, args, { stdio: 'pipe' });

      proc.stdout.on('data', (d) => this.outputChannel.append(d.toString()));
      proc.stderr.on('data', (d) => this.outputChannel.append(d.toString()));

      proc.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          const err = new Error(`${stepName} failed with code ${code}`);
          this.outputChannel.appendLine(`[setup] ERROR: ${err.message}`);
          reject(err);
        }
      });

      proc.on('error', (err) => {
        this.outputChannel.appendLine(`[setup] ERROR: ${err.message}`);
        reject(err);
      });
    });
  }
}
