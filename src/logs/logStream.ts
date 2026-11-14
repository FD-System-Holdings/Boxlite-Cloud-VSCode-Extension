import * as vscode from 'vscode';
import { BoxLiteBridgeClient } from '../bridge/client';

export function computeLogDelta(previousContent: string, currentContent: string): string {
  if (!currentContent) {
    return '';
  }
  if (!previousContent) {
    return currentContent;
  }
  if (currentContent === previousContent) {
    return '';
  }

  // Direct append (common when file hasn't exceeded tail window)
  if (currentContent.startsWith(previousContent)) {
    return currentContent.substring(previousContent.length);
  }

  // Sliding window overlap: compare line suffix with line prefix
  const prevLines = previousContent.split('\n');
  const currLines = currentContent.split('\n');

  const maxCheck = Math.min(prevLines.length, currLines.length);
  for (let k = maxCheck; k > 0; k--) {
    let match = true;
    for (let i = 0; i < k; i++) {
      if (prevLines[prevLines.length - k + i] !== currLines[i]) {
        match = false;
        break;
      }
    }
    if (match) {
      const newLines = currLines.slice(k);
      return newLines.length > 0 ? (newLines[0] === '' && newLines.length === 1 ? '' : '\n' + newLines.join('\n')) : '';
    }
  }

  // No overlap detected (e.g. log file rotated or completely rewritten)
  return '\n' + currentContent;
}

export class LogStreamManager implements vscode.Disposable {
  private channels = new Map<string, vscode.OutputChannel>();
  private intervals = new Map<string, NodeJS.Timeout>();
  private errorCounts = new Map<string, number>();
  private isDisposed = false;

  constructor(private bridge: BoxLiteBridgeClient) {}

  private safeAppendLine(channel: vscode.OutputChannel, line: string): void {
    if (this.isDisposed) {
      return;
    }
    try {
      channel.appendLine(line);
    } catch {
      // Ignore closed channel errors
    }
  }

  private safeAppend(channel: vscode.OutputChannel, text: string): void {
    if (this.isDisposed) {
      return;
    }
    try {
      channel.append(text);
    } catch {
      // Ignore closed channel errors
    }
  }

  public isStreaming(boxId: string): boolean {
    return this.intervals.has(boxId);
  }

  public async openOrStreamLogs(boxId: string, boxName: string): Promise<void> {
    if (this.isDisposed) {
      return;
    }
    let channel = this.channels.get(boxId);
    if (!channel) {
      channel = vscode.window.createOutputChannel(`BoxLite: ${boxName} (${boxId.substring(0, 8)})`);
      this.channels.set(boxId, channel);
    }

    try {
      channel.show(true);
    } catch {
      // Ignore closed channel errors
    }
    this.safeAppendLine(channel, `--- Streaming logs for Box ${boxName} (${boxId}) ---`);
    this.safeAppendLine(channel, `[${new Date().toLocaleTimeString()}] Fetching /tmp/server.log...`);

    let lastContent = '';
    this.errorCounts.set(boxId, 0);

    // Fetch initial logs
    try {
      const initial = await this.bridge.tailLog(boxId, '/tmp/server.log', 100);
      if (initial.content && initial.content.trim().length > 0) {
        lastContent = initial.content;
        this.safeAppend(channel, initial.content);
        if (!initial.content.endsWith('\n')) {
          this.safeAppendLine(channel, '');
        }
      } else {
        this.safeAppendLine(channel, '(No logs found in /tmp/server.log yet)');
      }
    } catch (e: any) {
      this.safeAppendLine(channel, `[error] Could not read /tmp/server.log: ${e.message}`);
    }

    // Clear existing interval if already polling
    this.stopStreaming(boxId);
    if (this.isDisposed) {
      return;
    }

    const interval = setInterval(async () => {
      if (this.isDisposed) {
        this.stopStreaming(boxId);
        return;
      }
      try {
        const res = await this.bridge.tailLog(boxId, '/tmp/server.log', 50);
        this.errorCounts.set(boxId, 0);

        if (res.stopped) {
          this.safeAppendLine(channel!, `[boxlite] Box ${boxId.substring(0, 8)} is stopped. Log streaming paused.`);
          this.stopStreaming(boxId);
          return;
        }

        if (res.content && res.content !== lastContent) {
          const delta = computeLogDelta(lastContent, res.content);
          if (delta.length > 0) {
            this.safeAppend(channel!, delta);
          }
          lastContent = res.content;
        }
      } catch (err: any) {
        const msg = (err.message || '').toLowerCase();
        if (
          msg.includes('stopped') ||
          msg.includes('stopping') ||
          msg.includes('not running') ||
          msg.includes('inactive') ||
          msg.includes('terminated') ||
          msg.includes('exited')
        ) {
          this.safeAppendLine(channel!, `[boxlite] Box is not running. Log streaming paused.`);
          this.stopStreaming(boxId);
          return;
        }
        const errs = (this.errorCounts.get(boxId) || 0) + 1;
        this.errorCounts.set(boxId, errs);
        if (errs >= 5) {
          this.safeAppendLine(channel!, `[stream] Stopped polling: box is unreachable or inactive (${err.message})`);
          this.stopStreaming(boxId);
        }
      }
    }, 2500);

    this.intervals.set(boxId, interval);
  }

  public stopStreaming(boxId: string) {
    if (this.intervals.has(boxId)) {
      clearInterval(this.intervals.get(boxId)!);
      this.intervals.delete(boxId);
    }
    this.errorCounts.delete(boxId);
  }

  public dispose() {
    this.isDisposed = true;
    for (const [, timer] of this.intervals.entries()) {
      clearInterval(timer);
    }
    this.intervals.clear();
    this.errorCounts.clear();
    for (const [, ch] of this.channels.entries()) {
      try {
        ch.dispose();
      } catch {
        // Ignore already-disposed channels
      }
    }
    this.channels.clear();
  }
}
