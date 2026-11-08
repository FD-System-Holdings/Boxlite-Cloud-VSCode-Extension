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
