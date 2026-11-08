import * as assert from 'assert';
import { diagnoseError } from '../src/util/diagnosis';

describe('Error Diagnostics (§5 Table Mapping)', () => {
  it('should diagnose 502 box unreachable errors', () => {
    const diag = diagnoseError('502 box unreachable from proxy');
    assert.strictEqual(diag.summary.includes('502'), true);
    assert.strictEqual(diag.checklist.some((item) => item.includes('0.0.0.0')), true);
  });

  it('should diagnose 403 forbidden / login errors', () => {
    const diag = diagnoseError('HTTP 403 Forbidden - access token missing');
    assert.strictEqual(diag.summary.includes('403'), true);
    assert.strictEqual(diag.checklist.some((item) => item.includes('X-BoxLite-Access-Token')), true);
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
});
