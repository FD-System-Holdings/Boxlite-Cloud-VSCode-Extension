import * as assert from 'assert';
import { computeLogDelta } from '../src/logs/logStream';

describe('Log Streaming Delta Algorithm', () => {
  it('should return empty string when current content is identical to previous', () => {
    const log = 'line 1\nline 2\nline 3';
    assert.strictEqual(computeLogDelta(log, log), '');
  });

  it('should return all content when previous content is empty', () => {
    const log = 'line 1\nline 2';
    assert.strictEqual(computeLogDelta('', log), log);
  });

  it('should handle direct extension without overlap', () => {
    const prev = 'line 1\nline 2\n';
    const curr = 'line 1\nline 2\nline 3\n';
    assert.strictEqual(computeLogDelta(prev, curr), 'line 3\n');
  });

  it('should correctly extract delta when sliding window advances', () => {
    // Simulate a 5-line tail window sliding forward by 2 lines
    const prev = 'line 1\nline 2\nline 3\nline 4\nline 5';
    const curr = 'line 3\nline 4\nline 5\nline 6\nline 7';

    const delta = computeLogDelta(prev, curr);
    assert.strictEqual(delta.includes('line 1'), false);
    assert.strictEqual(delta.includes('line 2'), false);
    assert.strictEqual(delta.includes('line 6'), true);
    assert.strictEqual(delta.includes('line 7'), true);
  });

  it('should handle log rotation or total content replacement', () => {
    const prev = 'old log content a\nold log content b';
    const curr = 'new log content x\nnew log content y';

    const delta = computeLogDelta(prev, curr);
    assert.strictEqual(delta.includes('new log content x'), true);
    assert.strictEqual(delta.includes('old log content'), false);
  });
});
