import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import { BridgeSupplyAuditService } from "../src/services/bridgeSupplyAuditService";
import { notificationService, AlertType, AlertSeverity } from "../src/services/notificationService";

describe("BridgeSupplyAuditService", () => {
  let auditService: BridgeSupplyAuditService;

  beforeEach(() => {
    auditService = new BridgeSupplyAuditService({
      checkIntervalMs: 1000,
    });
  });

  afterEach(() => {
    auditService.stop();
  });

  describe("evaluateBridgeSupply", () => {
    it("returns no mismatch when Soroban supply matches remote collateral balance", async () => {
      const result = await auditService.evaluateBridgeSupply({
        bridgeChainId: "1",
        chainName: "Ethereum",
        chainType: "EVM",
        sorobanContractId: "CC123",
        remoteContractAddress: "0xABC",
        sorobanSupply: 1000n,
        remoteCollateralBalance: 1000n,
      });

      expect(result.hasMismatch).toBe(false);
      expect(result.delta).toBe(0n);
    });

    it("detects mismatch when delta S != 0", async () => {
      const result = await auditService.evaluateBridgeSupply({
        bridgeChainId: "1",
        chainName: "Ethereum",
        chainType: "EVM",
        sorobanContractId: "CC123",
        remoteContractAddress: "0xABC",
        sorobanSupply: 1050n,
        remoteCollateralBalance: 1000n,
      });

      expect(result.hasMismatch).toBe(true);
      expect(result.delta).toBe(50n);
    });
  });

  describe("handleSupplyMismatch", () => {
    it("triggers high-priority PagerDuty alarm on supply mismatch", async () => {
      const sendAlertSpy = jest
        .spyOn(notificationService, "sendAlert")
        .mockResolvedValue(true);

      const comparison = {
        bridgeChainId: "1",
        chainName: "Polygon",
        chainType: "EVM",
        sorobanContractId: "CC456",
        remoteContractAddress: "0xDEF",
        sorobanSupply: 5000n,
        remoteCollateralBalance: 4900n,
        delta: 100n,
        hasMismatch: true,
        timestamp: new Date(),
      };

      await auditService.handleSupplyMismatch(comparison);

      expect(sendAlertSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: AlertType.SUPPLY_INVARIANT_DRIFT,
          severity: AlertSeverity.CRITICAL,
        })
      );

      sendAlertSpy.mockRestore();
    });
  });

  describe("lifecycle", () => {
    it("starts and stops cleanly", () => {
      auditService.start();
      expect(auditService.getStatus().isRunning).toBe(true);

      auditService.stop();
      expect(auditService.getStatus().isRunning).toBe(false);
    });
  });
});
