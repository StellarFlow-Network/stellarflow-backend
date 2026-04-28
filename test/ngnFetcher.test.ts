import assert from "node:assert/strict";
import axios from "axios";
import { NGNRateFetcher } from "../src/services/marketRate/ngnFetcher";

async function run() {
  const originalGet = axios.get;
  const savedEnv = {
    VTPASS_API_KEY: process.env.VTPASS_API_KEY,
    VTPASS_PUBLIC_KEY: process.env.VTPASS_PUBLIC_KEY,
    VTPASS_NGN_SERVICE_ID: process.env.VTPASS_NGN_SERVICE_ID,
    VTPASS_NGN_VARIATION_CODE: process.env.VTPASS_NGN_VARIATION_CODE,
  };

  try {
    process.env.VTPASS_API_KEY = "test-key";
    process.env.VTPASS_PUBLIC_KEY = "PK_test";
    process.env.VTPASS_NGN_SERVICE_ID = "test-service";
    process.env.VTPASS_NGN_VARIATION_CODE = "ref-usd";

    const fetcher = new NGNRateFetcher();

    axios.get = (async (url: string) => {
      if (url.includes("service-variations")) {
        return {
          data: {
            response_description: "000",
            content: {
              variations: [
                {
                  variation_code: "ref-usd",
                  name: "1 USD reference",
                  variation_amount: "1500.00",
                  fixedPrice: "Yes",
                },
              ],
            },
          },
        };
      }

      if (url.includes("api.coingecko.com")) {
        return {
          data: {
            stellar: {
              ngn: 300,
              usd: 0.2,
              last_updated_at: 1_774_464_561,
            },
          },
        };
      }

      if (url.includes("open.er-api.com")) {
        return {
          data: {
            result: "success",
            rates: {
              NGN: 7500,
            },
            time_last_update_unix: 1_774_396_951,
          },
        };
      }

      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof axios.get;

    const rate = await fetcher.fetchRate();
    const expectedRate = 300;

    assert.equal(rate.currency, "NGN");
    assert.equal(rate.rate, expectedRate);
    assert.equal(
      rate.source,
      "Median of 3 sources",
    );
  } finally {
    axios.get = originalGet;
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = val;
      }
    }
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
