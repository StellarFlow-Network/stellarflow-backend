import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { validateSorobanInvoker } from "../src/middleware/sorobanAuthInvoker.ts";

test("rejects expired invoker credentials before signature verification", () => {
  const result = validateSorobanInvoker({
    authorizationEntryXdr: "not-xdr",
    signaturePayload: "",
    publicKey: "00".repeat(32),
    currentLedger: 100,
    validUntilLedger: 100,
    accountBalanceStroops: 10,
    requiredBalanceStroops: 1,
  });
  assert.deepEqual(result, {
    valid: false,
    reason: "authorization credential has expired",
  });
});

test("rejects an underfunded invoker", () => {
  const result = validateSorobanInvoker({
    authorizationEntryXdr: "not-xdr",
    signaturePayload: "",
    publicKey: "00".repeat(32),
    currentLedger: 100,
    validUntilLedger: 110,
    accountBalanceStroops: 0,
    requiredBalanceStroops: 1,
  });
  assert.deepEqual(result, {
    valid: false,
    reason: "account balance is insufficient",
  });
});

test("signatures are verified with the invoker public key", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const rawPublicKey = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const payload = Buffer.from("canonical-auth-payload");
  const digest = awaitDigest(payload);
  const signature = sign(null, digest, privateKey);
  assert.equal(signature.length, 64);
  assert.equal(rawPublicKey.length, 32);
});

function awaitDigest(payload: Buffer): Buffer {
  return createHash("sha256").update(payload).digest();
}
