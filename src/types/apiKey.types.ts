export type ApiScope = "read" | "write";

/**
 * The object that the scope middleware attaches to
 * `req.apiKey` after a successful authentication check.
 */
export interface AuthenticatedApiKey {
  id: string;
  label?: string | null;
  scopes: ApiScope[];
  ownerId?: string | null;
}

/**
 * Convenience guard — checks whether a scope array contains
 * at least one of the required scopes.
 */
export function hasScope(
  grantedScopes: ApiScope[],
  required: ApiScope
): boolean {
  return grantedScopes.includes(required);
}

/**
 * Map an HTTP method to the minimum scope required.
 *
 *  GET, HEAD, OPTIONS → read
 *  POST, PUT, PATCH, DELETE → write
 *
 * Returns null for unknown methods (middleware will reject them).
 */
export function requiredScopeForMethod(
  method: string
): ApiScope | null {
  switch (method.toUpperCase()) {
    case "GET":
    case "HEAD":
    case "OPTIONS":
      return "read";

    case "POST":
    case "PUT":
    case "PATCH":
    case "DELETE":
      return "write";

    default:
      return null;
  }
}