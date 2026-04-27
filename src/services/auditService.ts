/**
 * Audit Service for institutional compliance reporting
 * Handles audit data generation, cryptographic signing, and export functionality
 */

import { Keypair } from "@stellar/stellar-sdk";
import * as crypto from "crypto";
import { generateAuditExportCSV, ExportOptions, AuditRecord, ExportMetadata } from "../utils/exportUtils";

export interface CertifiedAuditData {
  records: AuditRecord[];
  dataHash: string;
  signature: string;
  signerAddress: string;
  timestamp: string;
  recordCount: number;
}

export interface AuditExport {
  period: {
    start: string;
    end: string;
  };
  recordCount: number;
  dataHash: string;
  signature: string;
  signerPublicKey: string;
  generatedAt: string;
  records: AuditRecord[];
}

export interface AuditSummary {
  period: {
    start: string;
    end: string;
  };
  totalRecords: number;
  eventTypes: Record<string, number>;
  currencyActivity: Record<string, number>;
  signatureValidity: {
    valid: boolean;
    message?: string;
  };
}

export class AuditService {
  private readonly signerSecret: string;
  private readonly signerPublicKey: string;

  constructor(secretKey?: string) {
    // Use provided secret key or environment variable
    this.signerSecret = secretKey || process.env.ORACLE_SECRET_KEY || "";
    
    if (!this.signerSecret) {
      throw new Error("Oracle secret key is required for audit service");
    }

    // Generate public key from secret
    this.signerPublicKey = Keypair.fromSecret(this.signerSecret).publicKey();
  }

  /**
   * Creates a deterministic signature message for audit data
   */
  private createSignatureMessage(
    startDate: string,
    endDate: string,
    recordCount: number,
    dataHash: string
  ): string {
    return `STELLARFLOW-AUDIT-${startDate}-${endDate}-${recordCount}-${dataHash}`;
  }

  /**
   * Signs audit data using Ed25519
   */
  private signAuditData(message: string): string {
    const keypair = Keypair.fromSecret(this.signerSecret);
    return keypair.sign(Buffer.from(message, "utf-8")).toString("hex");
  }

  /**
   * Generates certified audit data with cryptographic hash and signature
   */
  async generateAuditData(
    startDate: Date,
    endDate: Date,
    assetPair?: string
  ): Promise<CertifiedAuditData> {
    // In a real implementation, this would query the database
    // For now, we'll use mock data aligned with Prisma schema
    const records: AuditRecord[] = [
      {
        timestamp: new Date("2024-01-01T00:00:00Z"),
        eventType: "PRICE_CONFIRMED_ONCHAIN",
        currency: "USD",
        rate: 1.23,
        txHash: "abc123",
        ledgerSeq: 12345,
        memoId: "SF-USD-1234567890-001",
        source: "CoinGecko",
        details: { source: "test", confidence: 0.95 }
      },
      {
        timestamp: new Date("2024-01-01T01:00:00Z"),
        eventType: "PRICE_CONFIRMED_ONCHAIN",
        currency: "NGN",
        rate: 850.50,
        txHash: "def456",
        ledgerSeq: 12346,
        memoId: "SF-NGN-1234567890-002",
        source: "ExchangeRateAPI",
        details: { source: "test", confidence: 0.88 }
      },
      {
        timestamp: new Date("2024-01-01T02:00:00Z"),
        eventType: "PROVIDER_ERROR",
        currency: "GHS",
        providerName: "GHSRateFetcher",
        errorMessage: "API timeout after 5000ms",
        details: { errorCode: "TIMEOUT", retryCount: 3 }
      },
      {
        timestamp: new Date("2024-01-01T03:00:00Z"),
        eventType: "LATENCY_VIOLATION",
        relayerName: "relayer-001",
        latencyDiffMs: 1250,
        thresholdMs: 1000,
        resolved: false,
        details: { violationType: "EXCESSIVE_LATENCY", payloadSize: 1024 }
      }
    ];

    // Filter records by date range and asset pair
    let filteredRecords = records.filter(record => {
      const recordDate = new Date(record.timestamp);
      return recordDate >= startDate && recordDate <= endDate;
    });

    if (assetPair) {
      const [baseCurrency, quoteCurrency] = assetPair.split('/');
      filteredRecords = filteredRecords.filter(record => {
        return record.currency === baseCurrency || record.currency === quoteCurrency;
      });
    }

    // Generate SHA-256 hash of the records
    const dataString = JSON.stringify(filteredRecords, null, 2);
    const dataHash = crypto.createHash("sha256").update(dataString).digest("hex");

    // Create signature message and sign
    const startStr = startDate.toISOString().split('T')[0] || '';
    const endStr = endDate.toISOString().split('T')[0] || '';
    const signatureMessage = this.createSignatureMessage(
      startStr,
      endStr,
      filteredRecords.length,
      dataHash
    );

    const signature = this.signAuditData(signatureMessage);

    return {
      records: filteredRecords.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime()),
      dataHash,
      signature,
      signerAddress: this.signerPublicKey,
      timestamp: new Date().toISOString(),
      recordCount: filteredRecords.length,
    };
  }

  /**
   * Generates a complete audit export with metadata
   */
  async generateAuditExport(
    startDate: Date,
    endDate: Date,
    assetPair?: string
  ): Promise<AuditExport> {
    const certifiedData = await this.generateAuditData(startDate, endDate, assetPair);
    const dataHash = certifiedData.dataHash;

    const startStr = startDate.toISOString().split('T')[0] || '';
    const endStr = endDate.toISOString().split('T')[0] || '';

    // Create signature message for verification
    const signatureMessage = this.createSignatureMessage(
      startStr,
      endStr,
      certifiedData.recordCount,
      dataHash,
    );

    const signature = this.signAuditData(signatureMessage);

    return {
      period: {
        start: startStr as string,
        end: endStr as string,
      },
      recordCount: certifiedData.recordCount,
      dataHash: certifiedData.dataHash,
      signature: certifiedData.signature,
      signerPublicKey: this.signerPublicKey,
      generatedAt: new Date().toISOString(),
      records: certifiedData.records,
    };
  }

  /**
   * Generates an audit summary with event statistics
   */
  async generateAuditSummary(
    startDate: Date,
    endDate: Date,
    assetPair?: string
  ): Promise<AuditSummary> {
    const certifiedData = await this.generateAuditData(startDate, endDate, assetPair);

    const eventTypes: Record<string, number> = {};
    const currencyActivity: Record<string, number> = {};

    for (const record of certifiedData.records) {
      eventTypes[record.eventType] = (eventTypes[record.eventType] || 0) + 1;

      if (record.currency) {
        currencyActivity[record.currency] = (currencyActivity[record.currency] || 0) + 1;
      }
    }

    return {
      period: {
        start: startDate.toISOString().split('T')[0] as string,
        end: endDate.toISOString().split('T')[0] as string,
      },
      totalRecords: certifiedData.recordCount,
      eventTypes,
      currencyActivity,
      signatureValidity: {
        valid: false, // Will be populated when export is generated
      },
    };
  }

  /**
   * Exports audit data as JSON
   */
  async exportAsJSON(
    startDate: Date,
    endDate: Date,
    assetPair?: string
  ): Promise<string> {
    const auditExport = await this.generateAuditExport(startDate, endDate, assetPair);
    return JSON.stringify(auditExport, null, 2);
  }

  /**
   * Exports audit data as CSV with cryptographic metadata
   */
  async exportAsCSV(
    startDate: Date,
    endDate: Date,
    assetPair?: string,
    outputDir?: string
  ): Promise<{ filePath: string; metadata: ExportMetadata }> {
    const certifiedData = await this.generateAuditData(startDate, endDate, assetPair);

    const exportOptions: ExportOptions = {
      startDate,
      endDate,
      ...(assetPair && { assetPair }),
      ...(outputDir && { outputDir })
    };

    return await generateAuditExportCSV(
      certifiedData.records,
      exportOptions,
      this.signerSecret
    );
  }

  /**
   * Verifies the signature of audit data
   */
  static verifySignature(auditExport: AuditExport): boolean {
    try {
      const signatureMessage = `STELLARFLOW-AUDIT-${auditExport.period.start}-${auditExport.period.end}-${auditExport.recordCount}-${auditExport.dataHash}`;
      
      const verificationKeypair = Keypair.fromPublicKey(auditExport.signerPublicKey);
      return verificationKeypair.verify(
        Buffer.from(signatureMessage, "utf-8"),
        Buffer.from(auditExport.signature, "hex")
      );
    } catch (error) {
      console.error("Error verifying audit signature:", error);
      return false;
    }
  }

  /**
   * Gets the signer's public key
   */
  getSignerPublicKey(): string {
    return this.signerPublicKey;
  }
}
