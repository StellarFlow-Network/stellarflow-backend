/**
 * Export utilities for audit reports
 * Handles CSV generation with cryptographic signatures for institutional compliance
 */

import { createObjectCsvWriter } from 'csv-writer';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { Keypair } from '@stellar/stellar-sdk';

export interface ExportOptions {
  startDate: Date;
  endDate: Date;
  assetPair?: string; // e.g., "NGN/XLM"
  outputDir?: string;
}

export interface ExportMetadata {
  dataHash: string;
  signature: string;
  signerAddress: string;
  timestamp: string;
  recordCount: number;
  dateRange: {
    start: string;
    end: string;
  };
  assetPair?: string;
}

export interface AuditRecord {
  timestamp: Date;
  eventType: string;
  currency?: string;
  rate?: number;
  txHash?: string;
  ledgerSeq?: number;
  source?: string;
  memoId?: string;
  details?: any;
  // Additional fields from Prisma schema
  providerName?: string;
  errorMessage?: string;
  relayerName?: string;
  latencyDiffMs?: number;
  thresholdMs?: number;
  resolved?: boolean;
}

/**
 * Creates exports directory if it doesn't exist
 */
function ensureExportsDirectory(outputDir: string = 'exports'): string {
  const fullPath = path.resolve(outputDir);
  if (!fs.existsSync(fullPath)) {
    fs.mkdirSync(fullPath, { recursive: true });
  }
  return fullPath;
}

/**
 * Generates SHA-256 hash of audit records
 */
function generateDataHash(records: AuditRecord[]): string {
  const dataString = JSON.stringify(records, null, 2);
  return crypto.createHash('sha256').update(dataString).digest('hex');
}

/**
 * Creates signature message for audit data
 */
function createSignatureMessage(
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
function signAuditData(message: string, secretKey: string): string {
  const keypair = Keypair.fromSecret(secretKey);
  return keypair.sign(Buffer.from(message, 'utf-8')).toString('hex');
}

/**
 * Filters audit records based on date range and asset pair
 */
function filterAuditRecords(
  records: AuditRecord[],
  options: ExportOptions
): AuditRecord[] {
  let filteredRecords = records;

  // Filter by date range
  filteredRecords = filteredRecords.filter(record => {
    const recordDate = new Date(record.timestamp);
    return recordDate >= options.startDate && recordDate <= options.endDate;
  });

  // Filter by asset pair if specified
  if (options.assetPair) {
    const [baseCurrency, quoteCurrency] = options.assetPair.split('/');
    filteredRecords = filteredRecords.filter(record => {
      // Match records that involve either currency in the pair
      return record.currency === baseCurrency || record.currency === quoteCurrency;
    });
  }

  return filteredRecords.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
}

/**
 * Generates CSV export with cryptographic metadata
 */
export async function generateAuditExportCSV(
  records: AuditRecord[],
  options: ExportOptions,
  secretKey: string
): Promise<{ filePath: string; metadata: ExportMetadata }> {
  const outputDir = ensureExportsDirectory(options.outputDir);
  const filteredRecords = filterAuditRecords(records, options);
  
  // Generate cryptographic metadata
  const dataHash = generateDataHash(filteredRecords);
  const startStr = options.startDate.toISOString().split('T')[0] || '';
  const endStr = options.endDate.toISOString().split('T')[0] || '';
  const signatureMessage = createSignatureMessage(startStr, endStr, filteredRecords.length, dataHash);
  const signature = signAuditData(signatureMessage, secretKey);
  const signerAddress = Keypair.fromSecret(secretKey).publicKey();

  const metadata: ExportMetadata = {
    dataHash,
    signature,
    signerAddress,
    timestamp: new Date().toISOString(),
    recordCount: filteredRecords.length,
    dateRange: { start: startStr, end: endStr },
    ...(options.assetPair && { assetPair: options.assetPair })
  };

  // Generate filename with timestamp and metadata
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const assetPairSuffix = options.assetPair ? `-${options.assetPair.replace('/', '-')}` : '';
  const fileName = `audit-export-${startStr}-to-${endStr}${assetPairSuffix}-${timestamp}.csv`;
  const filePath = path.join(outputDir, fileName);

  // Prepare CSV headers
  const headers = [
    { id: 'timestamp', title: 'Timestamp' },
    { id: 'eventType', title: 'Event Type' },
    { id: 'currency', title: 'Currency' },
    { id: 'rate', title: 'Rate' },
    { id: 'txHash', title: 'Transaction Hash' },
    { id: 'ledgerSeq', title: 'Ledger Sequence' },
    { id: 'source', title: 'Source' },
    { id: 'memoId', title: 'Memo ID' },
    { id: 'providerName', title: 'Provider Name' },
    { id: 'errorMessage', title: 'Error Message' },
    { id: 'relayerName', title: 'Relayer Name' },
    { id: 'latencyDiffMs', title: 'Latency Diff (ms)' },
    { id: 'thresholdMs', title: 'Threshold (ms)' },
    { id: 'resolved', title: 'Resolved' },
    { id: 'details', title: 'Details' }
  ];

  // Prepare CSV data
  const csvData = filteredRecords.map(record => ({
    timestamp: record.timestamp.toISOString(),
    eventType: record.eventType,
    currency: record.currency || '',
    rate: record.rate?.toString() || '',
    txHash: record.txHash || '',
    ledgerSeq: record.ledgerSeq?.toString() || '',
    source: record.source || '',
    memoId: record.memoId || '',
    providerName: record.providerName || '',
    errorMessage: record.errorMessage || '',
    relayerName: record.relayerName || '',
    latencyDiffMs: record.latencyDiffMs?.toString() || '',
    thresholdMs: record.thresholdMs?.toString() || '',
    resolved: record.resolved?.toString() || '',
    details: record.details ? JSON.stringify(record.details) : ''
  }));

  // Create CSV writer and write data
  const csvWriter = createObjectCsvWriter({
    path: filePath,
    header: headers,
    append: false
  });

  await csvWriter.writeRecords(csvData);

  // Append cryptographic metadata as comments at the end of the CSV
  const metadataComments = [
    '# STELLARFLOW AUDIT EXPORT METADATA',
    `# Generated: ${metadata.timestamp}`,
    `# Date Range: ${metadata.dateRange.start} to ${metadata.dateRange.end}`,
    `# Asset Pair: ${metadata.assetPair || 'All'}`,
    `# Record Count: ${metadata.recordCount}`,
    `# Data Hash (SHA-256): ${metadata.dataHash}`,
    `# Signature (Ed25519): ${metadata.signature}`,
    `# Signer Address: ${metadata.signerAddress}`,
    '# Verification: Use stellar-sdk to verify signature with the signature message',
    `# Signature Message: STELLARFLOW-AUDIT-${metadata.dateRange.start}-${metadata.dateRange.end}-${metadata.recordCount}-${metadata.dataHash}`,
    '# END METADATA'
  ];

  // Append metadata to the CSV file
  const metadataText = metadataComments.join('\n') + '\n';
  fs.appendFileSync(filePath, metadataText);

  return { filePath, metadata };
}

/**
 * Verifies the cryptographic signature of an audit export
 */
export function verifyAuditExport(
  metadata: ExportMetadata,
  signature: string,
  signerAddress: string
): boolean {
  try {
    const signatureMessage = createSignatureMessage(
      metadata.dateRange.start,
      metadata.dateRange.end,
      metadata.recordCount,
      metadata.dataHash
    );

    const verificationKeypair = Keypair.fromPublicKey(signerAddress);
    return verificationKeypair.verify(
      Buffer.from(signatureMessage, 'utf-8'),
      Buffer.from(signature, 'hex')
    );
  } catch (error) {
    console.error('Error verifying audit export signature:', error);
    return false;
  }
}
