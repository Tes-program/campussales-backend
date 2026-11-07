import { randomUUID } from 'crypto';
import { NextFunction, Request, Response } from 'express';

export const REQUEST_ID_HEADER = 'X-Request-Id';

const SAFE_INCOMING_ID = /^[A-Za-z0-9._-]{8,64}$/;

/**
 * Assigns every request an id before guards, pipes or interceptors run, so
 * 401s from guards and 400s from pipes carry it too. A well-formed incoming
 * X-Request-Id (e.g. from Railway's proxy or the frontend) is reused.
 */
export function requestIdMiddleware(
  req: Request & { requestId?: string },
  res: Response,
  next: NextFunction,
) {
  const incoming = req.header(REQUEST_ID_HEADER);
  const id =
    incoming && SAFE_INCOMING_ID.test(incoming) ? incoming : randomUUID();
  req.requestId = id;
  res.setHeader(REQUEST_ID_HEADER, id);
  next();
}
