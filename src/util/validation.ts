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
