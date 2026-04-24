import assert from "node:assert";
import http from "node:http";
import { AddressInfo } from "node:net";

type JsonResponse = {
  statusCode: number;
  body: any;
};

async function requestJson(
  port: number,
  path: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {},
): Promise<JsonResponse> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: options.method || "GET",
        headers: options.headers,
      },
      (response) => {
        let rawBody = "";

        response.on("data", (chunk) => {
          rawBody += chunk;
        });

        response.on("end", () => {
          try {
            resolve({
              statusCode: response.statusCode ?? 0,
              body: JSON.parse(rawBody),
            });
          } catch (error) {
            reject(error);
          }
        });
      },
    );

    request.on("error", reject);

    if (options.body) {
      request.write(options.body);
    }

    request.end();
  });
}

describe("admin lockdown route", () => {
  const originalEnv = { ...process.env };
  let app: typeof import("../src/app").default;
  let setLockdownState: typeof import("../src/state/appState").setLockdownState;
  let assertSigningAllowed: typeof import("../src/state/appState").assertSigningAllowed;

  beforeAll(async () => {
    const { Keypair } = await import("@stellar/stellar-sdk");

    process.env.API_KEY = "test-api-key";
    process.env.ADMIN_API_KEY = "test-admin-key";
    process.env.REDIS_URL = "";
    process.env.SOROBAN_ADMIN_SECRET = Keypair.random().secret();

    ({ default: app } = await import("../src/app"));
    ({ setLockdownState, assertSigningAllowed } = await import(
      "../src/state/appState"
    ));
  });

  beforeEach(async () => {
    await setLockdownState(false);
  });

  afterAll(async () => {
    await setLockdownState(false);

    for (const envKey of Object.keys(process.env)) {
      if (!(envKey in originalEnv)) {
        delete process.env[envKey];
      }
    }

    Object.assign(process.env, originalEnv);
  });

  it("toggles lockdown on and off", async () => {
    const server = app.listen(0);
    const address = server.address() as AddressInfo;

    try {
      const enableResponse = await requestJson(address.port, "/api/admin/lockdown", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": process.env.API_KEY as string,
          "x-admin-key": process.env.ADMIN_API_KEY as string,
        },
        body: JSON.stringify({ reason: "incident response" }),
      });

      assert.strictEqual(enableResponse.statusCode, 200);
      assert.strictEqual(enableResponse.body.success, true);
      assert.strictEqual(enableResponse.body.data.isLocked, true);
      assert.strictEqual(enableResponse.body.data.reason, "incident response");

      await assert.rejects(() => assertSigningAllowed(), /lockdown/i);

      const disableResponse = await requestJson(
        address.port,
        "/api/admin/lockdown",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": process.env.API_KEY as string,
            "x-admin-key": process.env.ADMIN_API_KEY as string,
          },
          body: JSON.stringify({}),
        },
      );

      assert.strictEqual(disableResponse.statusCode, 200);
      assert.strictEqual(disableResponse.body.success, true);
      assert.strictEqual(disableResponse.body.data.isLocked, false);

      await assert.doesNotReject(() => assertSigningAllowed());
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    }
  });

  it("rejects requests without admin credentials", async () => {
    const server = app.listen(0);
    const address = server.address() as AddressInfo;

    try {
      const response = await requestJson(address.port, "/api/admin/lockdown", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": process.env.API_KEY as string,
        },
        body: JSON.stringify({}),
      });

      assert.strictEqual(response.statusCode, 403);
      assert.strictEqual(response.body.success, false);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    }
  });
});

