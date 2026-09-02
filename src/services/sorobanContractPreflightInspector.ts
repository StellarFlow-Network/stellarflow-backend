import { rpc as SorobanRpc, Transaction, xdr } from "@stellar/stellar-sdk";
import stellarProvider from "../lib/stellarProvider";

export interface StorageTtlCheck {
  key: xdr.LedgerKey;
  minimumLedgers?: number;
}

export interface AuthorizationEntryInspection {
  index: number;
  valid: boolean;
  description: string;
}

export interface StorageTtlInspection {
  index: number;
  liveUntilLedger: number | null;
  currentLedger: number;
  remainingLedgers: number | null;
  valid: boolean;
  description: string;
}

export interface SorobanPreflightReport {
  ready: boolean;
  simulationSucceeded: boolean;
  authEntries: AuthorizationEntryInspection[];
  storageTtl: StorageTtlInspection[];
  errors: string[];
}

export interface SorobanContractPreflightInspectorOptions {
  minimumTtlLedgers?: number;
}

/** Inspects a built Soroban envelope before signing or broadcasting it. */
export class SorobanContractPreflightInspector {
  private readonly minimumTtlLedgers: number;

  constructor(
    private readonly rpcServer: SorobanRpc.Server = stellarProvider.getRpcServer(),
    options: SorobanContractPreflightInspectorOptions = {},
  ) {
    this.minimumTtlLedgers =
      options.minimumTtlLedgers ??
      Number(process.env.SOROBAN_PREFLIGHT_MIN_TTL_LEDGERS ?? "100");
  }

  async inspect(
    transaction: Transaction,
    storageChecks: StorageTtlCheck[] = [],
  ): Promise<SorobanPreflightReport> {
    const errors: string[] = [];
    let simulationSucceeded = false;
    let authEntries: AuthorizationEntryInspection[] = [];
    let storageTtl: StorageTtlInspection[] = [];

    try {
      const simulation = await this.rpcServer.simulateTransaction(transaction);
      if (SorobanRpc.Api.isSimulationError(simulation)) {
        errors.push(this.describeSimulationError(simulation.error));
      } else {
        simulationSucceeded = true;
        authEntries = this.inspectAuthorizationEntries(
          simulation.result?.auth ?? [],
        );
        errors.push(
          ...authEntries
            .filter((entry) => !entry.valid)
            .map((entry) => entry.description),
        );
      }
    } catch (error) {
      errors.push(
        `Unable to simulate transaction: ${this.describeError(error)}`,
      );
    }

    if (storageChecks.length > 0) {
      try {
        storageTtl = await this.inspectStorageTtl(storageChecks);
        errors.push(
          ...storageTtl
            .filter((entry) => !entry.valid)
            .map((entry) => entry.description),
        );
      } catch (error) {
        errors.push(
          `Unable to inspect storage TTL: ${this.describeError(error)}`,
        );
      }
    }

    return {
      ready: simulationSucceeded && errors.length === 0,
      simulationSucceeded,
      authEntries,
      storageTtl,
      errors,
    };
  }

  private inspectAuthorizationEntries(
    entries: xdr.SorobanAuthorizationEntry[],
  ): AuthorizationEntryInspection[] {
    return entries.map((entry, index) => {
      try {
        const credentials = entry.credentials();
        const invocation = entry.rootInvocation();
        const hasCredentials =
          credentials !== undefined && credentials.switch() !== undefined;
        const hasInvocation =
          invocation !== undefined && invocation.function() !== undefined;
        if (!hasCredentials || !hasInvocation) {
          return {
            index,
            valid: false,
            description: `Authorization entry ${index} is incomplete: credentials and root invocation are required.`,
          };
        }
        return {
          index,
          valid: true,
          description: `Authorization entry ${index} contains credentials and a root invocation.`,
        };
      } catch (error) {
        return {
          index,
          valid: false,
          description: `Authorization entry ${index} could not be decoded: ${this.describeError(error)}.`,
        };
      }
    });
  }

  private async inspectStorageTtl(
    checks: StorageTtlCheck[],
  ): Promise<StorageTtlInspection[]> {
    const latestLedger = await this.rpcServer.getLatestLedger();
    const entries = await this.rpcServer.getLedgerEntries(
      ...checks.map((check) => check.key),
    );

    return checks.map((check, index) => {
      const ledgerEntry = entries.entries[index];
      const liveUntilLedger = ledgerEntry?.liveUntilLedgerSeq ?? null;
      const remainingLedgers =
        liveUntilLedger === null
          ? null
          : Math.max(0, liveUntilLedger - latestLedger.sequence);
      const minimum = check.minimumLedgers ?? this.minimumTtlLedgers;
      const valid = remainingLedgers !== null && remainingLedgers >= minimum;
      return {
        index,
        liveUntilLedger,
        currentLedger: latestLedger.sequence,
        remainingLedgers,
        valid,
        description: valid
          ? `Storage entry ${index} has ${remainingLedgers} ledgers of TTL remaining.`
          : liveUntilLedger === null
            ? `Storage entry ${index} has no live-until ledger and may be missing or temporary.`
            : `Storage entry ${index} has only ${remainingLedgers} ledgers of TTL remaining; ${minimum} required.`,
      };
    });
  }

  private describeSimulationError(error: unknown): string {
    const detail =
      typeof error === "string" ? error : this.describeError(error);
    return `Simulation failed: ${detail}. The transaction was not broadcast.`;
  }

  private describeError(error: unknown): string {
    if (error instanceof Error) return error.message;
    if (typeof error === "string") return error;
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
}
