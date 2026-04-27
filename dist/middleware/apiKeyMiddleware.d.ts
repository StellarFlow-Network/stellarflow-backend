import { Request, Response, NextFunction } from "express";
export declare const apiKeyMiddleware: (req: Request, res: Response, next: NextFunction) => Promise<void>;
import { AuthenticatedApiKey } from "../types/apiKey.types";
declare global {
    namespace Express {
        interface Request {
            apiKey?: AuthenticatedApiKey;
        }
    }
}
/**
 * `apiKeyAuth()`
 *
 * Drop this onto any router or individual route that needs
 * API-key protection:
 *
 *   router.use(apiKeyAuth());          // protect all verbs
 *   router.post("/prices", apiKeyAuth(), handler);  // just POST
 *
 * The middleware automatically maps the HTTP method to the
 * required scope, so you never have to pass a scope manually.
 */
export declare function apiKeyAuth(): (req: Request, res: Response, next: NextFunction) => Promise<void>;
/** Require the "read" scope explicitly (ignores HTTP method). */
export declare function requireReadScope(): (_req: Request, res: Response, next: NextFunction) => void;
/** Require the "write" scope explicitly (ignores HTTP method). */
export declare function requireWriteScope(): (_req: Request, res: Response, next: NextFunction) => void;
//# sourceMappingURL=apiKeyMiddleware.d.ts.map