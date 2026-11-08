export interface BridgeRequest<T = any> {
  id: string;
  op: string;
  args?: T;
}

export interface BridgeErrorPayload {
  code: string;
  message: string;
  diagnosis?: string;
  stack?: string;
}

export interface BridgeResponse<T = any> {
  id: string;
  success: boolean;
  data?: T;
  error?: BridgeErrorPayload;
}

export interface TunnelInfo {
  port: number;
  url: string;
  isPublic: boolean;
  token?: string;
}

export interface BoxListItem {
  id: string;
  name: string;
  status: 'running' | 'stopped' | 'provisioning' | 'error' | string;
  image?: string;
  tunnels?: TunnelInfo[];
}

export interface NetworkConfig {
  inbound?: {
    mode: 'enabled' | 'disabled';
  };
  outbound?: {
    mode: 'enabled' | 'disabled';
    allow_net?: string[];
  };
}

export interface CreateBoxArgs {
  name?: string;
  image?: string;
  autoRemove?: boolean;
  autoStop?: number;
  entrypoint?: string[];
  network?: NetworkConfig;
}

export interface ExecArgs {
  boxId: string;
  command: string;
  args?: string[];
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CopyInArgs {
  boxId: string;
  source: string;
  destination: string;
}

export interface TunnelArgs {
  boxId: string;
  port: number;
  isPublic?: boolean;
}

export interface TunnelResult {
  boxId: string;
  port: number;
  isPublic: boolean;
  url: string;
  token?: string;
}

export interface TailLogArgs {
  boxId: string;
  logFile?: string;
  lines?: number;
}

export interface TailLogResult {
  boxId: string;
  content: string;
  exitCode: number;
}
