import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';
import { parseExecutableCommand, createCleanSubprocessEnv } from '../util/process';

export class PythonEnvManager {
  private outputChannel: vscode.OutputChannel;
  private cachedPythonPath: string | null = null;
  private resolvePythonPathPromise: Promise<string> | null = null;

  constructor(
    private context: vscode.ExtensionContext,
    outputChannel: vscode.OutputChannel
  ) {
    this.outputChannel = outputChannel;
  }

  public async getPythonPath(): Promise<string> {
    if (this.cachedPythonPath) {
      return this.cachedPythonPath;
    }
    if (this.resolvePythonPathPromise) {
      return this.resolvePythonPathPromise;
    }

    this.resolvePythonPathPromise = this.resolvePythonPath().finally(() => {
      this.resolvePythonPathPromise = null;
    });
    return this.resolvePythonPathPromise;
  }

  private async resolvePythonPath(): Promise<string> {
    const config = vscode.workspace.getConfiguration('boxlite');
    const configured = config.get<string>('pythonPath');
    if (configured && configured.trim().length > 0) {
      this.cachedPythonPath = configured.trim();
      return this.cachedPythonPath;
    }

    // Check virtual environment in globalStorageUri
    const venvPython = this.getGlobalStorageVenvPython();
    if (fs.existsSync(venvPython)) {
      this.cachedPythonPath = venvPython;
      return this.cachedPythonPath;
    }

    // Fallback to system py or python3 or python
    const candidates = process.platform === 'win32'
      ? ['py -3', 'python', 'py', 'python3']
      : ['python3', 'python'];

    for (const candidate of candidates) {
      if (await this.testExecutable(candidate)) {
        this.cachedPythonPath = candidate;
        return candidate;
      }
    }

    this.cachedPythonPath = 'python3';
    return 'python3';
  }

  public getGlobalStorageVenvPython(): string {
    const storagePath = this.context.globalStorageUri.fsPath;
    const isWindows = process.platform === 'win32';
    return isWindows
      ? path.join(storagePath, '.venv', 'Scripts', 'python.exe')
      : path.join(storagePath, '.venv', 'bin', 'python');
  }

  private safeAppendLine(message: string): void {
    try {
      this.outputChannel.appendLine(message);
    } catch {
      // Ignore writes after output channel disposal
    }
  }

  private safeAppend(message: string): void {
    try {
      this.outputChannel.append(message);
    } catch {
      // Ignore writes after output channel disposal
    }
  }

  private async testExecutable(execName: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      try {
        const { bin, args } = parseExecutableCommand(execName);
        const fullArgs = args.concat(['-c', 'import sys; print(sys.version_info[0])']);
        const env = createCleanSubprocessEnv();
        const proc = spawn(bin, fullArgs, { stdio: 'pipe', env, windowsHide: true });
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

  public async setupEnvironment(): Promise<string> {
    const storagePath = this.context.globalStorageUri.fsPath;
    if (!fs.existsSync(storagePath)) {
      fs.mkdirSync(storagePath, { recursive: true });
    }

    const venvDir = path.join(storagePath, '.venv');
    const pythonExecutable = this.getGlobalStorageVenvPython();

    try {
      this.outputChannel.show(true);
    } catch {
      // Ignore if channel unavailable
    }
    this.safeAppendLine(`[setup] Setting up managed Python virtual environment in ${venvDir}...`);

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
          const { bin, args } = parseExecutableCommand(sysPython);
          const fullArgs = args.concat(['-m', 'venv', venvDir]);
          await this.runProcess(bin, fullArgs, `Creating venv with ${bin}`);
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

        try {
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
        } catch (pipErr: any) {
          this.safeAppendLine(
            `[setup] Notice: Native boxlite wheel installation was skipped or failed (${pipErr.message}). Pure-Python REST bridge fallback will be used.`
          );
        }

        this.safeAppendLine('[setup] Python environment setup complete!');
        vscode.window.showInformationMessage('BoxLite Python environment successfully configured.');
        return pythonExecutable;
      }
    );
  }

  private runProcess(cmd: string, args: string[], stepName: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.safeAppendLine(`[setup] ${stepName}: ${cmd} ${args.join(' ')}`);
      const env = createCleanSubprocessEnv();
      const proc = spawn(cmd, args, { stdio: 'pipe', env, windowsHide: true });

      proc.stdout.on('data', (d) => this.safeAppend(d.toString()));
      proc.stderr.on('data', (d) => this.safeAppend(d.toString()));

      proc.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          const err = new Error(`${stepName} failed with code ${code}`);
          this.safeAppendLine(`[setup] ERROR: ${err.message}`);
          reject(err);
        }
      });

      proc.on('error', (err) => {
        this.safeAppendLine(`[setup] ERROR: ${err.message}`);
        reject(err);
      });
    });
  }
}
