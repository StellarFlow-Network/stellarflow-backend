import assert from 'node:assert/strict';
import { validatePrice } from '../src/services/marketRate/validation';

function run() {
  assert.equal(validatePrice(1), 1);
  assert.equal(validatePrice(12.34), 12.34);

  for (const value of [undefined, null, NaN, Infinity, -1, 0, '12']) {
    assert.throws(() => validatePrice(value), /Price must be a positive number/);
  }
}

run();
