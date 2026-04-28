import { Mutex } from "async-mutex";
import stellarProvider from "../lib/stellarProvider";

/**
 * SequenceManager (Singleton)
 * Synchronizes Stellar sequence numbers to prevent collisions.
 * Uses async-mutex to ensure atomic increments across concurrent requests.
 */
export class SequenceManager {
  private static instance: SequenceManager;
  private currentSequence: bigint | null = null;
  private mutex = new Mutex();

  private constructor() {}

  /**
   * Get the singleton instance of SequenceManager
   */
  public static getInstance(): SequenceManager {
    if (!SequenceManager.instance) {
      SequenceManager.instance = new SequenceManager();
    }
    return SequenceManager.instance;
  }

  /**
   * Fetches the next sequence number for the given address.
   * If not cached, fetches from Horizon. Otherwise, increments local counter.
   * @param address - The Stellar public key of the account
   * @returns The next sequence number as a string
   */
  public async getNextSequence(address: string): Promise<string> {
    return await this.mutex.runExclusive(async () => {
      try {
        if (this.currentSequence === null) {
          console.info(`[SequenceManager] Fetching sequence from Horizon for ${address}...`);
          const account = await stellarProvider.loadAccount(address);
          this.currentSequence = BigInt(account.sequenceNumber());
        } else {
          this.currentSequence += 1n;
        }
        return this.currentSequence.toString();
      } catch (error) {
        this.currentSequence = null; // Reset on error to force re-fetch next time
        throw error;
      }
    });
  }

  /**
   * Invalidate the current sequence to force a re-fetch from the network.
   * Typically called when a tx_bad_seq error is encountered.
   * @param _account - The account public key (reserved for multi-account support)
   */
  public invalidate(_account?: string): void {
    this.currentSequence = null;
    console.info("[SequenceManager] Sequence invalidated. Next call will fetch from Horizon.");
  }
}

export const sequenceManager = SequenceManager.getInstance();
