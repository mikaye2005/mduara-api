import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../utils/errors';
import { sendError } from '../utils/response.util';
import { logger } from '../utils/logger';

/** Centralized error handler. Must be registered last, after all routes. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(error: unknown, req: Request, res: Response, _next: NextFunction): void {
  if (error instanceof ZodError) {
    sendError(res, 400, 'Validation failed', 'VALIDATION_FAILED', error.flatten());
    return;
  }

  if (error instanceof AppError) {
    if (error.statusCode >= 500) {
      logger.error(error.message, { path: req.path, stack: error.stack });
    }
    sendError(res, error.statusCode, error.message, error.code, error.details);
    return;
  }

  const err = error as Error;
  logger.error('Unhandled error', { path: req.path, message: err?.message, stack: err?.stack });
  sendError(res, 500, 'Internal server error', 'INTERNAL_SERVER_ERROR');
}

export function notFoundHandler(req: Request, res: Response): void {
  sendError(res, 404, `Route ${req.method} ${req.path} not found`, 'ROUTE_NOT_FOUND');
}
