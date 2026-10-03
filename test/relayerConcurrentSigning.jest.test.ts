/**
 * Relayer concurrent signing workers — end-to-end stress test (issue #986).
 *
 * Concurrency path under test (mirrors `StellarService.executeGovernanceProposal`
 * / `submitBatchedPriceUpdates`, the repo's production signing path):
 *   1. 500 signing workers are started at the same time.
 *   2. Each worker allocates the next account sequence from the shared
 *      `SequenceManager` singleton, which serialises per-account access through
 *      an async mutex and only falls back to Horizon on a cache miss.
 *   3. The worker builds a real Stellar transaction for that sequence, signs its
 *      32-byte hash through the `ISigner` contract (backed here by
 *      `LocalSignerService` with a deterministic test key) and decorates the
 *      envelope with the resulting `xdr.DecoratedSignature`.
 *   4. The signed envelope is published to the relayer's lock-free submission
 *      queue (`LockFreeIngestionChannel`, reached through
 *      `UnifiedIngestionSystem`).
 *   5. The queue is drained and every envelope is submitted to a deterministic
 *      in-memory RPC ledger that rejects duplicate sequences ("tx_bad_seq").
 *
 * Why: the existing suites cover the queue primitives
 * (`test/lockFreeRingBuffer.test.ts`, `test/backpressure.test.ts`) and a single
 * signer backend (`test/pkcs11Signer.jest.test.ts`) in isolation, but nothing
 * exercises concurrent sequence allocation together with signing and submission
 * accounting. That combined path is exactly where sequence collisions and
 * silently dropped transactions would surface.
 *
 * No network access is used: the Horizon server consumed by `SequenceManager` is
 * replaced by a stub, and the submission target is the in-memory ledger below.
 */

import {
  Account,
  Asset,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";

import { createSigner } from "../src/signer/signer.factory";
import { LocalSignerService } from "../src/signer/local-signer.service";
import type { ISigner } from "../src/signer/signer.interface";
import { sequenceManager } from "../src/services/sequence-manager";
import {
  createIngestionSystem,
  type UnifiedIngestionSystem,
} from "../src/queue/ingestionIntegration";
import { PacketPriority } from "../src/queue/backpressure";
import type { IngestionPacket } from "../src/queue/backpressure";
import stellarProvider from "../src/lib/stellarProvider";

// Replace the Horizon/RPC singleton with a deterministic in-memory stub before
// any module that depends on it (SequenceManager) is evaluated.
jest.mock("../src/lib/stellarProvider", () => ({
  __esModule: true,
  default: { getServer: jest.fn() },
}));

const REQUESTS = 500;
const CHANNEL = "relayer-signing";
const LEDGER_SEQUENCE = 5_000_000n;
const TRANSIENT_FAILURE_EVERY = 37;
const MAX_SIGN_ATTEMPTS = 3;

// Deterministic relayer key (32-byte Ed25519 seed) — test-only, never funded.
const relayerKeypair = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 0x42));
const RELAYER_SECRET = relayerKeypair.secret();
const RELAYER_PUBLIC = relayerKeypair.publicKey();

interface SignedSubmission {
  requestId: number;
  sequence: string;
  txHash: string;
  envelopeXdr: string;
  status: "QUEUED_FOR_RPC";
}

/**
 * In-memory stand-in for the RPC/ledger submission endpoint. It enforces the
 * ledger's sequence invariant: a sequence may only be committed once, so any
 * duplicate allocation is counted and reported as a collision.
 */
class FakeRpcLedger {
  private readonly committed = new Set<string>();
  readonly accepted: SignedSubmission[] = [];
  collisions = 0;

  submit(submission: SignedSubmission): void {
    if (this.committed.has(submission.sequence)) {
      this.collisions += 1;
      throw new Error(
        `tx_bad_seq: sequence ${submission.sequence} was already committed`,
      );
    }
    this.committed.add(submission.sequence);
    this.accepted.push(submission);
  }

  get submittedCount(): number {
    return this.accepted.length;
  }
}

describe("Relayer concurrent signing workers (e2e stress)", () => {
  const mockedProvider = stellarProvider as unknown as { getServer: jest.Mock };

  let system: UnifiedIngestionSystem;
  let signer: ISigner;
  let ledger: FakeRpcLedger;

  beforeAll(() => {
    mockedProvider.getServer.mockReturnValue({
      loadAccount: async () => ({
        sequenceNumber: () => LEDGER_SEQUENCE.toString(),
      }),
    });
  });

  beforeEach(() => {
    // Reset the per-account cache so each run starts from the stubbed ledger state.
    sequenceManager.invalidate();
    system = createIngestionSystem({
      useLockFree: true,
      useWorkerThreads: false,
      ringBufferConfig: {
        capacity: 1024,
        enableMetrics: true,
        enableBatching: true,
        batchSize: 64,
      },
    });
    signer = createSigner({ backend: "local", localSecret: RELAYER_SECRET });
    ledger = new FakeRpcLedger();
  });

  afterEach(async () => {
    await system.shutdown();
  });

  it(
    "signs and queues 500 concurrent requests with strictly sequential, collision-free sequences",
    async () => {
      expect(signer).toBeInstanceOf(LocalSignerService);
      await expect(signer.getPublicKey()).resolves.toBe(RELAYER_PUBLIC);

      const submissions: SignedSubmission[] = [];
      const failures: Array<{ requestId: number; error: string }> = [];
      const publicKeypair = Keypair.fromPublicKey(RELAYER_PUBLIC);
      let verifiedSignatures = 0;
      let decoratedEnvelopes = 0;
      let totalAttempts = 0;
      let retries = 0;

      const runWorker = async (requestId: number): Promise<void> => {
        // 1. Allocate the next sequence for this account (mutex-serialised).
        const sequence = await sequenceManager.getNextSequence(RELAYER_PUBLIC);

        // 2. Build the real transaction this worker has been asked to relay.
        const account = new Account(RELAYER_PUBLIC, sequence);
        const tx = new TransactionBuilder(account, {
          fee: "100",
          networkPassphrase: Networks.TESTNET,
        })
          .addOperation(
            Operation.payment({
              destination: RELAYER_PUBLIC,
              asset: Asset.native(),
              amount: "1",
            }),
          )
          .setTimeout(180)
          .build();

        const txHash = tx.hash();
        const shouldFailFirstAttempt = requestId % TRANSIENT_FAILURE_EVERY === 0;

        // 3. Sign the transaction hash with a bounded retry budget.
        const signWithRetry = async (): Promise<Buffer | null> => {
          for (let attempt = 1; attempt <= MAX_SIGN_ATTEMPTS; attempt += 1) {
            totalAttempts += 1;
            try {
              if (shouldFailFirstAttempt && attempt === 1) {
                throw new Error("simulated transient signer failure");
              }
              const candidate = await signer.sign(txHash);
              if (!publicKeypair.verify(txHash, candidate)) {
                throw new Error("signature did not verify against the relayer key");
              }
              return candidate;
            } catch (error) {
              if (attempt >= MAX_SIGN_ATTEMPTS) {
                failures.push({
                  requestId,
                  error: error instanceof Error ? error.message : String(error),
                });
                return null;
              }
              retries += 1;
            }
          }
          return null;
        };

        const signature = await signWithRetry();
        if (signature === null) {
          return;
        }

        verifiedSignatures += 1;

        // 4. Decorate the envelope exactly as the relayer does before submission.
        tx.signatures.push(
          new xdr.DecoratedSignature({
            hint: publicKeypair.signatureHint(),
            signature,
          }),
        );
        decoratedEnvelopes += 1;

        const submission: SignedSubmission = {
          requestId,
          sequence,
          txHash: txHash.toString("hex"),
          envelopeXdr: tx.toEnvelope().toXDR("base64"),
          status: "QUEUED_FOR_RPC",
        };

        // 5. Publish the signed envelope to the lock-free submission queue.
        const packet: IngestionPacket = {
          priority: PacketPriority.CRITICAL,
          data: submission,
          timestamp: Date.now(),
        };

        const enqueued = await system.enqueue(packet, CHANNEL);
        if (!enqueued) {
          failures.push({ requestId, error: "submission queue rejected packet" });
          return;
        }

        submissions.push(submission);
      };

      // 6. Fire the whole batch concurrently and wait for every worker.
      await Promise.all(
        Array.from({ length: REQUESTS }, (_, requestId) => runWorker(requestId)),
      );

      // 7. Drain the queue and submit every envelope to the fake RPC ledger.
      const drained: SignedSubmission[] = [];
      while (system.getQueueLength(CHANNEL) > 0) {
        const packet = await system.dequeue(CHANNEL);
        if (packet) {
          drained.push(packet.data as SignedSubmission);
        }
      }

      const submissionErrors: string[] = [];
      for (const submission of drained) {
        try {
          ledger.submit(submission);
        } catch (error) {
          submissionErrors.push(
            error instanceof Error ? error.message : String(error),
          );
        }
      }

      // 8. 100% of the generated transactions were signed and queued.
      expect(failures).toEqual([]);
      expect(submissions).toHaveLength(REQUESTS);
      expect(verifiedSignatures).toBe(REQUESTS);
      expect(decoratedEnvelopes).toBe(REQUESTS);
      expect(drained).toHaveLength(REQUESTS);
      expect(drained.every((entry) => entry.status === "QUEUED_FOR_RPC")).toBe(true);
      expect(drained.every((entry) => entry.envelopeXdr.length > 0)).toBe(true);

      const signedByRequestId = new Map<number, SignedSubmission>(
        submissions.map((entry): [number, SignedSubmission] => [
          entry.requestId,
          entry,
        ]),
      );
      for (const entry of drained) {
        const signed = signedByRequestId.get(entry.requestId);
        expect(signed).toBeDefined();
        expect(entry.txHash).toBe(signed!.txHash);
        expect(entry.envelopeXdr).toBe(signed!.envelopeXdr);
      }

      // 9. Sequences are unique and strictly sequential — no collisions.
      const sequences = submissions.map((entry) => BigInt(entry.sequence));
      const uniqueSequences = new Set(sequences.map((value) => value.toString()));
      expect(uniqueSequences.size).toBe(REQUESTS);

      const sorted = [...sequences].sort((left, right) =>
        left < right ? -1 : left > right ? 1 : 0,
      );
      expect(sorted[0]).toBe(LEDGER_SEQUENCE);
      expect(sorted[sorted.length - 1]).toBe(
        LEDGER_SEQUENCE + BigInt(REQUESTS - 1),
      );
      for (let index = 1; index < sorted.length; index += 1) {
        expect(sorted[index]! - sorted[index - 1]!).toBe(1n);
      }

      // Only one Horizon sync was needed; every later allocation was local.
      expect(mockedProvider.getServer).toHaveBeenCalledTimes(1);

      // 10. The queue drained cleanly and the RPC stub saw no collisions.
      expect(system.getQueueLength(CHANNEL)).toBe(0);
      expect(submissionErrors).toEqual([]);
      expect(ledger.collisions).toBe(0);
      expect(ledger.submittedCount).toBe(REQUESTS);

      const metrics = await system.getMetrics();
      expect(metrics.aggregate.totalEnqueued).toBe(REQUESTS);
      expect(metrics.aggregate.totalDequeued).toBe(REQUESTS);
      expect(metrics.aggregate.totalFailures).toBe(0);

      // 11. Failure/retry accounting stays bounded.
      const injectedFailures = Array.from({ length: REQUESTS }, (_, index) => index)
        .filter((index) => index % TRANSIENT_FAILURE_EVERY === 0).length;
      expect(injectedFailures).toBeGreaterThan(0);
      expect(retries).toBe(injectedFailures);
      expect(totalAttempts).toBe(REQUESTS + injectedFailures);
      expect(totalAttempts).toBeLessThanOrEqual(REQUESTS * MAX_SIGN_ATTEMPTS);
    },
    60_000,
  );
});
