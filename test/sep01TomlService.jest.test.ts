import { describe, it, expect } from "@jest/globals";
import express from "express";
import request from "supertest";
import {
  SEP01_TOML_CACHE_KEY,
  Sep01TomlService,
  renderStellarToml,
  type Sep01Currency,
  type Sep01TomlConfig,
} from "../src/services/sep01TomlService";
import stellarTomlRouter from "../src/routes/stellarToml";

function baseConfig(overrides: Partial<Sep01TomlConfig> = {}): Sep01TomlConfig {
  return {
    version: "1.0.0",
    networkPassphrase: "Test SDF Network ; September 2015",
    accounts: ["GACCOUNT"],
    signingKey: "GSIGN",
    documentation: {
      orgName: "StellarFlow",
      orgUrl: "https://stellarflow.io",
    },
    principals: [],
    currencies: [],
    contracts: {},
    anchors: [],
    ...overrides,
  };
}

describe("Sep01TomlService (Issue #1040)", () => {
  it("renders standard SEP-01 sections", () => {
    const toml = renderStellarToml(
      baseConfig({
        currencies: [{ code: "USDC", name: "USD Coin", displayDecimals: 7 }],
        contracts: { oracle: "CABC" },
        anchors: [{ name: "Anchor", url: "https://anchor.example", protocols: ["SEP-24"] }],
      }),
    );

    expect(toml).toContain('VERSION = "1.0.0"');
    expect(toml).toContain(
      'NETWORK_PASSPHRASE = "Test SDF Network ; September 2015"',
    );
    expect(toml).toContain('ACCOUNTS = ["GACCOUNT"]');
    expect(toml).toContain("[DOCUMENTATION]");
    expect(toml).toContain("[[CURRENCIES]]");
    expect(toml).toContain('code = "USDC"');
    expect(toml).toContain("[STELLARFLOW.CONTRACTS]");
    expect(toml).toContain('oracle = "CABC"');
    expect(toml).toContain("[[STELLARFLOW.ANCHORS]]");
    expect(toml).toContain('protocols = ["SEP-24"]');
  });

  it("escapes quotes and newlines in string values", () => {
    const toml = renderStellarToml(
      baseConfig({
        documentation: {
          orgName: 'Stellar "Flow"\nInc',
          orgUrl: "https://stellarflow.io",
        },
      }),
    );
    expect(toml).toContain('ORG_NAME = "Stellar \\"Flow\\"\\nInc"');
  });

  it("caches the generated document and reuses it on the next call", async () => {
    const store = new Map<string, string>();
    let assetLoads = 0;
    const redis = {
      isOpen: true,
      async get(key: string) {
        return store.get(key) ?? null;
      },
      async setEx(key: string, _ttl: number, value: string) {
        store.set(key, value);
        return "OK";
      },
      async ttl() {
        return 3600;
      },
      async del(key: string) {
        return store.delete(key) ? 1 : 0;
      },
    };

    const service = new Sep01TomlService({
      getRedis: () => redis as never,
      loadAssets: async (): Promise<Sep01Currency[]> => {
        assetLoads += 1;
        return [{ code: "XLM", name: "Stellar Lumens" }];
      },
    });

    const first = await service.getToml();
    expect(first.cached).toBe(false);
    expect(store.has(SEP01_TOML_CACHE_KEY)).toBe(true);

    const second = await service.getToml();
    expect(second.cached).toBe(true);
    expect(second.toml).toBe(first.toml);
    expect(assetLoads).toBe(1);
  });

  it("falls back to generation when Redis is unavailable", async () => {
    const service = new Sep01TomlService({
      getRedis: () => null,
      loadAssets: async () => [{ code: "XLM", name: "Stellar Lumens" }],
    });
    const result = await service.getToml();
    expect(result.cached).toBe(false);
    expect(result.toml).toContain("NETWORK_PASSPHRASE");
  });

  it("serves GET /.well-known/stellar.toml as text/plain", async () => {
    const app = express();
    app.use("/.well-known", stellarTomlRouter);

    const response = await request(app).get("/.well-known/stellar.toml");

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("text/plain");
    expect(response.text).toContain("NETWORK_PASSPHRASE");
    expect(response.text).toContain("[DOCUMENTATION]");
  });
});
