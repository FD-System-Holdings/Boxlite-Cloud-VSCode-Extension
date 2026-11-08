import * as vscode from 'vscode';
import { BoxLiteBridgeClient } from '../bridge/client';

export class LogStreamManager implements vscode.Disposable {
  private channels = new Map<string, vscode.OutputChannel>();
  private intervals = new Map<string, NodeJS.Timeout>();

  constructor(private bridge: BoxLiteBridgeClient) {}

  public async openOrStreamLogs(boxId: string, boxName: string): Promise<void> {
    let channel = this.channels.get(boxId);
    if (!channel) {
      channel = vscode.window.createOutputChannel(`BoxLite: ${boxName} (${boxId.substring(0, 8)})`);
      this.channels.set(boxId, channel);
    }

    channel.show(true);
    channel.appendLine(`--- Streaming logs for Box ${boxName} (${boxId}) ---`);
    channel.appendLine(`[${new Date().toLocaleTimeString()}] Fetching /tmp/server.log...`);

    // Fetch initial logs
    try {
      const initial = await this.bridge.tailLog(boxId, '/tmp/server.log', 100);
      if (initial.content && initial.content.trim().length > 0) {
        channel.append(initial.content);
        if (!initial.content.endsWith('\n')) {
          channel.appendLine('');
        }
      } else {
        channel.appendLine('(No logs found in /tmp/server.log yet)');
      }
    } catch (e: any) {
      channel.appendLine(`[error] Could not read /tmp/server.log: ${e.message}`);
    }

    // Clear existing interval if already polling
    if (this.intervals.has(boxId)) {
      clearInterval(this.intervals.get(boxId)!);
    }

    let lastContent = '';
    const interval = setInterval(async () => {
      try {
        const res = await this.bridge.tailLog(boxId, '/tmp/server.log', 50);
        if (res.content && res.content !== lastContent) {
          // If new content is an extension of lastContent, append delta; otherwise print new
          if (res.content.startsWith(lastContent)) {
            const delta = res.content.substring(lastContent.length);
            channel!.append(delta);
          } else {
            channel!.append(res.content);
          }
          lastContent = res.content;
        }
      } catch {
        // Suppress polling errors
      }
    }, 2500);

    this.intervals.set(boxId, interval);
  }

  public stopStreaming(boxId: string) {
    if (this.intervals.has(boxId)) {
      clearInterval(this.intervals.get(boxId)!);
      this.intervals.delete(boxId);
    }
  }

  public dispose() {
    for (const [, timer] of this.intervals.entries()) {
      clearInterval(timer);
    }
    this.intervals.clear();
    for (const [, ch] of this.channels.entries()) {
      ch.dispose();
    }
    this.channels.clear();
  }
}
