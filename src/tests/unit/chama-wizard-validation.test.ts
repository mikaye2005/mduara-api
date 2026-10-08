import assert from 'node:assert/strict';
import test from 'node:test';
import { createChamaWizardSchema } from '../../validation/chama.validation';

const rule = 'A complete rule containing enough detail for all Chama members.';

test('Start Chama wizard payload matches the backend compatibility contract', () => {
  const parsed = createChamaWizardSchema.parse({
    autoCloseRecruitment: true,
    constitution: {
      version: 1,
      sections: {
        commitmentAndDefault: rule,
        contributionRules: rule,
        dissolution: rule,
        exitAndWithdrawal: rule,
        memberConductAndDisputes: rule,
        payoutRules: rule,
        purposeAndGoal: rule,
        votingAndDecisions: rule,
      },
    },
    contributionAmount: 5000,
    contributionFrequency: 'monthly',
    contributionStartDate: '2026-10-01',
    creationSource: 'self_service',
    durationMonths: 12,
    goalCode: 'emergency_fund',
    joiningWindowStartsAt: '2026-10-05',
    joiningWindowEndsAt: '2026-10-31',
    name: 'Imara Growth Circle',
    purpose: 'Build a shared emergency fund.',
    recruitmentMode: 'application',
    setupPaymentMode: 'deferred',
    targetAmount: 500000,
    targetMembers: 20,
    type: 'goal_based',
  });

  assert.equal(parsed.name, 'Imara Growth Circle');
  assert.equal(parsed.constitution.sections.votingAndDecisions, rule);
  assert.equal(parsed.joiningWindowStartsAt, '2026-10-05');
});

test('Start Chama wizard rejects an inverted joining window', () => {
  const result = createChamaWizardSchema.safeParse({
    autoCloseRecruitment: true,
    constitution: { version: 1, sections: Object.fromEntries([
      'commitmentAndDefault', 'contributionRules', 'dissolution', 'exitAndWithdrawal',
      'memberConductAndDisputes', 'payoutRules', 'purposeAndGoal', 'votingAndDecisions',
    ].map((key) => [key, rule])) },
    contributionAmount: 5000,
    contributionFrequency: 'monthly',
    contributionStartDate: '2026-10-01',
    creationSource: 'self_service',
    durationMonths: 18,
    goalCode: 'emergency_fund',
    joiningWindowStartsAt: '2026-12-31',
    joiningWindowEndsAt: '2026-10-05',
    name: 'Imara Growth Circle',
    purpose: 'Build a shared emergency fund.',
    recruitmentMode: 'application',
    setupPaymentMode: 'mpesa',
    targetAmount: 500000,
    targetMembers: 40,
    type: 'goal_based',
  });

  assert.equal(result.success, false);
  if (!result.success) {
    assert.deepEqual(result.error.issues[0]?.path, ['joiningWindowEndsAt']);
  }
});

test('goal-based wizard creation requires a configured goal', () => {
  const result = createChamaWizardSchema.safeParse({
    autoCloseRecruitment: true,
    constitution: { version: 1, sections: Object.fromEntries([
      'commitmentAndDefault', 'contributionRules', 'dissolution', 'exitAndWithdrawal',
      'memberConductAndDisputes', 'payoutRules', 'purposeAndGoal', 'votingAndDecisions',
    ].map((key) => [key, rule])) },
    contributionAmount: 5000,
    contributionFrequency: 'monthly',
    contributionStartDate: '2026-10-01',
    creationSource: 'self_service',
    durationMonths: 12,
    joiningWindowEndsAt: '2026-10-31',
    name: 'Imara Growth Circle',
    purpose: 'Build a shared emergency fund.',
    recruitmentMode: 'application',
    setupPaymentMode: 'deferred',
    targetAmount: 500000,
    targetMembers: 20,
    type: 'goal_based',
  });
  assert.equal(result.success, false);
});

test('Start Chama wizard accepts a complete custom contribution interval', () => {
  const result = createChamaWizardSchema.safeParse({
    autoCloseRecruitment: true,
    constitution: { version: 1, sections: Object.fromEntries([
      'commitmentAndDefault', 'contributionRules', 'dissolution', 'exitAndWithdrawal',
      'memberConductAndDisputes', 'payoutRules', 'purposeAndGoal', 'votingAndDecisions',
    ].map((key) => [key, rule])) },
    contributionAmount: 1000,
    contributionFrequency: 'custom',
    contributionInterval: 10,
    contributionIntervalUnit: 'day',
    contributionStartDate: '2026-10-10',
    creationSource: 'self_service',
    durationMonths: 12,
    goalCode: 'emergency_fund',
    joiningWindowStartsAt: '2026-10-05',
    joiningWindowEndsAt: '2026-10-31',
    name: 'Custom Circle',
    purpose: 'Build a shared emergency fund.',
    recruitmentMode: 'application',
    setupPaymentMode: 'mpesa',
    targetAmount: 12000,
    targetMembers: 12,
    type: 'goal_based',
  });

  assert.equal(result.success, true);
  if (result.success) assert.equal(result.data.contributionIntervalUnit, 'day');
});
