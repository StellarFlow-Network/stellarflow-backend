import { TransactionBuilder, rpc as SorobanRpc } from "@stellar/stellar-sdk";
import stellarProvider from "../lib/stellarProvider";
import { getStellarNetworkPassphrase } from "../lib/stellarNetwork";
import { feeEstimationService } from "./feeEstimationService";

export interface SorobanSimulationRequest {
  transaction: string;
}

export interface SorobanTransactionSimulation {
  status: "success" | "error" | "restore_required";
  latestLedger: number;
  instructions: string;
  memoryBytes: string;
  readEntries: number;
  writeEntries: number;
  readBytes: string;
  writeBytes: string;
  requiredBaseFee: string;
  priorityFees: {
    low: number;
    medium: number;
    urgent: number;
  };
  error?: string;
}

type SimulationWithCost = SorobanRpc.Api.SimulateTransactionResponse & {
  cost?: {
    cpuInsns?: string | number;
    memBytes?: string | number;
  };
};

function asString(value: unknown, fallback = "0"): string {
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }
  return fallback;
}

function asNonNegativeNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

export class SorobanTransactionSimulationService {
  async simulate(transactionXdr: string): Promise<SorobanTransactionSimulation> {
    const transaction = TransactionBuilder.fromXDR(
      transactionXdr,
      getStellarNetworkPassphrase(),
    );
    const rpcServer = stellarProvider.getRpcServer();
    const simulation = (await rpcServer.simulateTransaction(
      transaction,
    )) as SimulationWithCost;

    const feeEstimate = await feeEstimationService.getFeeEstimate();
    if (SorobanRpc.Api.isSimulationError(simulation)) {
      return {
        status: "error",
        latestLedger: simulation.latestLedger,
        instructions: "0",
        memoryBytes: "0",
        readEntries: 0,
        writeEntries: 0,
        readBytes: "0",
        writeBytes: "0",
        requiredBaseFee: "0",
        priorityFees: {
          low: feeEstimate.low,
          medium: feeEstimate.medium,
          urgent: feeEstimate.urgent,
        },
        error: simulation.error,
      };
    }

    const resources = simulation.transactionData.build().resources();
    const cost = simulation.cost;
    const requiredBaseFee = asString(simulation.minResourceFee);

    return {
      status: SorobanRpc.Api.isSimulationRestore(simulation)
        ? "restore_required"
        : "success",
      latestLedger: simulation.latestLedger,
      instructions: asString(cost?.cpuInsns ?? resources.instructions()),
      memoryBytes: asString(cost?.memBytes),
      readEntries: asNonNegativeNumber((resources as any).readEntries?.() ?? 0),
      writeEntries: asNonNegativeNumber((resources as any).writeEntries?.() ?? 0),
      readBytes: asString((resources as any).readBytes?.() ?? 0),
      writeBytes: asString((resources as any).writeBytes?.() ?? 0),
      requiredBaseFee,
      priorityFees: {
        low: Math.max(feeEstimate.low, Number(requiredBaseFee)),
        medium: Math.max(feeEstimate.medium, Number(requiredBaseFee)),
        urgent: Math.max(feeEstimate.urgent, Number(requiredBaseFee)),
      },
    };
  }
}

export const sorobanTransactionSimulationService =
  new SorobanTransactionSimulationService();