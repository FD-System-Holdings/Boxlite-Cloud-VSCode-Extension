import * as vscode from 'vscode';
import * as path from 'path';
import * as readline from 'readline';
import { ChildProcess, spawn } from 'child_process';
import {
  BridgeRequest,
  BridgeResponse,
  BoxListItem,
  CreateBoxArgs,
  ExecResult,
  TunnelResult,
  TailLogResult,
  VolumeItem,
  CreateVolumeArgs
} from './protocol';
import { CredentialsManager } from '../auth/credentials';
import { PythonEnvManager } from './env';
import { diagnoseError } from '../util/diagnosis';
import { parseExecutableCommand } from '../util/process';

export class BoxLiteBridgeClient implements vscode.Disposable {
  private process: ChildProcess | null = null;
  private pendingRequests = new Map<
    string,
    {
      resolve: (data: any) => void;
      reject: (err: any) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private requestCounter = 0;
  private isStarting = false;

  constructor(
    private context: vscode.ExtensionContext,
    private credentials: CredentialsManager,
    private envManager: PythonEnvManager,
    private outputChannel: vscode.OutputChannel
  ) {}

  public async getBridgeScriptPath(): Promise<string> {
    const candidates = [
      path.join(this.context.extensionPath, 'src', 'bridge', 'python', 'bridge.py'),
      path.join(this.context.extensionPath, 'dist', 'python', 'bridge.py'),
      path.join(this.context.extensionPath, 'python', 'bridge.py')
    ];
    for (const p of candidates) {
      if (require('fs').existsSync(p)) {
        return p;
      }
    }
    return candidates[0];
  }

  private async ensureProcess(): Promise<ChildProcess> {
    if (this.process && !this.process.killed) {
      return this.process;
    }

    if (this.isStarting) {
      // Wait for process to spawn
      await new Promise((r) => setTimeout(r, 200));
      return this.ensureProcess();
    }

    this.isStarting = true;
    try {
      const apiKey = await this.credentials.getApiKey();
      const restUrl = this.credentials.getRestUrl();
      const pythonPath = await this.envManager.getPythonPath();
      const scriptPath = await this.getBridgeScriptPath();

      const env: NodeJS.ProcessEnv = {
        ...process.env,
        BOXLITE_API_KEY: apiKey || '',
        BOXLITE_REST_URL: restUrl,
        PYTHONUNBUFFERED: '1',
        PYTHONUTF8: '1'
      };

      const { bin, args: parsedArgs } = parseExecutableCommand(pythonPath);
      const args = parsedArgs.concat([scriptPath]);

      this.outputChannel.appendLine(`[bridge] Starting python bridge: ${bin} ${args.join(' ')}`);

      const proc = spawn(bin, args, {
        env,
        stdio: ['pipe', 'pipe', 'pipe']
      });

      proc.on('error', (err) => {
        this.outputChannel.appendLine(`[bridge] Process error: ${err.message}`);
        this.rejectAllPending(err);
        this.process = null;
      });

      proc.on('exit', (code, signal) => {
        this.outputChannel.appendLine(
          `[bridge] Process exited with code ${code}, signal ${signal}`
        );
        this.rejectAllPending(new Error(`Bridge process exited with code ${code}`));
        this.process = null;
      });

      if (proc.stderr) {
        const stderrRl = readline.createInterface({ input: proc.stderr });
        stderrRl.on('line', (line) => {
          this.outputChannel.appendLine(`[bridge:py] ${line}`);
        });
      }

      if (proc.stdout) {
        const stdoutRl = readline.createInterface({ input: proc.stdout });
        stdoutRl.on('line', (line) => {
          this.handleStdoutLine(line);
        });
      }

      this.process = proc;
      return proc;
    } finally {
      this.isStarting = false;
    }
  }

  private handleStdoutLine(line: string) {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    try {
      const res: BridgeResponse = JSON.parse(trimmed);
      if (res && res.id) {
        const pending = this.pendingRequests.get(res.id);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingRequests.delete(res.id);

          if (res.success) {
            pending.resolve(res.data);
          } else {
            const errPayload = res.error || { code: 'UnknownError', message: 'Failed' };
            const diag = errPayload.diagnosis || diagnoseError(errPayload.message, errPayload.code).summary;
            const err = new Error(`BoxLite error [${errPayload.code}]: ${errPayload.message}\nDiagnosis: ${diag}`);
            (err as any).payload = errPayload;
            pending.reject(err);
          }
        }
      }
    } catch (e: any) {
      this.outputChannel.appendLine(`[bridge] Unrecognized output: ${trimmed}`);
    }
  }

  private rejectAllPending(err: Error) {
    for (const [, req] of this.pendingRequests.entries()) {
      clearTimeout(req.timer);
      req.reject(err);
    }
    this.pendingRequests.clear();
  }

  public async sendRequest<T = any>(op: string, args: any = {}, timeoutMs = 60000): Promise<T> {
    const proc = await this.ensureProcess();
    const reqId = `req_${++this.requestCounter}_${Date.now()}`;
    const req: BridgeRequest = { id: reqId, op, args };

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(reqId);
        reject(new Error(`BoxLite operation '${op}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingRequests.set(reqId, { resolve, reject, timer });

      const line = JSON.stringify(req) + '\n';
      if (proc.stdin && !proc.stdin.destroyed) {
        proc.stdin.write(line);
      } else {
        clearTimeout(timer);
        this.pendingRequests.delete(reqId);
        this.process = null;
        reject(new Error('Bridge stdin is closed'));
      }
    });
  }

  // BoxLite Cloud API Methods
  public async listBoxes(): Promise<BoxListItem[]> {
    const res = await this.sendRequest<{ boxes: BoxListItem[] }>('list_boxes', {}, 20000);
    return res.boxes || [];
  }

  public async inspectBox(boxId: string): Promise<any> {
    const res = await this.sendRequest<{ box: any }>('inspect_box', { boxId }, 20000);
    return res.box;
  }

  public async createBox(args: CreateBoxArgs): Promise<{ boxId: string; name: string; status: string }> {
    return this.sendRequest('create_box', args, 120000);
  }

  public async startBox(boxId: string): Promise<{ boxId: string; status: string }> {
    return this.sendRequest('start_box', { boxId }, 30000);
  }

  public async stopBox(boxId: string): Promise<{ boxId: string; status: string }> {
    return this.sendRequest('stop_box', { boxId }, 30000);
  }

  public async removeBox(boxId: string): Promise<{ boxId: string; removed: boolean }> {
    return this.sendRequest('remove_box', { boxId }, 30000);
  }

  public async exec(boxId: string, command: string, args: string[] = []): Promise<ExecResult> {
    return this.sendRequest<ExecResult>('exec', { boxId, command, args }, 60000);
  }

  public async copyIn(boxId: string, source: string, destination: string): Promise<boolean> {
    const res = await this.sendRequest<{ success: boolean }>('copy_in', { boxId, source, destination }, 120000);
    return res.success;
  }

  public async tunnel(boxId: string, port: number, isPublic = true): Promise<TunnelResult> {
    return this.sendRequest<TunnelResult>('tunnel', { boxId, port, isPublic }, 60000);
  }

  public async revokeTunnel(boxId: string, port: number): Promise<boolean> {
    const res = await this.sendRequest<{ revoked: boolean }>('revoke_tunnel', { boxId, port }, 30000);
    return res.revoked;
  }

  public async updateInbound(boxId: string, mode: 'enabled' | 'disabled'): Promise<void> {
    await this.sendRequest('update_inbound', { boxId, mode }, 30000);
  }

  public async updateOutbound(boxId: string, mode: 'enabled' | 'disabled', allowNet: string[] = []): Promise<void> {
    await this.sendRequest('update_outbound', { boxId, mode, allowNet }, 30000);
  }

  public async tailLog(boxId: string, logFile = '/tmp/server.log', lines = 100): Promise<TailLogResult> {
    return this.sendRequest<TailLogResult>('tail_log', { boxId, logFile, lines }, 15000);
  }

  // Volume Operations
  public async listVolumes(): Promise<VolumeItem[]> {
    const res = await this.sendRequest<{ volumes: VolumeItem[] }>('list_volumes', {}, 20000);
    return res.volumes || [];
  }

  public async createVolume(args: CreateVolumeArgs = {}): Promise<VolumeItem> {
    return this.sendRequest<VolumeItem>('create_volume', args, 60000);
  }

  public async inspectVolume(volumeId: string): Promise<any> {
    const res = await this.sendRequest<{ volume: any }>('inspect_volume', { volumeId }, 20000);
    return res.volume;
  }

  public async removeVolume(volumeId: string, force = false): Promise<{ volumeId: string; removed: boolean }> {
    return this.sendRequest<{ volumeId: string; removed: boolean }>('remove_volume', { volumeId, force }, 30000);
  }

  public restartBridge() {
    if (this.process) {
      try {
        this.process.kill();
      } catch {
        // Ignore
      }
      this.process = null;
    }
  }

  public dispose() {
    this.restartBridge();
    this.rejectAllPending(new Error('Bridge disposed'));
  }
}
