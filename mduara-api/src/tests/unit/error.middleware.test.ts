import assert from 'node:assert/strict';
import test from 'node:test';
import type { Request, Response } from 'express';
import { errorHandler } from '../../middlewares/error.middleware';
import { TooManyRequestsError } from '../../utils/errors';

test('errorHandler maps TooManyRequestsError to HTTP 429', () => {
  let statusCode = 0;
  let body: unknown;

  const res = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(payload: unknown) {
      body = payload;
      return this;
    },
  } as unknown as Response;

  errorHandler(
    new TooManyRequestsError('Too many OTP requests', { retryAfterSeconds: 60 }),
    { path: '/api/v1/auth/send-otp' } as Request,
    res,
    () => undefined,
  );

  assert.equal(statusCode, 429);
  assert.deepEqual(body, {
    success: false,
    error: {
      code: 'TOO_MANY_REQUESTS',
      message: 'Too many OTP requests',
      details: { retryAfterSeconds: 60 },
    },
  });
});
