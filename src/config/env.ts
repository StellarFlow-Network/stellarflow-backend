export const USE_MOCKS =
  process.env.USE_MOCKS ===
  'true';

export const OIDC_ISSUER =
  process.env.OIDC_ISSUER ?? '';

export const OIDC_CLIENT_ID =
  process.env.OIDJ_CLIENT_ID ?? '';

export const OIDC_CLIENT_SECRET =
  process.env.OIDC_CLIENT_SECRET ?? '';

export const OIDC_REDIRECT_URI =
  process.env.OIDC_REDIRECT_URI ?? '';

export const OIDC_AUTHORIZED_DOMAINS =
  (process.env.OIDC_AUTHORIZED_DOMAINS ?? '')
    .split(',')
    .map((domain) => domain.trim().toLowerCase())
    .filter(Boolean);

export const ADMIN_SESSION_COOKIE_NAME =
  process.env.ADMIN_SESSION_COOKIE_NAME ?? 'admin_session';

export const ADMIN_SESSION_ENCRYPTION_KEY =
  process.env.ADMIN_SESSION_ENCRYPTION_KEY ?? '';
