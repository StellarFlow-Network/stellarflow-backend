import { AsyncLocalStorage } from "async_hooks";

export interface RequestContext {
  requestId: string;
  traceId?: string;
  spanId?: string;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();
