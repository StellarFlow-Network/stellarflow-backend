/**
 * Database Seed Script
 * Populates initial currency data for price history tracking
 */

import { PrismaClient } from "@prisma/client";
import { logger } from "../src/lib/logger";

const prisma = new PrismaClient();

const currencies = [
  {
    code: "NGN",
    name: "Nigerian Naira",
    symbol: "₦",
    decimals: 2,
    isActive: true,
  },
  {
    code: "GHS",
    name: "Ghanaian Cedi",
    symbol: "₵",
    decimals: 2,
    isActive: true,
  },
  {
    code: "KES",
    name: "Kenyan Shilling",
    symbol: "KSh",
    decimals: 2,
    isActive: true,
  },
  {
    code: "USD",
    name: "US Dollar",
    symbol: "$",
    decimals: 2,
    isActive: true,
  },
  {
    code: "EUR",
    name: "Euro",
    symbol: "€",
    decimals: 2,
    isActive: true,
  },
  {
    code: "GBP",
    name: "British Pound",
    symbol: "£",
    decimals: 2,
    isActive: true,
  },
];

async function main() {
  logger.info("Seeding database...");

  for (const currency of currencies) {
    const existing = await prisma.currency.findUnique({
      where: { code: currency.code },
    });

    if (!existing) {
      await prisma.currency.create({
        data: currency,
      });
      logger.info(`Created currency: ${currency.code}`);
    } else {
      logger.info(`Currency already exists: ${currency.code}`);
    }
  }

  logger.info("Seeding completed!");
}

main()
  .catch((e) => {
    logger.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
