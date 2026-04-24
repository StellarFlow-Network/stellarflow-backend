#!/usr/bin/env tsx

import dotenv from "dotenv";
import { Horizon, Keypair } from "@stellar/stellar-sdk";

dotenv.config();

function resolveHorizonUrl(network: string): string {
  if (process.env.STELLAR_HORIZON_URL) {
    return process.env.STELLAR_HORIZON_URL;
  }

  return network === "PUBLIC"
    ? "https://horizon.stellar.org"
    : "https://horizon-testnet.stellar.org";
}

function resolveGasAccountPublicKey(): string {
  const directPublicKey =
    process.env.GAS_ACCOUNT_PUBLIC_KEY || process.env.STELLAR_PUBLIC_KEY;

  if (directPublicKey) {
    return directPublicKey;
  }

  const secret =
    process.env.GAS_ACCOUNT_SECRET ||
    process.env.STELLAR_SECRET ||
    process.env.ORACLE_SECRET_KEY ||
    process.env.SOROBAN_ADMIN_SECRET;

  if (!secret) {
    throw new Error(
      "Missing gas account key. Set GAS_ACCOUNT_PUBLIC_KEY or GAS_ACCOUNT_SECRET (or STELLAR_SECRET).",
    );
  }

  return Keypair.fromSecret(secret).publicKey();
}

async function checkGasAccountBalance(): Promise<void> {
  const network = (process.env.STELLAR_NETWORK || "TESTNET").toUpperCase();
  const threshold = Number(process.env.GAS_ALERT_THRESHOLD_XLM || "10");

  if (!Number.isFinite(threshold) || threshold <= 0) {
    throw new Error("GAS_ALERT_THRESHOLD_XLM must be a positive number");
  }

  const horizonUrl = resolveHorizonUrl(network);
  const publicKey = resolveGasAccountPublicKey();

  const server = new Horizon.Server(horizonUrl);
  const account = await server.loadAccount(publicKey);
  const native = account.balances.find((b) => b.asset_type === "native");
  const xlmBalance = native ? Number(native.balance) : 0;

  if (!Number.isFinite(xlmBalance)) {
    throw new Error("Unable to parse native XLM balance from Horizon response");
  }

  const now = new Date().toISOString();

  if (xlmBalance < threshold) {
    console.error(
      `ALERT ${now}: Gas Account balance is low (${xlmBalance.toFixed(7)} XLM). Threshold: ${threshold.toFixed(2)} XLM. Account: ${publicKey}`,
    );
    process.exitCode = 2;
    return;
  }

  console.log(
    `OK ${now}: Gas Account balance is healthy (${xlmBalance.toFixed(7)} XLM). Threshold: ${threshold.toFixed(2)} XLM.`,
  );
}

checkGasAccountBalance().catch((error) => {
  console.error("Failed to check Gas Account balance:", error);
  process.exit(1);
});
