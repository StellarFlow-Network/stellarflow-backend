import { StellarService } from '../src/services/stellarService';
import { TransactionBuilder, Networks, Keypair } from '@stellar/stellar-sdk';
import logger from '../src/utils/logger';
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// Mock the native logger module
jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

describe('StellarService Telemetry', () => {
  let stellarService: StellarService;
  const mockHash = 'abc123transactionhash';

  beforeEach(() => {
    stellarService = new StellarService();
        
    // Mock the horizon server response
    (stellarService as any).server = {
      submitTransaction: jest.fn().mockResolvedValue({
        hash: mockHash,
        successful: true
      })
    };
    
    // Mock signer to avoid real cryptography in test
    jest.spyOn(stellarService as any, 'getPublicKey').mockResolvedValue(Keypair.random().publicKey());
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should log a clean StellarExpert URL at INFO level upon successful broadcast', async () => {
    const mockSource = Keypair.random();
    const tx = new TransactionBuilder(mockSource, { fee: '100', networkPassphrase: Networks.TESTNET })
      .addOperation({} as any)
      .setTimeout(30)
      .build();

    await stellarService.submitTransactionWithRetries(() => tx, 0, 100);
    
    const expectedUrl = `https://testnet.stellarexpert.org/tx/${mockHash}`;
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining(`[StellarService] Transaction Broadcast Successful. View on StellarExpert: ${expectedUrl}`)
    );
  });
});