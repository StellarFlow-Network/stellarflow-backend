/**
 * Database Seed Script
 * Populates baseline currencies and fake price history for local testing.
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const currencies = [
  {
    code: "NGN",
    name: "Nigerian Naira",
    symbol: "NGN",
    decimals: 2,
    isActive: true,
  },
  {
    code: "GHS",
    name: "Ghanaian Cedi",
    symbol: "GHS",
    decimals: 2,
    isActive: true,
  },
  {
    code: "KES",
    name: "Kenyan Shilling",
    symbol: "KES",
    decimals: 2,
    isActive: true,
  },
  {
    code: "USD",
    name: "US Dollar",
    symbol: "USD",
    decimals: 2,
    isActive: true,
  },
  {
    code: "EUR",
    name: "Euro",
    symbol: "EUR",
    decimals: 2,
    isActive: true,
  },
  {
    code: "GBP",
    name: "British Pound",
    symbol: "GBP",
    decimals: 2,
    isActive: true,
  },
] as const;

type SeedPriceConfig = {
  currency: string;
  source: string;
  baseRate: number;
  amplitude: number;
};

const seedPriceConfigs: SeedPriceConfig[] = [
  {
    currency: "NGN",
    source: "Seeded Demo Feed",
    baseRate: 1825,
    amplitude: 65,
  },
  {
    currency: "KES",
    source: "Seeded Demo Feed",
    baseRate: 23.8,
    amplitude: 1.2,
  },
  {
    currency: "GHS",
    source: "Seeded Demo Feed",
    baseRate: 3.15,
    amplitude: 0.22,
  },
];

function roundRate(value: number): string {
  return value.toFixed(6);
}

function buildSeedPriceEntries(totalEntries: number) {
  const now = new Date();

  return Array.from({ length: totalEntries }, (_, index) => {
    const config = seedPriceConfigs[index % seedPriceConfigs.length];
    const cycle = Math.floor(index / seedPriceConfigs.length);
    const wave = Math.sin((cycle + 1) / 2.3) * config.amplitude;
    const drift = ((cycle % 5) - 2) * (config.amplitude / 10);
    const rate = config.baseRate + wave + drift;
    const bid = rate * 0.9975;
    const ask = rate * 1.0025;
    const timestamp = new Date(now.getTime() - (totalEntries - index) * 60_000);

    return {
      currency: config.currency,
      rate: roundRate(rate),
      bid: roundRate(bid),
      ask: roundRate(ask),
      source: `${config.source} ${config.currency}`,
      timestamp,
    };
  });
}

async function seedCurrencies() {
  for (const currency of currencies) {
    await prisma.currency.upsert({
      where: { code: currency.code },
      update: {
        name: currency.name,
        symbol: currency.symbol,
        decimals: currency.decimals,
        isActive: currency.isActive,
      },
      create: currency,
    });
  }
}

async function seedPriceHistory() {
  const entries = buildSeedPriceEntries(50);

  for (const entry of entries) {
    await prisma.priceHistory.upsert({
      where: {
        currency_source_timestamp: {
          currency: entry.currency,
          source: entry.source,
          timestamp: entry.timestamp,
        },
      },
      update: {
        rate: entry.rate,
        bid: entry.bid,
        ask: entry.ask,
      },
      create: entry,
    });
  }

  return entries.length;
}

async function seedRelayers() {
  const relayers = [
    {
      name: "GHS Relayer",
      apiKey: "relayer-ghs-key",
      isActive: true,
      allowedAssets: ["GHS"],
    },
    {
      name: "NGN Relayer",
      apiKey: "relayer-ngn-key",
      isActive: true,
      allowedAssets: ["NGN"],
    },
    {
      name: "Admin Relayer",
      apiKey: "relayer-admin-key",
      isActive: true,
      allowedAssets: ["NGN", "GHS", "KES"],
    },
  ];

  for (const relayer of relayers) {
    await prisma.relayer.upsert({
      where: { apiKey: relayer.apiKey },
      update: {
        name: relayer.name,
        isActive: relayer.isActive,
        allowedAssets: relayer.allowedAssets,
      },
      create: relayer,
    });
  }

  return relayers.length;
}

async function main() {
  console.log("Seeding database with demo data...");

  await seedCurrencies();
  const insertedEntries = await seedPriceHistory();
  const insertedRelayers = await seedRelayers();

  console.log(`Seeded ${currencies.length} currencies.`);
  console.log(`Seeded ${insertedEntries} dummy price history entries.`);
  console.log(`Seeded ${insertedRelayers} relayers.`);
  console.log("Seeding completed.");
}

main()
  .catch((error) => {
    console.error("Seed failed:", error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
