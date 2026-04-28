import { Keypair } from '@stellar/stellar-sdk';
import { ISigner } from './signer.interface';

/**
 * LocalSignerService — Development/Test fallback implementation of ISigner.
 * 
 * ⚠️ WARNING: This class uses local secret keys and must NEVER be used in production.
 */
export class LocalSignerService implements ISigner {
  private readonly keypair: Keypair;

  /**
   * @param secret - The Stellar secret key (S... address)
   */
  constructor(secret: string) {
    if (process.env.NODE_ENV === 'production') {
      console.warn('❌ CRITICAL SECURITY WARNING: LocalSigner active in PRODUCTION environment!');
    } else {
      console.warn('⚠️ LocalSigner active — do not use in production');
    }
    
    this.keypair = Keypair.fromSecret(secret);
  }

  /**
   * Returns the Stellar public key (G... address) this signer controls.
   */
  async getPublicKey(): Promise<string> {
    return this.keypair.publicKey();
  }

  /**
   * Signs the raw transaction hash bytes using the local keypair.
   * 
   * @param txHash - 32-byte Buffer of the transaction hash to sign
   * @returns 64-byte raw signature buffer
   */
  async sign(txHash: Buffer): Promise<Buffer> {
    return Buffer.from(this.keypair.sign(txHash));
  }
}
