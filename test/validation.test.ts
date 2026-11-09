import * as assert from 'assert';
import {
  validateAllowlistRule,
  validateNetworkPolicy,
  validateVolumeName,
  validateGuestPath
} from '../src/util/validation';

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

describe('Volume Name and Mount Path Validation (§4)', () => {
  it('should accept valid volume names', () => {
    assert.strictEqual(validateVolumeName('my-volume').valid, true);
    assert.strictEqual(validateVolumeName('data_01').valid, true);
    assert.strictEqual(validateVolumeName('vol.backup-2026').valid, true);
    assert.strictEqual(validateVolumeName('sqliteData').valid, true);
  });

  it('should reject invalid volume names', () => {
    assert.strictEqual(validateVolumeName('').valid, false);
    assert.strictEqual(validateVolumeName('   ').valid, false);
    assert.strictEqual(validateVolumeName('-invalid-start').valid, false);
    assert.strictEqual(validateVolumeName('invalid/slash').valid, false);
    assert.strictEqual(validateVolumeName('invalid:colon').valid, false);
    assert.strictEqual(validateVolumeName('a'.repeat(64)).valid, false);
  });

  it('should accept valid guest mount paths', () => {
    assert.strictEqual(validateGuestPath('/data').valid, true);
    assert.strictEqual(validateGuestPath('/mnt/storage').valid, true);
    assert.strictEqual(validateGuestPath('/app/db').valid, true);
  });

  it('should reject relative or non-absolute guest mount paths', () => {
    const res = validateGuestPath('data');
    assert.strictEqual(res.valid, false);
    assert.match(res.error || '', /absolute path/);
  });

  it('should reject root directory "/" as guest mount path', () => {
    const res = validateGuestPath('/');
    assert.strictEqual(res.valid, false);
    assert.match(res.error || '', /root directory/);
  });

  it('should reject system directories (/proc, /sys, /dev)', () => {
    assert.strictEqual(validateGuestPath('/proc').valid, false);
    assert.strictEqual(validateGuestPath('/sys').valid, false);
    assert.strictEqual(validateGuestPath('/dev').valid, false);
    assert.strictEqual(validateGuestPath('/proc/cpuinfo').valid, false);
  });

  it('should warn on /tmp or /dev/shm mount paths per agent.md §4', () => {
    const tmpRes = validateGuestPath('/tmp');
    assert.strictEqual(tmpRes.valid, true);
    assert.ok(tmpRes.warning?.includes('§4'));
    assert.ok(tmpRes.warning?.includes('hides rootfs content'));

    const shmRes = validateGuestPath('/dev/shm');
    assert.strictEqual(shmRes.valid, true);
    assert.ok(shmRes.warning?.includes('§4'));
  });
});
