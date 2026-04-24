import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { updateSecretKey } from "../services/secretManager";
import { logger } from "../utils/logger";

const ENV_PATH = path.resolve(process.cwd(), ".env");
const DEBOUNCE_MS = 500;

/**
 * Starts a fs.watch watcher on the .env file in process.cwd().
 * On change events, re-parses the file and calls updateSecretKey with the
 * new ORACLE_SECRET_KEY or SOROBAN_ADMIN_SECRET value (debounced at 500 ms).
 * Returns a cleanup function that stops the watcher.
 * If .env does not exist, logs a warning and returns a no-op cleanup.
 */
export function startEnvFileWatcher(): () => void {
  if (!fs.existsSync(ENV_PATH)) {
    logger.warn(
      `[EnvFileWatcher] .env not found at ${ENV_PATH}. File-based key reload disabled.`,
      "EnvFileWatcher",
    );
    return () => {};
  }

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const watcher = fs.watch(ENV_PATH, (event) => {
    if (event !== "change") return;

    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
    }

    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      try {
        const raw = fs.readFileSync(ENV_PATH);
        const parsed = dotenv.parse(raw);
        const newKey = parsed.ORACLE_SECRET_KEY || parsed.SOROBAN_ADMIN_SECRET;

        if (!newKey) {
          logger.warn(
            "[EnvFileWatcher] .env changed but no ORACLE_SECRET_KEY or SOROBAN_ADMIN_SECRET found. Key not updated.",
            "EnvFileWatcher",
          );
          return;
        }

        updateSecretKey(newKey, "file-watcher");
      } catch (err: any) {
        logger.warn(
          "[EnvFileWatcher] Failed to reload key from .env file.",
          "EnvFileWatcher",
          { reason: err.message },
        );
      }
    }, DEBOUNCE_MS);
  });

  logger.info(
    `[EnvFileWatcher] Watching ${ENV_PATH} for changes`,
    "EnvFileWatcher",
  );
  return () => watcher.close();
}
