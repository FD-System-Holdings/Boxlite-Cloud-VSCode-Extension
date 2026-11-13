import * as assert from 'assert';
import { diagnoseError } from '../src/util/diagnosis';

describe('Error Diagnostics (§5 Table Mapping)', () => {
  it('should diagnose 502 box unreachable errors', () => {
    const diag = diagnoseError('502 box unreachable from proxy');
    assert.strictEqual(diag.summary.includes('502'), true);
    assert.strictEqual(diag.checklist.some((item) => item.includes('0.0.0.0')), true);
  });

  it('should diagnose 401 unauthorized / invalid credentials errors', () => {
    const diag = diagnoseError('HTTP 401: Invalid credentials');
    assert.strictEqual(diag.summary.includes('401'), true);
    assert.strictEqual(diag.checklist.some((item) => item.includes('BOXLITE_API_KEY')), true);
  });

  it('should diagnose 403 forbidden / login errors', () => {
    const diag = diagnoseError('BoxLite Cloud API Error (403): Forbidden resource');
    assert.strictEqual(diag.summary.includes('403'), true);
    assert.strictEqual(diag.checklist.some((item) => item.includes('agent.md §5')), true);
    assert.strictEqual(diag.checklist.some((item) => item.includes('shared-volume support')), true);
  });

  it('should diagnose 409 conflict errors', () => {
    const diag = diagnoseError('409 Conflict: box name already exists');
    assert.strictEqual(diag.summary.includes('409'), true);
  });

  it('should diagnose NetworkError', () => {
    const diag = diagnoseError('Connection failed', 'NetworkError');
    assert.strictEqual(diag.summary.includes('Network Error'), true);
    assert.strictEqual(diag.checklist.some((item) => item.includes('BOXLITE_REST_URL')), true);
  });

  it('should diagnose 400 bad request / schema validation errors', () => {
    const diag = diagnoseError('BoxLite Cloud API error (400): property auto_remove should not exist');
    assert.strictEqual(diag.summary.includes('400'), true);
    assert.strictEqual(diag.checklist.some((item) => item.includes('auto_remove')), true);
  });

  it('should diagnose proxy TLS CA certificate verification failures', () => {
    const diag = diagnoseError('SSL: CERTIFICATE_VERIFY_FAILED against ca-certificates.crt');
    assert.strictEqual(diag.summary.includes('TLS Certificate Verification Failed'), true);
    assert.strictEqual(
      diag.checklist.some((item) => item.includes('/etc/ssl/certs/ca-certificates.crt')),
      true
    );
  });

  it('should diagnose missing headers mapping on Secret', () => {
    const diag = diagnoseError('Secret headers mapping is missing');
    assert.strictEqual(diag.summary.includes('Missing Required Headers Mapping'), true);
    assert.strictEqual(
      diag.checklist.some((item) => item.includes('<BOXLITE_SECRET:name>')),
      true
    );
  });

  it('should diagnose outbound secret proxy injection failures', () => {
    const diag = diagnoseError('Outbound BOXLITE_SECRET injection failed for target hostname');
    assert.strictEqual(diag.summary.includes('Secret Proxy Injection Diagnosis'), true);
    assert.strictEqual(
      diag.checklist.some((item) => item.includes('Secret.hosts')),
      true
    );
  });
});
