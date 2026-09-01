/**
 * Structural stand-in for `process.env`.
 *
 * Helpers that read configuration accept this instead of `NodeJS.ProcessEnv`
 * so they can be called with a plain object in tests, and so they avoid the
 * `NodeJS` global that the ESLint config does not declare.
 */
export type EnvSource = Record<string, string | undefined>;
