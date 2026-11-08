import * as assert from 'assert';
import { parseExecutableCommand } from '../src/util/process';

describe('Executable Command Parsing', () => {
  it('should parse simple binary names without arguments', () => {
    const res = parseExecutableCommand('python3');
    assert.strictEqual(res.bin, 'python3');
    assert.deepStrictEqual(res.args, []);
  });

  it('should parse Windows py launcher with flags', () => {
    const res = parseExecutableCommand('py -3');
    assert.strictEqual(res.bin, 'py');
    assert.deepStrictEqual(res.args, ['-3']);

    const res2 = parseExecutableCommand('py -3.11');
    assert.strictEqual(res2.bin, 'py');
    assert.deepStrictEqual(res2.args, ['-3.11']);
  });

  it('should preserve quoted executable paths with spaces', () => {
    const res = parseExecutableCommand('"C:\\Program Files\\Python311\\python.exe"');
    assert.strictEqual(res.bin, 'C:\\Program Files\\Python311\\python.exe');
    assert.deepStrictEqual(res.args, []);
  });

  it('should handle commands with flags', () => {
    const res = parseExecutableCommand('python -u');
    assert.strictEqual(res.bin, 'python');
    assert.deepStrictEqual(res.args, ['-u']);
  });

  it('should handle empty input gracefully', () => {
    const res = parseExecutableCommand('   ');
    assert.strictEqual(res.bin, '');
    assert.deepStrictEqual(res.args, []);
  });
});
