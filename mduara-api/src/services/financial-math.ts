/** Money is whole KES, matching the existing schema. Never convert money to Number. */
export function percentageFee(amount: bigint, percentage: string): bigint {
  if (amount < 0n || !/^\d+(?:\.\d{1,2})?$/.test(percentage)) throw new Error('Invalid fee calculation');
  const [whole, fraction = ''] = percentage.split('.');
  const basisPoints = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  // Round positive fractional KES upward, consistent with existing loan pricing.
  return (amount * basisPoints + 9_999n) / 10_000n;
}

export function contributionPenalty(unpaid: bigint, type: 'flat' | 'percentage', flatFee: string, rate: string): bigint {
  if (unpaid <= 0n) return 0n;
  if (type === 'percentage') return percentageFee(unpaid, rate);
  const fee = BigInt(flatFee);
  if (fee < 0n) throw new Error('Invalid flat fee');
  return fee;
}
