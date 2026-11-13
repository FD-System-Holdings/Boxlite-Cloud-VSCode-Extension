import * as assert from 'assert';
import {
  validateAllowlistRule,
  validateNetworkPolicy,
  validateVolumeName,
  validateGuestPath,
  validateImageReference,
  validateAliasName,
  validateDigest,
  validateRegistryHost,
  validateRepositoryPrefix,
  validateCheckpointName,
  validateCheckpointBoxOptions
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

describe('Image Reference, Alias and Registry Validation', () => {
  it('should accept valid container image references', () => {
    assert.strictEqual(validateImageReference('docker.io/library/alpine:3.20').valid, true);
    assert.strictEqual(validateImageReference('ghcr.io/acme/api:1.4.0').valid, true);
    assert.strictEqual(validateImageReference('quay.io/coreos/etcd:v3.5.0').valid, true);
    assert.strictEqual(validateImageReference('alpine').valid, true);
    assert.strictEqual(validateImageReference('alpine:latest').valid, true);
    assert.strictEqual(
      validateImageReference(
        'docker.io/library/ubuntu@sha256:716075908b8b0e890c2a51a89c9918fb52d7b8ca252e04313f84f0de5cfae60e'
      ).valid,
      true
    );
  });

  it('should warn when bare built-in images are specified (agent.md & docs.boxlite.ai/cloud/images)', () => {
    for (const name of ['base', 'python', 'node', 'sandbaseai-hermes']) {
      const res = validateImageReference(name);
      assert.strictEqual(res.valid, true);
      assert.ok(res.warning?.includes('BoxLite\'s built-in image'));
      assert.ok(res.warning?.includes('Docker Hub'));
    }
  });

  it('should reject invalid image references', () => {
    assert.strictEqual(validateImageReference('').valid, false);
    assert.strictEqual(validateImageReference('   ').valid, false);
    assert.strictEqual(validateImageReference('alpine with spaces').valid, false);
    assert.strictEqual(validateImageReference('https://docker.io/alpine').valid, false);
  });

  it('should validate alias names following tag syntax', () => {
    assert.strictEqual(validateAliasName('stable').valid, true);
    assert.strictEqual(validateAliasName('v1.0.0').valid, true);
    assert.strictEqual(validateAliasName('prod_build-2026').valid, true);

    assert.strictEqual(validateAliasName('').valid, false);
    assert.strictEqual(validateAliasName('tag with spaces').valid, false);
    assert.strictEqual(validateAliasName('tag:withcolon').valid, false);
    assert.strictEqual(validateAliasName('tag@withat').valid, false);
    assert.strictEqual(validateAliasName('a'.repeat(129)).valid, false);
  });

  it('should validate exact sha256 digests', () => {
    const validDigest = 'sha256:c64c687cbea90123456789abcdef0123456789abcdef0123456789abcdef0123';
    assert.strictEqual(validateDigest(validDigest).valid, true);

    assert.strictEqual(validateDigest('').valid, false);
    assert.strictEqual(validateDigest('c64c687cbea9...').valid, false); // missing sha256: prefix
    assert.strictEqual(validateDigest('sha256:tooshort').valid, false);
    assert.strictEqual(validateDigest('sha256:' + 'g'.repeat(64)).valid, false); // non-hex
  });

  it('should validate supported registry hosts', () => {
    assert.strictEqual(validateRegistryHost('ghcr.io').valid, true);
    assert.strictEqual(validateRegistryHost('docker.io').valid, true);
    assert.strictEqual(validateRegistryHost('quay.io').valid, true);
    assert.strictEqual(validateRegistryHost('gcr.io').valid, true);
    assert.strictEqual(validateRegistryHost('us.gcr.io').valid, true);
    assert.strictEqual(validateRegistryHost('eu.gcr.io').valid, true);
    assert.strictEqual(validateRegistryHost('asia.gcr.io').valid, true);

    assert.strictEqual(validateRegistryHost('').valid, false);
    assert.strictEqual(validateRegistryHost('unsupported-registry.com').valid, false);
  });

  it('should validate repository prefixes (trailing slash required)', () => {
    assert.strictEqual(validateRepositoryPrefix('').valid, true); // optional
    assert.strictEqual(validateRepositoryPrefix('   ').valid, true);
    assert.strictEqual(validateRepositoryPrefix('acme/').valid, true);
    assert.strictEqual(validateRepositoryPrefix('org/team/').valid, true);

    const noSlash = validateRepositoryPrefix('acme');
    assert.strictEqual(noSlash.valid, false);
    assert.ok(noSlash.error?.includes('trailing "/"'));

    const leadingSlash = validateRepositoryPrefix('/acme/');
    assert.strictEqual(leadingSlash.valid, false);
    assert.ok(leadingSlash.error?.includes('leading "/"'));

    assert.strictEqual(validateRepositoryPrefix('acme /').valid, false);
  });

  it('validates checkpoint names properly', () => {
    assert.strictEqual(validateCheckpointName('warm-env-v1').valid, true);
    assert.strictEqual(validateCheckpointName('chk_snapshot.01').valid, true);

    assert.strictEqual(validateCheckpointName('').valid, false);
    assert.strictEqual(validateCheckpointName('-bad').valid, false);
    assert.strictEqual(validateCheckpointName('bad space').valid, false);
    assert.strictEqual(validateCheckpointName('a'.repeat(129)).valid, false);
  });

  it('validates checkpoint box creation options against forbidden overrides', () => {
    assert.strictEqual(validateCheckpointBoxOptions('', false).valid, false);
    assert.strictEqual(validateCheckpointBoxOptions(undefined, false).valid, false);
    assert.strictEqual(validateCheckpointBoxOptions('chk_123', false).valid, true);

    const invalid = validateCheckpointBoxOptions('chk_123', true);
    assert.strictEqual(invalid.valid, false);
    assert.ok(invalid.error && invalid.error.length > 0);
  });
});
