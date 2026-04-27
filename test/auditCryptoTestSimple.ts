/**
 * Simple test for audit service cryptographic functionality
 * Tests signature generation and verification without database dependency
 */

import { Keypair } from "@stellar/stellar-sdk";
import * as crypto from "crypto";
import { AuditService } from "../src/services/auditService";

// Mock test data
const testRecords = [
  {
    timestamp: new Date("2024-01-01T00:00:00Z"),
    eventType: "PRICE_CONFIRMED_ONCHAIN",
    currency: "USD",
    rate: 1.23,
    txHash: "abc123",
    ledgerSeq: 12345,
    memoId: "SF-USD-1234567890-001",
    details: { source: "test" }
  }
];

// Test cryptographic functionality
function testAuditCryptography() {
  console.log("🧪 Testing Audit Cryptographic Functionality...\n");

  // 1. Test SHA-256 hash generation
  const dataString = JSON.stringify(testRecords, null, 2);
  const dataHash = crypto.createHash("sha256").update(dataString).digest("hex");
  console.log(`✅ SHA-256 Hash: ${dataHash}`);
  console.log(`✅ Hash Length: ${dataHash.length} characters`);

  // 2. Test signature message format
  const startStr = "2024-01-01";
  const endStr = "2024-01-02";
  const recordCount = testRecords.length;
  const signatureMessage = `STELLARFLOW-AUDIT-${startStr}-${endStr}-${recordCount}-${dataHash}`;
  console.log(`✅ Signature Message: ${signatureMessage}`);

  // 3. Test Ed25519 signature generation
  const testSecret = "SAULY2BKBNGNYETF2J4L3TJ4OCCW3WGBQ5F6JSPHBMEGQQO7QZ3IKUGP"; // Test secret key
  const testKeypair = Keypair.fromSecret(testSecret);
  const testPublicKey = testKeypair.publicKey();
  console.log(`✅ Test Public Key: ${testPublicKey}`);

  const signature = testKeypair.sign(Buffer.from(signatureMessage, "utf-8")).toString("hex");
  console.log(`✅ Signature: ${signature}`);
  console.log(`✅ Signature Length: ${signature.length} characters`);

  // 4. Test signature verification
  const verificationKeypair = Keypair.fromPublicKey(testPublicKey);
  const isValid = verificationKeypair.verify(
    Buffer.from(signatureMessage, "utf-8"),
    Buffer.from(signature, "hex")
  );
  console.log(`✅ Signature Verification: ${isValid ? "VALID" : "INVALID"}`);

  // 5. Test certified audit data structure
  const certifiedAuditData = {
    records: testRecords,
    dataHash,
    signature,
    signerAddress: testPublicKey,
    timestamp: new Date().toISOString(),
    recordCount: testRecords.length
  };

  console.log("\n📋 Certified Audit Data Structure:");
  console.log(JSON.stringify(certifiedAuditData, null, 2));

  return {
    hashGenerated: dataHash.length === 64,
    signatureGenerated: signature.length > 0,
    signatureVerified: isValid,
    structureValid: certifiedAuditData.records.length > 0 && 
                  certifiedAuditData.dataHash && 
                  certifiedAuditData.signature && 
                  certifiedAuditData.signerAddress
  };
}

// Run tests
const results = testAuditCryptography();
console.log("\n🎯 Test Results:");
console.log(`SHA-256 Hash Generated: ${results.hashGenerated ? "✅" : "❌"}`);
console.log(`Ed25519 Signature Generated: ${results.signatureGenerated ? "✅" : "❌"}`);
console.log(`Signature Verification: ${results.signatureVerified ? "✅" : "❌"}`);
console.log(`Data Structure Valid: ${results.structureValid ? "✅" : "❌"}`);

const allTestsPassed = Object.values(results).every(result => result);
console.log(`\n🏆 All Tests Passed: ${allTestsPassed ? "YES 🎉" : "NO ❌"}`);

if (allTestsPassed) {
  console.log("\n✨ Audit service cryptographic functionality is working correctly!");
  console.log("✨ Ready for institutional compliance reporting!");
  
  // Test CSV export functionality
  console.log("\n📄 Testing CSV Export Functionality...");
  testCSVExport();
}

/**
 * Tests CSV export functionality with actual file generation
 */
async function testCSVExport() {
  try {
    // Initialize audit service with test secret key
    const testSecret = "SAULY2BKBNGNYETF2J4L3TJ4OCCW3WGBQ5F6JSPHBMEGQQO7QZ3IKUGP";
    const auditService = new AuditService(testSecret);
    
    // Set test date range
    const startDate = new Date("2024-01-01");
    const endDate = new Date("2024-01-02");
    const assetPair = "USD/NGN";
    
    console.log(`📅 Exporting audit data from ${startDate.toISOString().split('T')[0]} to ${endDate.toISOString().split('T')[0]}`);
    console.log(`💱 Asset Pair: ${assetPair}`);
    
    // Generate CSV export
    const exportResult = await auditService.exportAsCSV(startDate, endDate, assetPair);
    
    console.log(`✅ CSV Export Created Successfully!`);
    console.log(`📁 File Path: ${exportResult.filePath}`);
    console.log(`📊 Record Count: ${exportResult.metadata.recordCount}`);
    console.log(`🔐 Data Hash: ${exportResult.metadata.dataHash}`);
    console.log(`✍️  Signature: ${exportResult.metadata.signature}`);
    console.log(`🔑 Signer Address: ${exportResult.metadata.signerAddress}`);
    
    // Verify the export signature
    const auditExport = await auditService.generateAuditExport(startDate, endDate, assetPair);
    const isSignatureValid = AuditService.verifySignature(auditExport);
    
    console.log(`🔍 Signature Verification: ${isSignatureValid ? "VALID ✅" : "INVALID ❌"}`);
    
    if (isSignatureValid) {
      console.log("\n🎉 CSV Export Test Completed Successfully!");
      console.log("📋 Export file is ready for institutional compliance review");
    } else {
      console.log("\n❌ CSV Export Signature Verification Failed");
    }
    
  } catch (error) {
    console.error("❌ CSV Export Test Failed:", error);
  }
}
