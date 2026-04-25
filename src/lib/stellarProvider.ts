import { Horizon } from "@stellar/stellar-sdk";
import dotenv from "dotenv";

dotenv.config();

const network = process.env.STELLAR_NETWORK || "TESTNET";
const horizonUrl =
  network === "PUBLIC"
    ? "https://horizon.stellar.org"
    : "https://horizon-testnet.stellar.org";

const stellarProvider = new Horizon.Server(horizonUrl);

export default stellarProvider;
