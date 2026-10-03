import { describe, it, expect } from "@jest/globals";
import { ZkCdnManager } from "../src/services/zkCdnManager";
import fs from "fs";
import path from "path";

describe("ZkCdnManager", () => {
  it("generates correct optimal CDN download URLs matching release version tags", () => {
    const manager = new ZkCdnManager({
      cdnBaseUrl: "https://cdn.example.com/zk",
      localStorageDir: "/tmp/zk-test",
    });

    const result = manager.getOptimalParamUrls("shielded-transfer", "v2.1.0");

    expect(result.circuitId).toBe("shielded-transfer");
    expect(result.version).toBe("v2.1.0");
    expect(result.cdnUrl).toBe("https://cdn.example.com/zk/v2.1.0/shielded-transfer-v2.1.0.zkey");
    expect(result.verifyingKeyUrl).toBe("https://cdn.example.com/zk/v2.1.0/shielded-transfer-v2.1.0.vkey.json");
  });
});
