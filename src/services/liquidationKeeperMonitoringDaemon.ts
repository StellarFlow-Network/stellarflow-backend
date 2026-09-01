import {
  Account,
  Contract,
  Keypair,
  rpc as SorobanRpc,
  Transaction,
  TransactionBuilder,
  xdr,
  nativeToScVal,
} from "@stellar/stellar-sdk";
import { assertSigningAllowed } from "../state/appState";
import { signer } from "../signer";
import stellarProvider from "../lib/stellarProvider";
import { getStellarNetworkPassphrase } from "../lib/stellarNetwork";
import type { VaultPosition } from "./yieldVaultLiquidationRiskService";

export interface VaultLedgerSnapshot {
  ledger: number;
  positions: VaultPosition[];
}

export interface VaultLedgerScanner {
  poll(ledgerCursor?: number): Promise<VaultLedgerSnapshot>;
}

export interface LiquidationContractCallPayload {
  contractId: string;
  method: string;
  args: xdr.ScVal[];
}

export interface LiquidationContractPayloadBuilder {
  build(position: VaultPosition): LiquidationContractCallPayload;
}

export interface LiquidationTransactionBroadcaster {
  broadcast(
    payload: LiquidationContractCallPayload,
    position: VaultPosition,
  ): Promise<string>;
}

export interface LiquidationKeeperDaemonOptions {
  intervalMs?: number;
  minimumHealthFactor?: number;
}

/** Polls vault ledgers and executes each newly observed undercollateralized position once. */
export class LiquidationKeeperMonitoringDaemon {
  private timer: ReturnType<typeof setInterval> | undefined;
  private polling = false;
  private ledgerCursor: number | undefined;
  private readonly processedPositions = new Set<string>();
  private readonly intervalMs: number;
  private readonly minimumHealthFactor: number;

  constructor(
    private readonly scanner: VaultLedgerScanner,
    private readonly payloadBuilder: LiquidationContractPayloadBuilder,
    private readonly broadcaster: LiquidationTransactionBroadcaster,
    options: LiquidationKeeperDaemonOptions = {},
  ) {
    this.intervalMs =
      options.intervalMs ??
      Number(process.env.LIQUIDATION_KEEPER_POLL_INTERVAL_MS ?? "5000");
    this.minimumHealthFactor = options.minimumHealthFactor ?? 1;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.poll(), this.intervalMs);
    void this.poll();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async poll(): Promise<number> {
    if (this.polling) return 0;
    this.polling = true;
    try {
      const snapshot = await this.scanner.poll(this.ledgerCursor);
      this.ledgerCursor = snapshot.ledger;
      let submitted = 0;

      for (const position of snapshot.positions) {
        if (position.healthFactor >= this.minimumHealthFactor) continue;
        if (this.processedPositions.has(position.id)) continue;

        const payload = this.payloadBuilder.build(position);
        try {
          await this.broadcaster.broadcast(payload, position);
          this.processedPositions.add(position.id);
          submitted += 1;
        } catch (error) {
          console.error(
            `[LiquidationKeeper] Failed to liquidate position ${position.id}:`,
            error,
          );
        }
      }
      return submitted;
    } finally {
      this.polling = false;
    }
  }
}

/** Builds a Soroban liquidation call using the position id and borrower address. */
export class SorobanLiquidationPayloadBuilder implements LiquidationContractPayloadBuilder {
  constructor(
    private readonly contractId: string,
    private readonly method = "liquidate",
  ) {}

  build(position: VaultPosition): LiquidationContractCallPayload {
    if (!position.userId)
      throw new Error("Liquidation position has no borrower");
    return {
      contractId: this.contractId,
      method: this.method,
      args: [
        nativeToScVal(position.id, { type: "symbol" }),
        nativeToScVal(position.userId, { type: "address" }),
      ],
    };
  }
}

/** Signs with the configured keeper signer, submits through Soroban RPC, and waits for finality. */
export class StellarLiquidationTransactionBroadcaster implements LiquidationTransactionBroadcaster {
  constructor(
    private readonly rpcServer: SorobanRpc.Server = stellarProvider.getRpcServer(),
    private readonly networkPassphrase = getStellarNetworkPassphrase(),
  ) {}

  async broadcast(
    payload: LiquidationContractCallPayload,
    _position: VaultPosition,
  ): Promise<string> {
    await assertSigningAllowed();
    const publicKey = await signer.getPublicKey();
    const account = await this.rpcServer.getAccount(publicKey);
    const transaction = new TransactionBuilder(
      new Account(
        (account as any).accountId ?? (account as any).id,
        (account as any).sequenceNumber ?? (account as any).sequence,
      ),
      {
        fee: "100",
        networkPassphrase: this.networkPassphrase,
      },
    )
      .addOperation(
        new Contract(payload.contractId).call(payload.method, ...payload.args),
      )
      .setTimeout(30)
      .build();

    const simulation = await this.rpcServer.simulateTransaction(transaction);
    if (SorobanRpc.Api.isSimulationError(simulation)) {
      throw new Error(`Liquidation simulation failed: ${simulation.error}`);
    }
    const prepared = SorobanRpc.assembleTransaction(transaction, simulation).build();
    const signature = await signer.sign(prepared.hash());
    const keypair = Keypair.fromPublicKey(publicKey);
    prepared.signatures.push(
      new xdr.DecoratedSignature({
        hint: keypair.signatureHint(),
        signature,
      }),
    );

    const submitted = await this.rpcServer.sendTransaction(prepared);
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const result = await this.rpcServer.getTransaction(submitted.hash);
      if (result.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS)
        return submitted.hash;
      if (result.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
        throw new Error(`Liquidation transaction ${submitted.hash} failed`);
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error(
      `Liquidation transaction ${submitted.hash} confirmation timed out`,
    );
  }
}
