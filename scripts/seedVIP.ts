/**
 * Seed script to add initial VIP institutional IPs to the whitelist
 * Run with: npx tsx scripts/seedVIP.ts
 */

import prisma from "../src/lib/prisma";

async function seedVIP() {
  console.log("🌱 Seeding VIP whitelist...");

  // Example institutional IPs - Replace with actual institutional IPs
  const vipIPs = [
    {
      ipAddress: "192.168.1.100",
      label: "Binance Institutional",
      priority: 10,
      rateLimitOverride: 5000,
      notes: "Primary Binance trading server - High priority during volatility",
    },
    {
      ipAddress: "10.0.0.50",
      label: "Coinbase Prime",
      priority: 9,
      rateLimitOverride: 3000,
      notes: "Coinbase Prime oracle server",
    },
    {
      ipAddress: "172.16.0.25",
      label: "Kraken Institutional",
      priority: 8,
      rateLimitOverride: 2000,
      notes: "Kraken institutional API endpoint",
    },
  ];

  for (const ip of vipIPs) {
    try {
      const created = await prisma.iPWhitelist.create({
        data: ip,
      });
      console.log(`✅ Added: ${ip.label} (${ip.ipAddress}) - Priority: ${ip.priority}`);
    } catch (error: any) {
      if (error.code === "P2002") {
        console.log(`⚠️  Already exists: ${ip.label} (${ip.ipAddress})`);
      } else {
        console.error(`❌ Failed to add ${ip.label}:`, error);
      }
    }
  }

  console.log("\n✨ VIP whitelist seeding complete!");
  console.log("\n📊 View all VIP IPs:");
  console.log("   GET /api/vip/whitelist");
  console.log("\n📈 View VIP statistics:");
  console.log("   GET /api/vip/stats");

  await prisma.$disconnect();
}

seedVIP().catch((error) => {
  console.error("❌ Seeding failed:", error);
  process.exit(1);
});
