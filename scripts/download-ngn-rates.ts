#!/usr/bin/env tsx

import { writeFileSync } from "fs";
import { Prisma, PriceHistory } from "@prisma/client";
import { prisma } from "../src/lib/prisma.js";

async function downloadNGNRates() {
  try {
    // Calculate date 30 days ago
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    console.log(
      `Fetching NGN rates from ${thirtyDaysAgo.toISOString()} to now...`,
    );

    // Query PriceHistory for NGN rates in the last 30 days
    const rates: PriceHistory[] = await prisma.priceHistory.findMany({
      where: {
        currency: "NGN",
        timestamp: {
          gte: thirtyDaysAgo,
        },
      },
      orderBy: {
        timestamp: "asc",
      },
    });

    if (rates.length === 0) {
      console.log("No NGN rates found in the last 30 days.");
      return;
    }

    console.log(`Found ${rates.length} NGN rate records.`);

    // Convert to CSV format
    const csvHeader = "timestamp,rate,source\n";
    const csvRows = rates.map(
      (rate) => `${rate.timestamp.toISOString()},${rate.rate},${rate.source}`,
    );
    const csvContent = csvHeader + csvRows.join("\n");

    // Write to file
    const filename = `ngn-rates-last-30-days-${new Date().toISOString().split("T")[0]}.csv`;
    writeFileSync(filename, csvContent);

    console.log(`NGN rates exported to ${filename}`);
    console.log(`Total records: ${rates.length}`);

    // Show some stats
    const ratesValues = rates.map((r: PriceHistory) =>
      parseFloat(r.rate.toString()),
    );
    const minRate = Math.min(...ratesValues);
    const maxRate = Math.max(...ratesValues);
    const avgRate =
      ratesValues.reduce((sum: number, rate: number) => sum + rate, 0) /
      ratesValues.length;

    console.log(
      `Rate range: ${minRate.toFixed(2)} - ${maxRate.toFixed(2)} NGN/XLM`,
    );
    console.log(`Average rate: ${avgRate.toFixed(2)} NGN/XLM`);
  } catch (error) {
    console.error("Error downloading NGN rates:", error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

// Run the script
downloadNGNRates();
