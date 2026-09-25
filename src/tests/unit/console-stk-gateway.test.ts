import assert from 'node:assert/strict';
import test from 'node:test';
import { ConsoleStkGateway } from '../../services/payment.service';

test('console STK gateway returns a provider-shaped successful callback', async () => {
  const result = await new ConsoleStkGateway().initiate({
    amount: 3000n,
    phoneNumber: '+254790857257',
    accountReference: 'MDUTEST',
    description: 'Development test',
  });

  assert.match(result.merchantRequestId, /^dev-merchant-/);
  assert.match(result.checkoutRequestId, /^dev-checkout-/);
  assert.equal(result.requestPayload.simulated, true);
  assert.equal(result.simulatedCallback?.Body?.stkCallback?.ResultCode, 0);
  assert.equal(
    result.simulatedCallback?.Body?.stkCallback?.CallbackMetadata?.Item?.find(
      (item) => item.Name === 'Amount',
    )?.Value,
    '3000',
  );
});
