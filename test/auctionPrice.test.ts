import {
  VaultService,
  AUCTION_START_PREMIUM,
  AUCTION_DURATION_SECONDS,
  AUCTION_END_PRICE_RATIO,
} from "../src/services/vaultService";
import { VaultController } from "../src/controllers/vaultController";

let passed = 0;
let failed = 0;

function ok(description: string, condition: boolean, detail = "") {
  if (condition) {
    console.log(`  ✓ ${description}`);
    passed++;
  } else {
    console.log(`  ✗ ${description}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}

function close(description: string, actual: number, expected: number) {
  const tolerance = Math.max(Math.abs(expected) * 1e-9, 1e-12);
  const isClose =
    Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance;
  ok(description, isClose, `expected ${expected}, got ${actual}`);
}

type StubResponse = {
  statusCode: number;
  body: any;
  status: (code: number) => StubResponse;
  json: (payload: any) => StubResponse;
};

function stubResponse(): StubResponse {
  const res: StubResponse = {
    statusCode: 200,
    body: undefined,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(payload: any) {
      res.body = payload;
      return res;
    },
  };
  return res;
}

function stubRequest(query: Record<string, unknown>) {
  return { query } as any;
}

const ORACLE_XLM = 0.12;

async function run() {
  const service = VaultService.getInstance();

  console.log("🧪 Auction constants\n");
  close(
    "start premium is 1.10 (P_start = P_oracle * 1.10)",
    AUCTION_START_PREMIUM,
    1.1,
  );
  ok("window is 30 minutes", AUCTION_DURATION_SECONDS === 30 * 60);
  close("end ratio pins the floor", AUCTION_END_PRICE_RATIO, 0.5);

  console.log("\n🧪 VaultService auction curve\n");
  const quote = service.buildAuctionQuote("XLM", ORACLE_XLM, 0);
  close("P(0) = P_oracle * 1.10", quote.startPrice, ORACLE_XLM * 1.1);
  close("P(0) is the current price", quote.currentPrice, ORACLE_XLM * 1.1);
  close("floor = P_oracle * 0.50", quote.floorPrice, ORACLE_XLM * 0.5);
  close("window is 30 minutes", quote.durationSeconds, 1800);
  close(
    "k = ln(P_start / P_floor) / 1800",
    quote.decayConstant,
    Math.log((ORACLE_XLM * 1.1) / (ORACLE_XLM * 0.5)) / 1800,
  );

  const atWindow = service.buildAuctionQuote(
    "XLM",
    ORACLE_XLM,
    AUCTION_DURATION_SECONDS,
  );
  close("P(1800) reaches the floor", atWindow.currentPrice, ORACLE_XLM * 0.5);
  close(
    "remaining seconds at the end of the window",
    atWindow.remainingSeconds,
    0,
  );

  const halfway = service.calculateAuctionPrice(
    ORACLE_XLM,
    AUCTION_DURATION_SECONDS / 2,
  );
  close(
    "P(900) is the geometric mean of start and floor",
    halfway,
    Math.sqrt(ORACLE_XLM * 1.1 * (ORACLE_XLM * 0.5)),
  );

  const pastWindow = service.buildAuctionQuote("XLM", ORACLE_XLM, 9999);
  close(
    "elapsed past the window clamps to the floor",
    pastWindow.currentPrice,
    ORACLE_XLM * 0.5,
  );
  close("elapsed is clamped to 1800s", pastWindow.elapsedSeconds, 1800);

  const beforeStart = service.calculateAuctionPrice(ORACLE_XLM, -60);
  close(
    "negative elapsed clamps to the start price",
    beforeStart,
    ORACLE_XLM * 1.1,
  );

  let monotonic = true;
  let previous = Number.POSITIVE_INFINITY;
  for (let t = 0; t <= AUCTION_DURATION_SECONDS; t += 60) {
    const price = service.calculateAuctionPrice(ORACLE_XLM, t);
    if (!(price < previous)) monotonic = false;
    previous = price;
  }
  ok("price decays monotonically across the window", monotonic);

  let invalidPrice = false;
  try {
    service.buildAuctionQuote("XLM", 0, 0);
  } catch {
    invalidPrice = true;
  }
  ok("a zero oracle price is rejected", invalidPrice);

  let unknownAsset = false;
  try {
    await service.getAuctionPrice("NOPE", 0);
  } catch (error) {
    unknownAsset =
      error instanceof Error && error.message.includes("Price not available");
  }
  ok("an asset without an oracle feed rejects", unknownAsset);

  console.log("\n🧪 VaultController /auction-price\n");
  const controller = new VaultController();

  const missingAsset = stubResponse();
  await controller.getAuctionPrice(stubRequest({}), missingAsset);
  ok("missing asset responds 400", missingAsset.statusCode === 400);

  const badElapsed = stubResponse();
  await controller.getAuctionPrice(
    stubRequest({ asset: "XLM", elapsed: "-1" }),
    badElapsed,
  );
  ok("negative elapsed responds 400", badElapsed.statusCode === 400);

  const okResponse = stubResponse();
  await controller.getAuctionPrice(
    stubRequest({ asset: "XLM", elapsed: "900" }),
    okResponse,
  );
  ok("valid quote responds 200", okResponse.statusCode === 200);
  ok("quote reports the asset", okResponse.body?.data?.asset === "XLM");
  close(
    "quote current price matches P(900)",
    okResponse.body?.data?.currentPrice,
    halfway,
  );
  close(
    "quote start price matches P(0)",
    okResponse.body?.data?.startPrice,
    ORACLE_XLM * 1.1,
  );

  const missingFeed = stubResponse();
  await controller.getAuctionPrice(stubRequest({ asset: "NOPE" }), missingFeed);
  ok("unknown asset responds 404", missingFeed.statusCode === 404);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

await run();
