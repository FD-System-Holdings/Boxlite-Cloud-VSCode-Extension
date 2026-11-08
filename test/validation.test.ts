import * as assert from 'assert';
import { validateAllowlistRule, validateNetworkPolicy } from '../src/util/validation';

describe('Network Allowlist and Policy Validation', () => {
  it('should accept valid exact hostnames', () => {
    assert.strictEqual(validateAllowlistRule('api.example.com').valid, true);
    assert.strictEqual(validateAllowlistRule('boxlite.ai').valid, true);
  });

  it('should accept valid wildcard hostnames', () => {
    assert.strictEqual(validateAllowlistRule('*.example.com').valid, true);
    assert.strictEqual(validateAllowlistRule('*.boxlite.ai').valid, true);
  });

  it('should accept valid IPv4 and IPv4 CIDR', () => {
    assert.strictEqual(validateAllowlistRule('192.168.1.1').valid, true);
    assert.strictEqual(validateAllowlistRule('10.0.0.0/8').valid, true);
    assert.strictEqual(validateAllowlistRule('172.16.0.0/16').valid, true);
  });

  it('should reject URLs', () => {
    const res = validateAllowlistRule('https://api.example.com');
    assert.strictEqual(res.valid, false);
    assert.match(res.error || '', /URLs are not permitted/);
  });

  it('should reject host:port specifications', () => {
    const res = validateAllowlistRule('api.example.com:8080');
    assert.strictEqual(res.valid, false);
    assert.match(res.error || '', /Port specifications are not permitted/);
  });

  it('should reject empty rules', () => {
    const res = validateAllowlistRule('   ');
    assert.strictEqual(res.valid, false);
  });

  it('should invalidate outbound policy if mode is disabled but allowlist is not empty', () => {
    const res = validateNetworkPolicy('enabled', 'disabled', ['api.example.com']);
    assert.strictEqual(res.valid, false);
    assert.strictEqual(res.errors.length > 0, true);
  });

  it('should warn when outbound allowlist is empty (unrestricted)', () => {
    const res = validateNetworkPolicy('enabled', 'enabled', []);
    assert.strictEqual(res.valid, true);
    assert.strictEqual(res.warnings.some((w) => w.includes('unrestricted')), true);
  });
});
