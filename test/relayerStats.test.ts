import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import app from "../src/index";

describe("GET /api/stats/relayers", () => {
  it("should return relayer statistics", async () => {
    const response = await request(app).get("/api/stats/relayers");

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data).toHaveProperty("totalRelayers");
    expect(response.body.data).toHaveProperty("relayers");
    expect(Array.isArray(response.body.data.relayers)).toBe(true);

    // If there are relayers, verify the structure
    if (response.body.data.relayers.length > 0) {
      const relayer = response.body.data.relayers[0];
      expect(relayer).toHaveProperty("signerPublicKey");
      expect(relayer).toHaveProperty("signerName");
      expect(relayer).toHaveProperty("totalSignatures");
      expect(relayer).toHaveProperty("successfulPushes");
      expect(relayer).toHaveProperty("failedSignatures");
      expect(relayer).toHaveProperty("uptimePercentage");
      expect(relayer).toHaveProperty("averageLatencyMs");
      expect(relayer).toHaveProperty("lastActivity");

      // Verify types
      expect(typeof relayer.signerPublicKey).toBe("string");
      expect(typeof relayer.signerName).toBe("string");
      expect(typeof relayer.totalSignatures).toBe("number");
      expect(typeof relayer.successfulPushes).toBe("number");
      expect(typeof relayer.failedSignatures).toBe("number");
      expect(typeof relayer.uptimePercentage).toBe("number");
      expect(typeof relayer.averageLatencyMs).toBe("number");
    }
  });

  it("should sort relayers by uptime percentage (descending)", async () => {
    const response = await request(app).get("/api/stats/relayers");

    expect(response.status).toBe(200);
    
    if (response.body.data.relayers.length > 1) {
      const relayers = response.body.data.relayers;
      for (let i = 0; i < relayers.length - 1; i++) {
        expect(relayers[i].uptimePercentage).toBeGreaterThanOrEqual(
          relayers[i + 1].uptimePercentage
        );
      }
    }
  });
});
