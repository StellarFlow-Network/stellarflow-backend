import prisma from "../lib/prisma";
import { getIO } from "../lib/socket";

export class ArbitrageScanner {
  private static scanning = false;
  private static scanInterval: NodeJS.Timeout | null = null;
  private static readonly MIN_PROFIT_MARGIN_BPS = 50; // 0.5% margin

  public static start() {
    if (this.scanning) return;
    this.scanning = true;
    
    // Run every minute
    this.scanInterval = setInterval(async () => {
      try {
        await this.scan();
      } catch (err) {
        console.error("[ArbitrageScanner] Error during scan:", err);
      }
    }, 60000);
    
    console.log("🤖 ArbitrageScanner started");
  }

  public static stop() {
    if (this.scanInterval) {
      clearInterval(this.scanInterval);
      this.scanInterval = null;
    }
    this.scanning = false;
    console.log("🤖 ArbitrageScanner stopped");
  }

  private static async scan() {
    // 1. Fetch current external prices (PriceHistory - latest per currency)
    const activeCurrencies = await prisma.currency.findMany({
      where: { isActive: true },
    });
    
    for (const currency of activeCurrencies) {
      const latestPrice = await prisma.priceHistory.findFirst({
        where: { currency: currency.code },
        orderBy: { timestamp: "desc" },
      });

      if (!latestPrice) continue;

      const externalRate = parseFloat(latestPrice.rate.toString());

      // 2. Fetch internal AMM pool prices / stats
      // Simulating a fetch from PoolVolumeAnalytics or an internal matching engine
      // Since AMM pools and internal rate logic aren't fully specified, we'll mock the internal rate
      // by pulling the 1hr average or simulated pool price.
      
      const internalStats = await prisma.hourlyStats.findFirst({
        where: { currency: currency.code },
        orderBy: { hour: "desc" },
      });

      if (!internalStats) continue;

      const internalRate = parseFloat(internalStats.averageRate.toString());

      // 3. Calculate margin
      const marginRaw = Math.abs(externalRate - internalRate);
      const marginBps = (marginRaw / externalRate) * 10000;

      if (marginBps >= this.MIN_PROFIT_MARGIN_BPS) {
        // Arbitrage Opportunity Detected
        const opportunity = {
          currency: currency.code,
          externalRate,
          internalRate,
          marginBps: Math.round(marginBps),
          timestamp: new Date().toISOString(),
        };

        console.log(`⚡ Arbitrage Opportunity Detected: ${JSON.stringify(opportunity)}`);

        // Emit real-time alert over WebSocket
        try {
          const io = getIO();
          io.emit("ARBITRAGE_DETECTED", opportunity);
        } catch (e) {
          // io not initialized yet
        }
        
        // Optionally log to an analytics table in DB if it existed
      }
    }
  }
}
