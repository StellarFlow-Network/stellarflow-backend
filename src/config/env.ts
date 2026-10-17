export const USE_MOCKS =
  process.env.USE_MOCKS ===
  'true';

export const OIDC_ISSUER =
  process.env.OIDC_ISSUER ?? '';

export const OIDC_CLIENT_ID =
  process.env.OIDC_CLIENT_ID ?? '';

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

export const FLASH_LOAN_CIRCUIT_BREAKER_ENABLED =
  process.env.FLASH_LOAN_CIRCUIT_BREAKER_ENABLED === 'true';

export const FLASH_LOAN_SUSPICIOUS_THRESHOLD =
  Number(process.env.FLASH_LOAN_SUSPICIOUS_THRESHOLD ?? '3');

export const FLASH_LOAN_LEDGER_WINDOW =
  Number(process.env.FLASH_LOAN_LEDGER_WINDOW ?? '1');

export const CIRCUIT_BREAKER_PAUSE_FUNCTION =
  process.env.CIRCUIT_BREAKER_PAUSE_FUNCTION ?? 'pause';

export const MEMPOOL_POLL_INTERVAL_MS =
  Number(process.env.MEMPOOL_POLL_INTERVAL_MS ?? '1000');

export const SECURITY_TELEGRAM_API_BASE_URL =
  process.env.SECURITY_TELEGRAM_API_BASE_URL ?? 'https://api.telegram.org';

export const CIRCUIT_BREAKER_PAUSE_CONTRACT_ADDRESS =
  process.env.CIRCUIT_BREAKER_PAUSE_CONTRACT_ADDRESS ?? '';

export const SECURITY_TELEGRAM_BOT_TOKEN =
  process.env.SECURITY_TELEGRAM_BOT_TOKEN ?? '';

export const SECURITY_TELEGRAM_CHAT_ID =
  process.env.SECURITY_TELEGRAM_CHAT_ID ?? '';

export const FLASH_LOAN_CIRCUIT_BREAKER_DRY_RUN =
  process.env.FLASH_LOAN_CIRCUIT_BREAKER_DRY_RUN_ENABLED === 'true';
