import test from "node:test";
import assert from "node:assert/strict";
import {
  parseEvmCollateralLocked,
  parseSolanaCollateralLocked,
} from "../src/services/collateralLockedEvent.ts";

test("normalizes EVM collateral lock fields for the mint queue", () => {
  const event = parseEvmCollateralLocked("137", {
    transactionHash: "0xlock",
    tokenAmount: 25n,
    fromAddress: "0xfrom",
    destinationChainId:  StellarChain.SOROBAN,
    destinationAddress: "GDEST",
  });
  assert.equal(event.chainType, "EVM");
  assert.equal(event.tokenAmount, "25");
  assert.equal(event.destinationChainId, "150");
});

test("accepts only explicitly tagged Solana lock logs", () => {
  const fields = {
    transactionHash: "solana-signature",
    tokenAmount: "900",
    fromAddress: "SOLFROM",
    destinationChainId: "150",
    destinationAddress: "GDEST",
  };
  assert.equal(parseSolanaCollateralLocked("solana", "Program log: unrelated"), null);
  assert.equal(
    parseSolanaCollateralLocked("solana", `COLLATERAL_LOCKED:${JSON.stringify(fields)}`)?.tokenAmount,
    "900",
  );
});

test("rejects incomplete EVM lock events", () => {
  assert.throws(() =>
    parseEvmCollateralLocked("1", {
      transactionHash: "tx",
      tokenAmount: "",
      fromAddress: "from",
      destinationChainId: 150,
      destinationAddress: "to",
    }),
  );
});

const StellarChain = { SOROBAN: 150 } as const;
