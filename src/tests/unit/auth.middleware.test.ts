import assert from 'node:assert/strict';
import test from 'node:test';
import type { NextFunction, Request, Response } from 'express';
import { authenticate } from '../../middlewares/auth.middleware';
import { UnauthorizedError } from '../../utils/errors';

test('authenticate returns UnauthorizedError when Bearer header is missing', async () => {
  const req = { headers: {} } as Request;

  let capturedError: unknown;
  const next: NextFunction = (error?: unknown) => {
    capturedError = error;
  };

  await authenticate(req, {} as Response, next);

  assert.ok(capturedError instanceof UnauthorizedError);
	assert.equal((capturedError as UnauthorizedError).message, 'Missing or malformed Authorization header');
});
