import { createHash } from "node:crypto";
import {
  assertProofRoot,
  foldProofPath,
  InvalidLedgerProofError,
  sha256,
} from "../src/services/sorobanStateProofService";

describe("Soroban state proof hashing", () => {
  it("folds sibling hashes in the declared direction", () => {
    const leaf = sha256(Buffer.from("entry"));
    const left = sha256(Buffer.from("left sibling"));
    const expected = createHash("sha256")
      .update(Buffer.concat([left, leaf]))
      .digest();

    expect(
      foldProofPath(leaf, [{ hash: left.toString("hex"), side: "left" }]),
    ).toEqual(expected);
  });

  it("rejects malformed siblings and unbounded proof paths", () => {
    const leaf = sha256(Buffer.from("entry"));
    expect(() => foldProofPath(leaf, [{ hash: "bad", side: "left" }])).toThrow(
      "32-byte hexadecimal",
    );
    expect(() =>
      foldProofPath(
        leaf,
        Array.from({ length: 257 }, () => ({
          hash: "00".repeat(32),
          side: "left",
        })),
      ),
    ).toThrow("invalid or too deep");
  });

  it("rejects a computed root that differs from the ledger header root", () => {
    expect(() =>
      assertProofRoot(Buffer.alloc(32), sha256(Buffer.from("wrong root"))),
    ).toThrow(InvalidLedgerProofError);
  });
});
