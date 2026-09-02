import {
  TRACKED_TX_TYPES,
  type TrackedTxType,
  type TxType,
} from "./gasMetrics.types";

/**
 * Maps an invoked Soroban contract function to a transaction type (Issue #786).
 *
 * Contracts rarely name their entrypoints exactly `swap` / `deposit` /
 * `withdraw`, so a set of common aliases is recognised out of the box and
 * `GAS_PROFILER_TX_TYPE_ALIASES` allows deployment-specific overrides without
 * a code change.
 */

/** Built-in aliases, keyed by the alias and resolving to a tracked type. */
const DEFAULT_ALIASES: Record<string, TrackedTxType> = {
  swap: "swap",
  swap_exact_in: "swap",
  swap_exact_out: "swap",
  exchange: "swap",
  trade: "swap",

  deposit: "deposit",
  add_liquidity: "deposit",
  mint: "deposit",
  supply: "deposit",

  withdraw: "withdraw",
  remove_liquidity: "withdraw",
  redeem: "withdraw",
  burn: "withdraw",
};

/** Normalizes a function name so `swapExactIn`, `swap-exact-in` and `SWAP_EXACT_IN` agree. */
export function normalizeFunctionName(functionName: unknown): string | null {
  if (typeof functionName !== "string") return null;

  const normalized = functionName
    .trim()
    // camelCase to snake_case before lowercasing, so the word boundary survives.
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[\s-]+/g, "_")
    .replace(/^_+|_+$/g, "");

  return normalized.length > 0 ? normalized : null;
}

function isTrackedTxType(value: string): value is TrackedTxType {
  return (TRACKED_TX_TYPES as readonly string[]).includes(value);
}

/**
 * Parses `GAS_PROFILER_TX_TYPE_ALIASES`, formatted as
 * `alias:type,alias:type` — for example `settle:swap,top_up:deposit`.
 * Entries whose target is not a tracked type are ignored.
 */
export function parseTxTypeAliases(
  raw: string | undefined,
): Record<string, TrackedTxType> {
  if (!raw) return {};

  const aliases: Record<string, TrackedTxType> = {};

  for (const entry of raw.split(",")) {
    const [rawAlias, rawTarget] = entry.split(":");
    const alias = normalizeFunctionName(rawAlias);
    const target = normalizeFunctionName(rawTarget);

    if (!alias || !target || !isTrackedTxType(target)) continue;

    aliases[alias] = target;
  }

  return aliases;
}

/**
 * Resolves a function name to a transaction type.
 *
 * Returns `unknown` when there is no function name at all (a non-invoke
 * operation), and `other` when a function was invoked but is not one we track.
 * Keeping those distinct matters for reporting: `unknown` means the profiler
 * could not see a function, while `other` means the contract call is simply
 * outside the tracked set.
 */
export function classifyTxType(
  functionName: unknown,
  aliases: Record<string, TrackedTxType> = {},
): TxType {
  const normalized = normalizeFunctionName(functionName);
  if (!normalized) return "unknown";

  const override = aliases[normalized];
  if (override) return override;

  const builtIn = DEFAULT_ALIASES[normalized];
  if (builtIn) return builtIn;

  return "other";
}

export const defaultTxTypeAliases = DEFAULT_ALIASES;
