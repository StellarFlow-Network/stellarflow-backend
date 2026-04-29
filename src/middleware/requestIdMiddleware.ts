import { Request, Response, NextFunction } from "express";
import { generateSortableLogId } from "../utils/idGenerator";
import { requestContext } from "../lib/requestContext";

declare module "express" {
  interface Request {
    requestId?: string;
  }
}

export function requestIdMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const requestId = generateSortableLogId();
  req.requestId = requestId;
  res.setHeader("X-Request-Id", requestId);

  if (!res.locals) {
    res.locals = {} as any;
  }
  res.locals.requestId = requestId;

  requestContext.run({ requestId }, () => {
    next();
  });
}
