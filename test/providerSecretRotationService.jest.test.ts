import axios from "axios";
import { ProviderSecretRotationService } from "../src/services/providerSecretRotationService";

jest.mock("axios");

const mockedAxios = axios as jest.Mocked<typeof axios>;

describe("ProviderSecretRotationService", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    jest.useRealTimers();
    mockedAxios.get.mockReset();

    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
  });

  it("uses a 24-hour rotation interval by default", () => {
    const service = new ProviderSecretRotationService({
      secretManagerUrl: "https://example.test/secrets",
      secretKeys: ["VTPASS_API_KEY"],
    });

    expect(service.getStatus().rotationIntervalMs).toBe(24 * 60 * 60 * 1000);
  });

  it("fetches on startup and rotates keys on each interval", async () => {
    jest.useFakeTimers();

    mockedAxios.get
      .mockResolvedValueOnce({
        data: {
          secrets: {
            VTPASS_API_KEY: "vtpass-key-1",
            BINANCE_API_KEY: "binance-key-1",
          },
        },
      } as any)
      .mockResolvedValueOnce({
        data: {
          secrets: {
            VTPASS_API_KEY: "vtpass-key-2",
            BINANCE_API_KEY: "binance-key-2",
          },
        },
      } as any);

    const service = new ProviderSecretRotationService({
      secretManagerUrl: "https://example.test/secrets",
      secretManagerToken: "secret-token",
      secretKeys: ["VTPASS_API_KEY", "BINANCE_API_KEY"],
      rotationIntervalMs: 1_000,
      requestTimeoutMs: 5_000,
    });

    await service.start();

    expect(process.env.VTPASS_API_KEY).toBe("vtpass-key-1");
    expect(process.env.BINANCE_API_KEY).toBe("binance-key-1");
    expect(mockedAxios.get).toHaveBeenCalledTimes(1);
    expect(mockedAxios.get).toHaveBeenNthCalledWith(
      1,
      "https://example.test/secrets",
      {
        headers: {
          Accept: "application/json",
          Authorization: "Bearer secret-token",
          "X-Vault-Token": "secret-token",
        },
        timeout: 5_000,
      },
    );

    await jest.advanceTimersByTimeAsync(1_000);

    expect(mockedAxios.get).toHaveBeenCalledTimes(2);
    expect(process.env.VTPASS_API_KEY).toBe("vtpass-key-2");
    expect(process.env.BINANCE_API_KEY).toBe("binance-key-2");

    service.stop();
    expect(service.getStatus().isRunning).toBe(false);
  });

  it("extracts keys from Vault-style data.data payload", async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: {
        data: {
          data: {
            VTPASS_API_KEY: "vault-vtpass-key",
          },
        },
      },
    } as any);

    const service = new ProviderSecretRotationService({
      secretManagerUrl: "https://vault.example/v1/secret/data/providers",
      secretKeys: ["VTPASS_API_KEY"],
    });

    await service.rotateOnce("startup");

    expect(process.env.VTPASS_API_KEY).toBe("vault-vtpass-key");
  });

  it("extracts keys from Doppler-style secrets array payload", async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: {
        secrets: [
          {
            name: "BINANCE_API_KEY",
            computed: "doppler-binance-key",
          },
          {
            name: "VTPASS_API_KEY",
            raw: "doppler-vtpass-key",
          },
        ],
      },
    } as any);

    const service = new ProviderSecretRotationService({
      secretManagerUrl: "https://doppler.example/v3/configs/config/secrets",
      secretKeys: ["BINANCE_API_KEY", "VTPASS_API_KEY"],
    });

    await service.rotateOnce("startup");

    expect(process.env.BINANCE_API_KEY).toBe("doppler-binance-key");
    expect(process.env.VTPASS_API_KEY).toBe("doppler-vtpass-key");
  });

  it("does not start polling when secret-manager URL is missing", async () => {
    jest.useFakeTimers();

    const service = new ProviderSecretRotationService({
      secretManagerUrl: "",
      secretKeys: ["VTPASS_API_KEY"],
      rotationIntervalMs: 1_000,
    });

    await service.start();
    await jest.advanceTimersByTimeAsync(3_000);

    expect(service.getStatus().isRunning).toBe(false);
    expect(mockedAxios.get).not.toHaveBeenCalled();
  });
});