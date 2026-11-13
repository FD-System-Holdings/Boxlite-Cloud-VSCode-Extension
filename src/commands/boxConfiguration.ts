import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { CreateBoxArgs, SecretSpec, VolumeMountSpec } from '../bridge/protocol';
import { SecretsManager } from '../auth/secretsStore';
import { buildSupervisorEntrypoint, BoxliteProjectConfig } from '../deploy/project';
import {
  formatSecretPlaceholder,
  validateAllowlistRule,
  validateEnvAgainstSecrets,
  validateNetworkPolicy,
  validateSecretHeaders,
  validateSecretHosts,
  validateSecretName,
  validateSecretSpec
} from '../util/validation';

export type SizingPreset = 'small' | 'medium' | 'large' | 'custom';
export type EntrypointPreset = 'supervisor' | 'keepalive' | 'default' | 'custom';

export interface BoxConfiguration {
  name: string;
  image: string;
  sizingPreset: SizingPreset;
  cpus: number;
  memoryMib: number;
  diskSizeGb: number;
  inboundMode: 'enabled' | 'disabled';
  outboundMode: 'enabled' | 'disabled';
  allowNet: string[];
  autoStop: number;
  autoDelete: number;
  autoResume: boolean;
  entrypointPreset: EntrypointPreset;
  customEntrypoint?: string[];
  customStartCommand?: string;
  env: Record<string, string>;
  defaultPort: number;
  volumes?: VolumeMountSpec[];
  secrets?: SecretSpec[];
}

export interface BoxTemplate {
  id: string;
  label: string;
  description: string;
  detail: string;
  config: Partial<BoxConfiguration>;
}

export const SIZING_PRESETS: Record<
  Exclude<SizingPreset, 'custom'>,
  { label: string; description: string; cpus: number; memoryMib: number; diskSizeGb: number }
> = {
  small: {
    label: 'Small',
    description: '1 vCPU · 2048 MiB RAM · 10 GB Disk (Light workloads / Sandboxes)',
    cpus: 1,
    memoryMib: 2048,
    diskSizeGb: 10
  },
  medium: {
    label: 'Medium (Recommended)',
    description: '2 vCPU · 4096 MiB RAM · 20 GB Disk (Standard web services & apps)',
    cpus: 2,
    memoryMib: 4096,
    diskSizeGb: 20
  },
  large: {
    label: 'Large',
    description: '4 vCPU · 8192 MiB RAM · 40 GB Disk (Data processing & build tasks)',
    cpus: 4,
    memoryMib: 8192,
    diskSizeGb: 40
  }
};

export const STANDARD_IMAGES = [
  {
    label: 'python',
    description: 'Python 3 Standard Environment (agent.md §1 canonical)',
    detail: 'Fast startup, standard library, ideal for Python HTTP servers and agents'
  },
  {
    label: 'node',
    description: 'Node.js Runtime (LTS)',
    detail: 'Pre-configured with Node.js and npm for JavaScript/TypeScript services'
  },
  {
    label: 'ubuntu',
    description: 'Ubuntu Linux Cloud Environment',
    detail: 'Ubuntu base image suitable for general CLI tooling and utilities'
  },
  {
    label: 'debian',
    description: 'Debian Linux Slim Environment',
    detail: 'Lightweight Debian container base'
  },
  {
    label: 'alpine',
    description: 'Alpine Linux (Minimal)',
    detail: 'Extremely small image footprint, ideal for isolated utilities'
  }
];

export const BOX_TEMPLATES: BoxTemplate[] = [
  {
    id: 'python-app',
    label: '$(symbol-event) Python Web Application (agent.md §1)',
    description: 'Standard Python web service with background supervisor',
    detail: 'image: python · 2 vCPU · 4 GB RAM · Inbound enabled · Unrestricted outbound · Auto-stop disabled · Port 8080',
    config: {
      image: 'python',
      sizingPreset: 'medium',
      cpus: 2,
      memoryMib: 4096,
      diskSizeGb: 20,
      inboundMode: 'enabled',
      outboundMode: 'enabled',
      allowNet: [],
      autoStop: 0,
      autoDelete: 0,
      autoResume: true,
      entrypointPreset: 'supervisor',
      customStartCommand: 'python3 -u server.py',
      defaultPort: 8080
    }
  },
  {
    id: 'node-app',
    label: '$(server-process) Node.js Web Application',
    description: 'Node.js server with automatic supervisor restart',
    detail: 'image: node · 2 vCPU · 4 GB RAM · Inbound enabled · Unrestricted outbound · Auto-stop disabled · Port 3000',
    config: {
      image: 'node',
      sizingPreset: 'medium',
      cpus: 2,
      memoryMib: 4096,
      diskSizeGb: 20,
      inboundMode: 'enabled',
      outboundMode: 'enabled',
      allowNet: [],
      autoStop: 0,
      autoDelete: 0,
      autoResume: true,
      entrypointPreset: 'supervisor',
      customStartCommand: 'npm start',
      defaultPort: 3000
    }
  },
  {
    id: 'secure-egress',
    label: '$(shield) Secure / Egress-Restricted Box (agent.md §3)',
    description: 'Inbound web service with restricted outbound network allowlist',
    detail: 'image: python · 2 vCPU · 4 GB RAM · Inbound enabled · Filtered egress domain rules · 15m idle auto-stop',
    config: {
      image: 'python',
      sizingPreset: 'medium',
      cpus: 2,
      memoryMib: 4096,
      diskSizeGb: 20,
      inboundMode: 'enabled',
      outboundMode: 'enabled',
      allowNet: ['pypi.org', 'files.pythonhosted.org'],
      autoStop: 900,
      autoDelete: 0,
      autoResume: true,
      entrypointPreset: 'supervisor',
      customStartCommand: 'python3 -u server.py',
      defaultPort: 8080
    }
  },
  {
    id: 'airgapped-sandbox',
    label: '$(lock) Air-Gapped Isolated Sandbox (agent.md §3)',
    description: 'Completely isolated microVM with no guest NIC provisioned',
    detail: 'image: python · 1 vCPU · 2 GB RAM · Inbound disabled · Outbound disabled · Shell keepalive · 5m idle stop',
    config: {
      image: 'python',
      sizingPreset: 'small',
      cpus: 1,
      memoryMib: 2048,
      diskSizeGb: 10,
      inboundMode: 'disabled',
      outboundMode: 'disabled',
      allowNet: [],
      autoStop: 300,
      autoDelete: 0,
      autoResume: false,
      entrypointPreset: 'keepalive',
      defaultPort: 8080
    }
  },
  {
    id: 'ubuntu-utility',
    label: '$(terminal) Ubuntu Linux Interactive Utility',
    description: 'General purpose Ubuntu container with keepalive entrypoint',
    detail: 'image: ubuntu · 2 vCPU · 4 GB RAM · Outbound enabled · Inbound enabled · 30m idle stop',
    config: {
      image: 'ubuntu',
      sizingPreset: 'medium',
      cpus: 2,
      memoryMib: 4096,
      diskSizeGb: 20,
      inboundMode: 'enabled',
      outboundMode: 'enabled',
      allowNet: [],
      autoStop: 1800,
      autoDelete: 0,
      autoResume: false,
      entrypointPreset: 'keepalive',
      defaultPort: 8080
    }
  },
  {
    id: 'llm-secret-box',
    label: '$(shield) LLM / API Agent with Secret Proxy Injection (docs.boxlite.ai/cloud/secrets)',
    description: 'Calls OpenAI/HTTPS APIs with <BOXLITE_SECRET:model> placeholder injection',
    detail: 'image: python · 2 vCPU · 4 GB RAM · Restricted/Outbound enabled · Proxy Secret placeholder env',
    config: {
      image: 'python',
      sizingPreset: 'medium',
      cpus: 2,
      memoryMib: 4096,
      diskSizeGb: 20,
      inboundMode: 'disabled',
      outboundMode: 'enabled',
      allowNet: ['api.openai.com'],
      autoStop: 900,
      autoDelete: 0,
      autoResume: false,
      entrypointPreset: 'keepalive',
      env: { OPENAI_API_KEY: '<BOXLITE_SECRET:model>' },
      defaultPort: 8080
    }
  }
];

export function generateBoxName(prefix = 'box'): string {
  const rand = Math.random().toString(16).substring(2, 8);
  return `${prefix}-${rand}`;
}

export function getDefaultBoxConfiguration(): BoxConfiguration {
  const vsConfig = vscode.workspace.getConfiguration('boxlite');
  const defaultImage = vsConfig.get<string>('defaultImage', 'python');
  const defaultPort = vsConfig.get<number>('defaultPort', 8080);
  const defaultAutoStop = vsConfig.get<number>('autoStop', 0);
  const defaultAutoDelete = vsConfig.get<number>('defaultAutoDelete', 0);
  const defaultAutoResume = vsConfig.get<boolean>('defaultAutoResume', true);
  const defaultCpu = vsConfig.get<number>('defaultCpu', 2);
  const defaultMemory = vsConfig.get<number>('defaultMemory', 4096);
  const defaultDisk = vsConfig.get<number>('defaultDisk', 20);
  const defaultInbound = vsConfig.get<'enabled' | 'disabled'>('defaultInboundMode', 'enabled');
  const defaultOutbound = vsConfig.get<'enabled' | 'disabled'>('defaultOutboundMode', 'enabled');

  return {
    name: generateBoxName(),
    image: defaultImage,
    sizingPreset: 'medium',
    cpus: defaultCpu,
    memoryMib: defaultMemory,
    diskSizeGb: defaultDisk,
    inboundMode: defaultInbound,
    outboundMode: defaultOutbound,
    allowNet: [],
    autoStop: defaultAutoStop,
    autoDelete: defaultAutoDelete,
    autoResume: defaultAutoResume,
    entrypointPreset: 'supervisor',
    customStartCommand: 'python3 -u server.py',
    env: {},
    defaultPort,
    secrets: []
  };
}

export function getQuickCreateBoxConfiguration(name?: string): BoxConfiguration {
  return {
    ...getDefaultBoxConfiguration(),
    name: name?.trim() || generateBoxName(),
    sizingPreset: 'small',
    cpus: 1,
    memoryMib: 1024,
    diskSizeGb: 10,
    inboundMode: 'disabled',
    outboundMode: 'disabled',
    allowNet: [],
    autoResume: false,
    autoStop: 300
  };
}

export function resolveEntrypoint(config: BoxConfiguration): string[] | undefined {
  switch (config.entrypointPreset) {
    case 'supervisor':
      return buildSupervisorEntrypoint(config.customStartCommand || 'python3 -u server.py');
    case 'keepalive':
      return ['sh', '-c', 'while true; do sleep 3600; done'];
    case 'custom':
      if (config.customEntrypoint && config.customEntrypoint.length > 0) {
        return config.customEntrypoint;
      }
      return buildSupervisorEntrypoint(config.customStartCommand || 'python3 -u server.py');
    case 'default':
    default:
      return undefined;
  }
}

export function convertBoxConfigToCreateArgs(config: BoxConfiguration): CreateBoxArgs {
  const entrypoint = resolveEntrypoint(config);

  return {
    name: config.name.trim(),
    image: config.image.trim(),
    autoRemove: false,
    autoStop: config.autoStop,
    autoDelete: config.autoDelete,
    autoResume: config.autoResume,
    cpus: config.cpus,
    memoryMib: config.memoryMib,
    diskSizeGb: config.diskSizeGb,
    entrypoint,
    env: Object.keys(config.env).length > 0 ? config.env : undefined,
    network: {
      inbound: { mode: config.inboundMode },
      outbound: {
        mode: config.outboundMode,
        allow_net: config.outboundMode === 'enabled' ? config.allowNet : []
      }
    },
    volumes: config.volumes && config.volumes.length > 0 ? config.volumes : undefined,
    secrets: config.secrets && config.secrets.length > 0 ? config.secrets : undefined
  };
}

/**
 * Interactive Box Configuration Wizard
 * Presents a list of options for possible configuration of the box when creating a new box.
 */
export async function showBoxConfigurationWizard(
  initialConfig?: Partial<BoxConfiguration>,
  secretsManager?: SecretsManager
): Promise<CreateBoxArgs | undefined> {
  const current: BoxConfiguration = {
    ...getDefaultBoxConfiguration(),
    ...(initialConfig || {})
  };

  while (true) {
    const sizingLabel =
      current.sizingPreset !== 'custom'
        ? `${SIZING_PRESETS[current.sizingPreset].label} (${current.cpus} vCPU · ${current.memoryMib} MiB RAM · ${current.diskSizeGb} GB Disk)`
        : `Custom (${current.cpus} vCPU · ${current.memoryMib} MiB RAM · ${current.diskSizeGb} GB Disk)`;

    const inboundLabel =
      current.inboundMode === 'enabled'
        ? 'Enabled (Cloud Proxy Tunnels allowed)'
        : 'Disabled (Private microVM only)';

    const outboundLabel =
      current.outboundMode === 'disabled'
        ? 'Disabled (Air-gapped: no guest NIC)'
        : current.allowNet.length === 0
        ? 'Enabled (Unrestricted internet)'
        : `Enabled (${current.allowNet.length} allowlist rules: ${current.allowNet.slice(0, 2).join(', ')}${current.allowNet.length > 2 ? '...' : ''})`;

    const autoStopLabel =
      current.autoStop === 0
        ? 'Disabled (0s - Keep running indefinitely)'
        : `${current.autoStop}s (${Math.round(current.autoStop / 60)}m idle shutdown)`;

    const autoDeleteLabel =
      current.autoDelete === 0
        ? 'Disabled (0s - Persistent box)'
        : `${current.autoDelete}s (${Math.round(current.autoDelete / 86400)}d auto-delete)`;

    const autoResumeLabel = current.autoResume
      ? 'Enabled (Wake on proxy access)'
      : 'Disabled (Manual start only)';

    const entrypointLabel =
      current.entrypointPreset === 'supervisor'
        ? `App Supervisor (${current.customStartCommand || 'python3 -u server.py'})`
        : current.entrypointPreset === 'keepalive'
        ? 'Persistent Keepalive (sleep 3600 loop)'
        : current.entrypointPreset === 'default'
        ? 'Image Default Entrypoint'
        : `Custom Command (${current.customEntrypoint?.join(' ') || 'none'})`;

    const envKeys = Object.keys(current.env);
    const envLabel =
      envKeys.length === 0
        ? 'None configured'
        : `${envKeys.length} variable${envKeys.length > 1 ? 's' : ''} (${envKeys.slice(0, 3).join(', ')}${envKeys.length > 3 ? '...' : ''})`;

    const configuredSecrets = current.secrets || [];
    const secretsLabel =
      configuredSecrets.length === 0
        ? 'None configured'
        : `${configuredSecrets.length} secret${configuredSecrets.length > 1 ? 's' : ''} (${configuredSecrets.map((s) => s.name).join(', ')})`;

    const items: (vscode.QuickPickItem & { action: string })[] = [
      {
        label: '$(check) Create Box with Current Configuration',
        description: `Name: ${current.name} · Image: ${current.image}`,
        detail: 'Proceed to provision and boot the microVM with these settings',
        action: 'create'
      },
      {
        label: '$(symbol-variable) Box Name',
        description: current.name,
        detail: 'Unique identifier name for the BoxLite instance',
        action: 'name'
      },
      {
        label: '$(package) Base Image',
        description: current.image,
        detail: 'Runtime image alias (python, node, ubuntu, debian, alpine) or custom image',
        action: 'image'
      },
      {
        label: '$(dashboard) Compute & Memory Sizing',
        description: sizingLabel,
        detail: 'Allocate vCPU cores, RAM (MiB), and Rootfs disk quota (GB)',
        action: 'sizing'
      },
      {
        label: '$(globe) Inbound Proxy Access',
        description: inboundLabel,
        detail: 'Allow external Cloud proxy access and HTTP tunnels for web services (§2)',
        action: 'inbound'
      },
      {
        label: '$(shield) Outbound Network Policy',
        description: outboundLabel,
        detail: 'Configure guest internet egress: Unrestricted, Restricted Allowlist, or Disabled (§3)',
        action: 'outbound'
      },
      {
        label: '$(watch) Auto-Stop Interval',
        description: autoStopLabel,
        detail: 'Automatically stop microVM when idle to conserve compute resources (§1)',
        action: 'autoStop'
      },
      {
        label: '$(trash) Auto-Delete Interval',
        description: autoDeleteLabel,
        detail: 'Automatically delete box after specified seconds (0 = persistent)',
        action: 'autoDelete'
      },
      {
        label: '$(sync) Auto-Resume on Traffic',
        description: autoResumeLabel,
        detail: 'Automatically boot/wake microVM when HTTP request arrives at proxy URL',
        action: 'autoResume'
      },
      {
        label: '$(terminal) Entrypoint & Supervisor',
        description: entrypointLabel,
        detail: 'Process lifecycle supervisor for file delivery and automatic restarts (§1)',
        action: 'entrypoint'
      },
      {
        label: '$(key) Environment Variables',
        description: envLabel,
        detail: 'Set custom KEY=VALUE environment variables passed to the box container',
        action: 'env'
      },
      {
        label: '$(shield) Outbound Proxy Secrets',
        description: secretsLabel,
        detail: 'Inject real credentials into HTTPS headers at outbound proxy without exposing keys inside box',
        action: 'secrets'
      },
      {
        label: '$(plug) Default Service Port',
        description: `${current.defaultPort}`,
        detail: 'Initial application server port for declaring web tunnels',
        action: 'port'
      },
      {
        label: '$(file-code) Load Preset Template...',
        description: 'Python App · Node.js · Secure Box · Air-Gapped Sandbox',
        detail: 'Overwrite current options with an agent-verified configuration profile',
        action: 'template'
      },
      {
        label: '$(save) Save as Workspace Default (boxlite.json)',
        description: 'Persist options into workspace boxlite.json',
        detail: 'Stores these box parameters so future deployments reuse this setup',
        action: 'save'
      },
      {
        label: '$(close) Cancel',
        description: 'Abort box creation',
        detail: '',
        action: 'cancel'
      }
    ];

    const pick = await vscode.window.showQuickPick(items, {
      title: 'BoxLite: Configure New Box Options',
      placeHolder: 'Select an option to customize, or click "Create Box" to proceed'
    });

    if (!pick || pick.action === 'cancel') {
      return undefined;
    }

    if (pick.action === 'create') {
      // Validate
      if (!current.name.trim()) {
        vscode.window.showErrorMessage('Box name cannot be empty.');
        continue;
      }
      const netRes = validateNetworkPolicy(current.inboundMode, current.outboundMode, current.allowNet);
      if (!netRes.valid) {
        vscode.window.showErrorMessage(`Invalid network policy: ${netRes.errors.join('; ')}`);
        continue;
      }
      for (const s of current.secrets || []) {
        const sCheck = validateSecretSpec(s, true);
        if (!sCheck.valid) {
          vscode.window.showErrorMessage(`Invalid secret "${s.name}": ${sCheck.error}`);
          continue;
        }
      }
      const envSecretCheck = validateEnvAgainstSecrets(current.env, current.secrets || []);
      if (!envSecretCheck.valid) {
        vscode.window.showErrorMessage(envSecretCheck.error || 'Environment contains raw secret value.');
        continue;
      }
      return convertBoxConfigToCreateArgs(current);
    }

    switch (pick.action) {
      case 'name':
        await promptForName(current);
        break;
      case 'image':
        await promptForImage(current);
        break;
      case 'sizing':
        await promptForSizing(current);
        break;
      case 'inbound':
        await promptForInbound(current);
        break;
      case 'outbound':
        await promptForOutbound(current);
        break;
      case 'autoStop':
        await promptForAutoStop(current);
        break;
      case 'autoDelete':
        await promptForAutoDelete(current);
        break;
      case 'autoResume':
        await promptForAutoResume(current);
        break;
      case 'entrypoint':
        await promptForEntrypoint(current);
        break;
      case 'env':
        await promptForEnv(current);
        break;
      case 'secrets':
        await promptForSecrets(current, secretsManager);
        break;
      case 'port':
        await promptForPort(current);
        break;
      case 'template':
        await promptForTemplate(current);
        break;
      case 'save':
        await saveConfigToProject(current);
        break;
    }
  }
}

async function promptForName(current: BoxConfiguration) {
  const res = await vscode.window.showInputBox({
    prompt: 'Enter unique Box name',
    value: current.name,
    validateInput: (v) => (!v.trim() ? 'Name cannot be empty' : null)
  });
  if (res && res.trim()) {
    current.name = res.trim();
  }
}

async function promptForImage(current: BoxConfiguration) {
  const options = STANDARD_IMAGES.map((img) => ({
    label: img.label,
    description: img.description,
    detail: img.detail,
    isCustom: false
  })).concat([
    {
      label: '$(edit) Custom Image...',
      description: 'Specify custom image repository or tag',
      detail: 'e.g. python:3.12-slim, node:20-alpine, or docker registry tag',
      isCustom: true
    }
  ]);

  const selected = await vscode.window.showQuickPick(options, {
    title: 'Select Base Image',
    placeHolder: `Current: ${current.image}`
  });

  if (!selected) {
    return;
  }

  if (selected.isCustom) {
    const custom = await vscode.window.showInputBox({
      prompt: 'Enter container image tag (e.g. python:3.12-slim)',
      value: current.image
    });
    if (custom && custom.trim()) {
      current.image = custom.trim();
    }
  } else {
    current.image = selected.label;
  }
}

async function promptForSizing(current: BoxConfiguration) {
  const items = [
    {
      label: SIZING_PRESETS.small.label,
      description: SIZING_PRESETS.small.description,
      preset: 'small' as SizingPreset
    },
    {
      label: SIZING_PRESETS.medium.label,
      description: SIZING_PRESETS.medium.description,
      preset: 'medium' as SizingPreset
    },
    {
      label: SIZING_PRESETS.large.label,
      description: SIZING_PRESETS.large.description,
      preset: 'large' as SizingPreset
    },
    {
      label: '$(gear) Custom Sizing...',
      description: 'Manually specify vCPU, Memory MiB, and Disk GB',
      preset: 'custom' as SizingPreset
    }
  ];

  const pick = await vscode.window.showQuickPick(items, {
    title: 'Select Compute & Memory Sizing',
    placeHolder: `Current: ${current.sizingPreset}`
  });

  if (!pick) {
    return;
  }

  if (pick.preset === 'custom') {
    const cpusStr = await vscode.window.showInputBox({
      prompt: 'Number of vCPU cores (1, 2, 4, 8)',
      value: `${current.cpus}`,
      validateInput: (v) => {
        const n = parseInt(v, 10);
        return isNaN(n) || n < 1 || n > 32 ? 'Enter a valid vCPU count (1-32)' : null;
      }
    });
    if (!cpusStr) {
      return;
    }

    const memStr = await vscode.window.showInputBox({
      prompt: 'Memory in MiB (e.g. 1024, 2048, 4096, 8192)',
      value: `${current.memoryMib}`,
      validateInput: (v) => {
        const n = parseInt(v, 10);
        return isNaN(n) || n < 256 ? 'Enter a valid memory size in MiB (>= 256)' : null;
      }
    });
    if (!memStr) {
      return;
    }

    const diskStr = await vscode.window.showInputBox({
      prompt: 'Disk size in GB (e.g. 10, 20, 40)',
      value: `${current.diskSizeGb}`,
      validateInput: (v) => {
        const n = parseInt(v, 10);
        return isNaN(n) || n < 1 ? 'Enter a valid disk size in GB (>= 1)' : null;
      }
    });
    if (!diskStr) {
      return;
    }

    current.sizingPreset = 'custom';
    current.cpus = parseInt(cpusStr, 10);
    current.memoryMib = parseInt(memStr, 10);
    current.diskSizeGb = parseInt(diskStr, 10);
  } else {
    const p = SIZING_PRESETS[pick.preset];
    current.sizingPreset = pick.preset;
    current.cpus = p.cpus;
    current.memoryMib = p.memoryMib;
    current.diskSizeGb = p.diskSizeGb;
  }
}

async function promptForInbound(current: BoxConfiguration) {
  const items = [
    {
      label: '$(globe) Enabled (Recommended for Web Services)',
      description: 'Allow Cloud proxy access, public/private URLs, and declared tunnels (§2)',
      mode: 'enabled' as const
    },
    {
      label: '$(lock) Disabled',
      description: 'Deny proxy access; guest reachable only via direct exec commands (§3)',
      mode: 'disabled' as const
    }
  ];

  const pick = await vscode.window.showQuickPick(items, {
    title: 'Configure Inbound Proxy Access Mode',
    placeHolder: `Current: ${current.inboundMode}`
  });

  if (pick) {
    current.inboundMode = pick.mode;
  }
}

async function promptForOutbound(current: BoxConfiguration) {
  const items = [
    {
      label: '$(pass) Enabled · Unrestricted (allow_net=[])',
      description: 'Full outbound internet access to download dependencies and call external APIs (§1)',
      action: 'unrestricted'
    },
    {
      label: '$(filter) Enabled · Restricted Allowlist',
      description: 'Restrict outbound traffic to explicit domains/CIDRs (e.g. api.example.com, *.github.com) (§3)',
      action: 'restricted'
    },
    {
      label: '$(circle-slash) Disabled · Isolated / Air-Gapped',
      description: 'No guest NIC provisioned at creation. Warning: Cannot acquire NIC at runtime (§3)',
      action: 'disabled'
    }
  ];

  const pick = await vscode.window.showQuickPick(items, {
    title: 'Configure Outbound Network Policy (§3)',
    placeHolder: `Current: ${current.outboundMode} (${current.allowNet.length} rules)`
  });

  if (!pick) {
    return;
  }

  if (pick.action === 'unrestricted') {
    current.outboundMode = 'enabled';
    current.allowNet = [];
  } else if (pick.action === 'disabled') {
    current.outboundMode = 'disabled';
    current.allowNet = [];
  } else if (pick.action === 'restricted') {
    const currentStr = current.allowNet.join(', ');
    const input = await vscode.window.showInputBox({
      prompt: 'Enter comma-separated allowed hostnames or IPv4 CIDRs (e.g. api.boxlite.ai, *.github.com, 1.1.1.1/32)',
      value: currentStr || 'api.boxlite.ai, *.github.com',
      validateInput: (val) => {
        const rules = val.split(',').map((r) => r.trim()).filter((r) => r.length > 0);
        if (rules.length === 0) {
          return 'Enter at least one rule for restricted outbound mode, or choose Unrestricted';
        }
        for (const rule of rules) {
          const res = validateAllowlistRule(rule);
          if (!res.valid) {
            return `Rule "${rule}" is invalid: ${res.error}`;
          }
        }
        return null;
      }
    });

    if (input !== undefined) {
      current.outboundMode = 'enabled';
      current.allowNet = input
        .split(',')
        .map((r) => r.trim())
        .filter((r) => r.length > 0);
    }
  }
}

async function promptForAutoStop(current: BoxConfiguration) {
  const items = [
    { label: '0s (Disabled)', description: 'Keep box running continuously (recommended for always-on servers §1)', val: 0 },
    { label: '300s (5 minutes)', description: 'Stop after 5 minutes of inactivity', val: 300 },
    { label: '900s (15 minutes)', description: 'Stop after 15 minutes of inactivity', val: 900 },
    { label: '1800s (30 minutes)', description: 'Stop after 30 minutes of inactivity', val: 1800 },
    { label: '3600s (1 hour)', description: 'Stop after 1 hour of inactivity', val: 3600 },
    { label: '$(edit) Custom Interval...', description: 'Specify custom seconds (0 or >= 60)', val: -1 }
  ];

  const pick = await vscode.window.showQuickPick(items, {
    title: 'Configure Auto-Stop Inactivity Interval',
    placeHolder: `Current: ${current.autoStop}s`
  });

  if (!pick) {
    return;
  }

  if (pick.val === -1) {
    const custom = await vscode.window.showInputBox({
      prompt: 'Enter auto_stop in seconds (0 to disable, or >= 60 seconds)',
      value: `${current.autoStop}`,
      validateInput: (v) => {
        const n = parseInt(v, 10);
        if (isNaN(n) || n < 0) {
          return 'Enter a non-negative integer';
        }
        if (n > 0 && n < 60) {
          return 'Boxlite Cloud requires auto_stop to be 0 or >= 60 seconds';
        }
        return null;
      }
    });
    if (custom !== undefined) {
      current.autoStop = parseInt(custom, 10);
    }
  } else {
    current.autoStop = pick.val;
  }
}

async function promptForAutoDelete(current: BoxConfiguration) {
  const items = [
    { label: '0s (Disabled)', description: 'Box persists permanently until manually deleted (§4)', val: 0 },
    { label: '86400s (1 day)', description: 'Automatically destroy box after 24 hours', val: 86400 },
    { label: '604800s (7 days)', description: 'Automatically destroy box after 1 week', val: 604800 },
    { label: '2592000s (30 days)', description: 'Automatically destroy box after 30 days', val: 2592000 },
    { label: '$(edit) Custom Interval...', description: 'Specify custom seconds (0 = disabled)', val: -1 }
  ];

  const pick = await vscode.window.showQuickPick(items, {
    title: 'Configure Auto-Delete Lifecycle Interval',
    placeHolder: `Current: ${current.autoDelete}s`
  });

  if (!pick) {
    return;
  }

  if (pick.val === -1) {
    const custom = await vscode.window.showInputBox({
      prompt: 'Enter auto_delete interval in seconds (0 for persistent)',
      value: `${current.autoDelete}`,
      validateInput: (v) => {
        const n = parseInt(v, 10);
        return isNaN(n) || n < 0 ? 'Enter a non-negative integer' : null;
      }
    });
    if (custom !== undefined) {
      current.autoDelete = parseInt(custom, 10);
    }
  } else {
    current.autoDelete = pick.val;
  }
}

async function promptForAutoResume(current: BoxConfiguration) {
  const items = [
    {
      label: '$(pass) Enabled (Recommended)',
      description: 'MicroVM automatically wakes up when incoming traffic arrives at cloud proxy URL (§1)',
      val: true
    },
    {
      label: '$(circle-slash) Disabled',
      description: 'MicroVM must be started manually before accepting incoming requests',
      val: false
    }
  ];

  const pick = await vscode.window.showQuickPick(items, {
    title: 'Configure Auto-Resume on Proxy Access',
    placeHolder: `Current: ${current.autoResume ? 'Enabled' : 'Disabled'}`
  });

  if (pick) {
    current.autoResume = pick.val;
  }
}

async function promptForEntrypoint(current: BoxConfiguration) {
  const items = [
    {
      label: '$(server-process) App Supervisor (Recommended for deployments §1)',
      description: 'Keeps PID 1 alive, monitors /app, and automatically launches/restarts the server',
      preset: 'supervisor' as EntrypointPreset
    },
    {
      label: '$(terminal) Persistent Keepalive Shell',
      description: 'Runs "sleep infinity" loop; ideal for running interactive commands via exec',
      preset: 'keepalive' as EntrypointPreset
    },
    {
      label: '$(package) Image Default Entrypoint',
      description: 'Preserve base image ENTRYPOINT and CMD directives',
      preset: 'default' as EntrypointPreset
    },
    {
      label: '$(edit) Custom Command...',
      description: 'Specify custom executable and arguments',
      preset: 'custom' as EntrypointPreset
    }
  ];

  const pick = await vscode.window.showQuickPick(items, {
    title: 'Configure Container Entrypoint (§1 & §4)',
    placeHolder: `Current: ${current.entrypointPreset}`
  });

  if (!pick) {
    return;
  }

  if (pick.preset === 'supervisor') {
    const cmd = await vscode.window.showInputBox({
      prompt: 'Supervisor start command to execute when files exist in /app',
      value: current.customStartCommand || 'python3 -u server.py'
    });
    current.entrypointPreset = 'supervisor';
    if (cmd && cmd.trim()) {
      current.customStartCommand = cmd.trim();
    }
  } else if (pick.preset === 'custom') {
    const raw = await vscode.window.showInputBox({
      prompt: 'Enter space-separated command to run as PID 1 (e.g. sh -c "python3 main.py")',
      value: current.customEntrypoint?.join(' ') || 'sh -c "sleep 3600"'
    });
    if (raw && raw.trim()) {
      current.entrypointPreset = 'custom';
      current.customEntrypoint = ['sh', '-c', raw.trim()];
    }
  } else {
    current.entrypointPreset = pick.preset;
  }
}

async function promptForEnv(current: BoxConfiguration) {
  const envList = Object.entries(current.env);
  const items: (vscode.QuickPickItem & { action: string; key?: string })[] = [
    {
      label: '$(add) Add Environment Variable...',
      description: 'Format: KEY=VALUE',
      action: 'add'
    }
  ];

  for (const [k, v] of envList) {
    items.push({
      label: `$(key) ${k}`,
      description: v,
      detail: 'Click to edit or remove this variable',
      action: 'edit',
      key: k
    });
  }

  if (envList.length > 0) {
    items.push({
      label: '$(trash) Clear All Variables',
      description: `Remove all ${envList.length} variables`,
      action: 'clear'
    });
  }

  const pick = await vscode.window.showQuickPick(items, {
    title: 'Configure Box Environment Variables',
    placeHolder: `${envList.length} variables configured`
  });

  if (!pick) {
    return;
  }

  if (pick.action === 'add') {
    const pair = await vscode.window.showInputBox({
      prompt: 'Enter variable in KEY=VALUE format (e.g. PORT=8080 or NODE_ENV=production)',
      validateInput: (v) => {
        if (!v.includes('=')) {
          return 'Must contain "=" (e.g. KEY=VALUE)';
        }
        const key = v.substring(0, v.indexOf('=')).trim();
        if (!key) {
          return 'Key cannot be empty';
        }
        return null;
      }
    });

    if (pair) {
      const idx = pair.indexOf('=');
      const key = pair.substring(0, idx).trim();
      const val = pair.substring(idx + 1);
      current.env[key] = val;
    }
  } else if (pick.action === 'edit' && pick.key) {
    const action = await vscode.window.showQuickPick(
      [
        { label: '$(edit) Edit Value', val: 'edit' },
        { label: '$(trash) Remove Variable', val: 'remove' }
      ],
      { title: `Variable: ${pick.key}` }
    );

    if (action?.val === 'edit') {
      const newVal = await vscode.window.showInputBox({
        prompt: `New value for ${pick.key}`,
        value: current.env[pick.key]
      });
      if (newVal !== undefined) {
        current.env[pick.key] = newVal;
      }
    } else if (action?.val === 'remove') {
      delete current.env[pick.key];
    }
  } else if (pick.action === 'clear') {
    current.env = {};
  }
}

async function promptForSecrets(current: BoxConfiguration, secretsManager?: SecretsManager) {
  const secretList = current.secrets || [];
  const items: (vscode.QuickPickItem & { action: string; secretName?: string })[] = [
    {
      label: '$(add) Add New Outbound Proxy Secret...',
      description: 'Configure name, real credential value, allowed hosts, and header template',
      action: 'add-new'
    }
  ];

  if (secretsManager) {
    const saved = await secretsManager.listSecrets();
    for (const s of saved) {
      if (!secretList.some((c) => c.name.toLowerCase() === s.name.toLowerCase())) {
        items.push({
          label: `$(shield) Attach Saved Secret: ${s.name}`,
          description: `${s.hosts.join(', ')} · <BOXLITE_SECRET:${s.name}>`,
          detail: 'Stored in VS Code SecretStorage',
          action: 'attach-saved',
          secretName: s.name
        });
      }
    }
  }

  for (const s of secretList) {
    items.push({
      label: `$(key) ${s.name}`,
      description: `${s.hosts.join(', ')} · ${Object.entries(s.headers).map(([k, v]) => `${k}: ${v}`).join(', ')}`,
      detail: `Placeholder inside box: ${formatSecretPlaceholder(s.name)} (Click to remove)`,
      action: 'remove',
      secretName: s.name
    });
  }

  if (secretList.length > 0) {
    items.push({
      label: '$(trash) Clear All Secrets',
      description: `Remove all ${secretList.length} secrets from this box configuration`,
      action: 'clear'
    });
  }

  const pick = await vscode.window.showQuickPick(items, {
    title: 'Configure Box Outbound Proxy Secrets',
    placeHolder: `${secretList.length} secrets attached`
  });

  if (!pick) {
    return;
  }

  if (pick.action === 'attach-saved' && pick.secretName && secretsManager) {
    const stored = await secretsManager.getSecret(pick.secretName);
    if (stored) {
      current.secrets = [
        ...(current.secrets || []),
        {
          name: stored.name,
          value: stored.value,
          hosts: stored.hosts,
          headers: stored.headers
        }
      ];
      if (stored.envVar && !current.env[stored.envVar]) {
        current.env[stored.envVar] = formatSecretPlaceholder(stored.name);
      }
    }
  } else if (pick.action === 'add-new') {
    const preset = await vscode.window.showQuickPick(
      [
        {
          label: '$(sparkle) OpenAI / Compatible LLM API',
          description: 'name: model · host: api.openai.com · Authorization: Bearer {value}',
          name: 'model',
          hosts: 'api.openai.com',
          headerName: 'Authorization',
          headerTemplate: 'Bearer {value}',
          envVar: 'OPENAI_API_KEY'
        },
        {
          label: '$(hubot) Anthropic API',
          description: 'name: anthropic · host: api.anthropic.com · X-Api-Key: {value}',
          name: 'anthropic',
          hosts: 'api.anthropic.com',
          headerName: 'X-Api-Key',
          headerTemplate: '{value}',
          envVar: 'ANTHROPIC_API_KEY'
        },
        {
          label: '$(edit) Custom HTTPS API Secret...',
          description: 'Specify custom secret name, hosts, and header mapping',
          name: 'api_key',
          hosts: 'api.example.com',
          headerName: 'Authorization',
          headerTemplate: 'Bearer {value}',
          envVar: ''
        }
      ],
      { title: 'Select Secret Template' }
    );
    if (!preset) {
      return;
    }

    const name = await vscode.window.showInputBox({
      prompt: 'Enter secret name (used inside box as <BOXLITE_SECRET:name>)',
      value: preset.name,
      validateInput: (v) => {
        const res = validateSecretName(v);
        return res.valid ? null : res.error || 'Invalid secret name';
      }
    });
    if (!name) {
      return;
    }

    const hostsStr = await vscode.window.showInputBox({
      prompt: 'Enter comma-separated destination hostnames without https:// or path (e.g. api.openai.com)',
      value: preset.hosts,
      validateInput: (v) => {
        const hosts = v.split(',').map((h) => h.trim()).filter((h) => h.length > 0);
        const res = validateSecretHosts(hosts);
        return res.valid ? null : res.error || 'Invalid hostnames';
      }
    });
    if (!hostsStr) {
      return;
    }
    const hosts = hostsStr.split(',').map((h) => h.trim()).filter((h) => h.length > 0);

    const headerName = await vscode.window.showInputBox({
      prompt: 'Target HTTP request header name (must already be sent by guest code)',
      value: preset.headerName,
      validateInput: (v) => {
        const res = validateSecretHeaders({ [v.trim()]: preset.headerTemplate });
        return res.valid ? null : res.error || 'Invalid header name';
      }
    });
    if (!headerName) {
      return;
    }

    const headerTemplate = await vscode.window.showInputBox({
      prompt: `Header template for "${headerName.trim()}" using {value} (e.g. "Bearer {value}" or "{value}")`,
      value: preset.headerTemplate,
      validateInput: (v) => {
        const res = validateSecretHeaders({ [headerName.trim()]: v });
        return res.valid ? null : res.error || 'Invalid header template';
      }
    });
    if (!headerTemplate) {
      return;
    }

    const value = await vscode.window.showInputBox({
      prompt: `Enter real credential value for "${name.trim()}" (stored securely; never written to BoxOptions.env)`,
      password: true,
      ignoreFocusOut: true,
      validateInput: (v) => {
        if (!v || !v.trim()) {
          return 'Secret value cannot be empty.';
        }
        if (v.includes('<BOXLITE_SECRET:')) {
          return 'Enter the real credential value here, not the <BOXLITE_SECRET:...> placeholder.';
        }
        return null;
      }
    });
    if (!value) {
      return;
    }

    const envVar = await vscode.window.showInputBox({
      prompt: `Optional guest env var to populate with "${formatSecretPlaceholder(name.trim())}" (leave empty to skip)`,
      value: preset.envVar
    });
    if (envVar === undefined) {
      return;
    }

    const headers = { [headerName.trim()]: headerTemplate.trim() };
    const newSecret: SecretSpec = {
      name: name.trim(),
      value: value.trim(),
      hosts,
      headers
    };

    const existing = (current.secrets || []).filter(
      (s) => s.name.toLowerCase() !== newSecret.name.toLowerCase()
    );
    current.secrets = [...existing, newSecret];

    if (envVar.trim()) {
      current.env[envVar.trim()] = formatSecretPlaceholder(newSecret.name);
    }

    if (secretsManager) {
      await secretsManager.saveSecret({
        ...newSecret,
        envVar: envVar.trim() || undefined
      });
    }
  } else if (pick.action === 'remove' && pick.secretName) {
    current.secrets = (current.secrets || []).filter(
      (s) => s.name.toLowerCase() !== pick.secretName!.toLowerCase()
    );
  } else if (pick.action === 'clear') {
    current.secrets = [];
  }
}

async function promptForPort(current: BoxConfiguration) {
  const res = await vscode.window.showInputBox({
    prompt: 'Default application service port (1-65535)',
    value: `${current.defaultPort}`,
    validateInput: (v) => {
      const p = parseInt(v, 10);
      return isNaN(p) || p < 1 || p > 65535 ? 'Port must be an integer between 1 and 65535' : null;
    }
  });

  if (res) {
    current.defaultPort = parseInt(res, 10);
  }
}

async function promptForTemplate(current: BoxConfiguration) {
  const items = BOX_TEMPLATES.map((tmpl) => ({
    label: tmpl.label,
    description: tmpl.description,
    detail: tmpl.detail,
    tmpl
  }));

  const pick = await vscode.window.showQuickPick(items, {
    title: 'Select Configuration Template (§1, §2, §3)',
    placeHolder: 'Choose a configuration preset to populate all box settings'
  });

  if (pick) {
    Object.assign(current, pick.tmpl.config);
    vscode.window.showInformationMessage(`Loaded template "${pick.tmpl.label}".`);
  }
}

export async function saveConfigToProject(
  config: BoxConfiguration,
  workspaceUri?: vscode.Uri
): Promise<boolean> {
  const root = workspaceUri || vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!root) {
    vscode.window.showWarningMessage('Cannot save configuration: No workspace folder is open.');
    return false;
  }

  const filePath = path.join(root.fsPath, 'boxlite.json');
  let existing: Partial<BoxliteProjectConfig> = {};
  if (fs.existsSync(filePath)) {
    try {
      existing = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch {
      // Ignore
    }
  }

  const projectConfig: BoxliteProjectConfig = {
    ...existing,
    name: config.name,
    image: config.image,
    appDir: existing.appDir || './app',
    port: config.defaultPort,
    healthPath: existing.healthPath || '/healthz',
    start: config.customStartCommand || existing.start || 'python3 -u server.py',
    access: config.inboundMode === 'enabled' ? 'public' : 'private',
    network: {
      inbound: config.inboundMode,
      outbound: {
        mode: config.outboundMode,
        allow_net: config.allowNet
      }
    },
    autoStop: config.autoStop,
    autoDelete: config.autoDelete,
    autoResume: config.autoResume,
    cpus: config.cpus,
    memoryMib: config.memoryMib,
    diskSizeGb: config.diskSizeGb,
    volumes: config.volumes || existing.volumes || [],
    secrets:
      config.secrets && config.secrets.length > 0
        ? config.secrets.map((s) => SecretsManager.toConfigSpec(s))
        : existing.secrets || [],
    env: config.env
  };

  try {
    fs.writeFileSync(filePath, JSON.stringify(projectConfig, null, 2), 'utf-8');
    vscode.window.showInformationMessage(`Saved box configuration to ${path.basename(filePath)}.`);
    return true;
  } catch (err: any) {
    vscode.window.showErrorMessage(`Failed to save boxlite.json: ${err.message}`);
    return false;
  }
}
