import {
  Address,
  Keypair,
  Networks,
  StrKey,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";

const STELLAR_NETWORK_ENV = "STELLAR_NETWORK";
const STELLAR_NETWORK_PASSPHRASE_ENV = "STELLAR_NETWORK_PASSPHRASE";

export function getStellarNetwork(): "PUBLIC" | "TESTNET" {
  const explicitNetwork = process.env[STELLAR_NETWORK_ENV]?.trim().toUpperCase();
  if (explicitNetwork === "PUBLIC" || explicitNetwork === "TESTNET") {
    return explicitNetwork;
  }

  const explicitPassphrase = process.env[STELLAR_NETWORK_PASSPHRASE_ENV]?.trim();
  if (explicitPassphrase?.toUpperCase() === "PUBLIC") {
    return "PUBLIC";
  }
  if (explicitPassphrase?.toUpperCase() === "TESTNET") {
    return "TESTNET";
  }

  return "TESTNET";
}

export function getStellarNetworkPassphrase(): string {
  const providedPassphrase = process.env[STELLAR_NETWORK_PASSPHRASE_ENV]?.trim();
  if (providedPassphrase) {
    const normalized = providedPassphrase.toUpperCase();
    if (normalized === "PUBLIC") {
      return Networks.PUBLIC;
    }
    if (normalized === "TESTNET") {
      return Networks.TESTNET;
    }
    return providedPassphrase;
  }

  return getStellarNetwork() === "PUBLIC" ? Networks.PUBLIC : Networks.TESTNET;
}

export interface SorobanAuthVerificationOptions {
  /** Current unix timestamp in seconds. Defaults to Date.now() / 1000. */
  now?: number;
  /** Optional network passphrase override used for signature verification. */
  networkPassphrase?: string;
}

export interface SorobanAuthVerificationResult {
  valid: boolean;
  errors: string[];
}

function normalizeAddress(address: string): string {
  try {
    return Address.fromString(address).toString();
  } catch {
    return address;
  }
}

function extractSignatureBytes(signature: xdr.ScVal): Buffer | null {
  const switchName = signature.switch().name;
  if (switchName === "scvBytes") {
    return Buffer.from(signature.bytes());
  }
  if (switchName === "scvU32" || switchName === "scvI32") {
    const value = switchName === "scvU32" ? signature.u32() : signature.i32();
    const buf = Buffer.alloc(4);
    buf.writeUInt32BE(value >>> 0, 0);
    return uf;
  }
  return null;
}

/**
 * Verifies a single Soroban authorization entry off-chain.
 *
 * Checks:
 *  - The credential is an address-based (sorobanCredentialsAddress) envelope.
 *  - The credential has not expired (current time <= valid_until timestamp).
 *  - The provided signature is valid against the invoker public key.
 */
export function verifySorobanAuthEntry(
  entry: xdr.SorobanAuthorizationEntry,
  options: SorobanAuthVerificationOptions = {},
): SorobanAuthVerificationResult {
  const errors: string[] = [];
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const networkPassphrase = options.networkPassphrase ?? getStellarNetworkPassphrase();

  const credentials = entry.credentials();
  if (credentials.switch().name !== "sorobanCredentialsAddress") {
    errors.push("Unsupported Soroban credentials type: expected address credentials");
    return { valid: false, errors };
  }

  const addressCredentials = credentials.address();
  const validUntil = Number(addressCredentials.signatureExpirationLedger());
  if (Number.isFinite(validUntil) && now > validUntil) {
    errors.push(
      `Authorization credential expired: current time ${now} > valid_until ${validUntil}`,
    );
  }

  const invokerAddress = addressCredentials.address();
  let invokerPublicKey: string | null = null;
  try {
    const scAddress = invokerAddress;
    if (scAddress.switch().name === "scAddressTypeAccount") {
      const accountId = scAddress.accountId();
      if (accountId.switch().name === "publicKeyTypeEd25519") {
        invokerPublicKey = StrKey.encodeEd25519PublicKey(
          Buffer.from(accountId.ed25519()),
        );
      }
    }
  } catch {
    invokerPublicKey = null;
  }

  if (!invokerPublicKey) {
    errors.push("Unable to derive invoker public key from authorization credential");
    return { valid: false, errors };
  }

  const signature = addressCredentials.signature();
  const signatureBytes = extractSignatureBytes(signature);
  if (!signatureBytes || signatureBytes.length === 0) {
    errors.push("Authorization credential is missing a signature payload");
    return { valid: false, errors };
  }

  try {
    const keypair = Keypair.fromPublicKey(invokerPublicKey);
    const preimage = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
      new xdr.HashIdPreimageSorobanAuthorization({
        networkId: Buffer.from(
          TransactionBuilder.calculateNetworkId(networkPassphrase),
        ),
        nonce: addressCredentials.nonce(),
        signatureExpirationLedger: addressCredentials.signatureExpirationLedger(),
        invocation: entry.rootInvocation(),
      }),
    );
    const payload = Buffer.from(preimage.toXDR());
    const digest = Buffer.from(
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require("crypto").createHash("sha256").update(payload).digest(),
    );
    if (!keypair.verify(digest, signatureBytes)) {
      errors.push("Invalid signature for Soroban authorization credential");
    }
  } catch (error) {
    errors.push(
      `Failed to verify Soroban authorization signature: ${ error instanceof Error ? error.message : String(error) }`,
    );
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Verifies all Soroban authorization entries attached to a transaction.
 * Returns a combined result; invalid entries are reported with their index.
 */
export function verifySorobanAuthEntries(
  entries: xdr.SorobanAuthorizationEntry[],
  options: SorobanAuthVerificationOptions = {},
): SorobanAuthVerificationResult {
  const errors: string[] = [];
  entries.forEach((entry, index) => {
    const result = verifySorobanAuthEntry(entry, options);
    if (!result.valid) {
      result.errors.forEach((message) => errors.push(`entry[${index}]: ${message}`));
    }
  });
  return { valid: errors.length === 0, errors };
}

export interface AccountBalanceCheckOptions {
  /** Minimum balance (in stroops) required to cover fees and reserves. */
  minimumBalanceStroops?: bigint;
}

/**
 * Ensures an account has sufficient balance to cover the required amount.
 * Intended to be called before queuing a transaction for RPC submission.
 */
export function checkAccountBalanceSufficiency(
  balanceStroops: bigint | string | number,
  requiredStroops: bigint | string | number,
): SorobanAuthVerificationResult {
  const balance = BigInt(balanceStroops);
  const required = BigInt(requiredStroops);
  if (balance < required) {
    return {
      valid: false,
      errors: [
        `Insufficient account balance: have ${balance.toString()} stroops, need ${required.toString()} stroops`,
      ],
    };
  }
  return { valid: true, errors: [] };
}

/**
 * Pre-flight middleware: validates Soroban auth envelopes and account balance
 * before a transaction is queued for RPC submission.
 */
export function preflightSorobanAuth(
  entries: xdr.SorobanAuthorizationEntry[],
  balanceStroops: bigint | string | number,
  requiredStroops: bigint | string | number,
  options: SorobanAuthVerificationOptions = {},
): SorobanAuthVerificationResult {
  const authResult = verifySorobanAuthEntries(entries, options);
  const balanceResult = checkAccountBalanceSufficiency(balanceStroops, requiredStroops);
  const errors = [...authResult.errors, ...balanceResult.errors];
  return { valid: errors.length === 0, errors };
}

export { normalizeAddress };
