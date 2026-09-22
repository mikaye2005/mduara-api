import assert from 'node:assert/strict';
import test from 'node:test';
import {
  chamaRoleMatchesAny,
  chamaRoleSatisfies,
  protectAdministrativeRoutes,
  requireChamaRoles,
  requireRoles,
} from '../../middlewares/authorization.middleware';
import type { ChamaMembershipRepository } from '../../middlewares/authorization.middleware';
import { identityRolesFromPlatformFlag } from '../../middlewares/auth.middleware';
import type { ActiveChamaMembership, ApiRequest, ApiResponse } from '../../types/auth';

test('BE-25 officials inherit Member capability without inheriting other offices', () => {
  assert.equal(chamaRoleSatisfies('SECRETARY', 'MEMBER'), true);
  assert.equal(chamaRoleSatisfies('TREASURER', 'MEMBER'), true);
  assert.equal(chamaRoleSatisfies('CHAIRPERSON', 'MEMBER'), true);
  assert.equal(chamaRoleSatisfies('SECRETARY', 'TREASURER'), false);
  assert.equal(chamaRoleSatisfies('TREASURER', 'SECRETARY'), false);
  assert.equal(chamaRoleMatchesAny('SECRETARY', ['MEMBER']), true);
});

test('BE-25 Chama role middleware resolves authorization against the requested Chama', async () => {
  const memberships = new Map<string, ActiveChamaMembership>([
    ['chama-a', {
      chamaId: 'chama-a',
      userId: 'user-1',
      role: 'SECRETARY',
      officialRole: 'SECRETARY',
    }],
    ['chama-b', {
      chamaId: 'chama-b',
      userId: 'user-1',
      role: 'TREASURER',
      officialRole: 'TREASURER',
    }],
  ]);

  const repository: ChamaMembershipRepository = {
    async findActiveMembership(userId, chamaId) {
      const membership = memberships.get(chamaId) ?? null;
      return membership?.userId === userId ? membership : null;
    },
  };

  const response = createResponseRecorder();
  let nextCalls = 0;
  const middleware = requireChamaRoles(['TREASURER'], { repository, allowSuperAdmin: false });

  const requestA: ApiRequest = {
    headers: {},
    params: { chamaId: 'chama-a' },
    auth: { userId: 'user-1', roles: ['MEMBER'] },
  };
  await middleware(requestA, response.apiResponse, () => { nextCalls += 1; });
  assert.equal(nextCalls, 0);
  assert.equal(response.statusCode, 403);

  response.reset();
  const requestB: ApiRequest = {
    headers: {},
    params: { chamaId: 'chama-b' },
    auth: { userId: 'user-1', roles: ['MEMBER'] },
  };
  await middleware(requestB, response.apiResponse, () => { nextCalls += 1; });
  assert.equal(nextCalls, 1);
  assert.equal(requestB.chamaMembership?.officialRole, 'TREASURER');
});

function createResponseRecorder() {
  let statusCode = 200;
  let body: unknown;

  const apiResponse: ApiResponse = {
    status(code) {
      statusCode = code;
      return {
        json(value: unknown) {
          body = value;
          return value;
        },
      };
    },
  };

  return {
    apiResponse,
    get statusCode() { return statusCode; },
    get body() { return body; },
    reset() {
      statusCode = 200;
      body = undefined;
    },
  };
}


test('BE-04 platform admin authorization is independent of Chama office roles', () => {
  const middleware = requireRoles(['SUPER_ADMIN']);

  const memberResponse = createResponseRecorder();
  let memberNext = 0;
  const memberRequest: ApiRequest = {
    headers: {},
    auth: { userId: 'member-user', roles: ['MEMBER'] },
  };
  middleware(memberRequest, memberResponse.apiResponse, () => { memberNext += 1; });
  assert.equal(memberNext, 0);
  assert.equal(memberResponse.statusCode, 403);

  const adminResponse = createResponseRecorder();
  let adminNext = 0;
  const adminRequest: ApiRequest = {
    headers: {},
    auth: { userId: 'admin-user', roles: ['SUPER_ADMIN'] },
  };
  middleware(adminRequest, adminResponse.apiResponse, () => { adminNext += 1; });
  assert.equal(adminNext, 1);
  assert.equal(adminResponse.statusCode, 200);
});


test('BE-35 client-selected active Chama cannot override route-scoped authorization', async () => {
  const memberships = new Map<string, ActiveChamaMembership>([
    ['chama-a', { chamaId: 'chama-a', userId: 'user-1', role: 'SECRETARY', officialRole: 'SECRETARY' }],
    ['chama-b', { chamaId: 'chama-b', userId: 'user-1', role: 'TREASURER', officialRole: 'TREASURER' }],
  ]);
  const repository: ChamaMembershipRepository = {
    async findActiveMembership(userId, chamaId) {
      const membership = memberships.get(chamaId) ?? null;
      return membership?.userId === userId ? membership : null;
    },
  };
  const middleware = requireChamaRoles(['SECRETARY'], { repository, allowSuperAdmin: false });

  const spoofed = createResponseRecorder();
  let spoofedNext = 0;
  const request: ApiRequest = {
    headers: { 'x-active-chama-id': 'chama-a' },
    params: { chamaId: 'chama-b' },
    auth: { userId: 'user-1', roles: ['MEMBER'] },
  };
  await middleware(request, spoofed.apiResponse, () => { spoofedNext += 1; });
  assert.equal(spoofedNext, 0);
  assert.equal(spoofed.statusCode, 403);

  spoofed.reset();
  const legitimate: ApiRequest = {
    headers: { 'x-active-chama-id': 'chama-b' },
    params: { chamaId: 'chama-a' },
    auth: { userId: 'user-1', roles: ['MEMBER'] },
  };
  await middleware(legitimate, spoofed.apiResponse, () => { spoofedNext += 1; });
  assert.equal(spoofedNext, 1);
  assert.equal(legitimate.chamaMembership?.officialRole, 'SECRETARY');
});

test('BE-35 platform-admin role derives only from users.is_platform_admin semantics', () => {
  assert.deepEqual(identityRolesFromPlatformFlag(false), ['MEMBER']);
  assert.deepEqual(identityRolesFromPlatformFlag(true), ['SUPER_ADMIN']);

  const guard = protectAdministrativeRoutes('/api/v1/admin');
  const officeResponse = createResponseRecorder();
  let officeNext = 0;
  const officeRequest: ApiRequest = {
    headers: {},
    originalUrl: '/api/v1/admin/users',
    auth: { userId: 'secretary-user', roles: identityRolesFromPlatformFlag(false) },
    chamaMembership: { chamaId: 'chama-a', userId: 'secretary-user', role: 'SECRETARY', officialRole: 'SECRETARY' },
  };
  guard(officeRequest, officeResponse.apiResponse, () => { officeNext += 1; });
  assert.equal(officeNext, 0);
  assert.equal(officeResponse.statusCode, 403);

  const adminResponse = createResponseRecorder();
  let adminNext = 0;
  const adminRequest: ApiRequest = {
    headers: {},
    originalUrl: '/api/v1/admin/users',
    auth: { userId: 'admin-user', roles: identityRolesFromPlatformFlag(true) },
  };
  guard(adminRequest, adminResponse.apiResponse, () => { adminNext += 1; });
  assert.equal(adminNext, 1);
  assert.equal(adminResponse.statusCode, 200);
});
