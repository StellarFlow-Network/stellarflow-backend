import type { Express } from "express";

import { corsMiddleware, corsErrorHandler } from "./corsMiddleware";
import { securityHeadersMiddleware } from "./securityHeadersMiddleware";

/**
 * Registers the HTTP security chain for Issue #792.
 *
 * The order matters and is asserted by `test/httpSecurity.jest.test.ts`:
 *
 * 1. `securityHeadersMiddleware` first, so the headers land on every response.
 *    Anything registered after a short-circuiting handler (a CORS rejection, a
 *    preflight 204, a maintenance 503) is skipped for those responses.
 * 2. `corsMiddleware` evaluates the origin allowlist.
 * 3. `corsErrorHandler` immediately after, to turn a rejected origin into a
 *    403 CORS_DENIED rather than letting it reach the generic 500 handler.
 *
 * Call this before any route or body parser is mounted.
 */
export function applyHttpSecurity(app: Express): void {
  app.use(securityHeadersMiddleware);
  app.use(corsMiddleware);
  app.use(corsErrorHandler);
}

export default applyHttpSecurity;
