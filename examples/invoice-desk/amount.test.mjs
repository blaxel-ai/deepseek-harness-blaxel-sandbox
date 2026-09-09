import test from 'node:test';
import assert from 'node:assert/strict';

import {formatAmount} from './invoices.mjs';

test('formats zero with two decimal places', () => {
  assert.equal(formatAmount(0), '$0.00');
});

test('formats cents with two decimal places', () => {
  assert.equal(formatAmount(5), '$0.05');
});

test('formats thousands with comma separators', () => {
  assert.equal(formatAmount(123456789), '$1,234,567.89');
});

test('formats refunds as negative USD amounts', () => {
  assert.equal(formatAmount(-129950), '-$1,299.50');
});
