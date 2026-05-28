/**
 * Relayer type definitions and utilities.
 */

/**
 * Active relayer attached to a request after successful authentication.
 */
export interface ActiveRelayer {
  id: number;
  name: string;
  allowedAssets: string[];
  /** Ed25519 public key (hex) registered for this relayer, if any */
  publicKey?: string | null;
  /**
   * Check if this is a no-op relayer (always false for ActiveRelayer).
   * Allows for polymorphic checks: `if (relayer.is_noop()) { ... }`
   */
  is_noop(): boolean;
}

/**
 * EmptyRelayer represents a no-op relayer for when relayer metadata
 * is not available. Instead of returning undefined or null,
 * downstream consumers receive this strictly-typed empty object.
 *
 * This maintains pure object-oriented aesthetics and eliminates
 * the architectural "noise" of checking for null/undefined.
 */
export class EmptyRelayer {
  /**
   * Check if this is a no-op relayer (always true for EmptyRelayer).
   * Allows for polymorphic checks: `if (relayer.is_noop()) { ... }`
   */
  public is_noop(): boolean {
    return true;
  }

  /**
   * Placeholder id for type compatibility.
   * Will never be used in actual logic.
   */
  public readonly id: number = -1;

  /**
   * Placeholder name for type compatibility.
   * Useful for logging/debugging.
   */
  public readonly name: string = "[no-op]";

  /**
   * Empty array of allowed assets.
   * Downstream consumers can safely check this array.
   */
  public readonly allowedAssets: string[] = [];

  /**
   * No public key is registered for a no-op relayer.
   */
  public readonly publicKey: null = null;
}

/**
 * Union type for both active and empty relayers.
 */
export type Relayer = ActiveRelayer | EmptyRelayer;

/**
 * Factory function to create a singleton EmptyRelayer.
 * Ensures consistent identity checks across the application.
 */
const EMPTY_RELAYER_SINGLETON = new EmptyRelayer();

export function getEmptyRelayer(): EmptyRelayer {
  return EMPTY_RELAYER_SINGLETON;
}

/**
 * Type guard to check if a relayer is active (not empty).
 * Usage: `if (isActiveRelayer(relayer)) { ...use relayer.id... }`
 */
export function isActiveRelayer(relayer: Relayer): relayer is ActiveRelayer {
  return !relayer.is_noop();
}
