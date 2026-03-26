/**
 * Database Seed Script
 * Populates initial currency data for price history tracking
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const currencies = [
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
  console.log("Seeding database...");

  for (const currency of currencies) {
    const existing = await prisma.currency.findUnique({
      where: { code: currency.code },
    });

    if (!existing) {
      await prisma.currency.create({
        data: currency,
      });
      console.log(`Created currency: ${currency.code}`);
    } else {
      console.log(`Currency already exists: ${currency.code}`);
    }
  }

  console.log("Seeding completed!");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
