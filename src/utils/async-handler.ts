import type { NextFunction, Request, Response } from 'express';

type AsyncRouteHandler<Req extends Request = Request> = (
  req: Req,
  res: Response,
  next: NextFunction,
) => Promise<void>;

/** Wraps an async Express handler so rejected promises reach the error-handling middleware. */
export function asyncHandler<Req extends Request = Request>(handler: AsyncRouteHandler<Req>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    handler(req as Req, res, next).catch(next);
  };
}
