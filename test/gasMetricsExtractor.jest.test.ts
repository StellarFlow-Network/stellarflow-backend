/**
 * Issue #786 – extraction of CPU instruction counts and storage fee metrics.
 *
 * Fixtures are built with the real SDK XDR classes and round-tripped through
 * base64, so the tests exercise the same decode path an RPC payload takes
 * rather than hand-rolled mock objects.
 */
import { describe, it, expect } from "@jest/globals";
import {
  Account,
  Address,
  Contract,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  xdr,
} from "@stellar/stellar-sdk";

import {
  extractGasMetrics,
  extractResourceFeeBreakdown,
} from "../src/services/gasProfiler/gasMetricsExtractor";

const CONTRACT_ID = "CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE";
const SOURCE = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 7)).publicKey();

function buildSorobanData(
  overrides: {
    instructions?: number;
    diskReadBytes?: number;
    writeBytes?: number;
    resourceFee?: number;
  } = {},
): xdr.SorobanTransactionData {
  return new xdr.SorobanTransactionData({
    ext: new xdr.SorobanTransactionDataExt(0),
    resources: new xdr.SorobanResources({
      footprint: new xdr.LedgerFootprint({ readOnly: [], readWrite: [] }),
      instructions: overrides.instructions ?? 42_500_000,
      diskReadBytes: overrides.diskReadBytes ?? 6_400,
      writeBytes: overrides.writeBytes ?? 1_200,
    }),
    resourceFee: new xdr.Int64(overrides.resourceFee ?? 98_765),
  });
}

/** Builds an invoke-contract envelope and round-trips it through base64. */
function buildEnvelope(
  functionName: string,
  sorobanData: xdr.SorobanTransactionData | null = buildSorobanData(),
): xdr.TransactionEnvelope {
  const builder = new TransactionBuilder(new Account(SOURCE, "1"), {
    fee: "100000",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      new Contract(CONTRACT_ID).call(
        functionName,
        new Address(SOURCE).toScVal(),
        nativeToScVal(100, { type: "i128" }),
      ),
    )
    .setTimeout(30);

  if (sorobanData) builder.setSorobanData(sorobanData);

  return xdr.TransactionEnvelope.fromXDR(builder.build().toXDR(), "base64");
}

/** A classic manageData transaction, as the price-update path submits. */
function buildClassicEnvelope(): xdr.TransactionEnvelope {
  const tx = new TransactionBuilder(new Account(SOURCE, "1"), {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.manageData({ name: "NGN_PRICE", value: "1234.5" }))
    .setTimeout(30)
    .build();

  return xdr.TransactionEnvelope.fromXDR(tx.toXDR(), "base64");
}

function buildResult(feeCharged: number): xdr.TransactionResult {
  return new xdr.TransactionResult({
    feeCharged: new xdr.Int64(feeCharged),
    result: xdr.TransactionResultResult.txSuccess([]),
    ext: new xdr.TransactionResultExt(0),
  });
}

function buildMetaV3(fees?: {
  nonRefundable: number;
  refundable: number;
  rent: number;
}): xdr.TransactionMeta {
  const ext = fees
    ? new xdr.SorobanTransactionMetaExt(
        1,
        new xdr.SorobanTransactionMetaExtV1({
          ext: new xdr.ExtensionPoint(0),
          totalNonRefundableResourceFeeCharged: new xdr.Int64(
            fees.nonRefundable,
          ),
          totalRefundableResourceFeeCharged: new xdr.Int64(fees.refundable),
          rentFeeCharged: new xdr.Int64(fees.rent),
        }),
      )
    : new xdr.SorobanTransactionMetaExt(0);

  const meta = new xdr.TransactionMeta(
    3,
    new xdr.TransactionMetaV3({
      ext: new xdr.ExtensionPoint(0),
      txChangesBefore: [],
      operations: [],
      txChangesAfter: [],
      sorobanMeta: new xdr.SorobanTransactionMeta({
        ext,
        events: [],
        returnValue: xdr.ScVal.scvVoid(),
        diagnosticEvents: [],
      }),
    }),
  );

  return xdr.TransactionMeta.fromXDR(meta.toXDR("base64"), "base64");
}

/** Meta v4 wraps SorobanTransactionMetaV2 but exposes the same ext union. */
function buildMetaV4(rent: number): xdr.TransactionMeta {
  const meta = new xdr.TransactionMeta(
    4,
    new xdr.TransactionMetaV4({
      ext: new xdr.ExtensionPoint(0),
      txChangesBefore: [],
      operations: [],
      txChangesAfter: [],
      events: [],
      diagnosticEvents: [],
      sorobanMeta: new xdr.SorobanTransactionMetaV2({
        ext: new xdr.SorobanTransactionMetaExt(
          1,
          new xdr.SorobanTransactionMetaExtV1({
            ext: new xdr.ExtensionPoint(0),
            totalNonRefundableResourceFeeCharged: new xdr.Int64(1),
            totalRefundableResourceFeeCharged: new xdr.Int64(2),
            rentFeeCharged: new xdr.Int64(rent),
          }),
        ),
        returnValue: xdr.ScVal.scvVoid(),
      }),
    }),
  );

  return xdr.TransactionMeta.fromXDR(meta.toXDR("base64"), "base64");
}

describe("extractGasMetrics", () => {
  it("extracts CPU instructions and byte counts from the envelope resources", () => {
    const metrics = extractGasMetrics({
      txHash: "abc123",
      status: "SUCCESS",
      ledger: 55_000,
      createdAt: 1_700_000_000,
      envelopeXdr: buildEnvelope("swap"),
      resultXdr: buildResult(120_000),
      resultMetaXdr: buildMetaV3({
        nonRefundable: 50_000,
        refundable: 20_000,
        rent: 15_000,
      }),
    });

    expect(metrics).not.toBeNull();
    expect(metrics!.cpuInstructions).toBe(42_500_000);
    expect(metrics!.diskReadBytes).toBe(6_400);
    expect(metrics!.writeBytes).toBe(1_200);
    expect(metrics!.resourceFeeStroops).toBe(98_765n);
  });

  it("extracts the total fee charged and the storage rent split", () => {
    const metrics = extractGasMetrics({
      txHash: "abc123",
      envelopeXdr: buildEnvelope("swap"),
      resultXdr: buildResult(120_000),
      resultMetaXdr: buildMetaV3({
        nonRefundable: 50_000,
        refundable: 20_000,
        rent: 15_000,
      }),
    });

    expect(metrics!.feeChargedStroops).toBe(120_000n);
    expect(metrics!.nonRefundableFeeStroops).toBe(50_000n);
    expect(metrics!.refundableFeeStroops).toBe(20_000n);
    expect(metrics!.rentFeeStroops).toBe(15_000n);
  });

  it("classifies the invoked function and records the contract", () => {
    const metrics = extractGasMetrics({
      txHash: "abc123",
      envelopeXdr: buildEnvelope("swap"),
      resultXdr: buildResult(1),
      resultMetaXdr: buildMetaV3(),
    });

    expect(metrics!.txType).toBe("swap");
    expect(metrics!.functionName).toBe("swap");
    expect(metrics!.contractId).toBe(CONTRACT_ID);
  });

  it.each([
    ["deposit", "deposit"],
    ["withdraw", "withdraw"],
    ["add_liquidity", "deposit"],
    ["remove_liquidity", "withdraw"],
    ["swapExactIn", "swap"],
    ["harvest", "other"],
  ])("maps invoked function %s to type %s", (fn, expected) => {
    const metrics = extractGasMetrics({
      txHash: "h",
      envelopeXdr: buildEnvelope(fn),
      resultXdr: buildResult(1),
    });

    expect(metrics!.txType).toBe(expected);
  });

  it("applies deployment-specific alias overrides", () => {
    const metrics = extractGasMetrics(
      {
        txHash: "h",
        envelopeXdr: buildEnvelope("settle"),
        resultXdr: buildResult(1),
      },
      { aliases: { settle: "swap" } },
    );

    expect(metrics!.txType).toBe("swap");
  });

  it("reads the fee split from meta v4 as well as v3", () => {
    const metrics = extractGasMetrics({
      txHash: "abc123",
      envelopeXdr: buildEnvelope("swap"),
      resultXdr: buildResult(10),
      resultMetaXdr: buildMetaV4(4_321),
    });

    expect(metrics!.rentFeeStroops).toBe(4_321n);
  });

  it("defaults the fee split to zero when the meta extension is absent", () => {
    const metrics = extractGasMetrics({
      txHash: "abc123",
      envelopeXdr: buildEnvelope("swap"),
      resultXdr: buildResult(10),
      resultMetaXdr: buildMetaV3(),
    });

    expect(metrics!.rentFeeStroops).toBe(0n);
    expect(metrics!.nonRefundableFeeStroops).toBe(0n);
  });

  it("skips a classic transaction that has no Soroban resources", () => {
    const metrics = extractGasMetrics({
      txHash: "abc123",
      envelopeXdr: buildClassicEnvelope(),
      resultXdr: buildResult(100),
    });

    // Recording zeroes for an unmetered transaction would skew daily averages.
    expect(metrics).toBeNull();
  });

  it("skips a response with no transaction hash", () => {
    expect(
      extractGasMetrics({ envelopeXdr: buildEnvelope("swap") }),
    ).toBeNull();
  });

  it("skips a response with no envelope", () => {
    expect(extractGasMetrics({ txHash: "abc" })).toBeNull();
  });

  it("marks a failed transaction as unsuccessful but still records cost", () => {
    const metrics = extractGasMetrics({
      txHash: "abc123",
      status: "FAILED",
      envelopeXdr: buildEnvelope("swap"),
      resultXdr: buildResult(120_000),
    });

    // A failed Soroban call still consumes CPU and is still billed.
    expect(metrics!.successful).toBe(false);
    expect(metrics!.feeChargedStroops).toBe(120_000n);
  });

  it("converts the RPC createdAt from unix seconds", () => {
    const metrics = extractGasMetrics({
      txHash: "abc123",
      createdAt: 1_700_000_000,
      envelopeXdr: buildEnvelope("swap"),
      resultXdr: buildResult(1),
    });

    expect(metrics!.occurredAt.toISOString()).toBe("2023-11-14T22:13:20.000Z");
  });

  it("tags the sample source", () => {
    const submitted = extractGasMetrics(
      { txHash: "a", envelopeXdr: buildEnvelope("swap") },
      { source: "submission" },
    );

    expect(submitted!.source).toBe("submission");
    expect(
      extractGasMetrics({ txHash: "a", envelopeXdr: buildEnvelope("swap") })!
        .source,
    ).toBe("backfill");
  });

  it("reports zero fee when the result XDR is missing", () => {
    const metrics = extractGasMetrics({
      txHash: "abc",
      envelopeXdr: buildEnvelope("swap"),
    });

    expect(metrics!.feeChargedStroops).toBe(0n);
  });
});

describe("extractResourceFeeBreakdown", () => {
  it("returns zeroes for undefined meta", () => {
    expect(extractResourceFeeBreakdown(undefined)).toEqual({
      nonRefundableFeeStroops: 0n,
      refundableFeeStroops: 0n,
      rentFeeStroops: 0n,
    });
  });

  it("returns zeroes for a pre-Soroban meta version", () => {
    const meta = new xdr.TransactionMeta(0, []);

    expect(extractResourceFeeBreakdown(meta).rentFeeStroops).toBe(0n);
  });
});
