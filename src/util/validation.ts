export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export function validateAllowlistRule(rule: string): { valid: boolean; error?: string } {
  const trimmed = rule.trim();
  if (!trimmed) {
    return { valid: false, error: 'Empty rule is not allowed' };
  }

  // Reject URLs
  if (trimmed.includes('://')) {
    return { valid: false, error: `Invalid rule "${trimmed}": URLs are not permitted. Use hostname or IP only.` };
  }

  // Reject host:port
  if (trimmed.includes(':') && !trimmed.includes('/')) {
    // Might be IPv6 or host:port
    const parts = trimmed.split(':');
    if (parts.length === 2 && !isNaN(Number(parts[1]))) {
      return { valid: false, error: `Invalid rule "${trimmed}": Port specifications are not permitted. Use hostname or IP only.` };
    }
  }

  // Reject comma-separated values in single rule
  if (trimmed.includes(',')) {
    return { valid: false, error: `Invalid rule "${trimmed}": Comma-separated values are not allowed in a single rule.` };
  }

  // IPv4 check: e.g. 192.168.1.1
  const ipv4Regex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
  if (ipv4Regex.test(trimmed)) {
    return { valid: true };
  }

  // IPv4 CIDR check: e.g. 192.168.1.0/24
  const ipv4CidrRegex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\/(?:[0-9]|[1-2][0-9]|3[0-2])$/;
  if (ipv4CidrRegex.test(trimmed)) {
    return { valid: true };
  }

  // Wildcard hostname: e.g. *.example.com
  const wildcardHostnameRegex = /^\*\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;
  if (wildcardHostnameRegex.test(trimmed)) {
    return { valid: true };
  }

  // Exact hostname: e.g. api.example.com
  const hostnameRegex = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;
  if (hostnameRegex.test(trimmed)) {
    return { valid: true };
  }

  return {
    valid: false,
    error: `Invalid rule "${trimmed}": Must be exact hostname (api.example.com), wildcard (*.example.com), IPv4 (1.2.3.4), or IPv4 CIDR (1.2.3.0/24).`
  };
}

export function validateNetworkPolicy(
  _inboundMode: 'enabled' | 'disabled',
  outboundMode: 'enabled' | 'disabled',
  allowNet: string[] = []
): ValidationResult {
  const result: ValidationResult = { valid: true, errors: [], warnings: [] };

  if (outboundMode === 'disabled' && allowNet.length > 0) {
    result.valid = false;
    result.errors.push('Cannot specify an outbound allowlist when outbound mode is disabled.');
  }

  for (const rule of allowNet) {
    const check = validateAllowlistRule(rule);
    if (!check.valid && check.error) {
      result.valid = false;
      result.errors.push(check.error);
    }
  }

  if (outboundMode === 'enabled' && allowNet.length === 0) {
    result.warnings.push('Outbound allow_net is empty ([]), which grants unrestricted outbound access (not deny-all).');
  }

  if (outboundMode === 'disabled') {
    result.warnings.push('Disabling outbound suspends the guest NIC, which also disables inbound access and DNS.');
  }

  return result;
}

export function validateVolumeName(name: string): { valid: boolean; error?: string } {
  const trimmed = name.trim();
  if (!trimmed) {
    return { valid: false, error: 'Volume name cannot be empty.' };
  }
  if (trimmed.length > 63) {
    return { valid: false, error: 'Volume name cannot exceed 63 characters.' };
  }
  const nameRegex = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
  if (!nameRegex.test(trimmed)) {
    return {
      valid: false,
      error: 'Volume name must start with an alphanumeric character and contain only letters, numbers, hyphens, dots, or underscores.'
    };
  }
  return { valid: true };
}

export function validateGuestPath(guestPath: string): { valid: boolean; error?: string; warning?: string } {
  const trimmed = guestPath.trim();
  if (!trimmed) {
    return { valid: false, error: 'Guest mount path cannot be empty.' };
  }
  if (!trimmed.startsWith('/')) {
    return { valid: false, error: 'Guest mount path must be an absolute path starting with "/".' };
  }
  if (trimmed.includes('..')) {
    return { valid: false, error: 'Guest mount path must not contain relative ".." segments.' };
  }
  if (trimmed === '/') {
    return { valid: false, error: 'Cannot mount volume onto root directory "/".' };
  }

  if (trimmed === '/tmp' || trimmed === '/dev/shm') {
    return {
      valid: true,
      warning: `Mounting on "${trimmed}" hides rootfs content (§4). File copy operations under mounted volumes require an exec-based archive workflow.`
    };
  }

  const systemPaths = ['/proc', '/sys', '/dev'];
  for (const sys of systemPaths) {
    if (trimmed === sys || trimmed.startsWith(sys + '/')) {
      return { valid: false, error: `Cannot mount volume onto system path "${trimmed}".` };
    }
  }

  return { valid: true };
}

export function validateImageReference(imageRef: string): { valid: boolean; error?: string; warning?: string } {
  const trimmed = imageRef.trim();
  if (!trimmed) {
    return { valid: false, error: 'Image reference cannot be empty.' };
  }

  if (/\s/.test(trimmed)) {
    return { valid: false, error: 'Image reference must not contain whitespace.' };
  }

  if (trimmed.includes('://')) {
    return { valid: false, error: 'Image reference must not include URL scheme (http:// or https://).' };
  }

  const bareBuiltins = ['base', 'python', 'node', 'sandbaseai-hermes'];
  if (bareBuiltins.includes(trimmed.toLowerCase())) {
    return {
      valid: true,
      warning: `Notice: '${trimmed}' refers to BoxLite's built-in image, not Docker Hub's. To use an image from Docker Hub, specify the full reference (e.g. 'docker.io/library/${trimmed}:latest') (agent.md & docs.boxlite.ai/cloud/images).`
    };
  }

  // General image reference pattern: [registry[:port]/][namespace/]repository[:tag][@sha256:digest]
  const refRegex = /^[a-zA-Z0-9_.-]+(?::[0-9]+)?(?:\/[a-zA-Z0-9_.-]+)*(?::[a-zA-Z0-9_.-]+)?(?:@sha256:[a-fA-F0-9]{64})?$/;
  if (!refRegex.test(trimmed)) {
    return {
      valid: false,
      error: `Invalid image reference "${trimmed}". Expected format: [host/][namespace/]name[:tag][@sha256:digest] (e.g. 'docker.io/library/alpine:3.20' or 'ghcr.io/acme/api:1.4.0').`
    };
  }

  return { valid: true };
}

export function validateAliasName(alias: string): { valid: boolean; error?: string } {
  const trimmed = alias.trim();
  if (!trimmed) {
    return { valid: false, error: 'Alias name cannot be empty.' };
  }
  if (trimmed.length > 128) {
    return { valid: false, error: 'Alias name cannot exceed 128 characters.' };
  }
  const tagRegex = /^[a-zA-Z0-9_.-]+$/;
  if (!tagRegex.test(trimmed)) {
    return {
      valid: false,
      error: 'Alias name must follow valid tag syntax (alphanumeric characters, underscores, periods, and hyphens).'
    };
  }
  return { valid: true };
}

export function validateDigest(digest: string): { valid: boolean; error?: string } {
  const trimmed = digest.trim();
  if (!trimmed) {
    return { valid: false, error: 'Digest cannot be empty.' };
  }
  const digestRegex = /^sha256:[a-fA-F0-9]{64}$/;
  if (!digestRegex.test(trimmed)) {
    return {
      valid: false,
      error: 'Digest must start with "sha256:" followed by 64 hexadecimal characters.'
    };
  }
  return { valid: true };
}

export const ALLOWED_REGISTRY_HOSTS = [
  'ghcr.io',
  'docker.io',
  'quay.io',
  'gcr.io',
  'us.gcr.io',
  'eu.gcr.io',
  'asia.gcr.io'
];

export function validateRegistryHost(host: string): { valid: boolean; error?: string } {
  const trimmed = host.trim().toLowerCase();
  if (!trimmed) {
    return { valid: false, error: 'Registry host cannot be empty.' };
  }
  if (!ALLOWED_REGISTRY_HOSTS.includes(trimmed)) {
    return {
      valid: false,
      error: `Registry host "${trimmed}" is not supported. Supported hosts: ${ALLOWED_REGISTRY_HOSTS.join(', ')} (docs.boxlite.ai/cloud/private-images).`
    };
  }
  return { valid: true };
}

export function validateRepositoryPrefix(prefix: string): { valid: boolean; error?: string } {
  const trimmed = prefix.trim();
  if (!trimmed) {
    return { valid: true }; // Optional
  }
  if (!trimmed.endsWith('/')) {
    return {
      valid: false,
      error: 'Repository prefix must end with a trailing "/" (e.g. "acme/" or "org/team/"). A prefix without a trailing "/" is refused.'
    };
  }
  if (trimmed.startsWith('/')) {
    return {
      valid: false,
      error: 'Repository prefix must not start with a leading "/".'
    };
  }
  if (/\s/.test(trimmed)) {
    return {
      valid: false,
      error: 'Repository prefix must not contain whitespace.'
    };
  }
  return { valid: true };
}

export function validateCheckpointName(name: string): { valid: boolean; error?: string } {
  const trimmed = name.trim();
  if (!trimmed) {
    return { valid: false, error: 'Checkpoint name cannot be empty.' };
  }
  if (trimmed.length > 128) {
    return { valid: false, error: 'Checkpoint name cannot exceed 128 characters.' };
  }
  const nameRegex = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
  if (!nameRegex.test(trimmed)) {
    return {
      valid: false,
      error:
        'Checkpoint name must start with a letter or digit and contain only letters, digits, dots (.), underscores (_), or hyphens (-).'
    };
  }
  return { valid: true };
}

export function validateCheckpointBoxOptions(
  checkpoint?: string,
  hasOverrides?: boolean
): { valid: boolean; error?: string } {
  const trimmed = checkpoint?.trim();
  if (!trimmed) {
    return { valid: false, error: 'Checkpoint ID or name cannot be empty.' };
  }
  if (hasOverrides) {
    return {
      valid: false,
      error:
        'Restored boxes inherit saved settings from the checkpoint; do not pass image, resource, network, volume, or lifecycle overrides.'
    };
  }
  return { valid: true };
}

export function formatSecretPlaceholder(name: string): string {
  return `<BOXLITE_SECRET:${name.trim()}>`;
}

export function validateSecretName(name: string): { valid: boolean; error?: string } {
  const trimmed = name.trim();
  if (!trimmed) {
    return { valid: false, error: 'Secret name cannot be empty.' };
  }
  if (trimmed.length > 64) {
    return { valid: false, error: 'Secret name cannot exceed 64 characters.' };
  }
  if (/[<>:\s]/.test(trimmed)) {
    return {
      valid: false,
      error: 'Secret name must not contain whitespace, "<", ">", or ":" characters.'
    };
  }
  const nameRegex = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
  if (!nameRegex.test(trimmed)) {
    return {
      valid: false,
      error:
        'Secret name must start with a letter or digit and contain only letters, digits, underscores (_), dots (.), or hyphens (-).'
    };
  }
  return { valid: true };
}

export function validateSecretHost(host: string): { valid: boolean; error?: string } {
  const trimmed = host.trim();
  if (!trimmed) {
    return { valid: false, error: 'Destination host cannot be empty.' };
  }
  if (/\s/.test(trimmed)) {
    return { valid: false, error: `Invalid secret host "${trimmed}": Whitespace is not allowed.` };
  }
  if (trimmed.includes('://')) {
    return {
      valid: false,
      error: `Invalid secret host "${trimmed}": Specify only the hostname without "https://" or a URL scheme (docs.boxlite.ai/cloud/secrets).`
    };
  }
  if (trimmed.includes('/')) {
    return {
      valid: false,
      error: `Invalid secret host "${trimmed}": Specify only the hostname without a path or CIDR suffix.`
    };
  }
  if (trimmed.includes(':')) {
    return {
      valid: false,
      error: `Invalid secret host "${trimmed}": Specify only the hostname without a port.`
    };
  }
  const ipv4Regex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
  if (ipv4Regex.test(trimmed)) {
    return {
      valid: false,
      error: `Invalid secret host "${trimmed}": Use a DNS hostname (e.g. api.openai.com), not an IPv4 address.`
    };
  }
  const wildcardHostnameRegex = /^\*\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;
  const hostnameRegex = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;
  if (wildcardHostnameRegex.test(trimmed) || hostnameRegex.test(trimmed)) {
    return { valid: true };
  }
  return {
    valid: false,
    error: `Invalid secret host "${trimmed}": Must be a valid hostname (e.g. api.openai.com or *.example.com).`
  };
}

export function validateSecretHosts(hosts: string[]): { valid: boolean; error?: string } {
  if (!Array.isArray(hosts) || hosts.length === 0) {
    return {
      valid: false,
      error: 'Specify at least one destination hostname (e.g. api.openai.com) for secret injection.'
    };
  }
  for (const h of hosts) {
    const check = validateSecretHost(h);
    if (!check.valid) {
      return check;
    }
  }
  return { valid: true };
}

export function validateSecretHeaders(headers: Record<string, string>): { valid: boolean; error?: string } {
  if (!headers || typeof headers !== 'object' || Object.keys(headers).length === 0) {
    return {
      valid: false,
      error: 'Secret requires an explicit headers mapping (e.g. {"Authorization": "Bearer {value}"}).'
    };
  }

  const headerNameRegex = /^[A-Za-z0-9-]+$/;
  for (const [headerName, template] of Object.entries(headers)) {
    if (!headerName.trim() || !headerNameRegex.test(headerName.trim())) {
      return {
        valid: false,
        error: `Invalid header name "${headerName}". Use standard HTTP header characters (letters, digits, hyphens).`
      };
    }
    if (typeof template !== 'string' || !template.trim()) {
      return {
        valid: false,
        error: `Header template for "${headerName}" cannot be empty.`
      };
    }
    if (template.includes('<BOXLITE_SECRET:')) {
      return {
        valid: false,
        error: `Header template for "${headerName}" must use "{value}" instead of "<BOXLITE_SECRET:...>". Guest requests send "<BOXLITE_SECRET:name>", while Secret.headers uses "{value}".`
      };
    }
    if (!template.includes('{value}')) {
      return {
        valid: false,
        error: `Header template for "${headerName}" must include the "{value}" template variable (e.g. "Bearer {value}" or "{value}").`
      };
    }
  }

  return { valid: true };
}

export function validateSecretSpec(
  spec: { name: string; value?: string; hosts: string[]; headers: Record<string, string> },
  requireValue = true
): { valid: boolean; error?: string; warning?: string } {
  const nameCheck = validateSecretName(spec.name || '');
  if (!nameCheck.valid) {
    return nameCheck;
  }

  const hostsCheck = validateSecretHosts(spec.hosts || []);
  if (!hostsCheck.valid) {
    return hostsCheck;
  }

  const headersCheck = validateSecretHeaders(spec.headers || {});
  if (!headersCheck.valid) {
    return headersCheck;
  }

  let warning: string | undefined;
  const val = spec.value ?? '';
  if (requireValue) {
    if (!val.trim()) {
      return { valid: false, error: 'Secret value cannot be empty.' };
    }
    if (val.includes('<BOXLITE_SECRET:')) {
      return {
        valid: false,
        error: 'Do not put a <BOXLITE_SECRET:...> placeholder in Secret.value; supply the real credential here and use the placeholder inside the box.'
      };
    }
  }

  if (val && (val.trim().startsWith('blk_live_') || val.trim().startsWith('bl_live_'))) {
    warning = 'Value looks like a BoxLite Cloud API key. Use your BoxLite Cloud API key for ApiKeyCredential and the upstream provider key for Secret.value (docs.boxlite.ai/cloud/secrets).';
  }

  return { valid: true, warning };
}

export function validateEnvAgainstSecrets(
  env: Record<string, string>,
  secrets: Array<{ name: string; value?: string }>
): { valid: boolean; error?: string } {
  if (!env || !secrets || secrets.length === 0) {
    return { valid: true };
  }

  for (const secret of secrets) {
    const rawVal = secret.value?.trim();
    if (!rawVal) {
      continue;
    }
    for (const [envKey, envVal] of Object.entries(env)) {
      if (typeof envVal === 'string' && envVal.length > 0 && (envVal === rawVal || envVal.includes(rawVal))) {
        return {
          valid: false,
          error: `Environment variable "${envKey}" contains the raw credential for secret "${secret.name}". Never put real keys in BoxOptions.env; use "${formatSecretPlaceholder(secret.name)}" instead.`
        };
      }
    }
  }

  return { valid: true };
}

export function validateCustomDomain(domain: string): {
  valid: boolean;
  normalized?: string;
  error?: string;
  warning?: string;
} {
  const trimmed = (domain || '').trim().replace(/\.+$/, '').toLowerCase();
  if (!trimmed) {
    return { valid: false, error: 'Domain name cannot be empty.' };
  }
  if (trimmed.includes('://')) {
    return { valid: false, error: 'Enter a domain hostname without a URL scheme (e.g. app.example.com).' };
  }
  if (trimmed.includes('/') || trimmed.includes('?') || trimmed.includes('#')) {
    return { valid: false, error: 'Domain name cannot contain paths, query strings, or fragments.' };
  }
  if (trimmed.includes(':')) {
    return { valid: false, error: 'Domain name cannot include a port specification.' };
  }
  if (/\s/.test(trimmed)) {
    return { valid: false, error: 'Domain name cannot contain whitespace.' };
  }
  if (trimmed.startsWith('*.')) {
    return { valid: false, error: 'Wildcard custom domains are not supported; enter an exact domain or subdomain.' };
  }
  if (trimmed.length > 253) {
    return { valid: false, error: 'Domain name cannot exceed 253 characters.' };
  }

  const ipv4Regex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
  if (ipv4Regex.test(trimmed)) {
    return { valid: false, error: 'IP addresses are not valid custom domains; enter a DNS hostname.' };
  }

  const fqdnRegex = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
  if (!fqdnRegex.test(trimmed)) {
    return {
      valid: false,
      error: 'Enter a valid fully-qualified domain name (e.g. app.example.com).'
    };
  }

  let warning: string | undefined;
  if (trimmed === 'boxlite.ai' || trimmed.endsWith('.boxlite.ai')) {
    warning = 'boxlite.ai subdomains are platform-managed by BoxLite Cloud.';
  }

  return { valid: true, normalized: trimmed, warning };
}
