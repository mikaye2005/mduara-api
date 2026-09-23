import assert from 'node:assert/strict';
import test from 'node:test';
import { contributionPenalty, percentageFee } from '../../services/financial-math';

test('flat penalties apply once to a positive unpaid balance', () => {
  assert.equal(contributionPenalty(600n, 'flat', '100', '0'), 100n);
  assert.equal(contributionPenalty(0n, 'flat', '100', '0'), 0n);
  assert.equal(contributionPenalty(-100n, 'flat', '100', '0'), 0n);
});
test('percentage fees use the unpaid balance and round fractional KES up', () => {
  assert.equal(contributionPenalty(600n, 'percentage', '999', '2.50'), 15n);
  assert.equal(percentageFee(101n, '2.50'), 3n);
  assert.equal(percentageFee(101n, '0.00'), 0n);
});
test('fee arithmetic retains precision beyond Number.MAX_SAFE_INTEGER', () => {
  assert.equal(percentageFee(9007199254740993n, '10.00'), 900719925474100n);
});
test('invalid financial values are rejected', () => {
  for (const rate of ['-1', 'NaN', '1e2', '1.001']) assert.throws(() => percentageFee(100n, rate));
  assert.throws(() => contributionPenalty(100n, 'flat', '-1', '0'));
});
