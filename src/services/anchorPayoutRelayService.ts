import { REMITTANCE_STATUS } from "./complianceTypes";

export class PayoutHaltedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PayoutHaltedError";
  }
}

/**
 * Relays a cleared remittance to the receiving-side anchor.
 * Hard-stops when the row is flagged or screening did not succeed.
 */
export class AnchorPayoutRelayService {
  constructor(
    private readonly relayUrl = process.env.ANCHOR_PAYOUT_RELAY_URL?.trim(),
    private readonly fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  ) {}

  async relay(transaction: {
    id: string;
    status: string;
    payoutHalted?: boolean;
    senderPublicKey: string;
    recipientPublicKey: string;
  }): Promise<{ relayed: boolean; halted: boolean }> {
    if (
      transaction.payoutHalted ||
      transaction.status === REMITTANCE_STATUS.FLAGGED_COMPLIANCE ||
      transaction.status === REMITTANCE_STATUS.PAYOUT_HALTED
    ) {
      throw new PayoutHaltedError(
        `Anchor payout halted for remittance ${transaction.id} (status=${transaction.status})`,
      );
    }

    if (transaction.status !== REMITTANCE_STATUS.COMPLIANCE_CLEARED) {
      throw new PayoutHaltedError(
        `Anchor payout refused for remittance ${transaction.id}: compliance not cleared`,
      );
    }

    if (!this.relayUrl) {
      return { relayed: true, halted: false };
    }

    const response = await this.fetchImpl(this.relayUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        remittanceId: transaction.id,
        senderPublicKey: transaction.senderPublicKey,
        recipientPublicKey: transaction.recipientPublicKey,
      }),
    });

    if (!response.ok) {
      throw new Error(
        `Anchor payout relay returned HTTP ${response.status} for ${transaction.id}`,
      );
    }

    return { relayed: true, halted: false };
  }
}

export const anchorPayoutRelayService = new AnchorPayoutRelayService();
