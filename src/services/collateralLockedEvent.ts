export interface CollateralLockedEvent {
  chainId: string;
  chainType: "EVM" | "SOLANA";
  transactionHash: string;
  tokenAmount: string;
  fromAddress: string;
  destinationChainId: string;
  destinationAddress: string;
  eventTimestamp: Date;
}

export interface CollateralLockedFields {
  transactionHash: string;
  tokenAmount: string | bigint;
  fromAddress: string;
  destinationChainId: string | number | bigint;
  destinationAddress: string;
  eventTimestamp?: Date;
}

/** Normalizes the common CollateralLocked ABI emitted by EVM bridge contracts. */
export function parseEvmCollateralLocked(
  chainId: string,
  fields: CollateralLockedFields,
): CollateralLockedEvent {
  return normalize("EVM", chainId, fields);
}

/**
 * Parses the JSON payload emitted by the Solana bridge program log adapter.
 * Logs are prefixed so unrelated program output cannot be treated as a lock.
 */
export function parseSolanaCollateralLocked(
  chainId: string,
  log: string,
): CollateralLockedEvent | null {
  const prefix = "COLLATERAL_LOCKED:";
  if (!log.startsWith(prefix)) return null;
  try {
    const fields = JSON.parse(log.slice(prefix.length)) as CollateralLockedFields;
    if (!fields.transactionHash) return null;
    return normalize("SOLANA", chainId, fields);
  } catch {
    return null;
  }
}

function normalize(
  chainType: "EVM" | "SOLANA",
  chainId: string,
  fields: CollateralLockedFields,
): CollateralLockedEvent {
  if (
    !fields.transactionHash ||
    !fields.fromAddress ||
    !fields.destinationAddress ||
    fields.tokenAmount === "" ||
    fields.destinationChainId === ""
  ) {
    throw new Error("CollateralLocked event is missing a required field");
  }
  return {
    chainId,
    chainType,
    transactionHash: fields.transactionHash,
    tokenAmount: fields.tokenAmount.toString(),
    fromAddress: fields.fromAddress,
    destinationChainId: fields.destinationChainId.toString(),
    destinationAddress: fields.destinationAddress,
    eventTimestamp: fields.eventTimestamp ?? new Date(),
  };
}
