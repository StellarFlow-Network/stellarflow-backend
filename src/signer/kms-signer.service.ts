import { KMSClient, SignCommand } from '@aws-sdk/client-kms';
import { ISigner } from './signer.interface';

/**
 * Custom error for HSM signing failures.
 */
export class HsmSigningError extends Error {
  constructor(message: string, public readonly cause?: any) {
    super(message);
    this.name = 'HsmSigningError';
  }
}

/**
 * KmsSignerService — AWS KMS implementation of ISigner.
 * 
 * Assumption: The AWS KMS key is an asymmetric Ed25519 key.
 * While Stellar uses Ed25519, AWS KMS also supports ECDSA (secp256k1).
 * We use the ED25519 algorithm to match Stellar's requirements.
 */
export class KmsSignerService implements ISigner {
  /**
   * @param keyId - The AWS KMS key ARN or alias
   * @param publicKey - The Stellar G... address corresponding to the KMS key
   * @param kmsClient - Injected KMS client for interaction with AWS
   */
  constructor(
    private readonly keyId: string,
    private readonly publicKey: string,
    private readonly kmsClient: KMSClient,
  ) {}

  /**
   * Returns the Stellar public key (G... address) this signer controls.
   * This is returned from local config to avoid unnecessary KMS round-trips.
   */
  async getPublicKey(): Promise<string> {
    return this.publicKey;
  }

  /**
   * Signs the raw transaction hash bytes using AWS KMS.
   * The private key never leaves the HSM.
   * 
   * @param txHash - 32-byte Buffer of the transaction hash to sign
   * @returns 64-byte raw signature buffer
   * @throws HsmSigningError if the signing operation fails
   */
  async sign(txHash: Buffer): Promise<Buffer> {
    try {
      const command = new SignCommand({
        KeyId: this.keyId,
        Message: txHash,
        MessageType: 'RAW',
        SigningAlgorithm: 'ED25519' as any,
      });

      const response = await this.kmsClient.send(command);

      if (!response.Signature) {
        throw new Error('KMS returned an empty signature');
      }

      // AWS KMS returns the signature as a Uint8Array/Buffer
      return Buffer.from(response.Signature);
    } catch (error: any) {
      console.error('[KmsSignerService] KMS signing failed:', error);
      throw new HsmSigningError(`Failed to sign with KMS key ${this.keyId}: ${error.message}`, error);
    }
  }
}
