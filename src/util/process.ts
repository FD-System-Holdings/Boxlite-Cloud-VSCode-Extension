import * as fs from 'fs';

export interface ExecutableCommand {
  bin: string;
  args: string[];
}

const UNSAFE_SUBPROCESS_ENV_VARS = [
  'ELECTRON_RUN_AS_NODE',
  'VSCODE_INSPECTOR_OPTIONS',
  'NODE_OPTIONS',
  'VSCODE_ESM_ENTRYPOINT',
  'VSCODE_HANDLES_UNCAUGHT_ERRORS'
] as const;

/** Builds a clean environment for child processes without VS Code / Electron debug hooks. */
export function createCleanSubprocessEnv(overrides?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...overrides };
  for (const key of UNSAFE_SUBPROCESS_ENV_VARS) {
    delete env[key];
  }
  return env;
}

export function parseExecutableCommand(commandString: string): ExecutableCommand {
  const trimmed = commandString.trim();
  if (!trimmed) {
    return { bin: '', args: [] };
  }

  // If wrapped in matching quotes: "C:\Program Files\Python\python.exe"
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    const unquoted = trimmed.slice(1, -1);
    return { bin: unquoted, args: [] };
  }

  // Windows Python Launcher syntax (e.g. 'py -3', 'py -3.11')
  if (trimmed.startsWith('py ') || trimmed.startsWith('py.exe ')) {
    const parts = trimmed.split(' ').filter(Boolean);
    return { bin: parts[0], args: parts.slice(1) };
  }

  // If commandString is an existing file path, keep it intact (handles paths with spaces)
  if (fs.existsSync(trimmed)) {
    return { bin: trimmed, args: [] };
  }

  // If no spaces, it is a simple binary name like 'python3' or 'python'
  const firstSpace = trimmed.indexOf(' ');
  if (firstSpace === -1) {
    return { bin: trimmed, args: [] };
  }

  // Check if unquoted path with spaces exists (e.g., entered by user in settings without quotes)
  // Otherwise, split on first space
  return {
    bin: trimmed.substring(0, firstSpace),
    args: trimmed.substring(firstSpace + 1).trim().split(' ').filter(Boolean)
  };
}
