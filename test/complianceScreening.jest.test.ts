import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { REMITTANCE_STATUS } from "../src/services/complianceTypes";
import { PayoutHaltedError } from "../src/services/anchorPayoutRelayService";
import { AnchorPayoutRelayService } from "../src/services/anchorPayoutRelayService";
import { createComplianceScreeningWorker } from "../src/services/complianceScreeningWorker";

describe("AnchorPayoutRelayService", () => {
  const baseTx = {
    id: "tx-1",
    senderPublicKey: "GABC",
    recipientPublicKey: "GDEF",
    status: REMITTANCE_STATUS.COMPLIANCE_CLEARED,
    payoutHalted: false,
  };

  it("halts relay when the remittance is flagged_compliance", async () => {
    const relay = new AnchorPayoutRelayService();
    await expect(
      relay.relay({
        ...baseTx,
        status: REMITTANCE_STATUS.FLAGGED_COMPLIANCE,
        payoutHalted: true,
      }),
    ).rejects.toBeInstanceOf(PayoutHaltedError);
  });

  it("relays when compliance is cleared", async () => {
    const relay = new AnchorPayoutRelayService();
    await expect(relay.relay(baseTx)).resolves.toEqual({
      relayed: true,
      halted: false,
    });
  });
});

describe("ComplianceScreeningWorker", () => {
  const sendAlert = jest.fn().mockResolvedValue(true);
  const update = jest.fn().mockResolvedValue({});
  const findMany = jest.fn();

  beforeEach(() => {
    update.mockClear();
    findMany.mockReset();
    sendAlert.mockClear();
  });

  function db() {
    return {
      remittanceTransaction: { findMany, update },
    };
  }

  it("flags sanctioned counterparties and does not relay payout", async () => {
    const relay = jest.fn();
    const screeningWorker = createComplianceScreeningWorker({
      screening: {
        isConfigured: () => true,
        screenPublicKey: jest
          .fn()
          .mockResolvedValueOnce({
            publicKey: "GSENDER",
            sanctioned: true,
            provider: "ofac-api",
          })
          .mockResolvedValueOnce({
            publicKey: "GRECIP",
            sanctioned: false,
            provider: "ofac-api",
          }),
      } as never,
      payoutRelay: { relay } as never,
      notifications: { sendAlert } as never,
      db: db() as never,
    });

    await screeningWorker.screenTransaction({
      id: "r-1",
      senderPublicKey: "GSENDER",
      recipientPublicKey: "GRECIP",
      status: REMITTANCE_STATUS.PENDING_SCREENING,
      payoutHalted: false,
    });

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: REMITTANCE_STATUS.FLAGGED_COMPLIANCE,
          payoutHalted: true,
        }),
      }),
    );
    expect(relay).not.toHaveBeenCalled();
    expect(sendAlert).toHaveBeenCalled();
  });

  it("clears a clean pair and relays payout", async () => {
    const relay = jest.fn().mockResolvedValue({ relayed: true, halted: false });
    const screeningWorker = createComplianceScreeningWorker({
      screening: {
        isConfigured: () => true,
        screenPublicKey: jest.fn().mockResolvedValue({
          publicKey: "GKEY",
          sanctioned: false,
          provider: "ofac-api",
        }),
      } as never,
      payoutRelay: { relay } as never,
      notifications: { sendAlert } as never,
      db: db() as never,
    });

    await screeningWorker.screenTransaction({
      id: "r-2",
      senderPublicKey: "GAAA",
      recipientPublicKey: "GBBB",
      status: REMITTANCE_STATUS.PENDING_SCREENING,
      payoutHalted: false,
    });

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: REMITTANCE_STATUS.COMPLIANCE_CLEARED,
        }),
      }),
    );
    expect(relay).toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: REMITTANCE_STATUS.PAYOUT_RELAYED,
        }),
      }),
    );
  });
});
