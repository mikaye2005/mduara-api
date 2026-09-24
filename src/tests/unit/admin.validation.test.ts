import assert from 'node:assert/strict';
import test from 'node:test';
import {
  adminBroadcastSchema,
  adminMembershipSchema,
  adminRoleChangeSchema,
  adminSearchSchema,
  adminTicketCommentSchema,
} from '../../validation/admin.validation';

test('Super Admin operational inputs require explicit reasons and bounded search', () => {
  assert.equal(adminSearchSchema.parse({ q: 'Mumbi' }).limit, 10);
  assert.throws(() => adminSearchSchema.parse({ q: 'x' }));
  assert.throws(() => adminRoleChangeSchema.parse({ role: 'chairperson', reason: 'no' }));

  const membership = adminMembershipSchema.parse({
    userId: '2c25f520-7a6a-4b71-b11d-78c3d697e7ac',
    reason: 'Approved platform-assisted onboarding',
  });
  assert.equal(membership.role, 'member');
  assert.equal(membership.membershipStatus, 'pending');
});

test('platform broadcasts enforce audience scope and safe defaults', () => {
  const broadcast = adminBroadcastSchema.parse({
    audience: 'all_active_users',
    title: 'Scheduled maintenance',
    body: 'M-Duara will be unavailable briefly tonight.',
    reason: 'Notify users before planned maintenance',
  });
  assert.deepEqual(broadcast.channels, ['in_app']);
  assert.throws(() => adminBroadcastSchema.parse({
    audience: 'chama',
    title: 'Notice',
    body: 'A scoped operational notice.',
    reason: 'Requested by platform operations',
  }));
});

test('ticket notes are internal unless explicitly made visible', () => {
  assert.deepEqual(adminTicketCommentSchema.parse({ body: 'Provider evidence verified.' }), {
    body: 'Provider evidence verified.',
    internal: true,
  });
});
