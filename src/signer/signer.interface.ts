/**
 * ISigner — abstract signing contract.
 * All signers must implement this interface so the relayer is decoupled
 * from any specific key management backend.
 */
export interface ISigner {
  /**
   * Returns the Stellar public key (G... address) this signer controls.
   * Does not require a round-trip to KMS — the public key is stored locally.
   */
  getPublicKey(): Promise<string>;

  /**
   * Signs the raw transaction hash bytes using the underlying key material.
   * The private key never leaves the HSM.
   * @param txHash - 32-byte Buffer of the transaction hash to sign
   * @returns 64-byte DER or raw signature buffer
   */
  sign(txHash: Buffer): Promise<Buffer>;
}
