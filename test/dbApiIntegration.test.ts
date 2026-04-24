import assert from "node:assert";
import http from "node:http";
import { AddressInfo } from "node:net";
import dotenv from "dotenv";
import app from "../src/app";
import prisma from "../src/lib/prisma";

dotenv.config();

const API_KEY = process.env.API_KEY || "test-integration-api-key";
const STELLAR_SECRET = process.env.STELLAR_SECRET || "test-integration-secret";

process.env.API_KEY = API_KEY;
process.env.STELLAR_SECRET = STELLAR_SECRET;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL is required for integration tests. Set it in .env or the environment.",
  );
}

async function getJson(url: string, headers: Record<string, string>) {
  return new Promise<{ statusCode: number; body: unknown }>(
    (resolve, reject) => {
      const req = http.request(url, { method: "GET", headers }, (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          try {
            const body = JSON.parse(data);
            resolve({ statusCode: res.statusCode ?? 0, body });
          } catch (error) {
            reject(error);
          }
        });
      });

      req.on("error", reject);
      req.end();
    },
  );
}

async function runTest() {
  const server = app.listen(0);
  const address = server.address() as AddressInfo | null;
  if (!address) {
    throw new Error("Failed to start test server");
  }

  const port = address.port;
  const currency = "TEST";
  const sourceName = `integration-test-${Date.now()}`;
  const timestamp = new Date().toISOString();
  let createdRecordId: number | null = null;

  try {
    await prisma.currency.upsert({
      where: { code: currency },
      update: {
        name: "Integration Test Currency",
        symbol: "TST",
        decimals: 2,
        isActive: false,
      },
      create: {
        code: currency,
        name: "Integration Test Currency",
        symbol: "TST",
        decimals: 2,
        isActive: false,
      },
    });

    const created = await prisma.priceHistory.create({
      data: {
        currency,
        rate: "123.45",
        source: sourceName,
        timestamp: new Date(timestamp),
      },
    });

    createdRecordId = created.id;

    const url = `http://127.0.0.1:${port}/api/v1/history/${currency}?from=${encodeURIComponent(
      timestamp,
    )}&to=${encodeURIComponent(timestamp)}`;

    const { statusCode, body } = await getJson(url, {
      "x-api-key": API_KEY,
      "Content-Type": "application/json",
    });

    assert.strictEqual(statusCode, 200, `Expected 200, got ${statusCode}`);
    assert.strictEqual((body as any).success, true);
    assert.strictEqual((body as any).asset, currency);
    assert.strictEqual((body as any).range, "custom");
    assert.ok(
      Array.isArray((body as any).data),
      "Expected response data to be an array",
    );
    assert.strictEqual((body as any).data.length, 1);
    assert.strictEqual((body as any).data[0].source, sourceName);
    assert.strictEqual((body as any).data[0].rate, 123.45);
    assert.strictEqual((body as any).data[0].timestamp, timestamp);

    console.log("✅ DB-to-API integration test passed.");
  } finally {
    if (createdRecordId !== null) {
      await prisma.priceHistory.delete({ where: { id: createdRecordId } });
    }

    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });

    await prisma.$disconnect();
  }
}

runTest().catch((error) => {
  console.error("DB-to-API integration test failed:", error);
  process.exit(1);
});
