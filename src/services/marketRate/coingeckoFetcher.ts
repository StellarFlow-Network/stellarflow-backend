import axios from "axios";

export class CoinGeckoFetcher {
  private static readonly API_URL = "https://api.coingecko.com/api/v3/simple/price?ids=stellar&vs_currencies=usd";

  /**
   * Fetches the current XLM/USD price from CoinGecko.
   * @returns The price as a number (e.g., 0.12 for 1 XLM = $0.12)
   * @throws Error if the fetch fails or the response is invalid
   */
  static async fetchXlmUsdPrice(): Promise<number> {
    const response = await axios.get(CoinGeckoFetcher.API_URL);
    if (
      response.data &&
      response.data.stellar &&
      typeof response.data.stellar.usd === "number"
    ) {
      return response.data.stellar.usd;
    }
    throw new Error("Invalid response from CoinGecko API");
  }
}
